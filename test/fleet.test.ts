import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { readAudit } from "../src/audit.js";
import { FleetService, type SubmitJobRequest } from "../src/fleet.js";
import { FleetError } from "../src/fleet-errors.js";
import { readKillRequest, selfSupervisor, type SessionIdentity } from "../src/job-runtime.js";
import type { Caller } from "../src/ownership.js";
import { DEFAULT_ADMISSION_POLICY } from "../src/policy.js";
import { withFleetLock } from "../src/reconcile.js";
import { writeJob, type ProcessIdentity } from "../src/registry.js";
import type { CaptureProvider, FleetSurface, JobRecord, ManagedAgent, SpawnAgentOptions, StateEvent } from "../src/types.js";
// isStaleJob only judges the running platform's containment mode, so fake leftover records use it;
// on Windows a Job Object that does not exist counts as gone (OpenJobObject: ERROR_FILE_NOT_FOUND).
const ghostMode = (process.platform === "win32" ? { mode: "win32-job-object", jobName: "agtop-test-missing-job" }
  : { mode: process.platform === "darwin" ? "darwin-env-pgid" : "linux-env-pgid" }) as Pick<JobRecord, "mode" | "jobName">;

let root = "", previousStateDir: string | undefined;
const services: FleetService[] = [];
const fakes = new Map<string, { finish(code: number): void; out?: { stdout: PassThrough; stderr: PassThrough } }>();
beforeEach(() => {
  previousStateDir = process.env.AGTOP_STATE_DIR;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-fleet-"));
  process.env.AGTOP_STATE_DIR = root;
});
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  fakes.clear(); fs.rmSync(root, { recursive: true, force: true });
  if (previousStateDir === undefined) delete process.env.AGTOP_STATE_DIR; else process.env.AGTOP_STATE_DIR = previousStateDir;
});

const identity = (sessionId: string, token = `${sessionId}-token`.padEnd(40, "x")): SessionIdentity =>
  ({ sessionId, ownerToken: token, tokenHash: createHash("sha256").update(token).digest("hex") });
const admin: Caller = { kind: "admin" };
const asSession = (service: FleetService, peer = "agent-1"): Caller => ({ kind: "session", session: service.session, peer });
const codeOf = (fn: () => unknown): string | undefined => { try { fn(); return undefined; } catch (error) { return error instanceof FleetError ? error.code : String(error); } };

async function openFleet(surface: FleetSurface = "library", session?: SessionIdentity, refresher?: { scan: (signal: AbortSignal) => Promise<ProcessIdentity[]>; intervalMs?: number; idleMs?: number }): Promise<FleetService> {
  const spawn = (async (options: SpawnAgentOptions) => {
    let finish!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { finish = resolve; });
    const out = options.stdio === "capture" ? { stdout: new PassThrough(), stderr: new PassThrough() } : undefined;
    fakes.set(options.jobId!, { finish, ...(out === undefined ? {} : { out }) });
    return {
      jobId: options.jobId!, pid: 4242, containmentMode: "passive-ppid", exited, startTime: "1700000000000",
      ...(out === undefined ? {} : { output: out }),
      terminate: async () => { out?.stdout.end(); out?.stderr.end(); finish(143); return { killedPids: [4242], failedPids: [], errors: [] }; },
    } as ManagedAgent;
  }) as typeof import("../src/manager.js").spawnContainedAgent;
  const capture: CaptureProvider = {
    kind: "pipe",
    open: async () => ({
      posixStdio: () => ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"], windowsHandles: () => ({ stdin: 0, stdout: 0, stderr: 0 }),
      attach: () => { throw new Error("the fake spawn attaches its own streams"); }, releaseChildEnds: () => {}, dispose: () => {},
    }),
  };
  const snapshot = (): Array<{ pid: number; startTime: string }> => [{ pid: process.pid, startTime: selfSupervisor("library").startTime }];
  const service = await FleetService.open({ surface, ...(session === undefined ? {} : { session }), spawn, capture,
    ...(refresher === undefined ? {} : { stalenessScan: refresher.scan, stalenessRefreshMs: refresher.intervalMs, ...(refresher.idleMs === undefined ? {} : { stalenessIdleRescanMs: refresher.idleMs }) }),
    reconcile: { snapshot }, guard: { accelerators: () => undefined, freeMemoryMb: () => 100_000 } });
  services.push(service);
  return service;
}
async function finish(service: FleetService, jobId: string, code = 0): Promise<void> {
  const fake = fakes.get(jobId)!;
  fake.out?.stdout.end(); fake.out?.stderr.end(); fake.finish(code);
  await service.wait(jobId, 5000);
}
function write(jobId: string, text: string): void { fakes.get(jobId)!.out!.stdout.write(text); }

