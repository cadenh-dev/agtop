import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fleetCommand } from "../src/cli-fleet.js";
import { FleetService } from "../src/fleet.js";
import { selfSupervisor, type SessionIdentity } from "../src/job-runtime.js";
import type { Caller } from "../src/ownership.js";
import type { CaptureProvider, ManagedAgent, SpawnAgentOptions } from "../src/types.js";

let root = "", previousStateDir: string | undefined;
let service: FleetService | undefined;
const fakes = new Map<string, { finish(code: number): void; out?: { stdout: PassThrough; stderr: PassThrough } }>();
beforeEach(() => {
  previousStateDir = process.env.AGTOP_STATE_DIR;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-cli-fleet-"));
  process.env.AGTOP_STATE_DIR = root;
});
afterEach(async () => {
  if (service !== undefined) await service.close();
  service = undefined; fakes.clear();
  fs.rmSync(root, { recursive: true, force: true });
  if (previousStateDir === undefined) delete process.env.AGTOP_STATE_DIR; else process.env.AGTOP_STATE_DIR = previousStateDir;
});

const admin: Caller = { kind: "admin" };
const identity = (sessionId: string): SessionIdentity => {
  const token = `${sessionId}-token`.padEnd(40, "x");
  return { sessionId, ownerToken: token, tokenHash: createHash("sha256").update(token).digest("hex") };
};
async function openService(): Promise<FleetService> {
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
  return FleetService.open({ surface: "library", session: identity("session-a"), spawn, capture,
    reconcile: { snapshot }, guard: { accelerators: () => undefined, freeMemoryMb: () => 100_000 } });
}
async function finish(jobId: string, code = 0): Promise<void> {
  const fake = fakes.get(jobId)!;
  fake.out?.stdout.end(); fake.out?.stderr.end(); fake.finish(code);
  await service!.wait(jobId, 5000);
}
const write = (jobId: string, stream: "stdout" | "stderr", text: string): void => { fakes.get(jobId)!.out![stream].write(text); };

interface RunResult { code: number; stdout: string; stderr: string }
/** Runs the command in-process exactly as cli.ts does, capturing both streams and the exit code. */
async function run(...args: string[]): Promise<RunResult> {
  const out: string[] = [], err: string[] = [];
  const stdout = process.stdout.write, stderr = process.stderr.write;
  const sink = (target: string[]) => ((chunk: string | Uint8Array) => {
    target.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString()); return true;
  }) as unknown as typeof process.stdout.write;
  process.stdout.write = sink(out); process.stderr.write = sink(err); process.exitCode = 0;
  try {
    expect(await fleetCommand(args[0]!, args.slice(1))).toBe(true);
    return { code: Number(process.exitCode ?? 0), stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = stdout; process.stderr.write = stderr; process.exitCode = 0;
  }
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref(); });

test("jobs prints the documented text row and the list JSON", async () => {
  service = await openService();
  await service.submit({ command: "echo", jobId: "alpha" }, admin);
  write("alpha", "stdout", "one\ntwo\n"); write("alpha", "stderr", "err\n"); await finish("alpha", 3);
  await service.submit({ command: "echo", jobId: "beta" }, admin); await finish("beta", 0);

  const text = await run("jobs");
  expect(text.code).toBe(0); expect(text.stderr).toBe("");
  const lines = text.stdout.trimEnd().split("\n");
  expect(lines).toHaveLength(2);
  const cells = lines.find((line) => line.startsWith("alpha"))!.split(/\s{2,}/);
  expect(cells.slice(0, 3)).toEqual(["alpha", "exited", "custom"]);
  expect(cells[4]).toBe("3"); expect(cells[5]).toBe("8/4");

  const json = await run("jobs", "--json");
  expect(json.code).toBe(0);
  const data = JSON.parse(json.stdout) as { jobs: Array<{ jobId: string; state: string }>; nextAfter: string | null };
  expect(data.jobs.map((job) => job.jobId).sort()).toEqual(["alpha", "beta"]);
  expect(data.nextAfter).toBeNull();
  expect((await run("jobs", "--state", "running")).stdout.trim()).toBe("No fleet jobs.");
});

