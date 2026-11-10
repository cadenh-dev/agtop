import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { EventStore } from "../src/event-store.js";
import { JobIndex } from "../src/job-index.js";
import { JobRuntime, newSessionIdentity, selfSupervisor, writeKillRequest, type RuntimeDeps } from "../src/job-runtime.js";
import { supervisorAlive } from "../src/reconcile.js";
import { pipeCaptureProvider } from "../src/streams.js";
import type { CaptureProvider, CaptureSession, CaptureSpec, JobRecordV2, KillResult, ManagedAgent, SpawnAgentOptions, StateEvent } from "../src/types.js";

let root = "", previousStateDir: string | undefined;
beforeEach(() => {
  previousStateDir = process.env.AGTOP_STATE_DIR;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-runtime-"));
  process.env.AGTOP_STATE_DIR = root;
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (previousStateDir === undefined) delete process.env.AGTOP_STATE_DIR; else process.env.AGTOP_STATE_DIR = previousStateDir;
});

const NO_CAPTURE: CaptureSpec = { kind: "none", ringBytes: 0, spool: "off", spoolMaxBytes: 0, redact: true };
const CAPTURE: CaptureSpec = { kind: "pipe", ringBytes: 65_536, spool: "tail", spoolMaxBytes: 1_048_576, redact: true };

function recordFor(jobId: string, overrides: Partial<JobRecordV2> = {}): JobRecordV2 {
  return {
    version: 2, jobId, state: "queued", stateReason: "submitted", harness: "custom", command: "echo", args: [], cwd: root, peer: "tester",
    backend: "unknown", owner: { sessionId: "session", tokenHash: "", surface: "library" }, visibility: "owner",
    supervisor: selfSupervisor("library"), containment: null, capture: CAPTURE,
    queue: { admission: "immediate", priority: 0, dependsOn: [], resources: {}, leasePorts: [], leaseTtlMs: 0, timeoutMs: 0, maxQueueMs: 0 },
    envKeys: [], createdAt: new Date().toISOString(), startedAt: null, exitedAt: null, exitCode: null, signal: null,
    lastSeq: 0, outputBytes: { stdout: 0, stderr: 0 }, error: null, ...overrides,
  };
}

function setup(options: { spawn?: typeof import("../src/manager.js").spawnContainedAgent; capture?: CaptureProvider; hooks?: RuntimeDeps["hooks"]; now?: () => number } = {}) {
  const store = new EventStore(), index = new JobIndex(store, { readV1: () => [] });
  return { store, index, runtime: new JobRuntime({ store, index, ...options }) };
}

const spawnOf = (agent: ManagedAgent | Error): typeof import("../src/manager.js").spawnContainedAgent =>
  (async (_options: SpawnAgentOptions) => { if (agent instanceof Error) throw agent; return agent; }) as typeof import("../src/manager.js").spawnContainedAgent;

function fakeAgent(onTerminate?: (finish: (code: number) => void) => KillResult | Promise<KillResult>): ManagedAgent & { finish(code: number): void } {
  let finish!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { finish = resolve; });
  return {
    jobId: "fake", pid: 4242, containmentMode: "passive-ppid", exited, startTime: "1700000000000",
    terminate: async () => {
      const result = onTerminate === undefined ? { killedPids: [4242], failedPids: [], errors: [] } : await onTerminate(finish);
      finish(143);
      return result;
    },
    finish,
  };
}

function states(store: EventStore, jobId: string): string[] {
  return store.readAllEvents(jobId).events.filter((event): event is StateEvent => event.type === "state").map((event) => event.state);
}

test("happy path: ordered lifecycle, contiguous seq, ring output and exit code", async () => {
  const { store, runtime } = setup({ capture: pipeCaptureProvider() });
  const jobId = "happy-path";
  const script = "process.stdout.write('hello fleet\\n');process.stderr.write('err line\\n');process.exitCode=3;";
  runtime.enqueue(recordFor(jobId, { command: process.execPath, args: ["-e", script] }), {});
  const running = await runtime.start(jobId);
  expect(running.state).toBe("running");
  expect(running.containment?.rootPid).toBeGreaterThan(0);
  const final = await runtime.wait(jobId);
  expect(final.state).toBe("exited");
  expect(final.exitCode).toBe(3);
  expect(final.containment?.startTime).not.toBe("");
  const page = store.readEvents(jobId, { types: ["state", "spawn", "stdout", "stderr", "exit"], limit: 1000 });
  expect(page.events.map((event) => event.seq)).toEqual(page.events.map((_, index) => index + 1));
  const lifecycle = page.events.filter((event) => event.type === "state" || event.type === "spawn" || event.type === "exit")
    .map((event) => event.type === "state" ? `state:${event.state}` : event.type);
  expect(lifecycle.slice(0, 4)).toEqual(["state:queued", "state:starting", "spawn", "state:running"]);
  expect(lifecycle.slice(-3)).toEqual(["state:exiting", "exit", "state:exited"]);
  const exit = page.events.find((event) => event.type === "exit");
  if (exit?.type !== "exit") throw new Error("missing exit event");
  expect(exit.drained).toBe(true);
  const text = (stream: "stdout" | "stderr") => runtime.ring(jobId)!.read({ stream, encoding: "utf8" }).chunks.map((chunk) => chunk.data).join("");
  expect(text("stdout")).toContain("hello fleet");
  expect(text("stderr")).toContain("err line");
}, 30_000);

