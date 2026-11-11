// The single fleet API for daemons, MCP servers, CLIs and federation listeners (contracts 8.7).
// Output routing, ownership checks and submission defaults live here; surfaces never import the
// runtime, scheduler, queue, leases, policy, event store or index directly.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { audit } from "./audit.js";
import { OutputRingBuffer } from "./capture.js";
import { DEFAULT_SPOOL_MAX_BYTES, EventStore, fleetDir, jobDir } from "./event-store.js";
import { FleetError } from "./fleet-errors.js";
import { harnesses } from "./harnesses.js";
import { JobIndex, toSummary, type JobFilter } from "./job-index.js";
import { LEGAL_TRANSITIONS, isTerminal } from "./job-state.js";
import { JobRuntime, newSessionIdentity, selfSupervisor, writeKillRequest, type SessionIdentity } from "./job-runtime.js";
import { LeaseManager } from "./leases.js";
import { killAgentTree, type spawnContainedAgent } from "./manager.js";
import { assertAllowed, canSee, canSeeCommand, isOwner, type Caller } from "./ownership.js";
import { ResourcePolicyGuard, loadAdmissionPolicy, parseAdmissionPolicy, saveAdmissionPolicy } from "./policy.js";
import { validateDependencies } from "./queue.js";
import { reconcileFleet, withFleetLock } from "./reconcile.js";
import { validateJobId, type ProcessIdentity } from "./registry.js";
import { Scheduler } from "./scheduler.js";
import { ensurePrivateDir } from "./secure-fs.js";
import type {
  AdmissionPolicy, AcceleratorSnapshot, AgentProcessTree, CaptureProvider, EventsPage, EventsQuery, FleetSurface, GuardState, HarnessType, JobEvent,
  JobRecordV2, JobState, JobSummaryV2, KillResult, LeaseHolder, ListenerInfo, OutputPage, OutputQuery, OutputVisibility,
  PortLease, QueueEntryView, ResourceRequest, SpoolMode, StateEvent, TruncationInfo,
} from "./types.js";

export interface SubmitJobRequest {
  jobId?: string; harness?: HarnessType; command: string; args?: string[]; cwd?: string; peer?: string;
  extraEnv?: Record<string, string>; useLemonadeLocal?: boolean; lemonadeUrl?: string; cgroupRoot?: string;
  capture?: boolean; redact?: boolean; ringBytes?: number; spool?: SpoolMode; visibility?: OutputVisibility;
  admission?: "immediate" | "queued"; priority?: number; dependsOn?: string[]; resources?: ResourceRequest;
  leasePorts?: number[]; leaseTtlMs?: number; timeoutMs?: number; maxQueueMs?: number;
}
export interface JobView {
  job: JobSummaryV2; record?: JobRecordV2; queue?: QueueEntryView;
  leases: Array<Omit<PortLease, "leaseId" | "sessionId">>;
  truncation: { stdout: TruncationInfo | null; stderr: TruncationInfo | null };
}
/** Contract fields plus test-only seams; production callers pass only the contract fields. */
export interface FleetOpenOptions {
  surface: FleetSurface; session?: SessionIdentity; trees?: () => AgentProcessTree[];
  spawn?: typeof spawnContainedAgent; capture?: CaptureProvider;
  reconcile?: { snapshot?: () => ProcessIdentity[]; now?: () => Date };
  guard?: { accelerators?: () => AcceleratorSnapshot | undefined; freeMemoryMb?: () => number; now?: () => number };
}

const LIMIT_DEFAULT = 100, LIMIT_MAX = 500, HYDRATED_RING_CACHE = 16, TIME_MAX = 604_800_000;
const JOB_STATES = new Set<JobState>(Object.keys(LEGAL_TRANSITIONS) as JobState[]);
const SUBMIT_FIELDS = new Set("jobId harness command args cwd peer extraEnv useLemonadeLocal lemonadeUrl cgroupRoot capture redact ringBytes spool visibility admission priority dependsOn resources leasePorts leaseTtlMs timeoutMs maxQueueMs".split(" "));

