import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import type { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { posixOps, type PosixOps } from "./platform.js";
import { validateJobId } from "./registry.js";
import type { RawOsProcess } from "./types.js";

export const WATCHDOG_ARG = "__agtop-watchdog";

export interface WatchdogCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export function watchdogCommand(pgid: number, jobId: string, options: {
  moduleUrl?: string;
  exists?: (file: string) => boolean;
  execPath?: string;
  electron?: boolean;
} = {}): WatchdogCommand {
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  const modulePath = fileURLToPath(moduleUrl);
  const ext = path.extname(modulePath);
  const script = fileURLToPath(new URL(`./watchdog-main${ext}`, moduleUrl));
  const exists = options.exists ?? fs.existsSync;
  const compiled = moduleUrl.includes("/$bunfs/") || moduleUrl.includes("~BUN") || !exists(script);
  const command = options.execPath ?? process.execPath;
  const env = { ...process.env };
  for (const key of ["AGTOP_JOB_ID", "AGTOP_HARNESS", "AGTOP_PEER", "AGTOP_WORKTREE", "AGTOP_BACKEND", "AGTOP_DAEMON_TOKEN"]) delete env[key];
  if (options.electron ?? Boolean(process.versions.electron)) env.ELECTRON_RUN_AS_NODE = "1";
  return {
    command,
    args: compiled ? [WATCHDOG_ARG, String(pgid), jobId] : [script, String(pgid), jobId],
    env,
  };
}

export async function launchWatchdog(cmd: WatchdogCommand, timeoutMs = 10_000): Promise<{ child: ChildProcess; pipe: Writable }> {
  const child = spawn(cmd.command, cmd.args, {
    stdio: ["ignore", "pipe", "ignore", "pipe"],
    env: cmd.env,
    detached: true,
  });
  const stdout = child.stdout;
  const pipe = child.stdio[3] as Writable;
  if (!stdout || !pipe) {
    child.kill("SIGKILL");
    throw new Error("Crash-cleanup helper failed to start (exit null)");
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    let timer: NodeJS.Timeout;
    const cleanup = () => {
      clearTimeout(timer);
      stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const fail = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      stdout.destroy();
      pipe.destroy();
      child.kill("SIGKILL");
      reject(new Error(`Crash-cleanup helper failed to start (exit ${code ?? "null"})`));
    };
    const onData = (chunk: Buffer | string) => {
      output += String(chunk);
      const lines = output.split(/\r?\n/);
      output = lines.pop() ?? "";
      if (lines.includes("ready")) {
        if (settled) return;
        settled = true;
        cleanup();
        stdout.destroy();
        child.unref();
        (pipe as Socket).unref?.();
        resolve({ child, pipe });
      }
    };
    const onError = () => fail(null);
    const onExit = (code: number | null) => fail(code);
    stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    timer = setTimeout(() => fail(null), Math.max(0, timeoutMs));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function runWatchdog(args: string[], ops?: PosixOps): Promise<number> {
  const pgid = Number(args[0]);
  const jobId = args[1];
  if (!Number.isSafeInteger(pgid) || pgid <= 0 || !jobId) return 2;
  try { validateJobId(jobId); } catch { return 2; }
  try { fs.fstatSync(3); } catch { return 2; }
  ops ??= posixOps();
  try { ops.assertWritable(); } catch { return 1; }

  // The helper has its own session and ignores terminal signals if they are
  // sent directly to it, so it can outlive the manager during cleanup.
  const ignore = () => {};
  process.on("SIGHUP", ignore);
  process.on("SIGINT", ignore);

  try { fs.writeSync(1, "ready\n"); } catch { return 1; }

  // fd 3 is held open by the manager. EOF means the manager exited, including
  // an uncatchable crash, so this watchdog owns final fallback cleanup.
  const byte = Buffer.alloc(1);
  try { while (fs.readSync(3, byte, 0, 1, null) > 0) {} } catch { /* Treat a broken pipe as manager death. */ }

  let quietScans = 0;
  let consecutiveFailures = 0;
  while (quietScans < 4) {
    let processes: RawOsProcess[];
    try {
      processes = await ops.scan();
      consecutiveFailures = 0;
    } catch {
      quietScans = 0;
      consecutiveFailures++;
      if (consecutiveFailures >= 40) return 1;
      await delay(250);
      continue;
    }
    const targets = processes.filter(p => p.pid !== process.pid && (p.pgid === pgid || p.envTags?.AGTOP_JOB_ID === jobId));
    if (!targets.length) quietScans++;
    else {
      quietScans = 0;
      await Promise.all(targets.map(async p => {
        try { await ops.signal(p.pid, p.startTime, 9); } catch { /* Exit or permission race; retry on next scan. */ }
      }));
    }
    if (quietScans < 4) await delay(100);
  }
  return 0;
}