test("logs renders text, applies tail and stream, and prints OutputPages as JSON", async () => {
  service = await openService();
  await service.submit({ command: "echo", jobId: "loggy" }, admin);
  write("loggy", "stdout", "one\ntwo\nthree\n"); write("loggy", "stderr", "errline\n"); await finish("loggy");

  const text = await run("logs", "loggy");
  expect(text.code).toBe(0);
  expect(text.stdout).toContain("one\ntwo\nthree\n"); expect(text.stdout).toContain("errline\n");
  expect((await run("logs", "loggy", "--stream", "stdout")).stdout).toBe("one\ntwo\nthree\n");
  expect((await run("logs", "loggy", "--stream", "stdout", "--tail", "1")).stdout).toBe("three\n");

  const json = await run("logs", "loggy", "--json");
  const page = JSON.parse(json.stdout) as { jobId: string; stream: string; chunks: Array<{ data: string }> };
  expect(page.jobId).toBe("loggy"); expect(page.stream).toBe("both");
  expect(page.chunks.map((chunk) => chunk.data).join("")).toContain("two\n");
});

test("logs --follow keeps polling until the job is terminal", async () => {
  service = await openService();
  await service.submit({ command: "echo", jobId: "follower" }, admin);
  write("follower", "stdout", "start\n"); await sleep(50);
  const pending = run("logs", "follower", "--follow");
  await sleep(150);
  write("follower", "stdout", "end\n");
  await finish("follower");
  const result = await pending;
  expect(result.code).toBe(0);
  expect(result.stdout.indexOf("start")).toBeGreaterThanOrEqual(0);
  expect(result.stdout.indexOf("end")).toBeGreaterThan(result.stdout.indexOf("start"));
});

test("events renders seq, timestamp, type and summary, and filters with --since", async () => {
  service = await openService();
  await service.submit({ command: "echo", jobId: "evt" }, admin); await finish("evt");

  const text = await run("events", "evt");
  expect(text.code).toBe(0);
  const lines = text.stdout.trimEnd().split("\n");
  expect(lines[0]).toMatch(/^\d+  \S+  state  - -> queued \(submitted\)$/);

  const json = await run("events", "evt", "--json");
  const page = JSON.parse(json.stdout) as { events: Array<{ seq: number }>; lastSeq: number };
  expect(page.events.length).toBeGreaterThan(0);
  expect((await run("events", "evt", "--since", String(page.lastSeq))).stdout.trim()).toBe("No events.");
});

test("queue shows queued entries with their blockers and the policy", async () => {
  service = await openService();
  await service.submit({ command: "echo", jobId: "blocker" }, admin);
  await service.submit({ command: "echo", jobId: "waiting", dependsOn: ["blocker"] }, admin);

  const text = await run("queue");
  expect(text.code).toBe(0);
  expect(text.stdout).toContain("waiting");
  expect(text.stdout).toContain("dependency blocker");
  expect(text.stdout).toContain("Guards: gpu-busy open");
  expect(text.stdout).toContain("Policy: maxRunning 8");

  const json = await run("queue", "--json");
  const view = JSON.parse(json.stdout) as { entries: Array<{ jobId: string; blockedBy: Array<{ kind: string; jobIds?: string[] }> }>; guards: unknown[]; policy: { maxRunning: number } };
  expect(view.entries.map((entry) => entry.jobId)).toContain("waiting");
  expect(view.entries.find((entry) => entry.jobId === "waiting")!.blockedBy[0]).toEqual({ kind: "dependency", jobIds: ["blocker"] });
  expect(view.guards).toHaveLength(3); expect(view.policy.maxRunning).toBe(8);
});