test("submit applies every default, records env keys only, and starts immediately", async () => {
  const service = await openFleet("library", identity("session-a"));
  const summary = await service.submit({ command: "echo", extraEnv: { SECRET: "hunter2" } }, asSession(service, "agent-1"));
  expect(summary.state).toBe("running"); expect(summary.owned).toBe(true);
  expect(summary.jobId).toMatch(/^[0-9a-f-]{36}$/);
  const record = service.get(summary.jobId, admin).record!;
  expect(record).toMatchObject({
    version: 2, state: "running", harness: "custom", command: "echo", args: [], cwd: process.cwd(), peer: "agent-1",
    backend: "unknown", visibility: "owner", envKeys: ["SECRET"], startedAt: expect.any(String),
    containment: { mode: "passive-ppid", rootPid: 4242, startTime: "1700000000000" },
  });
  expect(record.capture).toEqual({ kind: "pipe", ringBytes: 1_048_576, spool: "tail", spoolMaxBytes: 268_435_456, redact: true });
  expect(record.queue).toEqual({
    admission: "immediate", priority: 0, dependsOn: [], resources: {}, leasePorts: [], leaseTtlMs: 600_000, timeoutMs: 0, maxQueueMs: 0,
  });
  expect(record.owner).toEqual({ sessionId: "session-a", tokenHash: service.session.tokenHash, surface: "library" });
  expect(record.supervisor).toMatchObject({ pid: process.pid, surface: "library" });
  expect(JSON.stringify(record)).not.toContain("hunter2");
});

