import { randomUUID } from "node:crypto";
import fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fleetDir, type EventStore, type StoredOutput } from "./event-store.js";
import { FleetError } from "./fleet-errors.js";
import { foldEvents, type IndexRebuildStats, type JobIndex } from "./job-index.js";
import { isTerminal, RUNNING_STATES } from "./job-state.js";
import { killAgentTree } from "./manager.js";
import { isStaleJob, processSnapshot, readJobs, stateDir, type ProcessIdentity } from "./registry.js";
import { createPrivateFileExclusive, ensurePrivateDir } from "./secure-fs.js";
import type { JobRecord, JobRecordV2, OutputCounters, StateEvent, SupervisorIdentity } from "./types.js";

/** Retention (contracts 3): 72 h default (env override, 0 disables); at most 200 terminal jobs. */
export const RETENTION_HOURS = 72, RETENTION_MAX_JOBS = 200;
const LOCK_RETRY_MS = 10, LOCK_STALE_MS = 500, LOCK_TIMEOUT_MS = 5000;

export interface ReconcileStats extends IndexRebuildStats { lost: string[]; repaired: string[]; pruned: string[]; killedPids: number[] }

/** Lock file contents: a SupervisorIdentity without its surface. */
interface LockHolder { pid: number; startTime: string }
/** This process's { pid, startTime }, computed once, lazily, before any acquisition (D14c). */
let selfLockIdentity: LockHolder | undefined;
function ownLockIdentity(): LockHolder {
  if (selfLockIdentity !== undefined) return selfLockIdentity;
  try {
    const entry = processSnapshot().find((item) => item.pid === process.pid);
    if (entry !== undefined) selfLockIdentity = { pid: entry.pid, startTime: entry.startTime };
  } catch { /* Retry on the next call; "" still serializes this process. */ }
  return selfLockIdentity ?? { pid: process.pid, startTime: "" };
}
function rememberSelf(snapshot: ProcessIdentity[]): void {
  if (selfLockIdentity !== undefined) return;
  const entry = snapshot.find((item) => item.pid === process.pid);
  if (entry !== undefined) selfLockIdentity = { pid: entry.pid, startTime: entry.startTime };
}
function parseLockHolder(raw: string): SupervisorIdentity | undefined {
  try {
    const value = JSON.parse(raw) as Partial<LockHolder>;
    if (typeof value.pid === "number" && Number.isSafeInteger(value.pid) && typeof value.startTime === "string") return { pid: value.pid, startTime: value.startTime, surface: "library" };
  } catch { /* Unparseable contents are stale once the file is older than LOCK_STALE_MS. */ }
  return undefined;
}
function readLockRaw(lockPath: string): string | undefined { try { return fs.readFileSync(lockPath, "utf8"); } catch { return undefined; } }
/**
 * Removes a stale lock only if it still holds `raw`. Read-then-delete would let a slower waiter
 * delete a lock another waiter just created, so the file is first renamed aside (only one
 * process can move it), checked, and put back with link() (which never overwrites) if it is
 * someone's fresh lock.
 */
function deleteIfUnchanged(lockPath: string, raw: string): boolean {
  const aside = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
  try { fs.renameSync(lockPath, aside); } catch { return false; }
  try {
    if (fs.readFileSync(aside, "utf8") === raw) return true;
    try { fs.linkSync(aside, lockPath); } catch { /* A newer lock already exists; nothing to restore. */ }
    return false;
  } catch { return false; } finally { fs.rmSync(aside, { force: true }); }
}

/**
 * Runs fn while holding the fleet lock (contracts 8.5, D14a). A waiter takes at most one
 * liveness snapshot per call, only after 500 ms on the same holder. Not re-entrant.
 */
export function withFleetLock<T>(fn: () => T | Promise<T>, options?: { timeoutMs?: number }): Promise<T> {
  return runWithFleetLock(fn, options?.timeoutMs ?? LOCK_TIMEOUT_MS);
}
async function runWithFleetLock<T>(fn: () => T | Promise<T>, timeoutMs: number): Promise<T> {
  ensurePrivateDir(fleetDir());
  const lockPath = path.join(fleetDir(), "lock"), self = ownLockIdentity(), deadline = Date.now() + timeoutMs;
  let holderRaw: string | undefined, holderSince = 0, snapshotTaken = false, snapshot: ProcessIdentity[] | undefined, snapshotFor: string | undefined;
  for (;;) {
    if (createPrivateFileExclusive(lockPath, JSON.stringify(self))) break;
    const raw = readLockRaw(lockPath), holder = raw === undefined ? undefined : parseLockHolder(raw), observedAt = Date.now();
    if (raw !== holderRaw) { holderRaw = raw; holderSince = observedAt; }
    let deleted = false, ageMs = raw === undefined ? undefined : ((): number | undefined => { try { return observedAt - fs.statSync(lockPath).mtimeMs; } catch { return undefined; } })();
    if (raw !== undefined && holder === undefined) {
      if (ageMs !== undefined && ageMs >= LOCK_STALE_MS) deleted = deleteIfUnchanged(lockPath, raw);
    } else if (holder !== undefined && observedAt - holderSince >= LOCK_STALE_MS) {
      if (!snapshotTaken) { // One snapshot per call, for this holder; a failure means alive.
        snapshotTaken = true; snapshotFor = raw;
        try { snapshot = processSnapshot(); } catch { snapshot = undefined; }
      }
      if (snapshot !== undefined && snapshotFor === raw && raw !== undefined && !supervisorAlive(holder, snapshot)) deleted = deleteIfUnchanged(lockPath, raw);
    }
    if (Date.now() >= deadline) throw new FleetError("E_INTERNAL", "Fleet lock timeout");
    if (!deleted) await delay(LOCK_RETRY_MS);
  }
  try {
    return await fn();
  } finally {
    const raw = readLockRaw(lockPath), holder = raw === undefined ? undefined : parseLockHolder(raw);
    if (holder !== undefined && holder.pid === self.pid && holder.startTime === self.startTime) {
      try { fs.rmSync(lockPath, { force: true }); } catch { /* The next waiter treats it as stale. */ }
    }
  }
}

