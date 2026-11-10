import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { EventStore, fleetDir } from "../src/event-store.js";
import type { spawnContainedAgent } from "../src/manager.js";
import { JobIndex } from "../src/job-index.js";
import { isTerminal } from "../src/job-state.js";
import { JobRuntime, selfSupervisor, writeKillRequest } from "../src/job-runtime.js";
import { LeaseManager } from "../src/leases.js";
import { DEFAULT_ADMISSION_POLICY, ResourcePolicyGuard } from "../src/policy.js";
import { Scheduler } from "../src/scheduler.js";
import type {
  AcceleratorSnapshot, AdmissionPolicy, CaptureSpec, JobRecordV2, LeaseEvent, ManagedAgent, PolicyEvent,
  SpawnAgentOptions, StateEvent,
} from "../src/types.js";

const REPO = path.resolve(import.meta.dir, "..");
const NO_CAPTURE: CaptureSpec = { kind: "none", ringBytes: 0, spool: "off", spoolMaxBytes: 0, redact: true };
let root = "", previousStateDir: string | undefined;
const open: Array<{ scheduler: Scheduler; runtime: JobRuntime; index: JobIndex }> = [];

beforeEach(() => {
  previousStateDir = process.env.AGTOP_STATE_DIR;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-scheduler-"));
  process.env.AGTOP_STATE_DIR = root;
});
afterEach(async () => {
  for (const entry of open) {
    entry.scheduler.stop();
    for (const record of entry.index.list()) {
      if (!isTerminal(record.state) && entry.runtime.supervises(record.jobId)) await entry.runtime.kill(record.jobId, "cleanup");
    }
  }
  open.length = 0;
  fs.rmSync(root, { recursive: true, force: true });
  if (previousStateDir === undefined) delete process.env.AGTOP_STATE_DIR; else process.env.AGTOP_STATE_DIR = previousStateDir;
});

function queueOf(overrides: Partial<JobRecordV2["queue"]> = {}): JobRecordV2["queue"] {
  return { admission: "queued", priority: 0, dependsOn: [], resources: {}, leasePorts: [], leaseTtlMs: 60_000, timeoutMs: 0, maxQueueMs: 0, ...overrides };
}
function recordFor(jobId: string, overrides: Partial<JobRecordV2> = {}): JobRecordV2 {
  return {
    version: 2, jobId, state: "queued", stateReason: "submitted", harness: "custom", command: "echo", args: [], cwd: root, peer: "tester",
    backend: "unknown", owner: { sessionId: "session", tokenHash: "", surface: "library" }, visibility: "owner",
    supervisor: selfSupervisor("library"), containment: null, capture: NO_CAPTURE, queue: queueOf(),
    envKeys: [], createdAt: new Date().toISOString(), startedAt: null, exitedAt: null, exitCode: null, signal: null,
    lastSeq: 0, outputBytes: { stdout: 0, stderr: 0 }, error: null, ...overrides,
  };
}
function fakeAgent(finishAfterMs?: number): ManagedAgent {
  let finish!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { finish = resolve; });
  if (finishAfterMs !== undefined) setTimeout(() => finish(0), finishAfterMs).unref();
  return {
    jobId: "fake", pid: 4242, containmentMode: "passive-ppid" as const, exited, startTime: "1700000000000",
    terminate: async () => { finish(143); return { killedPids: [4242], failedPids: [], errors: [] }; },
  };
}
function snapshot(gpuPercent: number): AcceleratorSnapshot {
  return { devices: [{ id: "gpu-0", kind: "gpu", utilizationPercent: gpuPercent }], status: [], sampledAt: 0 };
}
function states(store: EventStore, jobId: string): string[] {
  return store.readAllEvents(jobId).events.filter((event): event is StateEvent => event.type === "state").map((event) => event.state);
}
function policyEvents(store: EventStore, jobId: string): PolicyEvent[] {
  return store.readAllEvents(jobId).events.filter((event): event is PolicyEvent => event.type === "policy");
}
function leaseEvents(store: EventStore, jobId: string): LeaseEvent[] {
  return store.readAllEvents(jobId).events.filter((event): event is LeaseEvent => event.type === "lease");
}
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function setup(options: {
  policy?: Partial<AdmissionPolicy>;
  guardProbes?: { accelerators?: () => AcceleratorSnapshot | undefined; freeMemoryMb?: () => number };
  spawn?: typeof spawnContainedAgent;
} = {}) {
  const policy: AdmissionPolicy = { ...DEFAULT_ADMISSION_POLICY, pollMs: 250, defaultLeaseTtlMs: 60_000, ...options.policy };
  const store = new EventStore();
  const index = new JobIndex(store, { readV1: () => [] });
  const leases = new LeaseManager({ listeners: () => [], alive: () => true });
  const guard = new ResourcePolicyGuard(policy, { accelerators: () => undefined, freeMemoryMb: () => 10_000, ...options.guardProbes });
  const spawned: Array<{ jobId: string; states: string[]; lock: boolean }> = [];
  const spawnImpl = options.spawn ?? ((async (spawnOptions: SpawnAgentOptions) => {
    spawned.push({ jobId: spawnOptions.jobId!, states: states(store, spawnOptions.jobId!), lock: fs.existsSync(path.join(fleetDir(), "lock")) });
    return fakeAgent();
  }) as typeof spawnContainedAgent);
  const runtime = new JobRuntime({ store, index, spawn: spawnImpl });
  const scheduler = new Scheduler({ runtime, index, leases, guard, policy: () => policy, listeners: () => [] });
  open.push({ scheduler, runtime, index });
  const enqueue = (jobId: string, overrides: Partial<JobRecordV2> = {}): void => { runtime.enqueue(recordFor(jobId, overrides), {}); };
  return { policy, store, index, leases, guard, runtime, scheduler, spawned, enqueue };
}

