import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path";
import { EventStore, encodeFrame } from "../src/event-store.js";
import { foldEvents, JobIndex, migrateV1Record, toSummary, isStaleV1Record } from "../src/job-index.js";
import { readJobs, writeJob, type ProcessIdentity } from "../src/registry.js";
import type { JobEvent, JobRecord, JobRecordPatch, JobRecordV2 } from "../src/types.js";

let root: string, store: EventStore;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-job-index-")); store = new EventStore({ root }); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function makeRecord(jobId: string, overrides: Partial<JobRecordV2> = {}): JobRecordV2 {
  return {
    version: 2, jobId, state: "queued", stateReason: "submitted", harness: "custom", command: "echo", args: ["hi"], cwd: root, peer: "tester", backend: "unknown",
    owner: { sessionId: "session-a", tokenHash: "", surface: "daemon" }, visibility: "owner", supervisor: { pid: 1, startTime: "1", surface: "daemon" }, containment: null,
    capture: { kind: "pipe", ringBytes: 4096, spool: "tail", spoolMaxBytes: 1_048_576, redact: true },
    queue: { admission: "immediate", priority: 0, dependsOn: [], resources: {}, leasePorts: [], leaseTtlMs: 0, timeoutMs: 0, maxQueueMs: 0 },
    envKeys: [], createdAt: "2026-01-01T00:00:00.000Z", startedAt: null, exitedAt: null, exitCode: null, signal: null, lastSeq: 0, outputBytes: { stdout: 0, stderr: 0 }, error: null, ...overrides,
  };
}
function v1Record(jobId: string, overrides: Partial<JobRecord> = {}): JobRecord {
  return { version: 1, jobId, rootPid: 4242, startTime: "100", harness: "custom", peer: "peer-v1", cwd: os.tmpdir(), backend: "unknown", mode: "passive-ppid", createdAt: "2026-01-02T00:00:00.000Z", ...overrides };
}
const liveV1Snapshot: ProcessIdentity[] = [{ pid: 4242, startTime: "100" }];
/** Writes a valid five-event finished-job log directly, without fsync, to keep the 200-job test fast. */
function writeFinishedLog(stateRoot: string, record: JobRecordV2): number {
  const dir = path.join(stateRoot, "fleet", "jobs", record.jobId), ts = record.createdAt;
  fs.mkdirSync(dir, { recursive: true });
  const events: JobEvent[] = [
    { seq: 1, timestamp: ts, jobId: record.jobId, type: "state", state: "queued", previous: null, reason: "submitted", record },
    { seq: 2, timestamp: ts, jobId: record.jobId, type: "state", state: "starting", previous: "queued", reason: "admitted" },
    { seq: 3, timestamp: ts, jobId: record.jobId, type: "state", state: "running", previous: "starting", reason: "spawned", patch: { startedAt: ts, lastSeq: 3 } },
    { seq: 4, timestamp: ts, jobId: record.jobId, type: "state", state: "exiting", previous: "running", reason: "root-exited" },
    { seq: 5, timestamp: ts, jobId: record.jobId, type: "state", state: "exited", previous: "exiting", reason: "root-exited", patch: { exitedAt: ts, exitCode: 0, lastSeq: 5 } },
  ];
  fs.writeFileSync(path.join(dir, "events.jsonl"), Buffer.concat(events.map((event) => encodeFrame(event))));
  return events.length;
}

test("foldEvents folds a full lifecycle and does not mutate the input events", () => {
  const writer = store.create(makeRecord("full"));
  writer.appendState("starting", "admitted");
  writer.appendSpawn({ pid: 42, startTime: "100", containmentMode: "passive-ppid", capture: "pipe" });
  writer.appendOutput("stdout", Buffer.from("hi"), 0);
  const runningPatch: JobRecordPatch = { startedAt: "2026-01-01T00:00:01.000Z", containment: { mode: "passive-ppid", rootPid: 42, startTime: "100" } };
  writer.appendState("running", "spawned", runningPatch);
  writer.appendLease({ action: "acquired", port: 3000 });
  writer.appendPolicy({ decision: "admit", rule: "queue", measured: null, threshold: null, detail: "ok" });
  writer.appendState("exiting", "root-exited");
  writer.appendExit({ exitCode: 0, signal: null, durationMs: 20, outputBytes: writer.outputBytes, drained: true });
  writer.appendState("exited", "root-exited", { exitedAt: "2026-01-01T00:00:02.000Z", exitCode: 0 });
  writer.close();
  const events = store.readAllEvents("full").events, snapshot = JSON.stringify(events), record = foldEvents(events)!;
  expect(record.state).toBe("exited"); expect(record.stateReason).toBe("root-exited");
  expect(record.containment).toEqual({ mode: "passive-ppid", rootPid: 42, startTime: "100" });
  expect(record.startedAt).toBe("2026-01-01T00:00:01.000Z"); expect(record.exitedAt).toBe("2026-01-01T00:00:02.000Z");
  expect(record.exitCode).toBe(0); expect(record.lastSeq).toBe(10); expect(JSON.stringify(events)).toBe(snapshot);
});