test("capture open failure records failed/capture-error before rejecting", async () => {
  const hooks: string[] = [];
  const { store, index, runtime } = setup({
    capture: { kind: "pipe", open: async () => { throw new Error("no pipes"); } },
    hooks: { beforeTerminal: () => hooks.push("before"), afterTerminal: (record) => hooks.push(`after:${record.state}`) },
  });
  const jobId = "capture-error";
  runtime.enqueue(recordFor(jobId), {});
  await expect(runtime.start(jobId)).rejects.toThrow("no pipes");
  const record = index.get(jobId)!;
  expect(record.state).toBe("failed"); expect(record.stateReason).toBe("capture-error"); expect(record.error).toBe("no pipes");
  expect(hooks).toEqual(["before", "after:failed"]);
  expect(states(store, jobId)).toEqual(["queued", "starting", "failed"]);
});

test("spawn failure disposes the capture session and records failed/spawn-error", async () => {
  let disposed = 0, attached = 0;
  const session: CaptureSession = {
    posixStdio: () => ["ignore", "pipe", "pipe"],
    windowsHandles: () => ({ stdin: 0, stdout: 0, stderr: 0 }),
    attach: () => { attached++; return { stdout: new PassThrough(), stderr: new PassThrough() }; },
    releaseChildEnds: () => {}, dispose: () => { disposed++; },
  };
  const { store, index, runtime } = setup({ capture: { kind: "pipe", open: async () => session }, spawn: spawnOf(new Error("spawn exploded")) });
  const jobId = "spawn-error";
  runtime.enqueue(recordFor(jobId), {});
  await expect(runtime.start(jobId)).rejects.toThrow("spawn exploded");
  expect(index.get(jobId)!.state).toBe("failed"); expect(index.get(jobId)!.stateReason).toBe("spawn-error");
  expect(disposed).toBe(1); expect(attached).toBe(0);
  expect(states(store, jobId)).toEqual(["queued", "starting", "failed"]);
});

test("kill writes exiting before terminate() and ends killed", async () => {
  const store = new EventStore(), index = new JobIndex(store, { readV1: () => [] });
  const jobId = "kill-running";
  let sawExiting = false;
  const agent = fakeAgent(() => {
    sawExiting = states(store, jobId).includes("exiting");
    return { killedPids: [4242], failedPids: [], errors: [] };
  });
  const runtime = new JobRuntime({ store, index, spawn: spawnOf(agent) });
  runtime.enqueue(recordFor(jobId, { capture: NO_CAPTURE }), {});
  await runtime.start(jobId);
  const result = await runtime.kill(jobId, "kill-requested");
  expect(sawExiting).toBe(true);
  expect(result?.killedPids).toEqual([4242]);
  const final = await runtime.wait(jobId);
  expect(final.state).toBe("killed"); expect(final.stateReason).toBe("kill-requested");
  expect(states(store, jobId)).toEqual(["queued", "starting", "running", "exiting", "killed"]);
  expect(index.get(jobId)!.state).toBe("killed");
});

test("timeout is measured from running and ends killed/timeout", async () => {
  const { runtime } = setup({ spawn: spawnOf(fakeAgent()) });
  const jobId = "timeout-job";
  runtime.enqueue(recordFor(jobId, { capture: NO_CAPTURE, queue: { ...recordFor(jobId).queue, timeoutMs: 50 } }), {});
  await runtime.start(jobId);
  const final = await runtime.wait(jobId);
  expect(final.state).toBe("killed"); expect(final.stateReason).toBe("timeout");
}, 15_000);

test("kill of a queued job is killed/cancelled without spawning", async () => {
  const { index, runtime } = setup();
  const jobId = "queued-kill";
  runtime.enqueue(recordFor(jobId, { capture: NO_CAPTURE }), {});
  expect(await runtime.kill(jobId, "cancelled")).toBeNull();
  const final = await runtime.wait(jobId);
  expect(final.state).toBe("killed"); expect(final.stateReason).toBe("cancelled");
  expect(final.exitedAt).not.toBeNull();
  expect(index.get(jobId)!.lastSeq).toBeGreaterThan(1);
  expect(await runtime.kill(jobId, "cancelled")).toBeNull();
});