/** Snapshot contains this supervisor's pid and start time; `{ pid: 0 }` is never alive. */
export function supervisorAlive(id: SupervisorIdentity, snapshot?: ProcessIdentity[]): boolean {
  if (!(id.pid > 0)) return false;
  let processes = snapshot;
  if (processes === undefined) { try { processes = processSnapshot(); } catch { return true; } }
  return processes.some((process) => process.pid === id.pid && process.startTime === id.startTime);
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
/** Per-stream last chunk offset + length, or the record's counter when it is larger. */
function outputCounters(record: JobRecordV2, stored: StoredOutput): OutputCounters {
  const counters: OutputCounters = { ...record.outputBytes };
  for (const chunk of stored.chunks) counters[chunk.stream] = Math.max(counters[chunk.stream], chunk.offset + chunk.data.length);
  return counters;
}
/** Deletes every fleet lease file naming this job (contracts 4 step 5.4; never imports leases.ts). */
function releaseJobLeases(jobId: string): void {
  const dir = path.join(fleetDir(), "leases");
  let names: string[];
  try { names = fs.readdirSync(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    try { if ((JSON.parse(fs.readFileSync(file, "utf8")) as { jobId?: unknown }).jobId === jobId) fs.rmSync(file, { force: true }); }
    catch { /* A torn or foreign lease file is not a reconciler concern. */ }
  }
}
function retentionHours(): number {
  const raw = process.env.AGTOP_FLEET_RETENTION_HOURS;
  if (raw === undefined || raw.trim() === "") return RETENTION_HOURS;
  const value = Number(raw); return Number.isFinite(value) && value >= 0 ? value : RETENTION_HOURS;
}
function pruneJobDirs(store: EventStore, records: Iterable<JobRecordV2>, nowMs: number, rename: typeof fs.renameSync = fs.renameSync): string[] {
  const list = [...records], protectedIds = new Set<string>(), pruned: string[] = [];
  for (const record of list) if (record.state === "queued") for (const dependency of record.queue.dependsOn) protectedIds.add(dependency);
  const remove = (record: JobRecordV2): boolean => {
    if (protectedIds.has(record.jobId)) return false;
    const companion = path.join(stateDir(), `${record.jobId}.json`);
    let v1: JobRecord | undefined, raw: Buffer | undefined;
    try { raw = fs.readFileSync(companion); v1 = JSON.parse(raw.toString("utf8")) as JobRecord; } catch { /* Missing, unreadable, or unparsable companions are left alone. */ }
    if (v1?.version === 1 && v1.jobId === record.jobId && record.containment !== null &&
      v1.rootPid === record.containment.rootPid && v1.startTime === record.containment.startTime) {
      const aside = `${companion}.retention.${process.pid}.${randomUUID()}`;
      try {
        rename(companion, aside);
        const moved = fs.readFileSync(aside);
        if (!moved.equals(raw!)) {
          try { fs.linkSync(aside, companion); } catch { /* A newer record already occupies the path. */ }
          fs.rmSync(aside, { force: true });
        } else fs.rmSync(aside, { force: true, maxRetries: 3, retryDelay: 100 });
      }
      catch (error) {
        process.stderr.write(`agtop: fleet retention could not remove v1 companion ${record.jobId}: ${message(error)}\n`);
        try { if (fs.existsSync(aside) && !fs.existsSync(companion)) fs.linkSync(aside, companion); } catch { /* Preserve whichever record remains reachable. */ }
        try { fs.rmSync(aside, { force: true }); } catch { /* Best effort cleanup. */ }
        return false;
      }
    }
    store.remove(record.jobId);
    pruned.push(record.jobId);
    return true;
  };
  const hours = retentionHours(), remaining: JobRecordV2[] = [];
  for (const record of list) {
    if (!isTerminal(record.state)) continue;
    const exitedMs = record.exitedAt === null ? Number.NaN : Date.parse(record.exitedAt);
    if (hours > 0 && Number.isFinite(exitedMs) && exitedMs < nowMs - hours * 3_600_000) remove(record); else remaining.push(record);
  }
  if (remaining.length > RETENTION_MAX_JOBS) {
    const exitedAtMs = (record: JobRecordV2): number => { const parsed = record.exitedAt === null ? Number.NaN : Date.parse(record.exitedAt); return Number.isFinite(parsed) ? parsed : 0; };
    remaining.sort((a, b) => exitedAtMs(a) - exitedAtMs(b) || (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0));
    // Protected dependencies do not count against the excess; keep removing unprotected ones.
    let excess = remaining.length - RETENTION_MAX_JOBS;
    for (const record of remaining) {
      if (excess <= 0) break;
      if (!protectedIds.has(record.jobId) && remove(record)) excess -= 1;
    }
  }
  return pruned;
}
/** Folds every job directory; a directory without a valid seq 1 is absent and stays on disk. */
function readRecords(store: EventStore): Map<string, JobRecordV2> {
  const records = new Map<string, JobRecordV2>();
  for (const jobId of store.listJobIds()) { const record = foldEvents(store.readAllEvents(jobId).events); if (record !== undefined) records.set(jobId, record); }
  return records;
}
/** True when the supervisor identity names this process (contracts 4 step 4). */
function isThisProcess(supervisor: SupervisorIdentity): boolean {
  return supervisor.pid === process.pid && (selfLockIdentity === undefined || supervisor.startTime === selfLockIdentity.startTime);
}

/**
 * Restart reconciliation (contracts 4, 8.5): one snapshot before the lock, then repair +
 * `lost` for dead supervisors, lease release, and retention. A failed snapshot marks
 * nothing lost, logs one stderr line, and still applies retention.
 */
export async function reconcileFleet(store: EventStore, index: JobIndex, options?: {
  snapshot?: () => ProcessIdentity[]; kill?: typeof killAgentTree; now?: () => Date; retentionRename?: typeof fs.renameSync;
}): Promise<ReconcileStats> {
  const startedAt = Date.now(), now = options?.now ?? (() => new Date());
  const stats: ReconcileStats = { ...index.rebuild(), lost: [], repaired: [], pruned: [], killedPids: [] };
  let snapshot: ProcessIdentity[];
  // A supervisor that started after the snapshot is missing from it; its jobs were created later.
  const snapshotAt = now().getTime();
  try {
    snapshot = (options?.snapshot ?? processSnapshot)(); rememberSelf(snapshot);
  } catch (error) {
    process.stderr.write(`agtop: fleet reconciliation skipped lost detection because the process snapshot failed: ${message(error)}\n`);
    await withFleetLock(() => { stats.pruned.push(...pruneJobDirs(store, readRecords(store).values(), now().getTime(), options?.retentionRename)); });
    stats.durationMs = Date.now() - startedAt; return stats;
  }
  await withFleetLock(async () => {
    const nowMs = now().getTime(), records: JobRecordV2[] = [];
    let v1Records: JobRecord[] | undefined;
    for (const jobId of store.listJobIds()) {
      const record = foldEvents(store.readAllEvents(jobId).events);
      if (record === undefined) continue;
      records.push(record);
      if (isTerminal(record.state) || supervisorAlive(record.supervisor, snapshot) || isThisProcess(record.supervisor)) continue;
      if (Date.parse(record.createdAt) > snapshotAt) continue; // cannot prove dead: submitted after the snapshot
      if (store.repair(jobId).corruptTailBytes > 0) stats.repaired.push(jobId);
      let detail = `supervisor lost while job was ${record.state}`;
      if (RUNNING_STATES.has(record.state)) {
        v1Records ??= readJobs();
        const v1 = v1Records.find((job) => job.jobId === jobId);
        if (v1 !== undefined && !isStaleJob(v1, snapshot)) {
          try {
            const result = await (options?.kill ?? killAgentTree)(jobId);
            stats.killedPids.push(...result.killedPids);
            if (result.errors.length > 0) detail += `; kill errors: ${result.errors.join("; ")}`;
          } catch (error) { detail += `; kill failed: ${message(error)}`; }
        }
      }
      const counters = outputCounters(record, store.readOutput(jobId)), writer = store.reopen(jobId);
      let event: StateEvent;
      try {
        event = writer.appendState("lost", "supervisor-lost",
          { exitedAt: new Date(nowMs).toISOString(), exitCode: null, lastSeq: writer.lastSeq, outputBytes: counters }, detail.slice(0, 500));
      } finally { writer.close(); }
      index.apply(event); stats.lost.push(jobId); releaseJobLeases(jobId);
      record.state = "lost"; record.exitedAt = new Date(nowMs).toISOString(); // counts toward retention this pass
    }
    stats.pruned.push(...pruneJobDirs(store, records, nowMs, options?.retentionRename));
  });
  stats.durationMs = Date.now() - startedAt; return stats;
}