test("admission writes starting before the lock is released and spawns only after it is gone", async () => {
  const { index, store, scheduler, enqueue, spawned } = setup();
  enqueue("admit-lock");
  const plan = await scheduler.tick();
  expect(plan.admit).toEqual(["admit-lock"]);
  expect(spawned).toHaveLength(1);
  expect(spawned[0].lock).toBe(false);
  expect(spawned[0].states).toEqual(["queued", "starting"]);
  expect(fs.existsSync(path.join(fleetDir(), "lock"))).toBe(false);
  expect(index.get("admit-lock")!.state).toBe("running");
  expect(states(store, "admit-lock")).toEqual(["queued", "starting", "running"]);
});

test("a lease conflict at acquire writes conflict, rolls back and leaves the job queued", async () => {
  const { leases, store, scheduler, enqueue, spawned } = setup();
  leases.acquire({ port: 4101, jobId: "other", peer: "tester", sessionId: "other", holder: selfSupervisor("library") });
  const check = leases.check.bind(leases);
  // Simulate the race: the planner's check sees the port free, the acquire then loses to a live lease.
  leases.check = ((port: number, forJobId?: string) => (port === 4101 ? null : check(port, forJobId))) as LeaseManager["check"];
  enqueue("conflict", { queue: queueOf({ leasePorts: [4100, 4101] }) });
  const plan = await scheduler.tick();
  expect(plan.admit).toEqual(["conflict"]);
  expect(leases.get(4100)).toBeNull();
  expect(leases.get(4101)?.jobId).toBe("other");
  expect(spawned).toHaveLength(0);
  expect(states(store, "conflict")).toEqual(["queued"]);
  expect(leaseEvents(store, "conflict").map((event) => [event.action, event.port]))
    .toEqual([["acquired", 4100], ["conflict", 4101]]);
});

test("policy defer and resume are written once per transition and only to affected queued jobs", async () => {
  let gpu = 90;
  const { index, store, scheduler, enqueue } = setup({ guardProbes: { accelerators: () => snapshot(gpu) } });
  enqueue("gpu-job", { queue: queueOf({ resources: { gpu: true } }) });
  enqueue("cpu-job");
  await scheduler.tick(); // defer, cpu-job admitted
  await scheduler.tick(); // no transition
  gpu = 75;
  await scheduler.tick(); // hysteresis: still closed, no event
  expect(policyEvents(store, "gpu-job").map((event) => [event.decision, event.rule, event.measured, event.threshold]))
    .toEqual([["defer", "gpu-busy", 90, 85]]);
  expect(policyEvents(store, "cpu-job")).toHaveLength(0);
  gpu = 60;
  await scheduler.tick(); // resume, gpu-job admitted
  expect(policyEvents(store, "gpu-job").map((event) => [event.decision, event.rule, event.measured, event.threshold]))
    .toEqual([["defer", "gpu-busy", 90, 85], ["resume", "gpu-busy", 60, 70]]);
  await scheduler.tick(); // running, no new policy event
  expect(policyEvents(store, "gpu-job")).toHaveLength(2);
  expect(index.get("gpu-job")!.state).toBe("running");
});

test("a kill marker cancels an own queued job before admission", async () => {
  const { index, store, scheduler, enqueue, spawned } = setup();
  enqueue("cancel-me");
  writeKillRequest("cancel-me", { by: "session:abc", reason: "cancelled", at: new Date().toISOString(), detail: "stop" });
  const plan = await scheduler.tick();
  expect(plan.admit).toEqual([]);
  expect(index.get("cancel-me")).toMatchObject({ state: "killed", stateReason: "cancelled" });
  expect(states(store, "cancel-me")).toEqual(["queued", "killed"]);
  expect(spawned).toHaveLength(0);
});

