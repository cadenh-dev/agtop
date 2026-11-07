import { afterEach, expect, test } from "bun:test";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { launchWatchdog, runWatchdog, WATCHDOG_ARG, watchdogCommand } from "../src/watchdog.js";

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
  await expect(launchWatchdog({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], env: process.env }, 50))
    .rejects.toThrow("Crash-cleanup helper failed to start (exit null)");
});
