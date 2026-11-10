// One admission pass under the fleet lock (contracts 8.4; fleet-v0.2.md sections 3 and 9).
// The lock is never held across a spawn, a process scan or a network call (landmine 11).
import { FleetError } from "./fleet-errors.js";
import type { JobIndex } from "./job-index.js";
import { readKillRequest, type JobRuntime } from "./job-runtime.js";
import type { LeaseManager } from "./leases.js";
import type { PolicyTransition, ResourcePolicyGuard } from "./policy.js";
import type { AdmissionPlan } from "./queue.js";
import { planAdmission } from "./queue.js";
import { withFleetLock } from "./reconcile.js";
import type {
  AdmissionPolicy, JobRecordV2, LeaseHolder, ListenerInfo, PolicyRule, PortLease, QueueEntry, QueueEntryView, ResourceRequest,
} from "./types.js";

interface PassResult { plan: AdmissionPlan; starts: Array<Promise<JobRecordV2>> }
interface FollowUp { promise: Promise<AdmissionPlan>; resolve: (plan: AdmissionPlan) => void; reject: (error: unknown) => void }

/** Which queued jobs a guard transition notifies; mirrors ResourcePolicyGuard.evaluate (contracts 8.2). */
function affected(rule: PolicyRule, resources: ResourceRequest): boolean {
  if (rule === "gpu-busy") return resources.gpu === true;
  if (rule === "npu-busy") return resources.npu === true;
  return true; // memory-low affects every queued job
}
function policyDetail(transition: PolicyTransition): string {
  const measured = transition.measured === null ? "unknown" : String(transition.measured);
  return `${transition.rule} ${transition.decision}: measured ${measured}, threshold ${transition.threshold}`;
}
/** The queue entry a queued record describes; enqueuedAt is the submission time (createdAt). */
function toQueueEntry(record: JobRecordV2): QueueEntry {
  return {
    jobId: record.jobId, peer: record.peer, harness: record.harness, priority: record.queue.priority,
    dependsOn: [...record.queue.dependsOn], resources: { ...record.queue.resources }, leasePorts: [...record.queue.leasePorts],
    redact: record.capture.redact, enqueuedAt: record.createdAt, maxQueueMs: record.queue.maxQueueMs,
    sessionId: record.owner.sessionId, supervisorPid: record.supervisor.pid,
  };
}
function leaseHolder(lease: PortLease): LeaseHolder {
  return { kind: "lease", port: lease.port, jobId: lease.jobId, peer: lease.peer, expiresAt: lease.expiresAt };
}

/**
 * The admission scheduler (contracts 8.4). Every pass refreshes the index and sweeps leases under the
 * fleet lock, writes policy and kill-marker outcomes, plans admission, acquires leases and finally
 * starts admitted jobs with `runtime.start()` as the last locked action so the lock is released
 * before the spawn (landmine 8, D26).
 */
export class Scheduler {
  private readonly deps: {
    runtime: JobRuntime; index: JobIndex; leases: LeaseManager; guard: ResourcePolicyGuard;
    policy: () => AdmissionPolicy; listeners: () => ListenerInfo[]; now?: () => number;
  };
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private followUp: FollowUp | null = null;
  private lastViews: QueueEntryView[] = [];

  constructor(deps: {
    runtime: JobRuntime; index: JobIndex; leases: LeaseManager; guard: ResourcePolicyGuard;
    policy: () => AdmissionPolicy; listeners: () => ListenerInfo[]; now?: () => number;
  }) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** Timer-driven ticks; the interval never holds the host process open. */
  start(): void {
    if (this.timer !== null) return;
    const timer = setInterval(() => { void this.tick().catch(() => undefined); }, this.deps.policy().pollMs);
    timer.unref();
    this.timer = timer;
  }
  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Runs one admission pass now. Passes never overlap: a call during a pass joins exactly one
   * follow-up pass and resolves with that follow-up's plan.
   */
  tick(): Promise<AdmissionPlan> {
    if (!this.running) return this.startPass();
    if (this.followUp !== null) return this.followUp.promise;
    let resolve!: (plan: AdmissionPlan) => void, reject!: (error: unknown) => void;
    const promise = new Promise<AdmissionPlan>((res, rej) => { resolve = res; reject = rej; });
    this.followUp = { promise, resolve, reject };
    return promise;
  }

