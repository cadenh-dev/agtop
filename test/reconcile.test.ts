import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { EventStore, encodeFrame, fleetDir, jobDir } from "../src/event-store.js";
import { FleetError } from "../src/fleet-errors.js";
import { JobIndex } from "../src/job-index.js";
import { RETENTION_HOURS, RETENTION_MAX_JOBS, reconcileFleet, supervisorAlive, withFleetLock } from "../src/reconcile.js";
import { writeJob, type ProcessIdentity } from "../src/registry.js";
import type { JobEvent, JobRecord, JobRecordV2, KillResult, StateEvent, SupervisorIdentity } from "../src/types.js";

let root = "", previousStateDir: string | undefined;
beforeEach(() => {
  previousStateDir = process.env.AGTOP_STATE_DIR; root = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-reconcile-"));
  process.env.AGTOP_STATE_DIR = root; delete process.env.AGTOP_FLEET_RETENTION_HOURS;
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (previousStateDir === undefined) delete process.env.AGTOP_STATE_DIR; else process.env.AGTOP_STATE_DIR = previousStateDir;
  delete process.env.AGTOP_FLEET_RETENTION_HOURS;
});

const DEAD: SupervisorIdentity = { pid: 4_000_001, startTime: "111", surface: "library" };
const LIVE: SupervisorIdentity = { pid: 5_000_001, startTime: "500", surface: "library" };
const liveSnapshot: ProcessIdentity[] = [{ pid: LIVE.pid, startTime: LIVE.startTime }];
const ago = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();
const noKill = async (): Promise<KillResult> => ({ killedPids: [], failedPids: [], errors: [] });

