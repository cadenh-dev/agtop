import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { EventStore, jobDir } from "../src/event-store.js";
import { startDaemon } from "../src/daemon.js";
import { validateRules } from "../scripts/skill-eval-grade.js";
import {
  BUDGETS, FAKE_SECRETS, REPO_ROOT, http, measureP1, measureP2, measureP3, measureP4,
  openMcpSession, toolText, waitFor, withTempStateDir, writePayloadFiles, writerArgs,
} from "../scripts/bench-fleet.js";
import { findByMarker, killByMarker } from "../scripts/process-probe.js";

const SKIP = process.env.AGTOP_SKIP_ACCEPTANCE === "1";
const heavyTest = SKIP ? test.skip : test;

function walkFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full)); else if (entry.isFile()) files.push(full);
  }
  return files;
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

heavyTest("P1: output tail 100 lines stays under 100 ms from memory and from another supervisor's spool", async () => {
  const result = await measureP1();
  expect(result.memory.source).toBe("memory");
  expect(result.spool.source).toBe("spool");
  expect(result.memory.p95).toBeLessThan(BUDGETS.p1P95Ms);
  expect(result.spool.p95).toBeLessThan(BUDGETS.p1P95Ms);
  expect(result.pass).toBe(true);
}, 180_000);

heavyTest("P2: list of 50 jobs stays under 250 ms over HTTP; MCP list returns all 50", async () => {
  const result = await measureP2();
  expect(result.http.jobs).toBe(50);
  expect(result.http.p95).toBeLessThan(BUDGETS.p2P95Ms);
  expect(result.http.pass).toBe(true);
  // MCP `list` shares one process scan for 2 s (lead decision D41), so it is gated like HTTP.
  expect(result.mcp.fleetJobs).toBe(50);
  expect(result.mcp.count).toBe(20);
  expect(result.mcp.p95).toBeLessThan(BUDGETS.p2P95Ms);
}, 240_000);

heavyTest("P3: 20 concurrent 2 MiB jobs stay under the RSS and retained-bytes budgets", async () => {
  const result = await measureP3();
  expect(result.rssDeltaBytes).toBeLessThan(BUDGETS.p3RssDeltaBytes);
  expect(result.retainedBytes).toBeLessThanOrEqual(BUDGETS.p3RetainedBytes);
  expect(result.pass).toBe(true);
}, 240_000);

heavyTest("P4: a 10 MiB child with secrets, UTF-8 and 10% stderr completes exactly five times", async () => {
  const result = await measureP4();
  expect(result.expected.stdout).toBeGreaterThan(0);
  expect(result.expected.stderr).toBeGreaterThan(0);
  expect(result.runs).toHaveLength(BUDGETS.p4Runs);
  for (const run of result.runs) {
    expect(run.state).toBe("exited");
    expect(run.exitCode).toBe(0);
    expect(run.elapsedMs).toBeLessThan(BUDGETS.p4TimeoutMs);
    expect(run.outputBytes.stdout).toBe(result.expected.stdout);
    expect(run.outputBytes.stderr).toBe(result.expected.stderr);
  }
  expect(result.pass).toBe(true);
}, 240_000);