test("start() on a job cancelled while queued rejects without launching or firing hooks", async () => {
  const calls: string[] = [];
  const { store, runtime } = setup({ spawn: spawnOf(fakeAgent()), hooks: { beforeTerminal: (id) => calls.push(`before:${id}`) } });
  const jobId = "cancelled-then-started";
  runtime.enqueue(recordFor(jobId, { capture: NO_CAPTURE }), {});
  await runtime.kill(jobId, "cancelled");
  await expect(runtime.start(jobId)).rejects.toThrow("not queued");
  expect(states(store, jobId)).toEqual(["queued", "killed"]);
  expect(calls).toEqual([]);
});

test("kill(\"cancelled\") on a running job records kill-requested, not cancelled", async () => {
  const agent = fakeAgent((finish) => { finish(1); return { killedPids: [7], failedPids: [], errors: [] }; });
  const { store, runtime } = setup({ spawn: spawnOf(agent) });
  const jobId = "cancel-running";
  runtime.enqueue(recordFor(jobId, { capture: NO_CAPTURE }), {});
  await runtime.start(jobId);
  await runtime.kill(jobId, "cancelled");
  const final = await runtime.wait(jobId);
  expect(final.state).toBe("killed"); expect(final.stateReason).toBe("kill-requested");
  expect(store.readAllEvents(jobId).events.some((event) => event.type === "state" && event.reason === "cancelled")).toBe(false);
});

test("start() makes starting durable synchronously but spawns only after a macrotask (L8)", async () => {
  let spawned = false;
  const agent = fakeAgent();
  const spawn = (async () => { spawned = true; return agent; }) as typeof import("../src/manager.js").spawnContainedAgent;
  const { store, runtime } = setup({ spawn });
  const jobId = "spawn-after-lock";
  runtime.enqueue(recordFor(jobId, { capture: NO_CAPTURE }), {});
  const started = runtime.start(jobId);
  expect(states(store, jobId)).toEqual(["queued", "starting"]);
  for (let i = 0; i < 50; i++) await Promise.resolve();
  expect(spawned).toBe(false);
  await started;
  expect(spawned).toBe(true);
  await runtime.kill(jobId, "kill-requested");
});

test("fail() records a queued job as failed and fires afterTerminal", () => {
  const finished: string[] = [];
  const { index, runtime } = setup({ hooks: { afterTerminal: (record) => finished.push(`${record.state}:${record.stateReason}`) } });
  const jobId = "fail-job";
  runtime.enqueue(recordFor(jobId, { capture: NO_CAPTURE }), {});
  runtime.fail(jobId, "dependency-failed", "dependency boom");
  const record = index.get(jobId)!;
  expect(record.state).toBe("failed"); expect(record.stateReason).toBe("dependency-failed");
  expect(record.error).toBe("dependency boom"); expect(record.exitedAt).not.toBeNull();
  expect(finished).toEqual(["failed:dependency-failed"]);
});

test("kill arriving while starting waits for start to settle; there is no starting -> killed", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const agent = fakeAgent();
  const { store, runtime } = setup({
    spawn: (async () => { await gate; return agent; }) as typeof import("../src/manager.js").spawnContainedAgent,
  });
  const jobId = "starting-kill";
  runtime.enqueue(recordFor(jobId, { capture: NO_CAPTURE }), {});
  const starting = runtime.start(jobId);
  const killing = runtime.kill(jobId, "kill-requested");
  release();
  await starting;
  await killing;
  const final = await runtime.wait(jobId);
  expect(final.state).toBe("killed");
  expect(states(store, jobId)).toEqual(["queued", "starting", "running", "exiting", "killed"]);
});

test("shutdown terminates live jobs with supervisor-shutdown", async () => {
  const { runtime } = setup({ spawn: spawnOf(fakeAgent()) });
  const jobId = "shutdown-job";
  runtime.enqueue(recordFor(jobId, { capture: NO_CAPTURE }), {});
  await runtime.start(jobId);
  await runtime.shutdown();
  const final = await runtime.wait(jobId);
  expect(final.state).toBe("killed"); expect(final.stateReason).toBe("supervisor-shutdown");
});

