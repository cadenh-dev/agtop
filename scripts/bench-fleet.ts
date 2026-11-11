// P1-P4 acceptance measurements (docs/design/fleet-acceptance.md section 2).
// test/fleet-acceptance.test.ts imports these; `bun run bench:fleet` prints the JSON report.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startDaemon } from "../src/daemon.js";
import { FleetService } from "../src/fleet.js";
import type { Caller } from "../src/ownership.js";
import { DEFAULT_ADMISSION_POLICY } from "../src/policy.js";
import { SecretRedactor } from "../src/redact.js";
import type { JobSummaryV2, OutputPage } from "../src/types.js";

export const REPO_ROOT = path.resolve(import.meta.dir, "..");
export const MIB = 1_048_576;
export const BUDGETS = {
  p1P95Ms: 100, p2P95Ms: 250, p3RssDeltaBytes: 52_428_800, p3RetainedBytes: 20 * MIB,
  p4TimeoutMs: 30_000, p4Runs: 5,
} as const;
const ADMIN: Caller = { kind: "admin" };
const WRITER_CHUNK_ROUNDS = 16;

/** The fake secrets from test/redact.test.ts; the 10 MiB child writes each one. */
export const FAKE_SECRETS: ReadonlyArray<{ id: string; value: string }> = [
  { id: "openai-key", value: "sk-" + "a".repeat(20) },
  { id: "github-token", value: "ghp_" + "A".repeat(36) },
  { id: "github-pat", value: "github_pat_" + "B".repeat(22) },
  { id: "aws-access-key", value: "AKIA" + "C".repeat(16) },
  { id: "google-api-key", value: "AIza" + "d".repeat(35) },
  { id: "slack-token", value: "xoxb-" + "e".repeat(10) },
  { id: "jwt", value: "eyJ" + "a".repeat(10) + "." + "b".repeat(10) + "." + "c".repeat(10) },
  { id: "auth-header", value: "hunter2" },
  { id: "bearer-token", value: "f".repeat(16) },
  { id: "env-secret", value: "abc123" },
];

function secretLine(index: number): string {
  const secret = FAKE_SECRETS[index % FAKE_SECRETS.length]!;
  if (secret.id === "auth-header") return `Authorization: ${secret.value}`;
  if (secret.id === "bearer-token") return `Bearer ${secret.value}`;
  if (secret.id === "env-secret") return `DEEPSEEK_API_KEY=${secret.value}`;
  return secret.value;
}

/** Deterministic output: numbered lines, multi-byte UTF-8, and (optionally) every fake secret. */
export function buildPayload(bytes: number, label: string, withSecrets = true): Buffer {
  const parts: Buffer[] = [];
  let total = 0, line = 0;
  while (total < bytes) {
    const text = withSecrets
      ? `${label} ${line} café 你好 🚀 ${secretLine(line)}\n`
      : `${label} ${line} lorem ipsum dolor sit amet consectetur adipiscing elit\n`;
    let buffer = Buffer.from(text, "utf8");
    const remaining = bytes - total;
    if (buffer.length > remaining) buffer = Buffer.from("x".repeat(remaining - 1) + "\n", "ascii");
    parts.push(buffer); total += buffer.length; line += 1;
  }
  return Buffer.concat(parts);
}

/** Bytes the capture reader records after redaction, independent of chunk boundaries (S11). */
export function redactedByteLength(buffer: Buffer): number {
  return new SecretRedactor().push(buffer, "eof").length;
}

/** Blocking, deliberately chunk-split writer; payloads are passed as files, never as command text. */
const WRITER_SCRIPT = `const fs = require("node:fs");
const out = fs.readFileSync(process.argv[1]), err = fs.readFileSync(process.argv[2]);
const writeAll = (fd, buf, from, to) => { while (from < to) from += fs.writeSync(fd, buf, from, to - from); };
const rounds = ${WRITER_CHUNK_ROUNDS};
for (let round = 0; round < rounds; round += 1) {
  const a = Math.floor(out.length * round / rounds), b = Math.floor(out.length * (round + 1) / rounds);
  if (b > a) writeAll(1, out, a, b);
  const c = Math.floor(err.length * round / rounds), d = Math.floor(err.length * (round + 1) / rounds);
  if (d > c) writeAll(2, err, c, d);
}`;

