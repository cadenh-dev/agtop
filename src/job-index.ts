import * as fs from "node:fs";
import * as path from "node:path";
import type { EventStore } from "./event-store.js";
import { RUNNING_STATES } from "./job-state.js";
import { readJobs } from "./registry.js";
import { isStaleJob, processSnapshot, type ProcessIdentity } from "./registry.js";
import type { CaptureSpec, JobContainment, JobEvent, JobOwner, JobRecord, JobRecordV2, JobState, JobSummaryV2, QueueSpec, SupervisorIdentity } from "./types.js";

/** Folds lifecycle events into a record. Returns undefined when seq 1 is missing or carries no record. */
export function foldEvents(events: JobEvent[]): JobRecordV2 | undefined {
  const first = events[0];
  if (first === undefined || first.seq !== 1 || first.type !== "state" || first.state !== "queued" || first.record === undefined) return undefined;
  // Start from a copy of the submission record: a fold never mutates its input events.
  let record: JobRecordV2 = { ...first.record }, highestSeq = 0, highestPatchLastSeq = 0;
  for (const event of events) {
    highestSeq = Math.max(highestSeq, event.seq);
    if (event.type !== "state" || event === first) continue;
    record = { ...record, state: event.state, stateReason: event.reason };
    if (event.patch !== undefined) {
      Object.assign(record, event.patch);
      highestPatchLastSeq = Math.max(highestPatchLastSeq, event.patch.lastSeq ?? 0);
    }
  }
  record.lastSeq = Math.max(record.lastSeq, highestSeq, highestPatchLastSeq);
  return record;
}

/** Read-only view of a v1 record as a fleet record (contracts 2.2). Never written to disk. */
export function migrateV1Record(v1: JobRecord): JobRecordV2 {
  const containment: JobContainment = { mode: v1.mode, rootPid: v1.rootPid, startTime: v1.startTime };
  if (v1.jobName !== undefined) containment.jobName = v1.jobName;
  if (v1.cgroupPath !== undefined) containment.cgroupPath = v1.cgroupPath;
  const owner: JobOwner = { sessionId: "v1", tokenHash: "", surface: "library" };
  const supervisor: SupervisorIdentity = { pid: 0, startTime: "", surface: "library" };
  const capture: CaptureSpec = { kind: "none", ringBytes: 0, spool: "off", spoolMaxBytes: 0, redact: true };
  const queue: QueueSpec = { admission: "immediate", priority: 0, dependsOn: [], resources: {}, leasePorts: [], leaseTtlMs: 0, timeoutMs: 0, maxQueueMs: 0 };
  return {
    version: 2, jobId: v1.jobId, state: "running", stateReason: "spawned", harness: v1.harness, command: "", args: [], cwd: v1.cwd,
    peer: v1.peer, backend: v1.backend, owner, visibility: "owner", supervisor, containment, capture, queue,
    envKeys: [], createdAt: v1.createdAt, startedAt: v1.createdAt, exitedAt: null, exitCode: null, signal: null,
    lastSeq: 0, outputBytes: { stdout: 0, stderr: 0 }, error: null,
  };
}

/** Maps a record to the list representation (contracts 2.1). command, args and cwd are opt-in. */
export function toSummary(record: JobRecordV2, caller: { owned: boolean; showCommand: boolean }): JobSummaryV2 {
  const summary: JobSummaryV2 = {
    jobId: record.jobId, state: record.state, stateReason: record.stateReason, harness: record.harness, peer: record.peer,
    owned: caller.owned, ownerSessionId: record.owner.sessionId, surface: record.owner.surface, visibility: record.visibility,
    rootPid: record.containment === null ? null : record.containment.rootPid,
    containmentMode: record.containment === null ? null : record.containment.mode,
    createdAt: record.createdAt, startedAt: record.startedAt, exitedAt: record.exitedAt, exitCode: record.exitCode,
    captured: record.capture.kind !== "none", lastSeq: record.lastSeq, outputBytes: { ...record.outputBytes },
    priority: record.queue.priority, leasePorts: [...record.queue.leasePorts],
  };
  if (caller.showCommand) { summary.command = record.command; summary.args = [...record.args]; summary.cwd = record.cwd; }
  return summary;
}

export interface JobFilter { states?: JobState[]; peer?: string; harness?: string; ownerSessionId?: string }
export interface IndexRebuildStats { jobs: number; events: number; corruptTailBytes: number; durationMs: number }

function eventsFile(store: EventStore, jobId: string): string {
  return path.join(store.stateRoot, "fleet", "jobs", jobId, "events.jsonl");
}
/** File size, or -1 when the log does not exist yet. */
function logSize(file: string): number {
  try { return fs.statSync(file).size; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return -1; throw error; }
}

/**
 * In-memory index over fleet job event logs plus migrated v1 records (contracts 5).
 * Never scans the OS process table and never writes anything.
 */
export class JobIndex {
  private readonly store: EventStore;
  private readonly readV1: () => JobRecord[];
  private readonly takeSnapshot: () => ProcessIdentity[];
  private snapshotCache?: { at: number; value?: ProcessIdentity[] };
  private readonly sizes = new Map<string, number>();
  private readonly fleet = new Map<string, JobRecordV2>();
  private readonly v1 = new Map<string, JobRecordV2>();