const invalid = (field: string, message: string): FleetError => new FleetError("E_INVALID_REQUEST", message, { field });
function optionalInt(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw invalid(field, `${field} must be an integer between ${min} and ${max}.`);
  return value;
}
function optionalBool(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw invalid(field, `${field} must be a boolean.`);
  return value;
}
function stringList(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw invalid(field, `${field} must be an array of at most ${maxItems} strings.`);
  for (const item of value) if (typeof item !== "string" || item.length > maxLength) throw invalid(field, `${field} items must be strings of at most ${maxLength} characters.`);
  return [...value] as string[];
}
const peerLabel = (value: unknown): string => typeof value === "string" && value.length > 0 && value.length <= 200
  ? value : (() => { throw invalid("peer", "peer must be a string of 1-200 characters."); })();
function resourcesField(value: unknown): ResourceRequest {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("resources", "resources must be an object.");
  const input = value as Record<string, unknown>, resources: ResourceRequest = {};
  for (const key of Object.keys(input)) if (key !== "gpu" && key !== "npu" && key !== "memoryMb") throw invalid("resources", `Unknown resources property: ${key}.`);
  for (const key of ["gpu", "npu"] as const) if (input[key] !== undefined) {
    if (typeof input[key] !== "boolean") throw invalid("resources", `resources.${key} must be a boolean.`);
    resources[key] = input[key] as boolean;
  }
  if (input.memoryMb !== undefined) {
    if (!Number.isInteger(input.memoryMb) || (input.memoryMb as number) < 1 || (input.memoryMb as number) > 1_048_576) throw invalid("resources", "resources.memoryMb must be an integer between 1 and 1048576.");
    resources.memoryMb = input.memoryMb as number;
  }
  return resources;
}
function portsField(value: unknown): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) throw invalid("leasePorts", "leasePorts must be an array of at most 8 integers.");
  const ports: number[] = [], seen = new Set<number>();
  for (const port of value) {
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) throw invalid("leasePorts", "leasePorts must contain integers between 1 and 65535.");
    if (seen.has(port)) throw invalid("leasePorts", "leasePorts must contain distinct ports.");
    seen.add(port); ports.push(port);
  }
  return ports;
}
function envField(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("extraEnv", "extraEnv must be an object of strings.");
  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw invalid("extraEnv", `extraEnv.${key} must be a string.`);
    env[key] = item;
  }
  return env;
}
const isLeaseConflict = (error: unknown): boolean => error instanceof FleetError && error.code === "E_LEASE_CONFLICT";
const leaseHolder = (lease: PortLease): LeaseHolder => ({ kind: "lease", port: lease.port, jobId: lease.jobId, peer: lease.peer, expiresAt: lease.expiresAt });
const conflict = (port: number, holder: LeaseHolder): FleetError =>
  new FleetError("E_LEASE_CONFLICT", `Port ${port} is already ${holder.kind === "lease" ? "leased" : "in use"}`, { holder });
function listenerOf(trees: AgentProcessTree[]): ListenerInfo[] {
  const listeners: ListenerInfo[] = [];
  for (const tree of trees) for (const process of tree.processes) for (const socket of process.listeningSockets ?? []) {
    listeners.push({ pid: process.pid, address: socket.address, port: socket.port, jobId: tree.jobId, peer: tree.userOrPeer });
  }
  return listeners;
}
const actorOf = (caller: Caller): string => caller.kind === "admin" ? "admin" : caller.kind === "peer" ? `peer:${caller.peer.id}` : `session:${caller.session.sessionId}`;
function blankTokenHash(event: JobEvent): JobEvent {
  if (event.type !== "state" || event.record === undefined) return event;
  return { ...event, record: { ...event.record, owner: { ...event.record.owner, tokenHash: "" } } } as StateEvent;
}
function segmentStamp(jobId: string): string {
  const dir = jobDir(jobId);
  const part = (name: string): string => { try { const stat = fs.statSync(path.join(dir, name)); return `${stat.size}:${stat.mtimeMs}`; } catch { return "-"; } };
  return `${part("output.prev.jsonl")}|${part("output.jsonl")}`;
}

