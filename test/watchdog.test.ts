import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnContainedAgent } from "../src/manager.js";
import { readJobs } from "../src/registry.js";
import { cleanupWatchdog, launchWatchdog, runWatchdog, WATCHDOG_ARG, watchdogCommand } from "../src/watchdog.js";
import type { PosixOps } from "../src/platform.js";
import type { RawOsProcess } from "../src/types.js";

const savedEnv = new Map<string, string | undefined>();
afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  savedEnv.clear();
});

function setEnv(key: string, value: string): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  process.env[key] = value;
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

async function waitPidGone(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && processExists(pid)) await new Promise(resolve => setTimeout(resolve, 20));
  expect(processExists(pid)).toBe(false);
}

function fakeOps(overrides: Partial<PosixOps> = {}): PosixOps {
  return {
    platform: process.platform === "darwin" ? "darwin" : "linux",
    fallbackMode: process.platform === "darwin" ? "darwin-env-pgid" : "linux-env-pgid",
    scan: async () => [],
    identity: async () => "100",
    signal: async () => "checked",
    assertWritable() {},
    ...overrides,
  };
}

test("watchdog command resolves source and dist entrypoints", () => {
  const sourceUrl = pathToFileURL(path.resolve("src/watchdog.ts")).href;
  const sourcePath = path.resolve("src/watchdog-main.ts");
  expect(watchdogCommand(123, "job", { moduleUrl: sourceUrl, exists: file => file === sourcePath, execPath: "runtime" })).toEqual({
    command: "runtime", args: [sourcePath, "123", "job"], env: expect.any(Object),
  });

  const distUrl = pathToFileURL(path.resolve("dist/watchdog.js")).href;
  const distPath = path.resolve("dist/watchdog-main.js");
  expect(watchdogCommand(123, "job", { moduleUrl: distUrl, exists: file => file === distPath, execPath: "runtime" }).args).toEqual([distPath, "123", "job"]);
});

test("watchdog command dispatches compiled modules through the hidden CLI argument", () => {
  const sourceUrl = pathToFileURL(path.resolve("src/watchdog.ts")).href;
  const moduleUrls = [sourceUrl.replace("watchdog.ts", "$bunfs/root/watchdog.ts"), sourceUrl.replace("watchdog.ts", "~BUN/watchdog.ts")];
  for (const moduleUrl of moduleUrls) {
    expect(watchdogCommand(42, "compiled", { moduleUrl, exists: () => true, execPath: "agtop" })).toEqual({
      command: "agtop", args: [WATCHDOG_ARG, "42", "compiled"], env: expect.any(Object),
    });
  }
  expect(watchdogCommand(42, "missing", { moduleUrl: pathToFileURL(path.resolve("src/watchdog.ts")).href, exists: () => false }).args)
    .toEqual([WATCHDOG_ARG, "42", "missing"]);
});

test("watchdog command removes inherited job tags and enables Electron Node mode", () => {
  for (const key of ["AGTOP_JOB_ID", "AGTOP_HARNESS", "AGTOP_PEER", "AGTOP_WORKTREE", "AGTOP_BACKEND", "AGTOP_DAEMON_TOKEN"]) setEnv(key, "inherited");
  const command = watchdogCommand(3, "job", {
    moduleUrl: pathToFileURL(path.resolve("src/watchdog.ts")).href,
    exists: () => true,
    electron: true,
  });
  for (const key of ["AGTOP_JOB_ID", "AGTOP_HARNESS", "AGTOP_PEER", "AGTOP_WORKTREE", "AGTOP_BACKEND", "AGTOP_DAEMON_TOKEN"]) expect(command.env[key]).toBeUndefined();
  expect(command.env.ELECTRON_RUN_AS_NODE).toBe("1");
});

test("runWatchdog rejects invalid arguments", async () => {
  expect(await runWatchdog([])).toBe(2);
  expect(await runWatchdog(["0", "job"])).toBe(2);
  expect(await runWatchdog(["12", "../invalid"])).toBe(2);
});

test("launchWatchdog rejects a helper that exits before readiness", async () => {
  await expect(launchWatchdog({ command: process.execPath, args: ["-e", "process.exit(17)"], env: process.env }, 2_000))
    .rejects.toThrow("Crash-cleanup helper failed to start (exit 17)");
});