test("staleness refresher runs only for unshadowed v1 records, outside the lock, and stops on close", async () => {
  let calls = 0;
  const service = await openFleet("library", identity("refresh"), { scan: async () => { calls++; expect(fs.existsSync(path.join(root, "fleet", "lock"))).toBe(false); return []; }, intervalMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(calls).toBe(0);
  writeJob({ version: 1, jobId: "ghost", rootPid: 99991, startTime: "1", harness: "custom", peer: "tester", cwd: root, backend: "unknown", ...ghostMode, createdAt: new Date(Date.now() - 60_000).toISOString() } as JobRecord);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(calls).toBeGreaterThan(0);
  await service.close();
  const stoppedAt = calls;
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(calls).toBe(stoppedAt);
});

test("a v1 job created after the last view occupies maxRunning until a later view proves it stale", async () => {
  const stale = { version: 1 as const, jobId: "old-v1", rootPid: 99990, startTime: "1", harness: "custom", peer: "tester", cwd: root, backend: "unknown", ...ghostMode, createdAt: new Date(Date.now() - 120_000).toISOString() };
  writeJob(stale as JobRecord);
  // Scans after the first wait for the gate, so no new view can land before the "still live" checks
  // (a slow CI runner otherwise reaches the next 20 ms tick first).
  let scans = 0, first!: () => void, openGate!: () => void;
  const firstScan = new Promise<void>((resolve) => { first = resolve; });
  const gate = new Promise<void>((resolve) => { openGate = resolve; });
  const service = await openFleet("library", identity("caps"), { intervalMs: 20, scan: async () => { scans++; if (scans === 1) { first(); return []; } await gate; return []; } });
  service.setPolicy({ ...DEFAULT_ADMISSION_POLICY, maxRunning: 1 });
  await firstScan;
  await new Promise((resolve) => setTimeout(resolve, 0));
  const fresh = { ...stale, jobId: "fresh-v1", rootPid: 99989, createdAt: new Date().toISOString() };
  writeJob(fresh as JobRecord);
  const queued = await service.submit({ command: "echo later", admission: "queued" }, asSession(service));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(service.get("fresh-v1", asSession(service)).job.state).toBe("running");
  expect(service.get(queued.jobId, asSession(service)).job.state).toBe("queued");
  openGate();
  // A scan that began before fresh-v1 existed cannot prove it dead; a later one does.
  for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
    if (codeOf(() => service.get("fresh-v1", asSession(service))) === "E_JOB_NOT_FOUND" && service.get(queued.jobId, asSession(service)).job.state !== "queued") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(codeOf(() => service.get("fresh-v1", asSession(service)))).toBe("E_JOB_NOT_FOUND");
  expect(service.get(queued.jobId, asSession(service)).job.state).toBe("running");
});
test("staleness refresher keeps the last view on failure, scans once per unchanged set, and aborts on close", async () => {
  writeJob({ version: 1, jobId: "gone-v1", rootPid: 99_988, startTime: "1", harness: "custom", peer: "tester", cwd: root, backend: "unknown", ...ghostMode, createdAt: new Date(Date.now() - 60_000).toISOString() } as JobRecord);
  fs.utimesSync(path.join(root, "gone-v1.json"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  let calls = 0, release!: () => void, aborted = false;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const service = await openFleet("library", identity("backoff"), { intervalMs: 5, idleMs: 60_000, scan: async (signal: AbortSignal) => {
    calls++;
    if (calls === 1) return [];
    signal.addEventListener("abort", () => { aborted = true; });
    await hold; // a slow scan: the next ticks must not start another one
    throw new Error("scan failed");
  } });
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(calls).toBe(1); // the set of v1 records did not change, so no rescan
  expect(codeOf(() => service.get("gone-v1", asSession(service)))).toBe("E_JOB_NOT_FOUND");
  writeJob({ version: 1, jobId: "another-v1", rootPid: 99_987, startTime: "1", harness: "custom", peer: "tester", cwd: root, backend: "unknown", ...ghostMode, createdAt: new Date(Date.now() - 60_000).toISOString() } as JobRecord);
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(calls).toBe(2); // the set changed: one more scan, which is still in flight
  release(); await new Promise((resolve) => setTimeout(resolve, 10));
  expect(codeOf(() => service.get("gone-v1", asSession(service)))).toBe("E_JOB_NOT_FOUND"); // the failed scan kept the last view
  await service.close();
  expect(aborted).toBe(true);
});

test("every submit validation failure names its field", async () => {
  const service = await openFleet(), caller = asSession(service);
  const cases: Array<[string, Record<string, unknown>]> = [
    ["jobId", { jobId: "bad/id" }], ["jobId", { jobId: 42 }], ["harness", { harness: "nope" }], ["command", { command: "" }],
    ["command", { command: "x".repeat(4097) }], ["command", { command: "a\0b" }], ["command", { command: 42 }], ["args", { args: "x" }],
    ["args", { args: Array(257).fill("x") }], ["args", { args: [1] }], ["args", { args: ["x".repeat(32_769)] }], ["cwd", { cwd: path.join(root, "missing") }], ["cwd", { cwd: 42 }],
    ["peer", { peer: "p".repeat(201) }], ["peer", { peer: 42 }], ["capture", { capture: "yes" }], ["redact", { redact: "no" }],
    ["ringBytes", { ringBytes: 65_535 }], ["ringBytes", { ringBytes: 1.5 }], ["ringBytes", { ringBytes: 16_777_217 }], ["spool", { spool: "some" }],
    ["visibility", { visibility: "nobody" }], ["admission", { admission: "soon" }], ["priority", { priority: 101 }],
    ["dependsOn", { dependsOn: Array(17).fill("a") }], ["dependsOn", { dependsOn: ["bad/id"] }], ["dependsOn", { dependsOn: "x" }],
    ["resources", { resources: { memoryMb: 0 } }], ["resources", { resources: { gpu: "yes" } }],
    ["resources", { resources: { other: true } }], ["resources", { resources: "x" }], ["leasePorts", { leasePorts: [0] }],
    ["leasePorts", { leasePorts: [1, 1] }], ["leasePorts", { leasePorts: Array(9).fill(1) }], ["leasePorts", { leasePorts: "x" }],
    ["leaseTtlMs", { leaseTtlMs: 9_999 }], ["timeoutMs", { timeoutMs: -1 }], ["maxQueueMs", { maxQueueMs: 604_800_001 }], ["extra", { extra: true }],
    ["lemonadeUrl", { lemonadeUrl: "x".repeat(2049) }], ["cgroupRoot", { cgroupRoot: "x".repeat(4097) }],
  ];
  for (const [field, request] of cases) {
    const error = await service.submit({ command: "echo", ...request } as SubmitJobRequest, caller).catch((caught) => caught);
    expect(error instanceof FleetError).toBe(true);
    expect(error).toMatchObject({ code: "E_INVALID_REQUEST", details: { field } });
  }
  const peer: Caller = { kind: "peer", peer: { id: "peer-a", url: "https://a", publicKey: "", scopes: [], jobPeerPrefixes: [], enabled: true, addedAt: "", lastSeenAt: null } };
  for (const [field, request] of [["redact", { redact: false }], ["extraEnv", { extraEnv: { A: "b" } }], ["cgroupRoot", { cgroupRoot: "/x" }], ["peer", { peer: `peer:peer-a-${"x".repeat(250)}` }]] as const) {
    const error = await service.submit({ command: "echo", ...request } as SubmitJobRequest, peer).catch((caught) => caught);
    expect(error).toMatchObject({ code: "E_INVALID_REQUEST", details: { field } });
  }
});

test("dependencies, terminal job reuse and E_JOB_EXISTS", async () => {
  const service = await openFleet(), caller = asSession(service);
  await expect(service.submit({ command: "echo", jobId: "dep", dependsOn: ["ghost"] }, caller)).rejects.toMatchObject({ code: "E_DEPENDENCY_NOT_FOUND" });
  await expect(service.submit({ command: "echo", jobId: "self", dependsOn: ["self"] }, caller)).rejects.toMatchObject({ code: "E_DEPENDENCY_CYCLE" });
  await service.submit({ command: "echo", jobId: "taken" }, caller);
  await expect(service.submit({ command: "echo", jobId: "taken" }, caller)).rejects.toMatchObject({ code: "E_JOB_EXISTS" });
  await finish(service, "taken");
  expect((await service.submit({ command: "echo", jobId: "taken" }, caller)).state).toBe("running");
});

test("the admission default is immediate, else queued; an immediate lease conflict creates nothing", async () => {
  const service = await openFleet(), caller = asSession(service);
  expect((await service.submit({ command: "echo", jobId: "now" }, caller)).state).toBe("running");
  expect((await service.submit({ command: "echo", jobId: "later", priority: 0 }, caller)).state).toBe("queued");
  const holder = service.leases.acquire({ port: 4701, jobId: "holder", peer: "x", sessionId: "y", holder: selfSupervisor("library") });
  const error = await service.submit({ command: "echo", jobId: "blocked", leasePorts: [4701], admission: "immediate" }, caller).catch((caught) => caught);
  expect(error.code).toBe("E_LEASE_CONFLICT"); expect(error.details?.holder).toBeDefined();
  expect(codeOf(() => service.get("blocked", admin))).toBe("E_JOB_NOT_FOUND");
  expect(service.list({}, admin).jobs.map((job) => job.jobId)).not.toContain("blocked");
  expect((await service.submit({ command: "echo", jobId: "leased", leasePorts: [4702], admission: "immediate" }, caller)).state).toBe("running");  expect(service.leases.get(4702)?.jobId).toBe("leased");
  const view = service.get("leased", admin);
  expect(view.leases[0]).toMatchObject({ port: 4702, jobId: "leased" });
  expect(view.leases[0]).not.toHaveProperty("leaseId");
  expect(view.leases[0]).not.toHaveProperty("sessionId");
  service.leases.release(4701, holder.leaseId);
});

test("output is served from the live ring, then from the spool; capture and spool errors", async () => {
  const a = await openFleet("library", identity("session-a"));
  await a.submit({ command: "echo", jobId: "out" }, asSession(a));
  write("out", "hello ring\n");
  await finish(a, "out");
  const memory = a.output("out", { stream: "stdout" }, admin);
  expect(memory.source).toBe("memory"); expect(memory.chunks.map((chunk) => chunk.data).join("")).toContain("hello ring");
  const b = await openFleet("library", identity("session-b"));
  const spool = b.output("out", { stream: "stdout" }, admin);
  expect(spool.source).toBe("spool"); expect(spool.chunks.map((chunk) => chunk.data).join("")).toContain("hello ring");
  await a.submit({ command: "echo", jobId: "nocap", capture: false }, asSession(a));
  await finish(a, "nocap");
  expect(codeOf(() => a.output("nocap", {}, admin))).toBe("E_CAPTURE_DISABLED");
  await a.submit({ command: "echo", jobId: "off", spool: "off" }, asSession(a));
  write("off", "gone\n");
  await finish(a, "off");
  const c = await openFleet("library", identity("session-c"));
  expect(codeOf(() => c.output("off", {}, admin))).toBe("E_OUTPUT_UNAVAILABLE");
});

test("list hides command lines from non-owners and pages with nextAfter", async () => {
  const service = await openFleet("library", identity("session-a"));
  for (const jobId of ["j1", "j2", "j3"]) { await service.submit({ command: `secret-${jobId}`, jobId }, asSession(service)); await finish(service, jobId); }
  const first = service.list({ limit: 2 }, admin);
  expect(first.jobs).toHaveLength(2); expect(first.jobs[0]!.command).toBeDefined();
  expect(first.nextAfter).not.toBeNull();
  const rest = service.list({ limit: 2, after: first.nextAfter! }, admin);
  expect(rest.jobs).toHaveLength(1); expect(rest.nextAfter).toBeNull();
  const foreign = service.list({}, { kind: "session", session: identity("session-z"), peer: "z" });
  expect(foreign.jobs).toHaveLength(3);
  for (const job of foreign.jobs) {
    expect(job.owned).toBe(false);
    expect([job.command, job.args, job.cwd]).toEqual([undefined, undefined, undefined]);
  }
  expect(codeOf(() => service.list({ limit: 0 }, admin))).toBe("E_INVALID_REQUEST");
});

test("events are readable and never carry the token hash", async () => {
  const service = await openFleet("library", identity("session-a"));
  await service.submit({ command: "echo", jobId: "ev" }, asSession(service));
  const page = service.events("ev", { types: ["state"], limit: 1000 }, admin);
  expect(page.events.length).toBeGreaterThan(0); expect((page.events[0] as StateEvent).record?.owner.tokenHash).toBe("");
  expect(JSON.stringify(page)).not.toContain(service.session.tokenHash);
});

test("kill terminates own jobs, marks foreign queued jobs, and audits admin kills", async () => {
  const a = await openFleet("library", identity("session-a"));
  await a.submit({ command: "echo", jobId: "own" }, asSession(a));
  const killed = await a.kill("own", asSession(a), "stop it");
  expect(killed.result?.killedPids).toEqual([4242]); expect(killed.job.state).toBe("killed");
  await a.submit({ command: "echo", jobId: "dep" }, asSession(a));
  await a.submit({ command: "echo", jobId: "waiting", dependsOn: ["dep"], priority: 0 }, asSession(a));
  a.setPolicy({ ...DEFAULT_ADMISSION_POLICY, maxQueued: 1 });
  expect((await a.submit({ command: "echo", jobId: "overflow", dependsOn: ["dep"], priority: 0 }, asSession(a)).catch((caught) => caught)).code).toBe("E_QUEUE_FULL");
  const b = await openFleet("library", identity("session-b"));
  expect((await b.kill("waiting", admin)).result).toBeNull();
  expect(readKillRequest("waiting")?.by).toBe("admin");
  expect(readAudit().some((record) => record.event === "admin-kill" && record.jobId === "waiting")).toBe(true);
  expect((await b.kill("dep", asSession(b)).catch((caught) => caught)).code).toBe("E_NOT_OWNER");
});

test("close terminates only jobs this process supervises", async () => {
  const a = await openFleet("library", identity("session-a"));
  const b = await openFleet("library", identity("session-b"));
  await a.submit({ command: "echo", jobId: "a-job" }, asSession(a));
  await b.submit({ command: "echo", jobId: "b-job" }, asSession(b));
  const [first, second] = [a.close(), a.close()];
  expect(second).toBe(first); // concurrent callers share one shutdown
  await second;
  expect(a.get("a-job", admin).job.state).toBe("killed"); expect(b.get("b-job", admin).job.state).toBe("running");
});

test("close during an admission pass waiting for the fleet lock starts nothing afterwards", async () => {
  const service = await openFleet("library", identity("session-a"));
  let release!: () => void;
  const held = withFleetLock(() => new Promise<void>((resolve) => { release = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  // Queued admission triggers a scheduler tick that now waits for the lock; close() races it.
  await service.submit({ command: "echo", jobId: "racing", priority: 1 }, asSession(service));
  const closing = service.close();
  setTimeout(() => release(), 100);
  await closing; await held;
  await new Promise((resolve) => setTimeout(resolve, 200));
  // shutdown() cancels own queued jobs, so the job ends killed; it must never have been started.
  const states = service.events("racing", {}, admin).events.flatMap((event) => (event.type === "state" ? [event.state] : []));
  expect(states).not.toContain("starting");
  expect(service.get("racing", admin).job.state).toBe("killed");
  await expect(service.submit({ command: "echo" }, asSession(service))).rejects.toMatchObject({ code: "E_INTERNAL" });
});

test("an immediate submit waiting for the fleet lock is refused if close() runs meanwhile", async () => {
  const service = await openFleet("library", identity("session-a"));
  let release!: () => void;
  const held = withFleetLock(() => new Promise<void>((resolve) => { release = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const pending = service.submit({ command: "echo", jobId: "late-immediate" }, asSession(service)).catch((caught) => caught);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await service.close();
  release(); await held;
  expect(await pending).toMatchObject({ code: "E_INTERNAL" });
  expect(codeOf(() => service.get("late-immediate", admin))).toBe("E_JOB_NOT_FOUND");
});

test("redact:false stores raw output, records it, and audits once", async () => {
  const service = await openFleet("library", identity("session-a"));
  const secret = `sk-${"a".repeat(30)}`;
  await service.submit({ command: "echo", jobId: "raw", redact: false }, asSession(service));
  write("raw", `${secret}\n`);
  await finish(service, "raw");
  expect(service.get("raw", admin).record?.capture.redact).toBe(false);
  expect(service.output("raw", { stream: "stdout" }, admin).chunks.map((chunk) => chunk.data).join("")).toContain(secret);
  expect(readAudit().filter((record) => record.event === "redact-disabled" && record.jobId === "raw")).toHaveLength(1);});

test("wait times out on a live job and resolves at its terminal state", async () => {
  const service = await openFleet();
  await service.submit({ command: "echo", jobId: "waity" }, asSession(service));
  expect(await service.wait("waity", 20)).toMatchObject({ exited: false, timedOut: true, state: "running" });
  await finish(service, "waity");
  expect(await service.wait("waity", 1000)).toMatchObject({ exited: true, state: "exited", exitCode: 0 });
});
test("setPolicy persists, reaches the guard, and is audited", async () => {
  const service = await openFleet();
  service.setPolicy({ ...DEFAULT_ADMISSION_POLICY, maxRunning: 3 });
  expect(service.queue().policy.maxRunning).toBe(3); expect(service.queue().guards.map((guard) => guard.rule)).toEqual(["gpu-busy", "npu-busy", "memory-low"]);
  expect(readAudit().some((record) => record.event === "policy-changed")).toBe(true);
  expect(fs.existsSync(path.join(root, "fleet", "policy.json"))).toBe(true);
  expect(codeOf(() => service.setPolicy({ ...DEFAULT_ADMISSION_POLICY, maxRunning: 0 }))).toBe("E_INVALID_REQUEST");
});