interface ServiceDeps {
  surface: FleetSurface; session: SessionIdentity; store: EventStore; index: JobIndex; leases: LeaseManager;
  guard: ResourcePolicyGuard; runtime: JobRuntime; scheduler: Scheduler; trees: () => AgentProcessTree[];
  policy: { current: AdmissionPolicy }; lifecycle: { closed: boolean };
}

/** The one object the daemon, MCP server, CLI and federation listener call (contracts 8.7). */
export class FleetService {
  static async open(options: FleetOpenOptions): Promise<FleetService> {
    ensurePrivateDir(fleetDir());
    const session = options.session ?? newSessionIdentity();
    const store = new EventStore(), index = new JobIndex(store);
    await reconcileFleet(store, index, options.reconcile); // takes the fleet lock itself (D16)
    const trees = options.trees ?? (() => []), listeners = (): ListenerInfo[] => listenerOf(trees());
    const leases = new LeaseManager({ listeners }), policy = { current: loadAdmissionPolicy() };
    const guard = new ResourcePolicyGuard(policy.current, options.guard), lifecycle = { closed: false };
    let scheduler: Scheduler | undefined;
    const runtime = new JobRuntime({
      store, index,
      ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
      ...(options.capture === undefined ? {} : { capture: options.capture }),
      hooks: {
        beforeTerminal: (jobId) => { leases.releaseJob(jobId); },
        afterTerminal: () => { if (scheduler !== undefined && !lifecycle.closed) void scheduler.tick().catch(() => undefined); },
      },
    });
    scheduler = new Scheduler({ runtime, index, leases, guard, policy: () => policy.current, listeners });
    try {
      scheduler.start();
      return new FleetService({ surface: options.surface, session, store, index, leases, guard, runtime, scheduler, trees, policy, lifecycle });
    } catch (error) {
      scheduler.stop(); // a failed open leaves no timer behind
      throw error;
    }
  }

  readonly session: SessionIdentity;
  readonly leases: LeaseManager;
  private readonly deps: ServiceDeps;
  private readonly hydrated = new Map<string, { ring: OutputRingBuffer; stamp: string }>();
  private constructor(deps: ServiceDeps) { this.deps = deps; this.session = deps.session; this.leases = deps.leases; }