test("foldEvents applies patches and keeps a patch-supplied higher lastSeq", () => {
  const base = makeRecord("patched");
  const events: JobEvent[] = [
    { seq: 1, timestamp: base.createdAt, jobId: base.jobId, type: "state", state: "queued", previous: null, reason: "submitted", record: base },
    { seq: 2, timestamp: base.createdAt, jobId: base.jobId, type: "state", state: "starting", previous: "queued", reason: "admitted", patch: { lastSeq: 7, outputBytes: { stdout: 3, stderr: 4 } } },
    { seq: 3, timestamp: base.createdAt, jobId: base.jobId, type: "spawn", pid: 9, startTime: "1", containmentMode: "passive-ppid", capture: "pipe" },
    { seq: 4, timestamp: base.createdAt, jobId: base.jobId, type: "state", state: "running", previous: "starting", reason: "spawned", patch: { lastSeq: 4 } },
  ];
  const record = foldEvents(events)!;
  expect(record.state).toBe("running"); expect(record.stateReason).toBe("spawned"); expect(record.lastSeq).toBe(7);
  expect(record.outputBytes).toEqual({ stdout: 3, stderr: 4 });
  expect(base.state).toBe("queued"); expect(base.outputBytes).toEqual({ stdout: 0, stderr: 0 });
});

test("foldEvents ignores a log without seq 1 or without a record", () => {
  expect(foldEvents([])).toBeUndefined();
  const base = makeRecord("missing");
  expect(foldEvents([{ seq: 2, timestamp: base.createdAt, jobId: base.jobId, type: "state", state: "starting", previous: "queued", reason: "admitted", record: base }])).toBeUndefined();
  expect(foldEvents([{ seq: 1, timestamp: base.createdAt, jobId: base.jobId, type: "state", state: "queued", previous: null, reason: "submitted" }])).toBeUndefined();
  // Sequence rule 2: seq 1 must be the queued/submitted event.
  expect(foldEvents([{ seq: 1, timestamp: base.createdAt, jobId: base.jobId, type: "state", state: "running", previous: null, reason: "spawned", record: base }])).toBeUndefined();
});

test("apply keeps the highest lastSeq when a patch carries an older one", () => {
  const index = new JobIndex(store, { readV1: () => [] }); index.rebuild();
  const base = makeRecord("older-patch");
  index.apply({ seq: 1, timestamp: base.createdAt, jobId: base.jobId, type: "state", state: "queued", previous: null, reason: "submitted", record: base });
  index.apply({ seq: 9, timestamp: base.createdAt, jobId: base.jobId, type: "policy", decision: "defer", rule: "gpu-busy", measured: 90, threshold: 85, detail: "" });
  index.apply({ seq: 10, timestamp: base.createdAt, jobId: base.jobId, type: "state", state: "starting", previous: "queued", reason: "admitted", patch: { lastSeq: 4 } });
  expect(index.get("older-patch")!.lastSeq).toBe(10);
});