  constructor(store: EventStore, options?: { readV1?: () => JobRecord[]; snapshot?: () => ProcessIdentity[] }) {
    this.store = store; this.readV1 = options?.readV1 ?? readJobs; this.takeSnapshot = options?.snapshot ?? processSnapshot;
  }

  rebuild(): IndexRebuildStats {
    const startedAt = Date.now();
    this.fleet.clear(); this.sizes.clear();
    let events = 0, corruptTailBytes = 0;
    for (const jobId of this.store.listJobIds()) {
      const size = logSize(eventsFile(this.store, jobId)), read = this.store.readAllEvents(jobId);
      events += read.events.length; corruptTailBytes += read.corruptTailBytes; this.sizes.set(jobId, size);
      const record = foldEvents(read.events);
      if (record !== undefined) this.fleet.set(jobId, record);
    }
    this.reloadV1();
    return { jobs: this.fleet.size, events, corruptTailBytes, durationMs: Date.now() - startedAt };
  }

  /** Re-reads events.jsonl of jobs whose file size changed, discovers new job directories, drops removed ones. */
  refresh(): void {
    const ids = new Set(this.store.listJobIds());
    for (const jobId of ids) {
      const size = logSize(eventsFile(this.store, jobId));
      // Unchanged size: skip, including directories that had no valid seq 1 last time.
      if (this.sizes.get(jobId) === size) continue;
      const read = this.store.readAllEvents(jobId);
      this.sizes.set(jobId, size);
      const record = foldEvents(read.events);
      if (record === undefined) this.fleet.delete(jobId); else this.fleet.set(jobId, record);
    }
    for (const jobId of [...this.fleet.keys()]) if (!ids.has(jobId)) { this.fleet.delete(jobId); this.sizes.delete(jobId); }
    for (const jobId of [...this.sizes.keys()]) if (!ids.has(jobId)) this.sizes.delete(jobId);
    this.reloadV1();
  }

  /** Called by the local supervisor after each lifecycle append, so local state never waits for refresh(). */
  apply(event: JobEvent): void {
    const existing = this.fleet.get(event.jobId);
    if (event.type === "state") {
      if (event.record !== undefined && event.seq === 1) {
        const record = { ...event.record };
        if (event.patch !== undefined) Object.assign(record, event.patch);
        record.lastSeq = Math.max(record.lastSeq, event.seq, event.patch?.lastSeq ?? 0);
        this.fleet.set(event.jobId, record); this.v1.delete(event.jobId);
        return;
      }
      if (existing === undefined) return;
      const previousLastSeq = existing.lastSeq; // the patch may carry an older lastSeq
      existing.state = event.state; existing.stateReason = event.reason;
      if (event.patch !== undefined) Object.assign(existing, event.patch);
      existing.lastSeq = Math.max(previousLastSeq, event.seq, event.patch?.lastSeq ?? 0);
      return;
    }
    if (existing !== undefined) existing.lastSeq = Math.max(existing.lastSeq, event.seq);
  }

  get(jobId: string): JobRecordV2 | undefined { return this.fleet.get(jobId) ?? this.v1.get(jobId); }

  /** createdAt descending, then jobId ascending (contracts 5). */
  list(filter?: JobFilter): JobRecordV2[] {
    let records = this.snapshot();
    if (filter !== undefined) records = records.filter((record) =>
      (filter.states === undefined || filter.states.includes(record.state)) &&
      (filter.peer === undefined || record.peer === filter.peer) &&
      (filter.harness === undefined || record.harness === filter.harness) &&
      (filter.ownerSessionId === undefined || record.owner.sessionId === filter.ownerSessionId));
    records.sort((a, b) => a.createdAt !== b.createdAt ? (a.createdAt < b.createdAt ? 1 : -1) : a.jobId === b.jobId ? 0 : a.jobId < b.jobId ? -1 : 1);
    return records;
  }

  queued(): JobRecordV2[] { return this.list({ states: ["queued"] }); }

  runningCounts(): { total: number; perPeer: Map<string, number>; perHarness: Map<string, number> } {
    const perPeer = new Map<string, number>(), perHarness = new Map<string, number>();
    let total = 0;
    for (const record of this.snapshot()) {
      if (!RUNNING_STATES.has(record.state)) continue;
      total++;
      perPeer.set(record.peer, (perPeer.get(record.peer) ?? 0) + 1);
      perHarness.set(record.harness, (perHarness.get(record.harness) ?? 0) + 1);
    }
    return { total, perPeer, perHarness };
  }

  /** Fleet records shadow migrated v1 records with the same ID (contracts 2.2). */
  private snapshot(): JobRecordV2[] {
    const merged = new Map<string, JobRecordV2>(this.v1);
    for (const [jobId, record] of this.fleet) merged.set(jobId, record);
    return [...merged.values()];
  }

  private reloadV1(): void {
    this.v1.clear();
    const records = this.readV1().filter((record) => !this.fleet.has(record.jobId));
    if (records.length === 0) return;
    let snapshot = this.snapshotCache;
    if (snapshot === undefined || performance.now() - snapshot.at >= 5000) {
      try { snapshot = { at: performance.now(), value: this.takeSnapshot() }; }
      catch { snapshot = { at: performance.now() }; }
      this.snapshotCache = snapshot;
    }
    for (const record of records) {
      if (snapshot.value !== undefined && isStaleJob(record, snapshot.value)) continue;
      this.v1.set(record.jobId, migrateV1Record(record));
    }
  }
}