  /** Validates, records and either starts the job at once or durably queues it (contracts 8.7). */
  async submit(request: SubmitJobRequest, caller: Caller): Promise<JobSummaryV2> {
    if (this.deps.lifecycle.closed) throw new FleetError("E_INTERNAL", "FleetService is closed.");
    if (typeof request !== "object" || request === null) throw invalid("request", "submit requires an object.");
    for (const key of Object.keys(request)) if (!SUBMIT_FIELDS.has(key)) throw invalid(key, `Unknown submit property: ${key}.`);
    this.deps.index.refresh(); const policy = this.deps.policy.current, jobId = this.jobIdField(request.jobId);
    const harness = request.harness === undefined ? "custom" : request.harness;
    if (typeof harness !== "string" || !harnesses.includes(harness as HarnessType)) throw invalid("harness", `harness must be one of: ${harnesses.join(", ")}.`);
    if (typeof request.command !== "string" || request.command.length === 0 || request.command.length > 4096 || request.command.includes("\0")) {
      throw invalid("command", "command must be a non-empty string of at most 4096 characters with no NUL.");
    }
    const args = stringList(request.args, "args", 256, 32_768), cwd = request.cwd === undefined ? process.cwd() : request.cwd;
    if (typeof cwd !== "string" || cwd.length > 4096) throw invalid("cwd", "cwd must be a string of at most 4096 characters.");
    try { if (!fs.statSync(cwd).isDirectory()) throw new Error("not a directory"); }
    catch { throw invalid("cwd", `cwd is not an existing directory: ${cwd}`); }
    const peer = this.peerField(request.peer, caller), capture = optionalBool(request.capture, "capture", true);
    const redact = optionalBool(request.redact, "redact", true), ringBytes = optionalInt(request.ringBytes, "ringBytes", 65_536, 16_777_216, 1_048_576);
    const spool = request.spool === undefined ? "tail" : request.spool;
    if (spool !== "tail" && spool !== "full" && spool !== "off") throw invalid("spool", 'spool must be "tail", "full" or "off".');
    const visibility = request.visibility === undefined ? "owner" : request.visibility;
    if (visibility !== "owner" && visibility !== "peer" && visibility !== "all") throw invalid("visibility", 'visibility must be "owner", "peer" or "all".');
    if (request.admission !== undefined && request.admission !== "immediate" && request.admission !== "queued") throw invalid("admission", 'admission must be "immediate" or "queued".');
    const hint = request.priority !== undefined || request.dependsOn !== undefined || request.leasePorts !== undefined ||
      request.resources !== undefined || request.maxQueueMs !== undefined;
    const admission = request.admission ?? (hint ? "queued" : "immediate");
    const priority = optionalInt(request.priority, "priority", -100, 100, 0), dependsOn = stringList(request.dependsOn, "dependsOn", 16, 80);
    for (const id of dependsOn) { try { validateJobId(id); } catch { throw invalid("dependsOn", `dependsOn contains an invalid job ID: ${id}`); } }
    const resources = resourcesField(request.resources), leasePorts = portsField(request.leasePorts);
    const leaseTtlMs = optionalInt(request.leaseTtlMs, "leaseTtlMs", 10_000, 86_400_000, policy.defaultLeaseTtlMs);
    const timeoutMs = optionalInt(request.timeoutMs, "timeoutMs", 0, TIME_MAX, 0), maxQueueMs = optionalInt(request.maxQueueMs, "maxQueueMs", 0, TIME_MAX, 0);
    const extraEnv = envField(request.extraEnv), useLemonadeLocal = optionalBool(request.useLemonadeLocal, "useLemonadeLocal", false);
    const lemonadeUrl = request.lemonadeUrl, cgroupRoot = request.cgroupRoot;
    if (lemonadeUrl !== undefined && (typeof lemonadeUrl !== "string" || lemonadeUrl.length > 2048)) throw invalid("lemonadeUrl", "lemonadeUrl must be a string of at most 2048 characters.");
    if (cgroupRoot !== undefined && (typeof cgroupRoot !== "string" || cgroupRoot.length > 4096)) throw invalid("cgroupRoot", "cgroupRoot must be a string of at most 4096 characters.");
    if (caller.kind === "peer" && (!redact || request.extraEnv !== undefined || request.cgroupRoot !== undefined)) {
      throw invalid(!redact ? "redact" : request.extraEnv !== undefined ? "extraEnv" : "cgroupRoot", "peer submissions may not disable redaction or set extraEnv or cgroupRoot.");
    }
    validateDependencies(jobId, dependsOn, (id) => { const found = this.deps.index.get(id); return found === undefined ? undefined : { dependsOn: found.queue.dependsOn }; });
    const existing = this.deps.index.get(jobId);
    if (existing !== undefined && !isTerminal(existing.state)) throw new FleetError("E_JOB_EXISTS", `Job ${jobId} already exists.`);
    if (admission === "queued" && this.deps.index.queued().length >= policy.maxQueued) throw new FleetError("E_QUEUE_FULL", `Queue is full (max ${policy.maxQueued}).`);
    const owner = caller.kind === "peer"
      ? { sessionId: `peer:${caller.peer.id}`, tokenHash: "", surface: "remote" as const, remotePeerId: caller.peer.id }
      : { sessionId: (caller.kind === "session" ? caller.session : this.session).sessionId, tokenHash: (caller.kind === "session" ? caller.session : this.session).tokenHash, surface: this.deps.surface };
    const record: JobRecordV2 = {
      version: 2, jobId, state: "queued", stateReason: "submitted", harness: harness as HarnessType, command: request.command,
      args, cwd, peer, backend: "unknown", owner, visibility, supervisor: selfSupervisor(this.deps.surface), containment: null,
      capture: { kind: capture ? "pipe" : "none", ringBytes: capture ? ringBytes : 0, spool: capture ? spool : "off", spoolMaxBytes: capture ? DEFAULT_SPOOL_MAX_BYTES : 0, redact },
      queue: { admission, priority, dependsOn, resources, leasePorts, leaseTtlMs, timeoutMs, maxQueueMs },
      envKeys: Object.keys(extraEnv), createdAt: new Date().toISOString(), startedAt: null, exitedAt: null,
      exitCode: null, signal: null, lastSeq: 0, outputBytes: { stdout: 0, stderr: 0 }, error: null,
    };
    const env = { extraEnv, useLemonadeLocal, ...(lemonadeUrl === "" ? {} : { lemonadeUrl }), ...(cgroupRoot === "" ? {} : { cgroupRoot }) };
    const auditRedaction = (): void => { if (!redact) audit({ event: "redact-disabled", actor: actorOf(caller), jobId }); };
    const enqueue = (): void => {
      try { this.deps.runtime.enqueue(record, env); }
      catch (error) { if (existing !== undefined) throw new FleetError("E_JOB_EXISTS", `Job ${jobId} already exists.`); throw error; }
    };
    if (admission === "queued") {
      auditRedaction(); enqueue();
      const queued = this.deps.index.get(jobId) ?? record; // durable "queued", before any admission pass
      void this.deps.scheduler.tick().catch(() => undefined);
      return this.summary(queued, caller);
    }
    let startPromise: Promise<JobRecordV2> | undefined;
    await withFleetLock(async () => {
      for (const port of leasePorts) { const holder = this.deps.leases.check(port, jobId); if (holder !== null) throw conflict(port, holder); }
      auditRedaction(); enqueue();
      try {
        for (const port of leasePorts) {
          const lease = this.deps.leases.acquire({ port, jobId, peer, sessionId: record.owner.sessionId, holder: record.supervisor, ttlMs: leaseTtlMs });
          this.deps.runtime.appendLease(jobId, { action: "acquired", port, expiresAt: lease.expiresAt, holder: leaseHolder(lease) });
        }
      } catch (error) {
        this.deps.leases.releaseJob(jobId);
        if (isLeaseConflict(error)) await this.deps.runtime.kill(jobId, "cancelled", "lease conflict after check");
        throw error;
      }
      // D26/L8: start() writes "starting" synchronously and spawns one macrotask later; nothing
      // awaits after it here, so withFleetLock releases before any process exists.
      startPromise = this.deps.runtime.start(jobId);
    });
    if (startPromise === undefined) throw new FleetError("E_INTERNAL", "Job was not started.");
    try { await startPromise; } catch (error) {
      this.deps.leases.releaseJob(jobId); // idempotent; beforeTerminal normally released them already
      throw error;
    }
    return this.summary(this.deps.index.get(jobId) ?? record, caller);
  }