function recordFor(jobId: string, supervisor = DEAD, overrides: Partial<JobRecordV2> = {}): JobRecordV2 {
  return {
    version: 2, jobId, state: "queued", stateReason: "submitted", harness: "custom", command: "echo", args: [], cwd: root, peer: "tester", backend: "unknown",
    owner: { sessionId: "session", tokenHash: "", surface: "library" }, visibility: "owner", supervisor, containment: null,
    capture: { kind: "pipe", ringBytes: 4096, spool: "tail", spoolMaxBytes: 1_048_576, redact: true },
    queue: { admission: "immediate", priority: 0, dependsOn: [], resources: {}, leasePorts: [], leaseTtlMs: 0, timeoutMs: 0, maxQueueMs: 0 },
    envKeys: [], createdAt: new Date().toISOString(), startedAt: null, exitedAt: null, exitCode: null, signal: null,
    lastSeq: 0, outputBytes: { stdout: 0, stderr: 0 }, error: null, ...overrides,
  };
}
function createJob(jobId: string, state: "queued" | "starting" | "running" | "exiting", supervisor = DEAD, overrides: Partial<JobRecordV2> = {}): void {
  const writer = new EventStore().create(recordFor(jobId, supervisor, overrides));
  if (state !== "queued") writer.appendState("starting", "admitted");
  if (state === "running" || state === "exiting") writer.appendState("running", "spawned", { startedAt: ago(0), containment: { mode: "passive-ppid", rootPid: 900, startTime: "9" } });
  if (state === "exiting") writer.appendState("exiting", "root-exited");
  writer.close();
}
function createTerminal(jobId: string, exitedAt: string): void {
  const writer = new EventStore().create(recordFor(jobId));
  writer.appendState("starting", "admitted"); writer.appendState("running", "spawned", { startedAt: ago(0), containment: { mode: "passive-ppid", rootPid: 900, startTime: "9" } });
  writer.appendState("exiting", "root-exited"); writer.appendState("exited", "root-exited", { exitedAt, exitCode: 0 }); writer.close();
}
/** Writes a terminal log without fsync so the 200-job retention test stays fast. */
function writeTerminalLog(jobId: string, exitedAt: string): void {
  fs.mkdirSync(jobDir(jobId), { recursive: true, mode: 0o700 });
  const record = recordFor(jobId), events: JobEvent[] = [
    { seq: 1, timestamp: exitedAt, jobId, type: "state", state: "queued", previous: null, reason: "submitted", record },
    { seq: 2, timestamp: exitedAt, jobId, type: "state", state: "exited", previous: "queued", reason: "root-exited", patch: { exitedAt, exitCode: 0, lastSeq: 2 } },
  ];
  fs.writeFileSync(path.join(jobDir(jobId), "events.jsonl"), Buffer.concat(events.map((event) => encodeFrame(event))));
}
function lastStateEvent(jobId: string): StateEvent {
  const states = new EventStore().readAllEvents(jobId).events.filter((event): event is StateEvent => event.type === "state");
  return states[states.length - 1];
}
const appendTornTail = (file: string): void => fs.appendFileSync(file, Buffer.from("deadbeef deadbeef {\"seq\":99"));
function writeLease(port: number, jobId: string | null): string {
  const dir = path.join(fleetDir(), "leases"); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${port}.json`);
  fs.writeFileSync(file, JSON.stringify({ leaseId: `lease-${port}`, port, jobId, peer: "tester", sessionId: "session",
    holder: { pid: process.pid, startTime: "1", surface: "library" }, acquiredAt: ago(0), renewedAt: ago(0),
    expiresAt: new Date(Date.now() + 60_000).toISOString(), ttlMs: 60_000 }));
  return file;
}

for (const state of ["queued", "starting", "running", "exiting"] as const) {
  test(`a dead supervisor marks a ${state} job lost, names the previous state, and releases its lease`, async () => {
    const store = new EventStore(), index = new JobIndex(store, { readV1: () => [] }); createJob("job", state);
    const ours = writeLease(3000, "job"), foreign = writeLease(3001, "other-job");
    const stats = await reconcileFleet(store, index, { snapshot: () => [], kill: noKill });
    expect(stats.lost).toEqual(["job"]); expect(stats.repaired).toEqual([]); expect(stats.pruned).toEqual([]);
    expect(fs.existsSync(ours)).toBe(false); expect(fs.existsSync(foreign)).toBe(true);
    const event = lastStateEvent("job");
    expect(event.state).toBe("lost"); expect(event.reason).toBe("supervisor-lost"); expect(event.previous).toBe(state);
    expect(event.detail).toContain(state); expect(event.patch?.exitCode).toBeNull();
    expect(event.patch?.exitedAt).not.toBeNull(); expect(event.patch?.lastSeq).toBe(event.seq);
  });
}

test("a job submitted after the snapshot was taken is never marked lost", async () => {
  const store = new EventStore(), index = new JobIndex(store, { readV1: () => [] });
  const snapshotTime = new Date(Date.now() - 60_000);
  // Its supervisor started after the snapshot, so it is missing from it; it must not count as dead.
  createJob("late-job", "running", DEAD, { createdAt: new Date(snapshotTime.getTime() + 1_000).toISOString() });
  const stats = await reconcileFleet(store, index, { snapshot: () => [], kill: noKill, now: () => snapshotTime });
  expect(stats.lost).toEqual([]);
  expect(lastStateEvent("late-job").state).toBe("running");
});

test("a live supervisor is untouched: no lost state and no tail truncation", async () => {
  const store = new EventStore(), index = new JobIndex(store, { readV1: () => [] }); createJob("live-job", "running", LIVE);
  const eventsFile = path.join(jobDir("live-job"), "events.jsonl"); appendTornTail(eventsFile);
  const before = fs.readFileSync(eventsFile);
  const stats = await reconcileFleet(store, index, { snapshot: () => liveSnapshot, kill: noKill });
  expect(stats.lost).toEqual([]); expect(stats.repaired).toEqual([]);
  expect(fs.readFileSync(eventsFile).equals(before)).toBe(true);
  expect(store.readAllEvents("live-job").corruptTailBytes).toBeGreaterThan(0);
  expect(lastStateEvent("live-job").state).toBe("running");
});

test("a reused pid with a different start time is dead, and a failed snapshot marks nothing lost", async () => {
  const store = new EventStore(), index = new JobIndex(store, { readV1: () => [] }); createJob("reused-pid", "running", LIVE);
  expect((await reconcileFleet(store, index, { snapshot: () => [{ pid: LIVE.pid, startTime: "other" }], kill: noKill })).lost).toEqual(["reused-pid"]);
  createJob("still-running", "running"); createTerminal("old-finished", ago(73));
  const originalWrite = process.stderr.write; let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    const stats = await reconcileFleet(store, index, { snapshot: () => { throw new Error("no powershell"); }, kill: noKill });
    expect(stats.lost).toEqual([]); expect(stats.repaired).toEqual([]); expect(stats.pruned).toEqual(["old-finished"]);
  } finally { process.stderr.write = originalWrite; }
  expect(lastStateEvent("still-running").state).toBe("running"); expect(stderr.trim().split("\n")).toHaveLength(1);
});

test("a corrupt tail is repaired only for dead supervisors", async () => {
  const store = new EventStore(), index = new JobIndex(store, { readV1: () => [] }); createJob("dead-job", "running"); createJob("live-job", "running", LIVE);
  const deadFile = path.join(jobDir("dead-job"), "events.jsonl"), liveFile = path.join(jobDir("live-job"), "events.jsonl");
  appendTornTail(deadFile); appendTornTail(liveFile); const liveBefore = fs.readFileSync(liveFile);
  const stats = await reconcileFleet(store, index, { snapshot: () => liveSnapshot, kill: noKill });
  expect(stats.repaired).toEqual(["dead-job"]); expect(store.readAllEvents("dead-job").corruptTailBytes).toBe(0);
  expect(lastStateEvent("dead-job").state).toBe("lost"); expect(fs.readFileSync(liveFile).equals(liveBefore)).toBe(true);
  expect(store.readAllEvents("live-job").corruptTailBytes).toBeGreaterThan(0);
});

test("kill runs only for a dead running supervisor with a live v1 record, and its errors land in detail", async () => {
  const store = new EventStore(), index = new JobIndex(store, { readV1: () => [] }); createJob("with-tree", "running"); createJob("without-tree", "running");
  createJob("queued-with-tree", "queued"); createJob("kill-throws", "running");
  const v1 = (jobId: string): JobRecord => ({ version: 1, jobId, rootPid: 700, startTime: "70", harness: "custom", peer: "tester",
    cwd: root, backend: "unknown", mode: "passive-ppid", createdAt: ago(0) });
  writeJob(v1("with-tree")); writeJob(v1("queued-with-tree")); writeJob(v1("kill-throws"));
  const calls: string[] = [];
  const kill = async (jobId: string): Promise<KillResult> => {
    calls.push(jobId); if (jobId === "kill-throws") throw new Error("tree vanished"); return { killedPids: [700], failedPids: [], errors: [] };
  };
  const stats = await reconcileFleet(store, index, { snapshot: () => [{ pid: 700, startTime: "70" }], kill });
  expect(calls.includes("with-tree")).toBe(true); expect(calls.includes("kill-throws")).toBe(true);
  expect(calls.includes("without-tree")).toBe(false); expect(calls.includes("queued-with-tree")).toBe(false);
  expect(stats.killedPids).toContain(700); expect(stats.lost).toContain("kill-throws");
  expect(lastStateEvent("kill-throws").detail).toContain("tree vanished"); expect(lastStateEvent("with-tree").state).toBe("lost");
});

test("retention prunes by age, is disabled by env 0, and keeps dependencies of queued jobs", async () => {
  const store = new EventStore(), index = new JobIndex(store, { readV1: () => [] });
  createTerminal("dep-job", ago(73)); createTerminal("free-job", ago(73)); createTerminal("old-job", ago(73));
  createJob("waiter", "queued", LIVE, { queue: { admission: "queued", priority: 0, dependsOn: ["dep-job"], resources: {}, leasePorts: [], leaseTtlMs: 0, timeoutMs: 0, maxQueueMs: 0 } });
  process.env.AGTOP_FLEET_RETENTION_HOURS = "0";
  expect((await reconcileFleet(store, index, { snapshot: () => liveSnapshot, kill: noKill })).pruned).toEqual([]);
  delete process.env.AGTOP_FLEET_RETENTION_HOURS;
  expect((await reconcileFleet(store, index, { snapshot: () => liveSnapshot, kill: noKill })).pruned).toEqual(["free-job", "old-job"]);
  expect(fs.existsSync(jobDir("dep-job"))).toBe(true); expect(fs.existsSync(jobDir("free-job"))).toBe(false);
  expect(lastStateEvent("waiter").state).toBe("queued");
});

test("retention keeps at most RETENTION_MAX_JOBS terminal jobs and removes the oldest", async () => {
  const store = new EventStore(), index = new JobIndex(store, { readV1: () => [] }); const base = Date.now() - 3_600_000, total = RETENTION_MAX_JOBS + 2;
  for (let index0 = 0; index0 < total; index0++) writeTerminalLog(`bulk-${String(index0).padStart(3, "0")}`, new Date(base + index0 * 1000).toISOString());
  const stats = await reconcileFleet(store, index, { snapshot: () => [], kill: noKill });
  expect(stats.pruned).toEqual(["bulk-000", "bulk-001"]);
  expect(fs.existsSync(jobDir("bulk-000"))).toBe(false); expect(fs.existsSync(jobDir("bulk-002"))).toBe(true);
  expect(fs.existsSync(jobDir(`bulk-${String(total - 1).padStart(3, "0")}`))).toBe(true);
});

test("supervisorAlive compares pid and start time, and pid 0 is never alive", () => {
  const snapshot: ProcessIdentity[] = [{ pid: 42, startTime: "100" }];
  expect(supervisorAlive({ pid: 42, startTime: "100", surface: "library" }, snapshot)).toBe(true);
  expect(supervisorAlive({ pid: 42, startTime: "101", surface: "library" }, snapshot)).toBe(false);
  expect(supervisorAlive({ pid: 43, startTime: "100", surface: "library" }, snapshot)).toBe(false);
  expect(supervisorAlive({ pid: 0, startTime: "", surface: "library" }, snapshot)).toBe(false);
  expect(supervisorAlive({ pid: 42, startTime: "100", surface: "library" }, [])).toBe(false);
  expect(RETENTION_HOURS).toBe(72); expect(RETENTION_MAX_JOBS).toBe(200);
});

test("withFleetLock creates, releases, and times out with E_INTERNAL when the holder looks alive", async () => {
  const lockPath = path.join(fleetDir(), "lock");
  expect(await withFleetLock(() => { expect(fs.existsSync(lockPath)).toBe(true); return 7; })).toBe(7);
  expect(fs.existsSync(lockPath)).toBe(false);
  await expect(withFleetLock(() => { throw new Error("boom"); })).rejects.toThrow("boom");
  expect(fs.existsSync(lockPath)).toBe(false);
  fs.mkdirSync(fleetDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startTime: "1" }));
  let ran = false, caught: unknown; const startedAt = Date.now();
  try { await withFleetLock(() => { ran = true; }, { timeoutMs: 120 }); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(FleetError); expect((caught as FleetError).code).toBe("E_INTERNAL");
  expect((caught as FleetError).message).toBe("Fleet lock timeout"); expect(ran).toBe(false);
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100); expect(fs.existsSync(lockPath)).toBe(true);
});

test("withFleetLock takes over a stale lock naming a dead pid and start time", async () => {
  const lockPath = path.join(fleetDir(), "lock"); fs.mkdirSync(fleetDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: DEAD.pid, startTime: DEAD.startTime })); const startedAt = Date.now();
  expect(await withFleetLock(() => "acquired", { timeoutMs: 4000 })).toBe("acquired");  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(500); expect(fs.existsSync(lockPath)).toBe(false);
});

test("two processes never hold the fleet lock at the same time", async () => {
  const shared = path.join(root, "shared.log"), script = ["const fs = await import(\"node:fs\");", "const { withFleetLock } = await import(process.env.RECONCILE_URL);",
    "await withFleetLock(async () => {", "  fs.appendFileSync(process.env.SHARED_FILE, \"start\\n\");",
    "  await new Promise((resolve) => setTimeout(resolve, 80));", "  fs.appendFileSync(process.env.SHARED_FILE, \"end\\n\");",
    "}, { timeoutMs: 4000 });"].join("\n");
  const env = { ...process.env, AGTOP_STATE_DIR: root, RECONCILE_URL: pathToFileURL(path.resolve("src/reconcile.ts")).href, SHARED_FILE: shared };
  const children = [0, 1].map(() => Bun.spawn([process.execPath, "-e", script], { env, stdout: "ignore", stderr: "pipe" }));
  for (const result of await Promise.all(children.map(async (child) => ({ code: await child.exited, stderr: await new Response(child.stderr as ReadableStream<Uint8Array>).text() })))) {
    expect(result.code, result.stderr).toBe(0);
  }
  expect(fs.readFileSync(shared, "utf8").trim().split(/\r?\n/)).toEqual(["start", "end", "start", "end"]);
});