heavyTest("S12: no fake secret reaches the ring, HTTP responses, MCP results, or job files", async () => {
  const outcome = await withTempStateDir("s12", async (root) => {
    const { stdoutFile, stderrFile } = writePayloadFiles(root, 9 * 1_048_576, 1 * 1_048_576, true);
    const daemon = await startDaemon({ port: 0 });
    const token = fs.readFileSync(daemon.tokenFile, "utf8");
    const session = await openMcpSession(root);
    try {
      const jobId = "s12-secrets";
      const run = await session.client.callTool({
        name: "run", arguments: { jobId, command: process.execPath, args: writerArgs(stdoutFile, stderrFile), cwd: root, harness: "custom" },
      });
      if (run.isError) throw new Error(toolText(run));
      const waited = await session.client.callTool({ name: "wait", arguments: { jobId, timeoutMs: 60_000 } });
      if (waited.isError) throw new Error(toolText(waited));
      const surfaces: string[] = [];
      let since = 0;
      for (let page = 0; page < 40; page += 1) {
        const read = await session.client.callTool({ name: "output", arguments: { jobId, format: "json", since, stream: "both", maxBytes: 262_144 } });
        if (read.isError) throw new Error(toolText(read));
        const body = JSON.parse(toolText(read)) as { hasMore: boolean; nextSince: number };
        surfaces.push(toolText(read));
        if (!body.hasMore || body.nextSince <= since) break;
        since = body.nextSince;
      }
      for (const [name, args] of [["status", { jobId }], ["list", {}], ["events", { jobId }]] as const) {
        const result = await session.client.callTool({ name, arguments: args });
        surfaces.push(toolText(result));
      }
      for (const route of [
        `/v1/jobs/${jobId}`, `/v1/jobs`, `/v1/jobs/${jobId}/events`,
        `/v1/jobs/${jobId}/output?stream=both&since=0&limit=1000&maxBytes=4194304`,
      ]) {
        const response = await http(daemon.port, token, "GET", route);
        expect(response.status).toBe(200);
        surfaces.push(response.text);
      }
      const files = walkFiles(jobDir(jobId)).map((file) => ({ file: path.basename(file), bytes: fs.readFileSync(file) }));
      return { surfaces, files };
    } finally {
      await session.close();
      await daemon.close();
    }
  });
  const leaked = FAKE_SECRETS.filter((secret) => outcome.surfaces.some((surface) => surface.includes(secret.value))).map((secret) => secret.id);
  expect(leaked).toEqual([]);
  const encoded = FAKE_SECRETS.flatMap((secret) => [Buffer.from(secret.value), Buffer.from(Buffer.from(secret.value).toString("base64"))]);
  const leakedFiles = outcome.files.filter((entry) => encoded.some((needle) => entry.bytes.includes(needle))).map((entry) => entry.file);
  expect(leakedFiles).toEqual([]);
}, 180_000);

heavyTest("F9: a hard-killed supervisor is marked lost, its tail repaired, and its pre-crash output served byte for byte", async () => {
  const previousStateDir = process.env.AGTOP_STATE_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-acceptance-f9-"));
  process.env.AGTOP_STATE_DIR = root;
  const marker = `AGTOP_F9_${process.pid}_${Date.now()}`;
  let child: ChildProcess | undefined, daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    const scriptFile = path.join(root, "supervisor-daemon.ts"), readyFile = path.join(root, "daemon-ready.json");
    fs.writeFileSync(scriptFile, [
      `import * as fs from "node:fs";`,
      `const daemon = await (await import(process.env.AGTOP_DAEMON_URL!)).startDaemon({ port: 0 });`,
      `fs.writeFileSync(process.env.AGTOP_READY_FILE!, JSON.stringify({ port: daemon.port, token: fs.readFileSync(daemon.tokenFile, "utf8") }));`,
      `setInterval(() => {}, 1000);`,
    ].join("\n"));
    child = spawn(process.execPath, [scriptFile], {
      env: { ...process.env, AGTOP_READY_FILE: readyFile, AGTOP_DAEMON_URL: pathToFileURL(path.join(REPO_ROOT, "src/daemon.ts")).href },
      stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
    });
    let childStderr = "";
    child.stderr?.on("data", (chunk) => { childStderr += String(chunk); });
    await waitFor(() => fs.existsSync(readyFile), 30_000, "the supervising daemon").catch(() => {
      throw new Error(`supervising daemon failed to start: ${childStderr.trim()}`);
    });
    const info = JSON.parse(fs.readFileSync(readyFile, "utf8")) as { port: number; token: string };
    const job = `const fs = require("node:fs");\n` +
      `const text = Array.from({ length: 4000 }, (_, i) => "f9 " + i + " payload payload payload payload\\n").join("");\n` +
      `fs.writeSync(1, text);\n` +
      `require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", process.argv[1]], { detached: true, stdio: "ignore" }).unref();\n` +
      `setInterval(() => {}, 1000);`;
    const submitted = await http(info.port, info.token, "POST", "/v1/jobs", {
      jobId: "f9-job", command: process.execPath, args: ["-e", job, marker], cwd: root, harness: "custom", ringBytes: 65_536,
    });
    if (submitted.status !== 201 && submitted.status !== 202) throw new Error(`submit failed: ${submitted.status} ${submitted.text}`);
    const route = "/v1/jobs/f9-job/output?stream=stdout&tail=100&since=0";
    const deadline = Date.now() + 60_000;
    let pre: any;
    while (Date.now() < deadline) {
      pre = await http(info.port, info.token, "GET", route);
      if (pre.status === 200 && pre.body.outputBytes.stdout >= 100_000) break;
      await delay(50);
    }
    if (pre === undefined || pre.status !== 200 || pre.body.outputBytes.stdout < 100_000) throw new Error("job never wrote its pre-crash tail");
    const jobView = await http(info.port, info.token, "GET", "/v1/jobs/f9-job");
    expect(jobView.body.job.state).toBe("running");

    try { process.kill(child.pid!, "SIGKILL"); } catch { /* already gone */ }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      child!.once("exit", () => { clearTimeout(timer); resolve(); });
      if (child!.exitCode !== null || child!.signalCode !== null) { clearTimeout(timer); resolve(); }
    });
    fs.appendFileSync(path.join(jobDir("f9-job"), "events.jsonl"), Buffer.from("deadbeef {\"seq\":999"));
    fs.appendFileSync(path.join(jobDir("f9-job"), "output.jsonl"), Buffer.from("deadbeef {\"seq\":999"));

    daemon = await startDaemon({ port: 0 });
    const token = fs.readFileSync(daemon.tokenFile, "utf8");
    const lost = await http(daemon.port, token, "GET", "/v1/jobs/f9-job");
    expect(lost.body.job.state).toBe("lost");
    const post = await http(daemon.port, token, "GET", route);
    expect(post.status).toBe(200);
    expect(post.body.source).toBe("spool");
    expect(post.body.chunks.map((chunk: any) => chunk.data).join("")).toBe(pre.body.chunks.map((chunk: any) => chunk.data).join(""));
    expect(post.body.chunks.map((chunk: any) => [chunk.seq, chunk.offset, chunk.byteLength])).toEqual(
      pre.body.chunks.map((chunk: any) => [chunk.seq, chunk.offset, chunk.byteLength]));
    expect(post.body.outputBytes).toEqual(pre.body.outputBytes);
    expect(new EventStore().readAllEvents("f9-job").corruptTailBytes).toBe(0);
    expect(new EventStore().readOutput("f9-job").corruptTailBytes).toBe(0);
    await waitFor(() => findByMarker(marker).length === 0, 20_000, "the crashed job's processes to be gone");
  } finally {
    if (daemon !== undefined) await daemon.close().catch(() => undefined);
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      try { process.kill(child.pid!, "SIGKILL"); } catch { /* gone */ }
    }
    killByMarker(marker);
    if (previousStateDir === undefined) delete process.env.AGTOP_STATE_DIR; else process.env.AGTOP_STATE_DIR = previousStateDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 180_000);