test("leases omits leaseId and sessionId in text and JSON", async () => {
  service = await openService();
  service.leases.acquire({ port: 4789, jobId: "leased-job", peer: "peer-x", sessionId: "session-x", holder: selfSupervisor("library") });

  const text = await run("leases");
  expect(text.code).toBe(0);
  expect(text.stdout).toContain("4789"); expect(text.stdout).toContain("leased-job"); expect(text.stdout).toContain("peer-x");

  const json = await run("leases", "--json");
  const list = JSON.parse(json.stdout) as Array<Record<string, unknown>>;
  expect(list[0]).toMatchObject({ port: 4789, jobId: "leased-job", peer: "peer-x" });
  expect(list[0]).not.toHaveProperty("leaseId"); expect(list[0]).not.toHaveProperty("sessionId");
});

test("submit posts every flag to the daemon with its bearer token and prints the response", async () => {
  const token = "test-daemon-token-".padEnd(40, "x");
  const received: Array<{ method?: string; url?: string; auth?: string; body: string }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") });
    res.setHeader("Content-Type", "application/json");
    if (received.length === 1) { res.writeHead(201); res.end(JSON.stringify({ job: { jobId: "sub-1", state: "running" } })); }
    else { res.writeHead(409); res.end(JSON.stringify({ error: "Job sub-1 already exists.", code: "E_JOB_EXISTS" })); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  const port = (server.address() as AddressInfo).port, cwd = path.join(root, "cwd");
  fs.mkdirSync(cwd); fs.writeFileSync(path.join(root, `daemon-${port}.token`), token);
  try {
    const result = await run("submit", "--port", String(port), "--id", "sub-1", "--harness", "codex", "--cwd", cwd, "--peer", "peer-z",
      "--priority", "5", "--depends-on", "a", "--depends-on", "b", "--lease-port", "4701", "--gpu", "--npu", "--memory-mb", "512",
      "--timeout", "5000", "--no-capture", "--no-redact", "--", "echo", "hello world");
    expect(result.code).toBe(0); expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ job: { jobId: "sub-1", state: "running" } });
    expect(received[0]).toMatchObject({ method: "POST", url: "/v1/jobs", auth: `Bearer ${token}` });
    expect(JSON.parse(received[0]!.body)).toEqual({
      command: "echo", args: ["hello world"], jobId: "sub-1", harness: "codex", cwd, peer: "peer-z",
      priority: 5, dependsOn: ["a", "b"], leasePorts: [4701], resources: { gpu: true, npu: true, memoryMb: 512 },
      timeoutMs: 5000, capture: false, redact: false,
    });
    const failure = await run("submit", "--port", String(port), "--", "echo", "again");
    expect(failure.code).toBe(1);
    expect(failure.stderr).toBe("agtop: Job sub-1 already exists.\n");
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("usage errors exit 1 and other commands are not claimed", async () => {
  expect(await fleetCommand("ps", [])).toBe(false);
  for (const [expected, args] of [
    ["Usage: agtop logs", ["logs"]],
    ["Unknown option: --nope", ["jobs", "--nope"]],
    ["Usage: agtop submit", ["submit", "--port", "13309"]],
    ["Usage: agtop events", ["events"]],
    ["--stream must be", ["logs", "x", "--stream", "all"]],
    ["--state must be", ["jobs", "--state", "bogus"]],
  ] as const) {
    const result = await run(...args);
    expect(result.code).toBe(1); expect(result.stderr).toContain(expected);
  }
});

test("cli.ts dispatches fleet commands and exits 1 on usage errors", async () => {
  const cli = path.join(path.resolve(import.meta.dir, ".."), "src", "cli.ts");
  const exec = promisify(execFile), env = { ...process.env, AGTOP_STATE_DIR: root };
  const ok = await exec(process.execPath, [cli, "jobs"], { env, windowsHide: true, timeout: 30_000 });
  expect(String(ok.stdout)).toBe("No fleet jobs.\n");
  const failed = await exec(process.execPath, [cli, "logs"], { env, windowsHide: true, timeout: 30_000 })
    .catch((error: { code?: number; stderr?: string }) => error);
  expect(failed).toMatchObject({ code: 1 });
  expect(String((failed as { stderr?: string }).stderr)).toContain("agtop: Usage: agtop logs");
}, 30_000);