  list(filter: JobFilter & { limit?: number; after?: string }, caller: Caller): { jobs: JobSummaryV2[]; nextAfter: string | null } {
    this.deps.index.refresh(); const query: JobFilter & { limit?: number; after?: string } = filter ?? {};
    if (query.states !== undefined && (!Array.isArray(query.states) || query.states.some((state) => !JOB_STATES.has(state)))) throw invalid("states", "states must contain job states.");
    for (const field of ["peer", "harness", "ownerSessionId", "after"] as const) if (query[field] !== undefined && typeof query[field] !== "string") throw invalid(field, `${field} must be a string.`);
    const limit = optionalInt(query.limit, "limit", 1, LIMIT_MAX, LIMIT_DEFAULT);
    const visible = this.deps.index.list({ states: query.states, peer: query.peer, harness: query.harness, ownerSessionId: query.ownerSessionId })
      .filter((record) => canSee(record, caller));
    let start = 0;
    if (query.after !== undefined) { const at = visible.findIndex((record) => record.jobId === query.after); if (at >= 0) start = at + 1; }
    const page = visible.slice(start, start + limit), nextAfter = start + limit < visible.length ? page[page.length - 1]!.jobId : null;
    return { jobs: page.map((record) => this.summary(record, caller)), nextAfter };
  }