test("G1: no file under src/ suspends a process", () => {
  const forbidden = ["SIGSTOP", "SIGTSTP", "cgroup.freeze", "NtSuspendProcess", "SuspendThread"];
  const hits: string[] = [];
  for (const file of walkFiles(path.join(REPO_ROOT, "src"))) {
    const text = fs.readFileSync(file, "utf8");
    for (const word of forbidden) if (text.includes(word)) hits.push(`${path.relative(REPO_ROOT, file)}: ${word}`);
  }
  expect(hits).toEqual([]);
});

test("G2/X4: no file under src/ uses Bun-only APIs or imports", () => {
  const hits: string[] = [];
  for (const file of walkFiles(path.join(REPO_ROOT, "src"))) {
    const text = fs.readFileSync(file, "utf8");
    if (text.includes("Bun.")) hits.push(`${path.relative(REPO_ROOT, file)}: Bun.`);
    if (text.includes('from "bun') || text.includes("from 'bun")) hits.push(`${path.relative(REPO_ROOT, file)}: bun import`);
  }
  expect(hits).toEqual([]);
});

test("C10: package.json dependencies are unchanged from d516dcb", () => {
  const expected = { "@modelcontextprotocol/sdk": "^1.32.2", koffi: "^2.14.1", zod: "^4.6.7" };
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  expect(pkg.dependencies).toEqual(expected);
});

test("the four new eval scenarios load through the existing rule validator", () => {
  for (const id of ["read-job-output", "queue-heavy-job", "port-lease-conflict", "foreign-output"]) {
    const file = path.join(REPO_ROOT, "evals", "agtop", `${id}.json`);
    const scenario = JSON.parse(fs.readFileSync(file, "utf8")) as { id: string; prompt: string; priorCalls?: unknown[]; rules: unknown };
    expect(scenario.id).toBe(id);
    expect(typeof scenario.prompt).toBe("string");
    expect(validateRules(scenario.rules)).toBe(true);
  }
});