  /** The views of the last completed pass; empty before the first one. */
  view(): QueueEntryView[] { return this.lastViews; }

  private startPass(): Promise<AdmissionPlan> {
    this.running = true;
    return this.runPass().then(
      (plan) => { this.finishPass(); return plan; },
      (error) => { this.finishPass(); throw error; },
    );
  }
  /** A failed pass must not wedge later ticks; a waiter starts exactly one follow-up pass. */
  private finishPass(): void {
    this.running = false;
    const waiter = this.followUp;
    if (waiter === null) return;
    this.followUp = null;
    this.startPass().then(waiter.resolve, waiter.reject);
  }

  private async runPass(): Promise<AdmissionPlan> {
    const { plan, starts } = await withFleetLock(() => this.pass());
    // Outside the lock. Spawn failures are already recorded as failed by the runtime, so a rejected
    // start() must never become an unhandled rejection here.
    await Promise.allSettled(starts);
    this.lastViews = plan.views;
    return plan;
  }

  /** The locked body. No await may follow the first runtime.start() call (L8/D26). */
  private async pass(): Promise<PassResult> {
    const { runtime, index, leases, guard } = this.deps;
    index.refresh();
    leases.sweep();
    const transitions = guard.sample();

    const ownQueued = index.queued().filter((record) => runtime.supervises(record.jobId));
    for (const transition of transitions) {
      for (const record of ownQueued) {
        if (!affected(transition.rule, record.queue.resources)) continue;
        runtime.appendPolicy(record.jobId, {
          decision: transition.decision, rule: transition.rule,
          measured: transition.measured, threshold: transition.threshold, detail: policyDetail(transition),
        });
      }
    }

    // Row 11: a kill marker on an own queued job is recorded as killed/cancelled. Awaiting is safe
    // here: no spawn has been requested yet.
    const kills: Array<Promise<unknown>> = [];
    for (const record of ownQueued) {
      const marker = readKillRequest(record.jobId);
      if (marker !== undefined) kills.push(runtime.kill(record.jobId, "cancelled", marker.detail));
    }
    if (kills.length > 0) await Promise.allSettled(kills);

    const policy = this.deps.policy();
    const plan = planAdmission({
      nowMs: this.now(), policy, ownSupervisorPid: process.pid,
      queued: index.queued().map(toQueueEntry),
      job: (jobId) => index.get(jobId),
      running: index.runningCounts(),
      leaseCheck: (port, jobId) => leases.check(port, jobId),
      policyBlocks: (resources) => guard.evaluate(resources),
    });

    for (const failure of plan.fail) {
      if (runtime.supervises(failure.jobId)) runtime.fail(failure.jobId, failure.reason, failure.detail);
    }

    const admitted: string[] = [];
    for (const jobId of plan.admit) {
      const record = index.get(jobId);
      if (record === undefined || !runtime.supervises(jobId)) continue;
      if (this.acquireLeases(record)) admitted.push(jobId);
    }
    return { plan, starts: admitted.map((jobId) => runtime.start(jobId)) };
  }

  /** Acquires every port of one admitted job; a conflict rolls back and leaves the job queued. */
  private acquireLeases(record: JobRecordV2): boolean {
    const { runtime, leases } = this.deps;
    let acquired = 0;
    for (const port of record.queue.leasePorts) {
      try {
        const lease = leases.acquire({
          port, jobId: record.jobId, peer: record.peer, sessionId: record.owner.sessionId,
          holder: record.supervisor, ttlMs: record.queue.leaseTtlMs,
        });
        acquired++;
        runtime.appendLease(record.jobId, { action: "acquired", port, expiresAt: lease.expiresAt, holder: leaseHolder(lease) });
      } catch (error) {
        if (!(error instanceof FleetError) || error.code !== "E_LEASE_CONFLICT") {
          if (acquired > 0) leases.releaseJob(record.jobId);
          throw error;
        }
        const holder = error.details?.holder as LeaseHolder | undefined;
        runtime.appendLease(record.jobId, { action: "conflict", port, ...(holder === undefined ? {} : { holder }) });
        leases.releaseJob(record.jobId);
        return false;
      }
    }
    return true;
  }
}