test("overlapping ticks never overlap and share exactly one follow-up pass", async () => {
  let releaseSpawn!: () => void;
  const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve; });
  let spawnEntered!: () => void;
  const entered = new Promise<void>((resolve) => { spawnEntered = resolve; });
  const gate: typeof spawnContainedAgent = (async () => { spawnEntered(); await spawnGate; return fakeAgent(); }) as typeof spawnContainedAgent;
  const { leases, scheduler, enqueue } = setup({ spawn: gate });
  const sweep = leases.sweep.bind(leases);
  let passes = 0;
  leases.sweep = () => { passes += 1; return sweep(); };
  enqueue("overlap");
  const first = scheduler.tick();
  await entered;
  expect(passes).toBe(1);
  const during = [scheduler.tick(), scheduler.tick(), scheduler.tick()];
  expect(new Set(during).size).toBe(1);
  expect(passes).toBe(1); // no second pass started while the first is still in flight
  releaseSpawn();
  const [firstPlan, followUp] = await Promise.all([first, during[0]]);
  expect(firstPlan.admit).toEqual(["overlap"]);
  expect(followUp.admit).toEqual([]);
  expect(passes).toBe(2); // several calls during one pass produced exactly one follow-up
  expect(during[1]).toBe(during[0]);
});

test("stop() clears the polling timer", async () => {
  const { leases, scheduler } = setup({ policy: { pollMs: 20 } });
  const sweep = leases.sweep.bind(leases);
  let passes = 0;
  leases.sweep = () => { passes += 1; return sweep(); };
  scheduler.start();
  await delay(120);
  expect(passes).toBeGreaterThan(0);
  scheduler.stop();
  const atStop = passes;
  await delay(120);
  expect(passes).toBe(atStop);
  scheduler.stop();
});

test("a throwing tick rejects but does not wedge later ticks", async () => {
  let calls = 0;
  const { scheduler, enqueue, spawned } = setup({
    guardProbes: { accelerators: () => { if (calls++ === 0) throw new Error("probe boom"); return undefined; } },
  });
  enqueue("after-throw");
  await expect(scheduler.tick()).rejects.toThrow("probe boom");
  expect(fs.existsSync(path.join(fleetDir(), "lock"))).toBe(false);
  expect((await scheduler.tick()).admit).toEqual(["after-throw"]);
  expect(spawned).toHaveLength(1);
});