test("migrateV1Record maps every field and omits absent containment optionals", () => {
  const migrated = migrateV1Record(v1Record("v1-full", { jobName: "job-name", cgroupPath: "/sys/fs/cgroup/x" }));
  expect(migrated).toEqual({
    version: 2, jobId: "v1-full", state: "running", stateReason: "spawned", harness: "custom", command: "", args: [], cwd: migrated.cwd, peer: "peer-v1", backend: "unknown",
    owner: { sessionId: "v1", tokenHash: "", surface: "library" }, visibility: "owner", supervisor: { pid: 0, startTime: "", surface: "library" },
    containment: { mode: "passive-ppid", rootPid: 4242, startTime: "100", jobName: "job-name", cgroupPath: "/sys/fs/cgroup/x" },
    capture: { kind: "none", ringBytes: 0, spool: "off", spoolMaxBytes: 0, redact: true },
    queue: { admission: "immediate", priority: 0, dependsOn: [], resources: {}, leasePorts: [], leaseTtlMs: 0, timeoutMs: 0, maxQueueMs: 0 },
    envKeys: [], createdAt: "2026-01-02T00:00:00.000Z", startedAt: "2026-01-02T00:00:00.000Z",
    exitedAt: null, exitCode: null, signal: null, lastSeq: 0, outputBytes: { stdout: 0, stderr: 0 }, error: null,
  });
  const plain = migrateV1Record(v1Record("v1-plain"));
  expect(plain.containment).toEqual({ mode: "passive-ppid", rootPid: 4242, startTime: "100" });
  expect("jobName" in plain.containment!).toBe(false); expect("cgroupPath" in plain.containment!).toBe(false);
});

test("toSummary maps the summary fields and hides the command unless allowed", () => {
  const record = makeRecord("summary", {
    state: "running", stateReason: "spawned", harness: "claude-code", peer: "peer-a", owner: { sessionId: "session-1", tokenHash: "", surface: "mcp" }, visibility: "peer",
    containment: { mode: "win32-job-object", rootPid: 77, startTime: "100" }, lastSeq: 12, outputBytes: { stdout: 10, stderr: 2 },
    queue: { admission: "queued", priority: 5, dependsOn: [], resources: { gpu: true }, leasePorts: [8080], leaseTtlMs: 0, timeoutMs: 0, maxQueueMs: 0 },
  });
  expect(toSummary(record, { owned: true, showCommand: true })).toEqual({
    jobId: "summary", state: "running", stateReason: "spawned", harness: "claude-code", peer: "peer-a",
    owned: true, ownerSessionId: "session-1", surface: "mcp", visibility: "peer", rootPid: 77, containmentMode: "win32-job-object",
    createdAt: record.createdAt, startedAt: null, exitedAt: null, exitCode: null, captured: true, lastSeq: 12, outputBytes: { stdout: 10, stderr: 2 },
    priority: 5, leasePorts: [8080], command: "echo", args: ["hi"], cwd: root,
  });
  const hidden = toSummary(record, { owned: false, showCommand: false });
  expect(hidden.owned).toBe(false); expect("command" in hidden).toBe(false); expect("args" in hidden).toBe(false); expect("cwd" in hidden).toBe(false);
  const bare = toSummary(makeRecord("bare", { capture: { kind: "none", ringBytes: 0, spool: "off", spoolMaxBytes: 0, redact: true } }), { owned: false, showCommand: false });
  expect(bare.rootPid).toBeNull(); expect(bare.containmentMode).toBeNull(); expect(bare.captured).toBe(false);
});

test("rebuild lets a fleet record win over a v1 record with the same ID", () => {
  const writer = store.create(makeRecord("fleet-a")); writer.appendState("starting", "admitted"); writer.close();
  const index = new JobIndex(store, { readV1: () => [v1Record("fleet-a"), v1Record("v1-only")] }), stats = index.rebuild();
  expect(stats.jobs).toBe(1); expect(stats.events).toBe(2); expect(stats.corruptTailBytes).toBe(0);
  expect(index.get("fleet-a")!.state).toBe("starting"); expect(index.get("fleet-a")!.command).toBe("echo");
  expect(index.get("v1-only")!.state).toBe("running"); expect(index.get("v1-only")!.command).toBe("");
  expect(index.list().map((record) => record.jobId).sort()).toEqual(["fleet-a", "v1-only"]);
});

test("refresh sees an event appended by a second writer", () => {
  const first = store.create(makeRecord("shared")); first.appendState("starting", "admitted"); first.close();
  const index = new JobIndex(store, { readV1: () => [] }); index.rebuild();
  expect(index.get("shared")!.state).toBe("starting");
  const second = new EventStore({ root }).reopen("shared"), appended = second.appendState("running", "spawned", { startedAt: "2026-01-01T00:00:05.000Z" }); second.close();
  index.refresh();
  expect(index.get("shared")!.state).toBe("running"); expect(index.get("shared")!.startedAt).toBe("2026-01-01T00:00:05.000Z");
  expect(index.get("shared")!.lastSeq).toBe(appended.seq);
});

