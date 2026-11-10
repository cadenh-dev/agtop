import { FleetError } from "./fleet-errors.js";
import type { AdmissionPolicy, BlockReason, JobRecordV2, LeaseHolder, PolicyRule, QueueEntry, QueueEntryView, ResourceRequest } from "./types.js";

/** Resource-guard refusal (contracts 8.2); Unit 3.2 re-exports it from src/policy.ts. */
export interface PolicyBlock { rule: PolicyRule; measured: number | null; threshold: number }
type ResourceKind = "gpu" | "npu" | "memory";
type JobSnapshot = Pick<JobRecordV2, "state" | "exitCode">;
type Running = { total: number; perPeer: Map<string, number>; perHarness: Map<string, number> };
type Outcome = { kind: "ok" } | { kind: "pending"; jobIds: string[] } | { kind: "failed"; jobIds: string[]; detail: string };

/** `priority + min(agingMaxBoost, floor(waited / agingIntervalMs) * agingStep)` (contracts 8.3). */
export function effectivePriority(entry: QueueEntry, policy: AdmissionPolicy, nowMs: number): number {
  // Waited time is never negative: cross-process clock skew must not push a job below its base priority.
  const steps = Math.floor(Math.max(0, nowMs - Date.parse(entry.enqueuedAt)) / policy.agingIntervalMs);
  return entry.priority + Math.min(policy.agingMaxBoost, steps * policy.agingStep);
}
function compareStrings(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

/** Effective priority descending, then `enqueuedAt` ascending, then `jobId` ascending. */
export function orderQueue(entries: QueueEntry[], policy: AdmissionPolicy, nowMs: number): QueueEntry[] {
  return entries
    .map((entry) => ({ entry, priority: effectivePriority(entry, policy, nowMs) }))
    .sort((a, b) =>
      b.priority - a.priority ||
      compareStrings(a.entry.enqueuedAt, b.entry.enqueuedAt) ||
      compareStrings(a.entry.jobId, b.entry.jobId))
    .map((ranked) => ranked.entry);
}

/** Throws E_DEPENDENCY_CYCLE for a self-reference or cycle, E_DEPENDENCY_NOT_FOUND for unknown IDs. */
export function validateDependencies(
  jobId: string,
  dependsOn: string[],
  known: (jobId: string) => { dependsOn: string[] } | undefined,
): void {
  if (dependsOn.includes(jobId)) throw new FleetError("E_DEPENDENCY_CYCLE", `Dependency cycle through ${jobId}`);
  const missing = [...new Set(dependsOn.filter((id) => known(id) === undefined))];
  if (missing.length > 0) {
    throw new FleetError("E_DEPENDENCY_NOT_FOUND", `Unknown dependency: ${missing.join(", ")}`, { jobIds: missing });
  }
  // The job under validation is not stored yet, so its edges come from `dependsOn`. A node seen
  // twice on the current stack is a cycle; unknown nodes are leaves and cannot form one.
  const depsOf = (id: string): string[] | undefined => (id === jobId ? dependsOn : known(id)?.dependsOn);
  const settled = new Set<string>(), onPath = new Set<string>();
  const visit = (id: string): void => {
    if (onPath.has(id)) throw new FleetError("E_DEPENDENCY_CYCLE", `Dependency cycle through ${id}`);
    if (settled.has(id)) return;
    const deps = depsOf(id);
    if (deps === undefined) return;
    onPath.add(id);
    for (const dependency of deps) visit(dependency);
    onPath.delete(id);
    settled.add(id);
  };
  onPath.add(jobId);
  for (const dependency of dependsOn) visit(dependency);
}

export interface AdmissionInput {
  nowMs: number; policy: AdmissionPolicy; ownSupervisorPid: number; queued: QueueEntry[];
  job(jobId: string): JobSnapshot | undefined;
  running: Running;
  leaseCheck(port: number, jobId: string): LeaseHolder | null;
  policyBlocks(resources: ResourceRequest): PolicyBlock[];
}
export interface AdmissionPlan {
  /** Own entries to start now, in order. */
  admit: string[];
  /** Own entries to fail now. */
  fail: Array<{ jobId: string; reason: "dependency-failed" | "queue-timeout"; detail: string }>;
  /** Every queued entry in global order, position 1-based, block reasons empty when admitted. */
  views: QueueEntryView[];
}

/** Step 1: satisfied, still running, or unusable dependencies. */
function inspectDependencies(entry: QueueEntry, job: AdmissionInput["job"]): Outcome {
  const pending: string[] = [], failed: string[] = [], details: string[] = [];
  for (const dependencyId of entry.dependsOn) {
    const dependency = job(dependencyId);
    const state = dependency?.state;
    if (dependency === undefined || state === "failed" || state === "killed" || state === "lost") {
      failed.push(dependencyId);
      details.push(dependency === undefined ? `dependency ${dependencyId} does not exist` : `dependency ${dependencyId} is ${state}`);
    } else if (state === "exited") {
      // A null exit code is unknown, and the contract only fails on a numeric nonzero code.
      if (typeof dependency.exitCode === "number" && dependency.exitCode !== 0) {
        failed.push(dependencyId);
        details.push(`dependency ${dependencyId} exited with code ${dependency.exitCode}`);
      }
    } else {
      pending.push(dependencyId);
    }
  }
  if (failed.length > 0) return { kind: "failed", jobIds: failed, detail: details.join("; ") };
  return pending.length > 0 ? { kind: "pending", jobIds: pending } : { kind: "ok" };
}

/** Step 3: the first failing cap in the contract's order — global, peer, harness. */
function capBlock(entry: QueueEntry, policy: AdmissionPolicy, running: Running): BlockReason | null {
  if (running.total >= policy.maxRunning) {
    return { kind: "cap", cap: "global", limit: policy.maxRunning, running: running.total };
  }
  const forPeer = running.perPeer.get(entry.peer) ?? 0;
  if (forPeer >= policy.maxRunningPerPeer) {
    return { kind: "cap", cap: "peer", limit: policy.maxRunningPerPeer, running: forPeer };
  }
  const limit = policy.harnessLimits[entry.harness] ?? policy.maxRunningPerHarness;
  const forHarness = running.perHarness.get(entry.harness) ?? 0;
  return forHarness >= limit ? { kind: "cap", cap: "harness", limit, running: forHarness } : null;
}

/** The resource kinds an entry asks for, in the contract's order. */
function requestedKinds(resources: ResourceRequest): ResourceKind[] {
  const kinds: ResourceKind[] = [];
  if (resources.gpu === true) kinds.push("gpu");
  if (resources.npu === true) kinds.push("npu");
  if (resources.memoryMb !== undefined) kinds.push("memory");
  return kinds;
}

/** A holder for a port claimed earlier in this pass, using the policy default TTL on the injected clock. */
function inPassHolder(port: number, claimant: QueueEntry, input: AdmissionInput): LeaseHolder {
  return {
    kind: "lease", port, jobId: claimant.jobId, peer: claimant.peer,
    expiresAt: new Date(input.nowMs + input.policy.defaultLeaseTtlMs).toISOString(),
  };
}

/** One deterministic admission pass (contracts 8.3); the input is never modified. */
export function planAdmission(input: AdmissionInput): AdmissionPlan {
  const { nowMs, policy, ownSupervisorPid } = input;
  const running: Running = {
    total: input.running.total,
    perPeer: new Map(input.running.perPeer),
    perHarness: new Map(input.running.perHarness),
  };
  const claimedPorts = new Map<number, QueueEntry>(), starvedKinds = new Map<ResourceKind, string>();
  const admit: string[] = [], fail: AdmissionPlan["fail"] = [], views: QueueEntryView[] = [];

  orderQueue(input.queued, policy, nowMs).forEach((entry, index) => {
    const own = entry.supervisorPid === ownSupervisorPid;
    const blockedBy: BlockReason[] = [];
    const publish = (): void => {
      views.push({ ...entry, position: index + 1, effectivePriority: effectivePriority(entry, policy, nowMs), blockedBy });
    };
    // 1. Dependencies.
    const dependencies = inspectDependencies(entry, input.job);
    if (dependencies.kind !== "ok") {
      blockedBy.push({ kind: "dependency", jobIds: dependencies.jobIds });
      if (dependencies.kind === "failed" && own) {
        fail.push({ jobId: entry.jobId, reason: "dependency-failed", detail: dependencies.detail });
      }
      publish();
      return;
    }
    // 2. Queue timeout. Only own entries can be failed; a timed-out foreign entry cannot be
    // admitted by its supervisor either, so it takes no slot here.
    if (entry.maxQueueMs > 0) {
      const waitedMs = nowMs - Date.parse(entry.enqueuedAt);
      if (waitedMs > entry.maxQueueMs) {
        if (own) {
          const detail = `queued for ${waitedMs} ms, max ${entry.maxQueueMs} ms`;
          fail.push({ jobId: entry.jobId, reason: "queue-timeout", detail });
        }
        publish();
        return;
      }
    }
    // 3. Concurrency caps.
    const cap = capBlock(entry, policy, running);
    if (cap !== null) {
      blockedBy.push(cap);
      publish();
      return;
    }
    // 4. Port leases: a real holder wins over a claim made earlier in this pass.
    for (const port of entry.leasePorts) {
      const holder = input.leaseCheck(port, entry.jobId);
      const claimant = claimedPorts.get(port);
      if (holder !== null) blockedBy.push({ kind: "lease", port, holder });
      else if (claimant !== undefined) blockedBy.push({ kind: "lease", port, holder: inPassHolder(port, claimant, input) });
    }
    if (blockedBy.length > 0) {
      publish();
      return;
    }
    // 5. Resource guards. Only a policy block starves the kinds it asks for.
    const policyBlocks = input.policyBlocks(entry.resources);
    if (policyBlocks.length > 0) {
      for (const block of policyBlocks) {
        blockedBy.push({ kind: "policy", rule: block.rule, measured: block.measured, threshold: block.threshold });
      }
      for (const kind of requestedKinds(entry.resources)) {
        if (!starvedKinds.has(kind)) starvedKinds.set(kind, entry.jobId);
      }
      publish();
      return;
    }
    // 6. Anti-starvation: a higher-ranked policy block holds back the same kind only.
    for (const kind of requestedKinds(entry.resources)) {
      const byJobId = starvedKinds.get(kind);
      if (byJobId !== undefined) {
        blockedBy.push({ kind: "outranked", byJobId });
        break;
      }
    }
    if (blockedBy.length > 0) {
      publish();
      return;
    }
    // 7. Admissible: it runs, whoever supervises it.
    running.total += 1;
    running.perPeer.set(entry.peer, (running.perPeer.get(entry.peer) ?? 0) + 1);
    running.perHarness.set(entry.harness, (running.perHarness.get(entry.harness) ?? 0) + 1);
    for (const port of entry.leasePorts) claimedPorts.set(port, entry);
    if (own) admit.push(entry.jobId);
    publish();
  });
  return { admit, fail, views };
}