test("launchWatchdog kills and rejects a helper that never becomes ready", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-watchdog-never-ready-"));
  const pidFile = path.join(temporary, "helper-pid");
  const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`;
  try {
    await expect(launchWatchdog({ command: process.execPath, args: ["-e", script], env: process.env }, 50))
    .rejects.toThrow("Crash-cleanup helper failed to start (exit null)");
    const helperPid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(Number.isSafeInteger(helperPid)).toBe(true);
    await waitPidGone(helperPid);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test("watchdog retries EPERM a bounded number of times, then exits with failure", async () => {
  const target: RawOsProcess = { pid: 900_001, ppid: 1, name: "blocked", cmdline: "blocked", startTime: "10", cpuSeconds: 0, cpuPercent: 0, memoryMb: 0, pgid: 42 };
  let attempts = 0;
  const ops = fakeOps({
    scan: async () => [target],
    signal: async () => { attempts++; throw Object.assign(new Error("denied"), { code: "EPERM" }); },
  });
  expect(await cleanupWatchdog(42, "blocked-job", ops, { deadlineMs: 500, maxPermissionFailures: 3, scanDelayMs: 1 })).toBe(1);
  expect(attempts).toBe(3);
});

test("watchdog cleanup returns failure at the overall deadline", async () => {
  const ops = fakeOps({ scan: () => new Promise(() => {}) });
  expect(await cleanupWatchdog(42, "hung-job", ops, { deadlineMs: 20 })).toBe(1);
});

test("watchdog does not signal ready when the job root identity cannot be read", async () => {
  let readyCount = 0, waitCount = 0;
  const beforeHup = process.listenerCount("SIGHUP"), beforeInt = process.listenerCount("SIGINT");
  const result = await runWatchdog(["42", "identity-job"], fakeOps({ identity: async () => undefined }), {
    io: { isControlPipe: () => true, sendReady: () => { readyCount++; }, waitForManager: () => { waitCount++; } },
  });
  expect(result).toBe(1);
  expect(readyCount).toBe(0);
  expect(waitCount).toBe(0);
  expect(process.listenerCount("SIGHUP")).toBe(beforeHup);
  expect(process.listenerCount("SIGINT")).toBe(beforeInt);
});

test("watchdog rejects a control descriptor that is not a pipe or socket", async () => {
  let readyCount = 0;
  const result = await runWatchdog(["42", "bad-pipe"], fakeOps(), {
    io: { isControlPipe: () => false, sendReady: () => { readyCount++; }, waitForManager() {} },
  });
  expect(result).toBe(2);
  expect(readyCount).toBe(0);
});

test.skipIf(process.platform === "win32")("failed manager watchdog launch kills the helper and keeps the gated harness from starting", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-watchdog-launch-failure-"));
  const state = path.join(temporary, "state");
  const helperPidFile = path.join(temporary, "helper-pid");
  const harnessMarker = path.join(temporary, "harness-started");
  const helperScript = `require('fs').writeFileSync(${JSON.stringify(helperPidFile)},String(process.pid));setInterval(()=>{},1000);`;
  const harnessScript = `require('fs').writeFileSync(${JSON.stringify(harnessMarker)},'started');setInterval(()=>{},1000);`;
  try {
    setEnv("NODE_ENV", "test");
    setEnv("AGTOP_STATE_DIR", state);
    setEnv("AGTOP_TEST_WATCHDOG_COMMAND", JSON.stringify([process.execPath, "-e", helperScript]));
    setEnv("AGTOP_TEST_WATCHDOG_TIMEOUT_MS", "50");
    await expect(spawnContainedAgent({ jobId: "watchdog-never-ready", harness: "custom", command: process.execPath, args: ["-e", harnessScript] }))
      .rejects.toThrow("Crash-cleanup helper failed to start (exit null)");
    const helperPid = Number(fs.readFileSync(helperPidFile, "utf8"));
    expect(Number.isSafeInteger(helperPid)).toBe(true);
    expect(fs.existsSync(harnessMarker)).toBe(false);
    expect(readJobs().some(job => job.jobId === "watchdog-never-ready")).toBe(false);
    expect(fs.existsSync(path.join(state, "watchdog-never-ready.json"))).toBe(false);
    await waitPidGone(helperPid);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