export function writerArgs(stdoutFile: string, stderrFile: string): string[] {
  return ["-e", WRITER_SCRIPT, stdoutFile, stderrFile];
}

export function writePayloadFiles(directory: string, stdoutBytes: number, stderrBytes: number, withSecrets = true): { stdoutFile: string; stderrFile: string } {
  const stdoutFile = path.join(directory, `payload-out-${stdoutBytes}-${withSecrets ? "s" : "p"}.bin`);
  const stderrFile = path.join(directory, `payload-err-${stderrBytes}-${withSecrets ? "s" : "p"}.bin`);
  fs.writeFileSync(stdoutFile, buildPayload(stdoutBytes, "out", withSecrets));
  fs.writeFileSync(stderrFile, buildPayload(stderrBytes, "err", withSecrets));
  return { stdoutFile, stderrFile };
}

export interface HttpResult { status: number; text: string; body: any }
export async function http(port: number, token: string, method: string, route: string, body?: unknown): Promise<HttpResult> {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  return { status: response.status, text, body: text.trim() ? JSON.parse(text) : undefined };
}

export async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}.`);
}

/** Runs fn with an isolated AGTOP_STATE_DIR and removes it afterwards. */
export async function withTempStateDir<T>(label: string, fn: (root: string) => Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `agtop-acceptance-${label}-`));
  const previous = process.env.AGTOP_STATE_DIR;
  process.env.AGTOP_STATE_DIR = root;
  try { return await fn(root); }
  finally {
    if (previous === undefined) delete process.env.AGTOP_STATE_DIR; else process.env.AGTOP_STATE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export interface LatencyResult { count: number; p50: number; p95: number; max: number; budgetMs: number; pass: boolean }
export function latency(samples: number[], budgetMs: number): LatencyResult {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (fraction: number): number => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
  const p95 = rank(0.95);
  return { count: samples.length, p50: rank(0.5), p95, max: sorted[sorted.length - 1] ?? 0, budgetMs, pass: p95 < budgetMs };
}

export interface P1Result {
  memory: LatencyResult & { source: string }; spool: LatencyResult & { source: string }; pass: boolean;
}

async function measureTail(port: number, token: string, jobId: string): Promise<LatencyResult & { source: string }> {
  const route = `/v1/jobs/${jobId}/output?stream=stdout&tail=100&since=0`;
  const warm = await http(port, token, "GET", route); // cold cache excluded (first request discarded)
  if (warm.status !== 200) throw new Error(`output warm-up failed with ${warm.status}: ${warm.text}`);
  if (!Array.isArray(warm.body?.chunks) || warm.body.chunks.length === 0) throw new Error("output warm-up returned no chunks");
  const samples: number[] = [];
  let source = String(warm.body.source);
  for (let index = 0; index < 200; index += 1) {
    const started = performance.now();
    const result = await http(port, token, "GET", route);
    samples.push(performance.now() - started);
    if (result.status !== 200) throw new Error(`output request failed with ${result.status}: ${result.text}`);
    source = String(result.body.source);
  }
  return { source, ...latency(samples, BUDGETS.p1P95Ms) };
}

interface SupervisorJob { jobId: string; state: string; exitCode: number | null; stop: () => Promise<void> }

async function startSupervisorJob(root: string, jobId: string, command: string, args: string[], timeoutMs: number): Promise<SupervisorJob> {
  const scriptFile = path.join(root, `supervisor-${jobId}.ts`), readyFile = path.join(root, `ready-${jobId}.json`);
  const fleetUrl = pathToFileURL(path.join(REPO_ROOT, "src/fleet.ts")).href;
  fs.writeFileSync(scriptFile, [
    `import * as fs from "node:fs";`,
    // FleetService.wait uses unref'd timers: without a ref'd handle first, POSIX exits before the job ends.
    `setInterval(() => {}, 1000);`,
    // Breadcrumbs: if the supervisor dies, the parent reports the last step it reached.
    `const step = (name: string): void => { try { fs.appendFileSync(process.env.AGTOP_READY_FILE! + ".steps", name + "\\n"); } catch {} };`,
    `process.on("exit", (code) => step("exit " + code));`,
    `for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.on(signal, () => { step("signal " + signal); process.exit(128); });`,
    `try {`,
    `step("start");`,
    `const { FleetService } = await import(process.env.AGTOP_FLEET_URL!);`,
    `step("imported");`,
    `const service = await FleetService.open({ surface: "library" });`,
    `step("opened");`,
    `const job = await service.submit({ jobId: process.env.AGTOP_JOB_ID!, command: process.env.AGTOP_COMMAND!, args: JSON.parse(process.env.AGTOP_ARGS!), cwd: process.env.AGTOP_CWD! }, { kind: "session", session: service.session, peer: "bench" });`,
    `step("submitted " + job.state);`,
    `const done = await service.wait(job.jobId, Number(process.env.AGTOP_WAIT_MS));`,
    `step("waited " + done.state);`,
    `fs.writeFileSync(process.env.AGTOP_READY_FILE!, JSON.stringify({ jobId: job.jobId, state: done.state, exitCode: done.exitCode }));`,
    `} catch (error) { step("error " + (error instanceof Error ? error.stack ?? error.message : String(error)).replace(/\\n/g, " | ")); throw error; }`,
  ].join("\n"));
  const child = spawn(process.execPath, [scriptFile], {
    env: {
      ...process.env, AGTOP_FLEET_URL: fleetUrl, AGTOP_JOB_ID: jobId, AGTOP_COMMAND: command,
      AGTOP_ARGS: JSON.stringify(args), AGTOP_CWD: root, AGTOP_WAIT_MS: String(timeoutMs), AGTOP_READY_FILE: readyFile,
    },
    stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  };
  try {
    const deadline = Date.now() + Math.max(30_000, timeoutMs);
    while (!fs.existsSync(readyFile)) {
      if (child.exitCode !== null || child.signalCode !== null) {
        let steps = "";
        try { steps = fs.readFileSync(`${readyFile}.steps`, "utf8").trim().replace(/\n/g, " > "); } catch { /* none written */ }
        throw new Error(`supervisor ${jobId} exited before its job (code ${child.exitCode}, signal ${child.signalCode}; steps: ${steps || "none"}): ${stderr.trim()}`);
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for supervisor ${jobId}.`);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    const ready = JSON.parse(fs.readFileSync(readyFile, "utf8")) as { jobId: string; state: string; exitCode: number | null };
    if (ready.state !== "exited" || ready.exitCode !== 0) throw new Error(`supervisor job ${jobId} ended ${ready.state}/${ready.exitCode}: ${stderr.trim()}`);
    return { ...ready, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

export async function measureP1(): Promise<P1Result> {
  return withTempStateDir("p1", async (root) => {
    const { stdoutFile, stderrFile } = writePayloadFiles(root, 10 * MIB, 0, false);
    const daemon = await startDaemon({ port: 0 });
    const token = fs.readFileSync(daemon.tokenFile, "utf8");
    try {
      const submitted = await http(daemon.port, token, "POST", "/v1/jobs", {
        jobId: "p1-memory", command: process.execPath, args: writerArgs(stdoutFile, stderrFile), cwd: root, harness: "custom",
      });
      if (submitted.status !== 201 && submitted.status !== 202) throw new Error(`submit failed: ${submitted.status} ${submitted.text}`);
      await waitForHttpJob(daemon.port, token, "p1-memory", (job) => job.state === "exited", 120_000);
      const memory = await measureTail(daemon.port, token, "p1-memory");
      if (memory.source !== "memory") throw new Error(`P1 memory job was served from ${memory.source}`);
      const supervised = await startSupervisorJob(root, "p1-spool", process.execPath, writerArgs(stdoutFile, stderrFile), 120_000);
      try {
        const spool = await measureTail(daemon.port, token, "p1-spool");
        if (spool.source !== "spool") throw new Error(`P1 spool job was served from ${spool.source}`);
        return { memory, spool, pass: memory.pass && spool.pass };
      } finally { await supervised.stop(); }
    } finally { await daemon.close(); }
  });
}

export async function waitForHttpJob(port: number, token: string, jobId: string, done: (job: JobSummaryV2) => boolean, timeoutMs: number): Promise<JobSummaryV2> {
  const deadline = Date.now() + timeoutMs;
  let last: JobSummaryV2 | undefined;
  while (Date.now() < deadline) {
    const view = await http(port, token, "GET", `/v1/jobs/${jobId}`);
    if (view.status !== 200) throw new Error(`GET /v1/jobs/${jobId} returned ${view.status}: ${view.text}`);
    last = view.body.job as JobSummaryV2;
    if (done(last)) return last;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for job ${jobId}; last state ${last?.state ?? "unknown"}.`);
}

export interface P2Result {
  http: LatencyResult & { jobs: number };
  /**
   * Measured, not gated: the documented p95 budget covers the HTTP list. MCP `list` also runs the
   * v0.1 process scan (listAgentTrees), which is outside this unit. `jobs` includes any live v0.1
   * agent trees the host has; `fleetJobs` counts this scenario's 50.
   */
  mcp: { count: number; p50: number; p95: number; max: number; jobs: number; fleetJobs: number };
  pass: boolean;
}

export async function measureP2(): Promise<P2Result> {
  return withTempStateDir("p2", async (root) => {
    const daemon = await startDaemon({ port: 0 });
    const token = fs.readFileSync(daemon.tokenFile, "utf8");
    try {
      const policy = { ...DEFAULT_ADMISSION_POLICY, maxRunning: 64, maxRunningPerPeer: 64, maxRunningPerHarness: 64, maxQueued: 500 };
      const saved = await http(daemon.port, token, "PUT", "/v1/policy", policy);
      if (saved.status !== 200) throw new Error(`PUT /v1/policy failed: ${saved.status} ${saved.text}`);
      const finished: string[] = [], running: string[] = [];
      for (let index = 0; index < 45; index += 1) {
        const jobId = `p2-fin-${index}`; finished.push(jobId);
        const submitted = await http(daemon.port, token, "POST", "/v1/jobs", {
          jobId, command: process.execPath, args: ["-e", "process.stdout.write('done\\n')"], cwd: root, harness: "custom",
        });
        if (submitted.status !== 201 && submitted.status !== 202) throw new Error(`submit ${jobId} failed: ${submitted.status} ${submitted.text}`);
      }
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        const listed = await http(daemon.port, token, "GET", "/v1/jobs?limit=100");
        const byId = new Map((listed.body.jobs as JobSummaryV2[]).map((job) => [job.jobId, job.state]));
        if (finished.every((jobId) => ["exited", "failed", "killed", "lost"].includes(String(byId.get(jobId))))) break;
        if (Date.now() >= deadline) throw new Error("Timed out waiting for the 45 finished jobs.");
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
      for (let index = 0; index < 5; index += 1) {
        const jobId = `p2-run-${index}`; running.push(jobId);
        const submitted = await http(daemon.port, token, "POST", "/v1/jobs", {
          jobId, command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: root, harness: "custom",
        });
        if (submitted.status !== 201 && submitted.status !== 202) throw new Error(`submit ${jobId} failed: ${submitted.status} ${submitted.text}`);
      }
      for (const jobId of running) await waitForHttpJob(daemon.port, token, jobId, (job) => job.state === "running", 60_000);

      const samples: number[] = [];
      let listedJobs = 0;
      for (let index = 0; index < 100; index += 1) {
        const started = performance.now();
        const result = await http(daemon.port, token, "GET", "/v1/jobs?limit=100");
        samples.push(performance.now() - started);
        if (result.status !== 200) throw new Error(`list failed: ${result.status} ${result.text}`);
        listedJobs = result.body.jobs.length;
      }
      const httpResult = { ...latency(samples, BUDGETS.p2P95Ms), jobs: listedJobs };

      const session = await openMcpSession(root);
      try {
        const times: number[] = [];
        let mcpJobs = 0, mcpFleetJobs = 0;
        for (let index = 0; index < 20; index += 1) {
          const started = performance.now();
          const result = await session.client.callTool({ name: "list", arguments: {} });
          times.push(performance.now() - started);
          if (result.isError) throw new Error(`MCP list failed: ${toolText(result)}`);
          const jobs = (JSON.parse(toolText(result)) as { jobs: Array<{ jobId: string }> }).jobs;
          mcpJobs = jobs.length;
          mcpFleetJobs = jobs.filter((job) => job.jobId.startsWith("p2-")).length;
        }
        const mcpLatency = latency(times, BUDGETS.p2P95Ms);
        return {
          http: httpResult,
          mcp: { count: mcpLatency.count, p50: mcpLatency.p50, p95: mcpLatency.p95, max: mcpLatency.max, jobs: mcpJobs, fleetJobs: mcpFleetJobs },
          pass: httpResult.pass && listedJobs === 50 && mcpFleetJobs === 50 && mcpLatency.pass,
        };
      } finally { await session.close(); }
    } finally { await daemon.close(); }
  });
}

export interface McpSession { client: Client; transport: StdioClientTransport; close: () => Promise<void> }
export function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  if (!Array.isArray(result.content)) return "";
  return result.content.map((item) => item.type === "text" && typeof item.text === "string" ? item.text : "").join("\n");
}
export async function openMcpSession(stateDir: string, extraEnv: Record<string, string> = {}): Promise<McpSession> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.AGTOP_OWNER_TOKEN; delete env.AGTOP_SESSION_ID;
  Object.assign(env, { AGTOP_STATE_DIR: stateDir, AGTOP_PEER: "acceptance" }, extraEnv);
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(REPO_ROOT, "src/cli.ts"), "mcp"], cwd: REPO_ROOT, env, stderr: "pipe",
  });
  transport.stderr?.on("data", () => { /* drain */ });
  const client = new Client({ name: "agtop-fleet-acceptance", version: "1.0.0" }, { capabilities: {} });
  try { await client.connect(transport); }
  catch (error) { await transport.close().catch(() => undefined); throw error; }
  return {
    client, transport,
    close: async () => { try { await client.close(); } catch { /* gone */ } try { await transport.close(); } catch { /* gone */ } },
  };
}

export interface P3Result { rssDeltaBytes: number; rssBudgetBytes: number; retainedBytes: number; retainedBudgetBytes: number; pass: boolean }

export async function measureP3(): Promise<P3Result> {
  return withTempStateDir("p3", async (root) => {
    const { stdoutFile, stderrFile } = writePayloadFiles(root, 2 * MIB, 0, false);
    const service = await FleetService.open({ surface: "library" });
    try {
      service.setPolicy({ ...DEFAULT_ADMISSION_POLICY, maxRunning: 64, maxRunningPerPeer: 64, maxRunningPerHarness: 64, maxQueued: 500 });
      Bun.gc(true);
      const before = process.memoryUsage().rss;
      const jobIds = Array.from({ length: 20 }, (_, index) => `p3-${index}`);
      await Promise.all(jobIds.map((jobId) => service.submit({
        jobId, command: process.execPath, args: writerArgs(stdoutFile, stderrFile), cwd: root, harness: "custom",
      }, ADMIN)));
      await Promise.all(jobIds.map((jobId) => service.wait(jobId, 120_000)));
      Bun.gc(true);
      await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
      Bun.gc(true);
      const after = process.memoryUsage().rss;
      let retainedBytes = 0;
      for (const jobId of jobIds) {
        const page: OutputPage = service.output(jobId, { stream: "both", limit: 1000, maxBytes: 4 * MIB }, ADMIN);
        retainedBytes += page.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      }
      const rssDeltaBytes = after - before;
      return {
        rssDeltaBytes, rssBudgetBytes: BUDGETS.p3RssDeltaBytes,
        retainedBytes, retainedBudgetBytes: BUDGETS.p3RetainedBytes,
        pass: rssDeltaBytes < BUDGETS.p3RssDeltaBytes && retainedBytes <= BUDGETS.p3RetainedBytes,
      };
    } finally { await service.close(); }
  });
}

export interface P4Run { jobId: string; state: string; exitCode: number | null; elapsedMs: number; outputBytes: { stdout: number; stderr: number } }
export interface P4Result { expected: { stdout: number; stderr: number }; runs: P4Run[]; budgetMs: number; pass: boolean }

export async function measureP4(): Promise<P4Result> {
  return withTempStateDir("p4", async (root) => {
    const { stdoutFile, stderrFile } = writePayloadFiles(root, 9 * MIB, 1 * MIB, true);
    const expected = {
      stdout: redactedByteLength(fs.readFileSync(stdoutFile)),
      stderr: redactedByteLength(fs.readFileSync(stderrFile)),
    };
    const service = await FleetService.open({ surface: "library" });
    try {
      service.setPolicy({ ...DEFAULT_ADMISSION_POLICY, maxRunning: 16, maxRunningPerPeer: 16, maxRunningPerHarness: 16 });
      const runs: P4Run[] = [];
      for (let index = 0; index < BUDGETS.p4Runs; index += 1) {
        const jobId = `p4-${index}`, started = performance.now();
        await service.submit({ jobId, command: process.execPath, args: writerArgs(stdoutFile, stderrFile), cwd: root, harness: "custom" }, ADMIN);
        const done = await service.wait(jobId, BUDGETS.p4TimeoutMs);
        const elapsedMs = performance.now() - started;
        const outputBytes = service.get(jobId, ADMIN).job.outputBytes;
        runs.push({ jobId, state: done.state, exitCode: done.exitCode, elapsedMs, outputBytes });
      }
      const pass = runs.every((run) => run.state === "exited" && run.exitCode === 0 && run.elapsedMs < BUDGETS.p4TimeoutMs &&
        run.outputBytes.stdout === expected.stdout && run.outputBytes.stderr === expected.stderr);
      return { expected, runs, budgetMs: BUDGETS.p4TimeoutMs, pass };
    } finally { await service.close(); }
  });
}

export interface FleetBenchReport {
  generatedAt: string; platform: string; bun: string | undefined;
  budgets: typeof BUDGETS; measurements: Record<string, unknown>; pass: boolean;
}

export async function runFleetBench(): Promise<FleetBenchReport> {
  const measurements: Record<string, unknown> = {};
  let pass = true;
  for (const [id, measure] of [["P1", measureP1], ["P2", measureP2], ["P3", measureP3], ["P4", measureP4]] as const) {
    try {
      const result = await measure();
      measurements[id] = result;
      if (!result.pass) pass = false;
    } catch (error) {
      measurements[id] = { error: error instanceof Error ? error.message : String(error), pass: false };
      pass = false;
    }
  }
  return {
    generatedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`,
    bun: typeof Bun === "undefined" ? undefined : Bun.version, budgets: BUDGETS, measurements, pass,
  };
}

if (import.meta.main) {
  // FleetService.wait uses unref'd timers; a ref'd keep-alive stops the entry process from
  // draining between a job's last handle and its wait() resolution.
  const keepAlive = setInterval(() => {}, 1_000);
  runFleetBench().then((report) => {
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }).catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }).finally(() => clearInterval(keepAlive));
}