  get(jobId: string, caller: Caller): JobView {
    const record = this.record(jobId);
    assertAllowed("read", record, caller);
    const view: JobView = { job: this.summary(record, caller), leases: this.leasesOf(jobId), truncation: this.truncationOf(record) };
    if (canSeeCommand(record, caller)) view.record = record;
    if (record.state === "queued") { const queue = this.deps.scheduler.view().find((entry) => entry.jobId === jobId); if (queue !== undefined) view.queue = queue; }
    return view;
  }

  output(jobId: string, query: OutputQuery, caller: Caller): OutputPage {
    const record = this.record(jobId);
    assertAllowed("output", record, caller);
    if (record.capture.kind === "none") throw new FleetError("E_CAPTURE_DISABLED", "this job was started without output capture.");
    let ring: OutputRingBuffer, source: "memory" | "spool";
    const live = this.deps.runtime.ring(jobId);
    if (live !== undefined) { ring = live; source = "memory"; }
    else if (this.deps.runtime.supervises(jobId)) { ring = new OutputRingBuffer({ capBytes: record.capture.ringBytes }); source = "memory"; }
    else {
      if (record.capture.spool === "off") throw new FleetError("E_OUTPUT_UNAVAILABLE", "the supervisor for this job is gone and its spool is off.");
      ring = this.hydratedRing(record); source = "spool";
    }
    const page = ring.read(query), totals = ring.totalBytes;
    return {
      jobId, state: record.state, exitCode: record.exitCode, stream: query.stream ?? "both", since: query.since ?? 0,
      nextSince: page.nextSince, lastSeq: Math.max(record.lastSeq, ring.lastSeq), hasMore: page.hasMore, source,
      outputBytes: { stdout: Math.max(record.outputBytes.stdout, totals.stdout), stderr: Math.max(record.outputBytes.stderr, totals.stderr) },
      truncation: { stdout: ring.truncation("stdout"), stderr: ring.truncation("stderr") }, chunks: page.chunks,
    };
  }

  events(jobId: string, query: EventsQuery, caller: Caller): EventsPage {
    const record = this.record(jobId);
    assertAllowed("events", record, caller);
    if (record.capture.kind === "none") throw new FleetError("E_CAPTURE_DISABLED", "this job was started without output capture.");
    const page = this.deps.store.readEvents(jobId, query);
    return { ...page, events: page.events.map(blankTokenHash) };
  }

  async kill(jobId: string, caller: Caller, detail?: string): Promise<{ job: JobSummaryV2; result: KillResult | null }> {
    const record = this.record(jobId);
    assertAllowed("kill", record, caller);
    const text = detail?.slice(0, 500);
    if (caller.kind === "admin") audit({ event: "admin-kill", actor: "admin", jobId, ...(text === undefined ? {} : { detail: text }) });
    if (isTerminal(record.state)) return { job: this.summary(record, caller), result: null };
    let result: KillResult | null = null;
    if (this.deps.runtime.supervises(jobId)) result = await this.deps.runtime.kill(jobId, "kill-requested", text);
    else {
      writeKillRequest(jobId, { by: actorOf(caller), reason: "kill-requested", at: new Date().toISOString(), ...(text === undefined ? {} : { detail: text }) });
      if (record.state === "starting" || record.state === "running" || record.state === "exiting") {
        // A foreign job still starting may not have a process tree yet; the marker already makes its
        // supervisor record killed, so "not found" there is not an error.
        try { result = await killAgentTree(jobId); } catch (error) { if (record.state !== "starting") throw error; }
      }
    }
    this.deps.index.refresh();
    return { job: this.summary(this.deps.index.get(jobId) ?? record, caller), result };
  }