test("refresh drops removed directories and discovers new ones", () => {
  for (const jobId of ["keep", "drop"]) store.create(makeRecord(jobId)).close();
  const index = new JobIndex(store, { readV1: () => [] }); index.rebuild();
  expect(index.get("drop")).toBeDefined();
  store.remove("drop"); store.create(makeRecord("fresh")).close(); index.refresh();
  expect(index.get("drop")).toBeUndefined(); expect(index.get("keep")).toBeDefined(); expect(index.get("fresh")!.state).toBe("queued");
});

test("runningCounts includes fleet and migrated v1 jobs", () => {
  const running = store.create(makeRecord("run-custom", { peer: "p1", harness: "custom" })); running.appendState("starting", "admitted"); running.appendState("running", "spawned"); running.close();
  const starting = store.create(makeRecord("start-claude", { peer: "p1", harness: "claude-code" })); starting.appendState("starting", "admitted"); starting.close();
  const exited = store.create(makeRecord("exit-custom", { peer: "p2", harness: "custom" })); exited.appendState("starting", "admitted"); exited.appendState("running", "spawned"); exited.appendState("exiting", "root-exited"); exited.appendState("exited", "root-exited"); exited.close();
  store.create(makeRecord("queued-custom", { peer: "p3", harness: "custom" })).close();
  const index = new JobIndex(store, { readV1: () => [v1Record("v1-run", { peer: "p3" })] }); index.rebuild();
  const counts = index.runningCounts();
  expect(counts.total).toBe(3); expect(Object.fromEntries(counts.perPeer)).toEqual({ p1: 2, p3: 1 });
  expect(Object.fromEntries(counts.perHarness)).toEqual({ custom: 2, "claude-code": 1 });
  expect(index.queued().map((record) => record.jobId)).toEqual(["queued-custom"]);
});

test("list orders by createdAt descending then jobId ascending and filters", () => {
  const jobs = [
    makeRecord("b-job", { createdAt: "2026-01-01T00:00:02.000Z", peer: "peer-b", harness: "custom", owner: { sessionId: "s-b", tokenHash: "", surface: "daemon" } }),
    makeRecord("a-job", { createdAt: "2026-01-01T00:00:02.000Z", peer: "peer-a", harness: "claude-code", owner: { sessionId: "s-a", tokenHash: "", surface: "daemon" } }),
    makeRecord("c-job", { createdAt: "2026-01-01T00:00:03.000Z", peer: "peer-a", harness: "custom", owner: { sessionId: "s-c", tokenHash: "", surface: "daemon" } }),
  ];
  for (const job of jobs) store.create(job).close();
  const index = new JobIndex(store, { readV1: () => [] }); index.rebuild();
  expect(index.list().map((record) => record.jobId)).toEqual(["c-job", "a-job", "b-job"]);
  expect(index.list({ states: ["running"] })).toEqual([]);
  expect(index.list({ states: ["queued"] }).map((record) => record.jobId)).toEqual(["c-job", "a-job", "b-job"]);
  expect(index.list({ peer: "peer-a" }).map((record) => record.jobId)).toEqual(["c-job", "a-job"]);
  expect(index.list({ harness: "custom" }).map((record) => record.jobId)).toEqual(["c-job", "b-job"]);
  expect(index.list({ ownerSessionId: "s-b" }).map((record) => record.jobId)).toEqual(["b-job"]);
  expect(index.list({ states: ["queued"], peer: "peer-a" }).map((record) => record.jobId)).toEqual(["c-job", "a-job"]);
});

test("apply folds local lifecycle events without waiting for refresh", () => {
  const index = new JobIndex(store, { readV1: () => [] }); index.rebuild();
  const writer = store.create(makeRecord("local"));
  index.apply(store.readAllEvents("local").events[0]!); expect(index.get("local")!.state).toBe("queued");
  index.apply(writer.appendState("starting", "admitted")); expect(index.get("local")!.state).toBe("starting");
  const spawn = writer.appendSpawn({ pid: 3, startTime: "1", containmentMode: "passive-ppid", capture: "pipe" });
  index.apply(spawn); expect(index.get("local")!.state).toBe("starting"); expect(index.get("local")!.lastSeq).toBe(spawn.seq);
  index.apply(writer.appendState("running", "spawned", { startedAt: "2026-01-01T00:00:01.000Z" })); writer.close();
  expect(index.get("local")!.state).toBe("running"); index.refresh(); expect(index.get("local")!.state).toBe("running");
});