test("a kill marker written before exit makes the job killed with the marker reason", async () => {
  const agent = fakeAgent();
  const { runtime } = setup({ spawn: spawnOf(agent) });
  const jobId = "marker-job";
  runtime.enqueue(recordFor(jobId, { capture: NO_CAPTURE }), {});
  await runtime.start(jobId);
  writeKillRequest(jobId, { by: "session:abc", reason: "cleanup", at: new Date().toISOString(), detail: "user cleanup" });
  agent.finish(0);
  const final = await runtime.wait(jobId);
  expect(final.state).toBe("killed"); expect(final.stateReason).toBe("cleanup"); expect(final.exitCode).toBe(0);
});

test("terminate() reporting failedPids ends failed/containment-error", async () => {
  const { runtime } = setup({ spawn: spawnOf(fakeAgent(() => ({ killedPids: [], failedPids: [4242], errors: [] }))) });
  const jobId = "containment-error";
  runtime.enqueue(recordFor(jobId, { capture: NO_CAPTURE }), {});
  await runtime.start(jobId);
  await runtime.kill(jobId, "kill-requested");
  const final = await runtime.wait(jobId);
  expect(final.state).toBe("failed"); expect(final.stateReason).toBe("containment-error");
  expect(final.error).toContain("failed PIDs: 4242");
});

test("environment scrubbing: owner token, session id and daemon token never reach the child", async () => {
  const saved = { owner: process.env.AGTOP_OWNER_TOKEN, session: process.env.AGTOP_SESSION_ID, daemon: process.env.AGTOP_DAEMON_TOKEN };
  process.env.AGTOP_OWNER_TOKEN = "owner-token".padEnd(40, "x");
  process.env.AGTOP_SESSION_ID = "session_123456";
  process.env.AGTOP_DAEMON_TOKEN = "daemon-token-value-1234567890";
  try {
    const { runtime } = setup({ capture: pipeCaptureProvider() });
    const jobId = "env-scrub";
    runtime.enqueue(recordFor(jobId, { command: process.execPath, args: ["-e", "process.stdout.write(Object.keys(process.env).join('\\n'))"] }), {});
    await runtime.start(jobId);
    await runtime.wait(jobId);
    const text = runtime.ring(jobId)!.read({ stream: "stdout", encoding: "utf8" }).chunks.map((chunk) => chunk.data).join("");
    expect(text.split("\n").length).toBeGreaterThan(3);
    for (const name of ["AGTOP_OWNER_TOKEN", "AGTOP_SESSION_ID", "AGTOP_DAEMON_TOKEN"]) expect(text).not.toContain(name);
  } finally {
    for (const [key, value] of [["AGTOP_OWNER_TOKEN", saved.owner], ["AGTOP_SESSION_ID", saved.session], ["AGTOP_DAEMON_TOKEN", saved.daemon]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}, 30_000);

test("crash-after-append: starting is durable before spawn is invoked", async () => {
  const store = new EventStore(), index = new JobIndex(store, { readV1: () => [] });
  const jobId = "crash-after-append";
  let seen: string[] = [];
  const runtime = new JobRuntime({
    store, index,
    spawn: (async () => {
      seen = states(store, jobId);
      throw new Error("spawn crashed");
    }) as typeof import("../src/manager.js").spawnContainedAgent,
  });
  runtime.enqueue(recordFor(jobId, { capture: NO_CAPTURE }), {});
  await expect(runtime.start(jobId)).rejects.toThrow("spawn crashed");
  expect(seen).toEqual(["queued", "starting"]);
  expect(states(store, jobId)).toEqual(["queued", "starting", "failed"]);
  expect(index.get(jobId)!.state).toBe("failed");
});

test("selfSupervisor is alive per supervisorAlive and computed once", () => {
  const first = selfSupervisor("library"), second = selfSupervisor("mcp");
  expect(first.pid).toBe(process.pid);
  expect(first.startTime).not.toBe("");
  expect(second.startTime).toBe(first.startTime);
  expect(second.surface).toBe("mcp");
  expect(supervisorAlive(first)).toBe(true);
}, 30_000);

test("newSessionIdentity honours valid environment values and replaces invalid ones", () => {
  const token = "t".repeat(40);
  const identity = newSessionIdentity({ AGTOP_SESSION_ID: "session_123", AGTOP_OWNER_TOKEN: token });
  expect(identity.sessionId).toBe("session_123");
  expect(identity.ownerToken).toBe(token);
  expect(identity.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
  const fallback = newSessionIdentity({ AGTOP_SESSION_ID: "short", AGTOP_OWNER_TOKEN: "tiny" });
  expect(fallback.sessionId).toMatch(/^[A-Za-z0-9_-]{8,80}$/);
  expect(fallback.sessionId).not.toBe("short");
  expect(fallback.ownerToken).toMatch(/^[0-9a-f]{64}$/);
  expect(fallback.tokenHash).toHaveLength(64);
});
