import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { ROLE_ORDER } from "../src/roles.js";

const exec = promisify(execFile);
const repoRoot = path.resolve(import.meta.dir, "..");
const cli = path.join(repoRoot, "src/cli.ts");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-cli-e2e-"));
const stateDir = path.join(tempRoot, "state");
fs.mkdirSync(stateDir, { recursive: true });

const TREE_FIELDS = [
  "jobId",
  "harness",
  "backend",
  "backendEvidence",
  "userOrPeer",
  "rootPid",
  "containmentMode",
  "totalCpuPercent",
  "totalMemoryMb",
  "processes",
  "roleCounts",
] as const;

const PROCESS_FIELDS = [
  "pid",
  "ppid",
  "name",
  "cmdline",
  "startTime",
  "cpuSeconds",
  "cpuPercent",
  "memoryMb",
  "role",
  "roleSource",
  "roleEvidence",
] as const;

function baseEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, AGTOP_STATE_DIR: stateDir, ...extra };
}

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], options: { env?: Record<string, string>; timeout?: number } = {}): Promise<CliResult> {
  const timeout = options.timeout ?? 45_000;
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, ...args], {
      env: baseEnv(options.env),
      windowsHide: true,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (err: unknown) {
    const e = err as { code?: number | string; status?: number; stdout?: string; stderr?: string; killed?: boolean; signal?: string };
    if (e.killed) throw new Error(`CLI timed out: agtop ${args.join(" ")}`);
    const code = typeof e.status === "number" ? e.status : typeof e.code === "number" ? e.code : 1;
    return { code, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
  }
}

async function pickClosedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(err => (err ? reject(err) : resolve(port)));
    });
    server.on("error", reject);
  });
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function pidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("agtop CLI subprocess", () => {
  test("--help exits 0 and lists commands", async () => {
    const { code, stdout } = await runCli(["--help"]);
    expect(code).toBe(0);
    for (const snippet of ["agtop ps", "agtop run", "agtop kill", "agtop harnesses", "agtop roles", "agtop lemonade", "agtop daemon", "agtop mcp", "agtop ui", "macOS uses a process group"]) {
      expect(stdout).toContain(snippet);
    }
  });

  test("unknown command and unknown flag exit nonzero with a useful message", async () => {
    const badCmd = await runCli(["not-a-command"]);
    expect(badCmd.code).toBe(1);
    expect(`${badCmd.stderr}${badCmd.stdout}`.toLowerCase()).toContain("unknown command");

    const badFlag = await runCli(["ps", "--nope"]);
    expect(badFlag.code).toBe(1);
    expect(`${badFlag.stderr}${badFlag.stdout}`).toMatch(/usage|unknown/i);

    const badRun = await runCli(["run", "--not-a-run-flag", "x", "--", process.execPath, "-e", "0"]);
    expect(badRun.code).toBe(1);
    expect(`${badRun.stderr}${badRun.stdout}`).toContain("Unknown option");
  });

  test("ps --json parses and exposes documented tree fields", async () => {
    const jobId = `ps-json-${Date.now()}`;
    const supervisor = spawn(process.execPath, [cli, "run", "--id", jobId, "--harness", "custom", "--", process.execPath, "-e", "setInterval(()=>{},10000)"], {
      env: baseEnv(),
      stdio: "ignore",
      windowsHide: true,
    });
    try {
      await waitFor(() => fs.existsSync(path.join(stateDir, `${jobId}.json`)), "managed job record");
      await delay(250);
      const { code, stdout } = await runCli(["ps", "--json"], { timeout: 60_000 });
      expect(code).toBe(0);
      const trees = JSON.parse(stdout) as Record<string, unknown>[];
      expect(Array.isArray(trees)).toBe(true);
      const tree = trees.find(t => t.jobId === jobId);
      expect(tree).toBeDefined();
      for (const key of TREE_FIELDS) expect(tree).toHaveProperty(key);
      const processes = tree!.processes as Record<string, unknown>[];
      expect(Array.isArray(processes)).toBe(true);
      expect(processes.length).toBeGreaterThan(0);
      for (const key of PROCESS_FIELDS) expect(processes[0]).toHaveProperty(key);
      expect(tree!.roleCounts).toBeDefined();
      expect(processes.find(p => p.pid === tree!.rootPid)).toMatchObject({ role: "agent", roleSource: "job" });
    } finally {
      supervisor.kill("SIGTERM");
      await Promise.race([new Promise<void>(r => supervisor.once("exit", () => r())), delay(5000)]);
      if (supervisor.exitCode === null) supervisor.kill("SIGKILL");
    }
  }, 60_000);

  test("harnesses codex --json filters the catalog", async () => {
    const { code, stdout } = await runCli(["harnesses", "codex", "--json"]);
    expect(code).toBe(0);
    const catalog = JSON.parse(stdout) as Array<{ id: string; label: string; kind: string }>;
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.every(h => `${h.id} ${h.label} ${h.kind}`.toLowerCase().includes("codex"))).toBe(true);
    expect(catalog.some(h => h.id === "codex")).toBe(true);
  });

  test("roles supports catalog JSON and substring filtering", async () => {
    const all = await runCli(["roles", "--json"]);
    expect(all.code).toBe(0);
    const catalog = JSON.parse(all.stdout) as Array<{ role: string }>;
    expect(catalog.map(item => item.role)).toEqual([...ROLE_ORDER]);
    const matching = await runCli(["roles", "mcp"]);
    expect(matching.code).toBe(0);
    expect(matching.stdout).toContain("mcp-server");
    expect(matching.stdout).not.toContain("dev-server");
  });

  test("bare agtop with redirected stdout prints a snapshot and exits", async () => {
    const { code, stdout } = await runCli([], { timeout: 60_000 });
    expect(code).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
    expect(stdout).toMatch(/No active AI agent harnesses|PID|CPU/);
  }, 60_000);

  test("run propagates child exit codes 0, 1, and 7", async () => {
    for (const exitCode of [0, 1, 7]) {
      const script = `process.exit(${exitCode})`;
      const result = await runCli(["run", "--harness", "custom", "--", process.execPath, "-e", script]);
      expect(result.code).toBe(exitCode);
    }
  }, 60_000);

  test("run preserves arguments with spaces, quotes, empty strings, and unicode", async () => {
    const outFile = path.join(tempRoot, "argv.json");
    const args = ["", "two words", 'a"b', "C:\\space here\\", "$literal; & ()", "café 日本語"];
    const script = `require('fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)));`;
    const runArgs = ["run", "--harness", "custom", "--", process.execPath, "-e", script, outFile, ...args];
    const { code } = await runCli(runArgs);
    expect(code).toBe(0);
    expect(JSON.parse(fs.readFileSync(outFile, "utf8"))).toEqual(args);
  }, 30_000);

  test("run without a command prints a usage error", async () => {
    const missingCmd = await runCli(["run", "--harness", "custom"]);
    expect(missingCmd.code).toBe(1);
    expect(`${missingCmd.stderr}${missingCmd.stdout}`).toContain("Usage: agtop run");
  });

  test.todo("BUG: agtop run should reject COMMAND when `--` is omitted");

  test("run cleans up a detached grandchild on normal exit", async () => {
    const markerFile = path.join(tempRoot, "grandchild.pid");
    const grandchild = `require('fs').writeFileSync(${JSON.stringify(markerFile)}, String(process.pid)); setInterval(()=>{}, 1000);`;
    const parent = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {stdio:'ignore', detached:true}).unref();`;
    const { code } = await runCli(["run", "--harness", "custom", "--", process.execPath, "-e", parent]);
    expect(code).toBe(0);
    await waitFor(() => fs.existsSync(markerFile), "grandchild pid file");
    const grandchildPid = Number(fs.readFileSync(markerFile, "utf8"));
    await delay(500);
    expect(await pidAlive(grandchildPid)).toBe(false);
  }, 45_000);

  test("kill unknown job id exits nonzero", async () => {
    const { code, stderr } = await runCli(["kill", "agtop-cli-missing-job-id"]);
    expect(code).toBe(1);
    expect(stderr).toContain("Agent tree not found");
  });

  test("lemonade --json against an unused port reports unreachable without hanging", async () => {
    const start = Date.now();
    const { code, stdout } = await runCli(["lemonade", "--json"], { timeout: 10_000 });
    expect(code).toBe(0);
    expect(Date.now() - start).toBeLessThan(9000);
    const status = JSON.parse(stdout) as { reachable: boolean; error?: string };
    expect(status.reachable).toBe(false);
  });

  test("run --lemonade injects base URLs and preserves OPENAI_API_KEY", async () => {
    const envFile = path.join(tempRoot, "lemonade-env.json");
    const closedPort = await pickClosedPort();
    const baseUrl = `http://127.0.0.1:${closedPort}`;
    const script = `require('fs').writeFileSync(process.argv[1], JSON.stringify({
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
      OPENAI_API_BASE: process.env.OPENAI_API_BASE,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      AGTOP_BACKEND: process.env.AGTOP_BACKEND,
    }));`;
    const preservedKey = "agtop-cli-test-key-should-stay";
    const { code } = await runCli(
      ["run", "--harness", "custom", "--lemonade", "--lemonade-url", baseUrl, "--", process.execPath, "-e", script, envFile],
      { env: { OPENAI_API_KEY: preservedKey } },
    );
    expect(code).toBe(0);
    const captured = JSON.parse(fs.readFileSync(envFile, "utf8")) as Record<string, string | undefined>;
    expect(captured.OPENAI_API_KEY).toBe(preservedKey);
    expect(captured.OPENAI_BASE_URL).toBe(`${baseUrl}/v1`);
    expect(captured.OPENAI_API_BASE).toBe(`${baseUrl}/v1`);
    expect(captured.ANTHROPIC_BASE_URL).toBe(baseUrl);
    expect(captured.AGTOP_BACKEND).toBe("amd-lemonade-local");
  }, 30_000);
});