const CHILD_PORTS = [4610, 4610, 4611, 4611];
function f14ChildScript(): string {
  const url = (name: string): string => JSON.stringify(pathToFileURL(path.join(REPO, "src", name)).href);
  return `import * as fs from "node:fs";
import { EventStore } from ${url("event-store.ts")};
import { JobIndex } from ${url("job-index.ts")};
import { JobRuntime, selfSupervisor } from ${url("job-runtime.ts")};
import { LeaseManager } from ${url("leases.ts")};
import { DEFAULT_ADMISSION_POLICY, ResourcePolicyGuard } from ${url("policy.ts")};
import { Scheduler } from ${url("scheduler.ts")};

const label = process.env.CHILD_LABEL, journal = process.env.CHILD_JOURNAL, pool = ${JSON.stringify(CHILD_PORTS)};
const ports = label === "a" ? pool.slice(0, 3) : pool.slice(1);
const policy = { ...DEFAULT_ADMISSION_POLICY, maxRunning: 2, maxRunningPerPeer: 16, maxRunningPerHarness: 16, pollMs: 250, defaultLeaseTtlMs: 60000 };
const store = new EventStore();
const index = new JobIndex(store, { readV1: () => [] });
const leases = new LeaseManager({ listeners: () => [], alive: () => true });
const guard = new ResourcePolicyGuard(policy, { accelerators: () => undefined, freeMemoryMb: () => 100000 });
const portOf = new Map();
let scheduler;
const runtime = new JobRuntime({
  store, index,
  spawn: async (options) => {
    index.refresh();
    const lease = leases.get(portOf.get(options.jobId));
    fs.appendFileSync(journal, JSON.stringify({ type: "spawn", label, jobId: options.jobId, port: portOf.get(options.jobId),
      running: index.runningCounts().total, leaseJob: lease === null ? null : lease.jobId }) + "\\n");
    let finish;
    const exited = new Promise((resolve) => { finish = resolve; });
    setTimeout(() => finish(0), 120).unref();
    return { jobId: options.jobId, pid: process.pid, containmentMode: "passive-ppid", exited, startTime: "1700000000000",
      terminate: async () => { finish(143); return { killedPids: [], failedPids: [], errors: [] }; } };
  },
  hooks: {
    beforeTerminal: (jobId) => { leases.releaseJob(jobId); },
    afterTerminal: () => { if (scheduler !== undefined) void scheduler.tick().catch(() => undefined); },
  },
});
scheduler = new Scheduler({ runtime, index, leases, guard, policy: () => policy, listeners: () => [] });
const base = Date.now();
for (let i = 0; i < ports.length; i++) {
  const jobId = label + "-" + i;
  portOf.set(jobId, ports[i]);
  runtime.enqueue({
    version: 2, jobId, state: "queued", stateReason: "submitted", harness: "custom", command: "echo", args: [], cwd: process.cwd(),
    peer: "tester", backend: "unknown", owner: { sessionId: "s-" + label, tokenHash: "", surface: "library" }, visibility: "owner",
    supervisor: selfSupervisor("library"), containment: null,
    capture: { kind: "none", ringBytes: 0, spool: "off", spoolMaxBytes: 0, redact: true },
    queue: { admission: "queued", priority: 0, dependsOn: [], resources: {}, leasePorts: [ports[i]], leaseTtlMs: 60000, timeoutMs: 0, maxQueueMs: 0 },
    envKeys: [], createdAt: new Date(base + i).toISOString(), startedAt: null, exitedAt: null, exitCode: null, signal: null,
    lastSeq: 0, outputBytes: { stdout: 0, stderr: 0 }, error: null,
  }, {});
}
scheduler.start();
void scheduler.tick().catch(() => undefined);
setTimeout(() => {
  scheduler.stop();
  index.refresh();
  fs.appendFileSync(journal, JSON.stringify({ type: "done", label, states: index.list().map((record) => [record.jobId, record.state]) }) + "\\n");
  process.exit(0);
}, 2600);
`;
}
function runChild(script: string, label: string, journal: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, CHILD_LABEL: label, CHILD_JOURNAL: journal }, stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}
function maxOverlap(intervals: Array<[number, number]>): number {
  const points = intervals.flatMap(([start, end]) => [{ at: start, delta: 1 }, { at: end, delta: -1 }]);
  points.sort((a, b) => a.at - b.at || a.delta - b.delta); // a terminal at t frees the slot at t
  let current = 0, max = 0;
  for (const point of points) { current += point.delta; max = Math.max(max, current); }
  return max;
}

test("F14: two supervisors on one state directory respect maxRunning and a shared port", async () => {
  const journal = path.join(root, "journal.jsonl"), script = path.join(root, "f14-child.ts");
  fs.writeFileSync(script, f14ChildScript());
  const runs = await Promise.all([runChild(script, "a", journal), runChild(script, "b", journal)]);
  expect(runs.map((run) => run.code)).toEqual([0, 0]); // stderr may hold Bun's harmless stdout-sync note
  const lines = fs.readFileSync(journal, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const spawns = lines.filter((line) => line.type === "spawn");
  expect(spawns).toHaveLength(6);
  expect(new Set(spawns.map((line) => line.label)).size).toBe(2);
  for (const line of spawns) {
    expect(line.running).toBeLessThanOrEqual(2);
    expect(line.leaseJob).toBe(line.jobId); // the spawning job itself held the port
  }
  const store = new EventStore();
  const portOf = new Map(spawns.map((line) => [line.jobId as string, line.port as number]));
  const intervals: Array<{ jobId: string; start: number; end: number }> = [];
  for (const jobId of store.listJobIds()) {
    const events = store.readAllEvents(jobId).events;
    const start = events.find((event) => event.type === "state" && event.state === "starting");
    const end = events.find((event) => event.type === "state" && (event.state === "exited" || event.state === "failed" || event.state === "killed"));
    if (start !== undefined && end !== undefined) intervals.push({ jobId, start: Date.parse(start.timestamp), end: Date.parse(end.timestamp) });
  }
  const overlap = (subset: typeof intervals): number => maxOverlap(subset.map((interval) => [interval.start, interval.end]));
  expect(intervals).toHaveLength(6);
  expect(overlap(intervals)).toBeLessThanOrEqual(2);
  for (const port of new Set(portOf.values())) {
    // Jobs that share a port never run at the same time, across both supervisors.
    expect(overlap(intervals.filter((interval) => portOf.get(interval.jobId) === port))).toBeLessThanOrEqual(1);
  }
  expect(new LeaseManager({ alive: () => true }).list()).toEqual([]); // every lease released at its terminal state
}, 30_000);