  async wait(jobId: string, timeoutMs: number): Promise<{ exited: boolean; timedOut?: true; state: JobState; exitCode: number | null }> {
    const initial = this.record(jobId), budget = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0, deadline = Date.now() + budget;
    for (;;) {
      const record = this.deps.index.get(jobId) ?? initial;
      if (isTerminal(record.state)) return { exited: true, state: record.state, exitCode: record.exitCode };
      if (Date.now() >= deadline) return { exited: false, timedOut: true, state: record.state, exitCode: record.exitCode };
      this.deps.index.refresh();
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))); timer.unref(); });
    }
  }

  queue(): { entries: QueueEntryView[]; guards: GuardState[]; policy: AdmissionPolicy } {
    return { entries: this.deps.scheduler.view(), guards: this.deps.guard.state(), policy: this.deps.policy.current };
  }
  setPolicy(policy: AdmissionPolicy): void {
    const validated = parseAdmissionPolicy(policy);
    saveAdmissionPolicy(validated);
    this.deps.guard.setPolicy(validated);
    this.deps.policy.current = validated;
    audit({ event: "policy-changed", actor: "admin" });
  }
  /** Stops the timer and terminates only the jobs this process supervises (contracts 8.7). */
  async close(): Promise<void> {
    if (this.deps.lifecycle.closed) return;
    this.deps.lifecycle.closed = true;
    this.deps.scheduler.stop();
    // shutdown() also cancels own queued jobs, and start() refuses a job that is no longer queued,
    // so an admission pass still in flight cannot start anything after this; submit() refuses too.
    await this.deps.runtime.shutdown();
    this.hydrated.clear();
  }

  private record(jobId: string): JobRecordV2 {
    this.deps.index.refresh();
    const record = this.deps.index.get(jobId); if (record === undefined) throw new FleetError("E_JOB_NOT_FOUND", `No job named ${jobId}.`);
    return record;
  }
  private summary(record: JobRecordV2, caller: Caller): JobSummaryV2 {
    return toSummary(record, { owned: isOwner(record, caller), showCommand: canSeeCommand(record, caller) });
  }
  private leasesOf(jobId: string): Array<Omit<PortLease, "leaseId" | "sessionId">> {
    return this.leases.list().filter((lease) => lease.jobId === jobId)
      .map((lease) => { const { leaseId: _leaseId, sessionId: _sessionId, ...rest } = lease; return rest; });
  }
  private truncationOf(record: JobRecordV2): { stdout: TruncationInfo | null; stderr: TruncationInfo | null } {
    const ring = record.capture.kind === "none" ? undefined : this.deps.runtime.ring(record.jobId)
      ?? (record.capture.spool === "off" ? undefined : this.hydratedRing(record));
    return { stdout: ring?.truncation("stdout") ?? null, stderr: ring?.truncation("stderr") ?? null };
  }
  /** LRU of 16 hydrated rings, refreshed when either spool segment's size or mtime changes. */
  private hydratedRing(record: JobRecordV2): OutputRingBuffer {
    const jobId = record.jobId, stamp = segmentStamp(jobId), cached = this.hydrated.get(jobId);
    if (cached !== undefined && cached.stamp === stamp) { this.hydrated.delete(jobId); this.hydrated.set(jobId, cached); return cached.ring; }
    const ring = new OutputRingBuffer({ capBytes: record.capture.ringBytes > 0 ? record.capture.ringBytes : undefined });
    ring.hydrate(this.deps.store.readOutput(jobId));
    this.hydrated.delete(jobId); this.hydrated.set(jobId, { ring, stamp });
    if (this.hydrated.size > HYDRATED_RING_CACHE) { const oldest = this.hydrated.keys().next().value; if (oldest !== undefined) this.hydrated.delete(oldest); }
    return ring;
  }
  private jobIdField(value: unknown): string {
    if (value === undefined) return randomUUID();
    if (typeof value !== "string") throw invalid("jobId", "jobId must be a string.");
    try { validateJobId(value); } catch { throw invalid("jobId", "jobId must contain 1-80 letters, digits, underscores, or hyphens."); }
    return value;
  }
  private peerField(value: unknown, caller: Caller): string {
    if (caller.kind === "peer") {
      const forced = `peer:${caller.peer.id}`;
      if (value !== undefined && (typeof value !== "string" || value.length > 200)) throw invalid("peer", "peer must be a string of at most 200 characters.");
      return typeof value === "string" && value.startsWith(forced) ? value : forced;
    }
    return value === undefined ? (caller.kind === "session" ? peerLabel(caller.peer) : peerLabel(os.userInfo().username)) : peerLabel(value);
  }
}