test("rebuild counts a corrupt tail but still folds the valid prefix", () => {
  const writer = store.create(makeRecord("corrupt")); writer.appendState("starting", "admitted"); writer.close();
  fs.appendFileSync(path.join(root, "fleet", "jobs", "corrupt", "events.jsonl"), Buffer.from("junk"));
  const index = new JobIndex(store, { readV1: () => [] });
  expect(index.rebuild().corruptTailBytes).toBe(4); expect(index.get("corrupt")!.state).toBe("starting");
});

test("uses the default state directory and keeps readJobs() to v1 records", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-job-index-state-")), previous = process.env.AGTOP_STATE_DIR;
  process.env.AGTOP_STATE_DIR = stateDir;
  try {
    writeJob(v1Record("v1-only"));
    const defaultStore = new EventStore(); defaultStore.create(makeRecord("fleet-job")).close();
    const index = new JobIndex(defaultStore, {}); index.rebuild();
    expect(index.list().map((record) => record.jobId).sort()).toEqual(["fleet-job", "v1-only"]);
    expect(index.get("v1-only")!.state).toBe("running"); expect(readJobs().map((record) => record.jobId)).toEqual(["v1-only"]);
  } finally {
    if (previous === undefined) delete process.env.AGTOP_STATE_DIR; else process.env.AGTOP_STATE_DIR = previous;
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("JobIndex filters only v1 records older than an injected view and never scans", () => {
  const live = v1Record("live-v1", { mode: "linux-env-pgid" });
  const stale = v1Record("stale-v1", { jobId: "stale-v1", rootPid: 9000, mode: "linux-env-pgid" });
  let viewCalls = 0;
  const view = { takenAtMs: Date.parse("2026-01-03T00:00:00Z"), processes: liveV1Snapshot };
  const index = new JobIndex(store, { readV1: () => [live, stale], staleness: () => view });
  index.rebuild();
  expect(index.list().map((job) => job.jobId)).toEqual(["live-v1"]);
  expect(index.runningCounts().total).toBe(1);
  const newRecord = v1Record("new-v1", { mode: "linux-env-pgid", createdAt: "2026-01-04T00:00:00.000Z" });
  const afterView = new JobIndex(store, { readV1: () => [newRecord], staleness: () => { viewCalls++; return view; } });
  afterView.rebuild();
  expect(afterView.list().map((job) => job.jobId)).toEqual(["new-v1"]);
  expect(afterView.runningCounts().total).toBe(1); expect(viewCalls).toBe(1);
  const bare = new JobIndex(store, { readV1: () => [stale] }); bare.rebuild();
  expect(bare.list().map((job) => job.jobId)).toEqual(["stale-v1"]);
});

test("Windows v1 staleness keeps live roots and opened jobs", () => {
  const record = v1Record("win-v1", { mode: "win32-job-object", jobName: "Global\\job", rootPid: 4242 });
  const view = { takenAtMs: Date.parse("2026-01-03T00:00:00Z"), processes: [] as ProcessIdentity[] };
  expect(isStaleV1Record(record, view, { platform: "win32", withJob: () => undefined })).toBe(true);
  expect(isStaleV1Record(record, { ...view, processes: [{ pid: 4242, startTime: "100" }] }, { platform: "win32", withJob: () => undefined })).toBe(false);
  expect(isStaleV1Record(record, view, { platform: "win32", withJob: () => [4242] })).toBe(false);
});

test("rebuilds 200 finished jobs in under one second", () => {
  let events = 0;
  for (let i = 0; i < 200; i++) events += writeFinishedLog(root, makeRecord(`perf-${i.toString().padStart(3, "0")}`));
  const index = new JobIndex(store, { readV1: () => [] }), stats = index.rebuild();
  expect(stats.jobs).toBe(200); expect(stats.events).toBe(events); expect(stats.durationMs).toBeLessThan(1000);
  expect(index.get("perf-199")!.state).toBe("exited");
});
