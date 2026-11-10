import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { Writable } from "node:stream";
import { CpuSampler, harnesses, isLocalHarness } from "./discovery.js";
import { backendFor, lemonadeBase } from "./backend.js";
import { readJobs, reserveJob, validateJobId, writeJob } from "./registry.js";
import { correlateTrees } from "./trees.js";
import { accelSampler } from "./accelerators.js";
import { windowsApi } from "./windows.js";
import { assertSupportedPlatform, isPgidMode, posixOps, scanProcesses } from "./platform.js";
import { ignoreWatchdogPipeErrors, launchWatchdog, watchdogCommand } from "./watchdog.js";
import type { AgentProcessTree, JobRecord, KillResult, ManagedAgent, RawOsProcess, SpawnAgentOptions } from "./types.js";

const sampler = new CpuSampler();
function supported() { assertSupportedPlatform(); }
function cgroupMembers(dir: string): number[] {
  const pids = fs.readFileSync(path.join(dir, "cgroup.procs"), "utf8").trim().split(/\s+/).map(Number).filter(n => n > 0);
  for (const child of fs.readdirSync(dir, { withFileTypes: true })) if (child.isDirectory()) pids.push(...cgroupMembers(path.join(dir, child.name)));
  return [...new Set(pids)];
}
function members(job: JobRecord, processes: RawOsProcess[]): number[] {
  if (job.mode === "win32-job-object" && process.platform === "win32" && job.jobName) return windowsApi().withJob(job.jobName, 4, h => windowsApi().pids(h)) || [];
  if (job.mode === "linux-cgroup" && job.cgroupPath) {
    try { return cgroupMembers(job.cgroupPath); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  }
  if (isPgidMode(job.mode)) {
    const root = processes.find(p => p.pid === job.rootPid && p.startTime === job.startTime && p.pgid === job.rootPid);
    return processes.filter(p => p.envTags?.AGTOP_JOB_ID === job.jobId || (!!root && p.pgid === job.rootPid)).map(p => p.pid);
  }
  return [];
}
let scanning: Promise<AgentProcessTree[]> | undefined;
export function listAgentTrees(): Promise<AgentProcessTree[]> {
  supported();
  return scanning ??= (async () => {
    const processes = sampler.sample(await scanProcesses());
    const jobs = readJobs();
    const trees = correlateTrees(processes, jobs, new Map(jobs.map(job => [job.jobId, members(job, processes)])));
    try { await accelSampler.sample(trees); } catch { /* Accelerator telemetry must not fail process discovery. */ }
    return trees;
  })().finally(() => { scanning = undefined; });
}
export async function killAgentTree(id: string, options: { expectedStartTime?: string } = {}): Promise<KillResult> {
  const target = (await listAgentTrees()).find(t => t.jobId === id || String(t.rootPid) === id);
  if (!target) throw new Error(`Agent tree not found: ${id}`);
  if (options.expectedStartTime !== undefined && (target.processes.find(p => p.pid === target.rootPid)?.startTime ?? "") !== options.expectedStartTime) {
    throw new Error("The process identity changed. Refresh the agent tree before terminating it.");
  }
  if (target.processes.some(p => p.pid === process.pid)) throw new Error("Refusing to terminate a tree containing this manager.");
  const result: KillResult = { killedPids: [], failedPids: [], errors: [] };
  const job = readJobs().find(j => j.jobId === target.jobId);
  const posix = process.platform === "win32" ? undefined : posixOps();
  posix?.assertWritable();
  let atomic = false;
  try {
    if (job?.mode === "win32-job-object" && job.jobName) {
      const done = windowsApi().withJob(job.jobName, 4 | 8, h => { windowsApi().check(windowsApi().terminateJob(h, 1), "TerminateJobObject"); return true; });
      if (!done) throw new Error("Job Object no longer exists.");
      atomic = true;
    } else if (job?.mode === "linux-cgroup" && job.cgroupPath) {
      fs.writeFileSync(path.join(job.cgroupPath, "cgroup.kill"), "1"); atomic = true;
    }
  } catch (e) { result.errors.push(String(e)); }
  if (!atomic) {
    for (const p of [...target.processes].reverse()) {
      try {
        if (process.platform === "win32") { if (windowsApi().killProcess(p)) result.killedPids.push(p.pid); else result.failedPids.push(p.pid); }
        else await posix!.signal(p.pid, p.startTime, 9);
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") result.errors.push(`PID ${p.pid}: ${String(e)}`); }
    }
  }
  // Report observed exits, never turn a failed termination call into a success count.
  for (let attempt = 0; attempt < 20; attempt++) {
    const remaining = await scanProcesses();
    const alive = new Set(remaining.map(p => `${p.pid}:${p.startTime}`));
    result.killedPids = target.processes.filter(p => !alive.has(`${p.pid}:${p.startTime}`)).map(p => p.pid);
    result.failedPids = target.processes.filter(p => alive.has(`${p.pid}:${p.startTime}`)).map(p => p.pid);
    if (!result.failedPids.length || process.platform === "win32") break;
    await delay(50);
  }
  return result;
}
function executable(command: string, cwd: string, env: Record<string, string>): string {
  const paths = /[/\\]/.test(command) ? [path.resolve(cwd, command)] : (env.PATH || env.Path || "").split(path.delimiter).map(p => path.join(p, command));
  for (const candidate of paths) {
    for (const suffix of process.platform === "win32" && !path.extname(candidate) ? [".exe", ".com", ""] : [""]) {
      try {
        const file = candidate + suffix;
        fs.accessSync(file, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
        if (fs.statSync(file).isFile()) {
          if (process.platform === "win32" && /\.(cmd|bat|ps1)$/i.test(file)) throw new Error("Use an explicit interpreter for scripts (for example: cmd.exe /c tool.cmd).");
          return path.resolve(file);
        }
      } catch (e) { if (e instanceof Error && e.message.startsWith("Use an explicit")) throw e; }
    }
  }
  throw new Error(`Executable not found: ${command}. On Windows, pass script shims through their interpreter.`);
}

/** In NODE_ENV=test, these hooks override helper argv and timeout for failed-launch coverage. */
function startWatchdog(pgid: number, jobId: string) {
  const testOverride = process.env.NODE_ENV === "test" ? process.env.AGTOP_TEST_WATCHDOG_COMMAND : undefined;
  if (testOverride === undefined) return launchWatchdog(watchdogCommand(pgid, jobId));
  let command: unknown;
  try { command = JSON.parse(testOverride); } catch { throw new Error("AGTOP_TEST_WATCHDOG_COMMAND must be a JSON string array."); }
  if (!Array.isArray(command) || command.length === 0 || command.some(part => typeof part !== "string") || !command[0]) {
    throw new Error("AGTOP_TEST_WATCHDOG_COMMAND must be a JSON string array with a command.");
  }
  const timeoutText = process.env.AGTOP_TEST_WATCHDOG_TIMEOUT_MS;
  const timeoutMs = timeoutText === undefined ? 10_000 : Number(timeoutText);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("AGTOP_TEST_WATCHDOG_TIMEOUT_MS must be a non-negative number.");
  return launchWatchdog({ command: command[0], args: command.slice(1), env: process.env }, timeoutMs);
}

export async function spawnContainedAgent(opts: SpawnAgentOptions): Promise<ManagedAgent> {
  supported();
  if (process.platform !== "linux" && opts?.cgroupRoot) throw new Error("cgroupRoot is supported only on Linux.");
  if (!opts || !harnesses.includes(opts.harness) || typeof opts.command !== "string" || !opts.command || (opts.args !== undefined && (!Array.isArray(opts.args) || opts.args.some(a => typeof a !== "string")))) throw new Error("Provide a valid harness, command, and string argument array.");
  for (const key of ["cwd", "userOrPeer", "lemonadeUrl", "cgroupRoot"] as const) {
    if (opts[key] !== undefined && typeof opts[key] !== "string") throw new Error(`${key} must be a string.`);
  }
  if (opts.stdio !== undefined && !["inherit", "ignore"].includes(opts.stdio)) throw new Error("stdio must be inherit or ignore.");
  if (opts.useLemonadeLocal !== undefined && typeof opts.useLemonadeLocal !== "boolean") throw new Error("useLemonadeLocal must be a boolean.");
  if (opts.extraEnv !== undefined && (!opts.extraEnv || typeof opts.extraEnv !== "object" || Array.isArray(opts.extraEnv))) throw new Error("extraEnv must be a string map.");
  const id = opts.jobId ?? randomUUID(); validateJobId(id);
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  if (!fs.statSync(cwd).isDirectory()) throw new Error("cwd must be a directory.");
  const env: Record<string, string> = {};
  // Windows environment keys are case insensitive.
  for (const [k, v] of Object.entries({ ...process.env, ...opts.extraEnv })) if (v !== undefined) {
    if (typeof v !== "string" || k.includes("=") || k.includes("\0") || v.includes("\0")) throw new Error("Invalid environment variable.");
    env[process.platform === "win32" ? k.toUpperCase() : k] = v;
  }
  Object.assign(env, { AGTOP_JOB_ID: id, AGTOP_HARNESS: opts.harness, AGTOP_PEER: opts.userOrPeer || os.userInfo().username, AGTOP_WORKTREE: cwd });
  // Do not inherit another manager's backend label.
  delete env.AGTOP_BACKEND;
  delete env.AGTOP_DAEMON_TOKEN;
  if (opts.useLemonadeLocal) {
    const base = lemonadeBase(opts.lemonadeUrl);
    const api = /\/v1$/.test(base) ? base : `${base}/v1`;
    Object.assign(env, { AGTOP_BACKEND: "amd-lemonade-local", OPENAI_BASE_URL: api, OPENAI_API_BASE: api, ANTHROPIC_BASE_URL: base.replace(/\/(api\/)?v1$/, "") });
  }
  const args = opts.args || [];
  if ([opts.command, ...args, cwd, env.AGTOP_PEER].some(v => v.includes("\0"))) throw new Error("Arguments cannot contain NUL characters.");
  const command = executable(opts.command, cwd, env);
  const posix = process.platform === "win32" ? undefined : posixOps();
  posix?.assertWritable();
  const release = reserveJob(id);
  const record: JobRecord = { version: 1, jobId: id, rootPid: 0, startTime: "", harness: opts.harness, peer: env.AGTOP_PEER, cwd,
    backend: backendFor([{ envTags: env } as RawOsProcess], isLocalHarness(opts.harness)).backend,
    mode: process.platform === "win32" ? "win32-job-object" : posix!.fallbackMode, createdAt: new Date().toISOString() };
  if (process.platform === "win32") {
    let native: ReturnType<ReturnType<typeof windowsApi>["launch"]> | undefined;
    try {
      record.jobName = `Local\\agtop-${randomUUID()}`;
      native = windowsApi().launch(record.jobName, command, args, cwd, env, opts.stdio === "inherit");
      record.rootPid = native.pid; record.startTime = native.startTime; writeJob(record); native.resume();
      const handle = native;
      const exited = (async () => {
        try { while (true) { const code = handle.poll(); if (code !== undefined) { handle.kill(); return code; } await delay(100); } }
        finally { handle.close(); release(); }
      })();
      return { jobId: id, pid: record.rootPid, containmentMode: record.mode, exited, terminate: () => killAgentTree(id) };
    } catch (e) {
      try { if (native) try { native.kill(); } finally { native.close(); } }
      finally { release(); }
      throw e;
    }
  }
  let child: ReturnType<typeof spawn> | undefined;
  let watchdog: ReturnType<typeof spawn> | undefined;
  let watchdogPipe: Writable | undefined;
  try {
    const cgroupRoot = process.platform === "linux" ? opts.cgroupRoot ?? process.env.AGTOP_CGROUP_ROOT : undefined;
    if (cgroupRoot) {
      const root = fs.realpathSync(cgroupRoot);
      if (!fs.existsSync(path.join(root, "cgroup.controllers"))) throw new Error("cgroupRoot must be a delegated cgroup v2 directory.");
      record.cgroupPath = path.join(root, `agtop-${randomUUID()}`);
      fs.mkdirSync(record.cgroupPath);
      if (!fs.existsSync(path.join(record.cgroupPath, "cgroup.kill"))) throw new Error("This cgroup does not support cgroup.kill.");
      record.mode = "linux-cgroup";
    }
    // A separate pipe gates exec without consuming the harness's stdin.
    child = spawn("/bin/sh", ["-c", 'read -r gate <&3 || exit 125; exec 3<&-; exec "$@"', "agtop-launch", command, ...args], { cwd, env, detached: true, stdio: [opts.stdio === "inherit" ? "inherit" : "ignore", opts.stdio === "inherit" ? "inherit" : "ignore", opts.stdio === "inherit" ? "inherit" : "ignore", "pipe"] });
    const launched = child;
    const rawExit = new Promise<number>((resolve, reject) => { launched.once("error", reject); launched.once("exit", (code, signal) => resolve(code ?? (signal ? 128 + (os.constants.signals[signal] || 1) : 1))); });
    // Observe errors even if setup fails before returning the public promise.
    void rawExit.catch(() => {});
    // Bun can miss the spawn event; a defined pid already proves the process was created.
    if (launched.pid === undefined) await new Promise<void>((_, reject) => launched.once("error", reject));
    record.rootPid = launched.pid!;
    record.startTime = await posix!.identity(record.rootPid) || "";
    if (!record.startTime) throw new Error("Launch process exited before containment setup.");
    if (record.cgroupPath) fs.writeFileSync(path.join(record.cgroupPath, "cgroup.procs"), String(record.rootPid));
    writeJob(record);
    if (!record.cgroupPath) {
      const started = await startWatchdog(record.rootPid, id);
      watchdog = started.child;
      watchdogPipe = started.pipe;
      ignoreWatchdogPipeErrors(watchdogPipe);
    }
    (launched.stdio[3] as Writable).end("go\n");
    const exited = rawExit.finally(async () => {
      try {
        if (record.cgroupPath) fs.writeFileSync(path.join(record.cgroupPath, "cgroup.kill"), "1");
        else {
          const remaining = await posix!.scan();
          for (const p of remaining.filter(p => p.envTags?.AGTOP_JOB_ID === id || p.pgid === record.rootPid)) {
            try { await posix!.signal(p.pid, p.startTime, 9); } catch {}
          }
        }
      } finally { watchdogPipe?.end(); release(); if (record.cgroupPath) try { fs.rmdirSync(record.cgroupPath); } catch {} }
    });
    return {
      jobId: id, pid: record.rootPid, containmentMode: record.mode, exited,
      terminate: async () => {
        const result = await killAgentTree(id);
        if (!result.failedPids.includes(record.rootPid)) {
          await Promise.race([exited.then(() => {}, () => {}), delay(5_000, undefined, { ref: false })]);
        }
        return result;
      },
    };
  } catch (e) {
    child?.kill("SIGKILL");
    (child?.stdio[3] as Writable | null | undefined)?.destroy();
    watchdogPipe?.end(); watchdog?.kill("SIGKILL"); release();
    if (record.cgroupPath) try { fs.rmdirSync(record.cgroupPath); } catch {}
    throw e;
  }
}
