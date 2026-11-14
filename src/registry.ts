import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { windowsApi } from "./windows.js";
import { darwinIdentities, darwinScannerMode } from "./darwin.js";
import type { JobRecord } from "./types.js";

export function stateDir(): string {
  return process.env.AGTOP_STATE_DIR || path.join(process.env.LOCALAPPDATA || process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "agtop");
}
export function validateJobId(id: string): void {
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) throw new Error("Job ID must contain 1–80 letters, digits, underscores, or hyphens.");
}
function recordPath(id: string): string { validateJobId(id); return path.join(stateDir(), `${id}.json`); }
export function reserveJob(id: string, staleCheck = isStaleJob): () => void {
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const file = recordPath(id);
  if (fs.existsSync(file)) {
    try {
      const record = JSON.parse(fs.readFileSync(file, "utf8")) as JobRecord;
      if (record.jobId === id && staleCheck(record)) fs.rmSync(file);
    } catch { /* Preserve unreadable records; a later explicit cleanup can report them. */ }
  }
  const fd = fs.openSync(file, "wx", 0o600);
  fs.closeSync(fd);
  return () => { fs.rmSync(file, { force: true }); };
}

export interface ProcessIdentity { pid: number; startTime: string; pgid?: number; tag?: string }
const powershellProcesses = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); @(Get-CimInstance Win32_Process | Select-Object ProcessId,@{n='Start';e={([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds().ToString()}}) | ConvertTo-Json -Compress";
function parseWindowsSnapshot(raw: string): ProcessIdentity[] {
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) || [];
  return (Array.isArray(parsed) ? parsed : [parsed]).map(p => ({ pid: Number(p.ProcessId), startTime: String(p.Start) }));
}
export function processSnapshot(platform: NodeJS.Platform = process.platform): ProcessIdentity[] {
  if (platform === "win32") {
    const raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", powershellProcesses], { encoding: "utf8", windowsHide: true, timeout: 20000 });
    return parseWindowsSnapshot(raw);
  }
  return processSnapshotFast(platform);
}
function processSnapshotFast(platform: NodeJS.Platform): ProcessIdentity[] {
  if (platform === "darwin") {
    if (darwinScannerMode() === "ps") throw new Error("Stale-job checks require the native macOS process snapshot.");
    return darwinIdentities();
  }
  if (platform !== "linux") throw new Error("Unsupported platform");
  return fs.readdirSync("/proc").filter(n => /^\d+$/.test(n)).flatMap(n => {
    try {
      const pid = Number(n), stat = fs.readFileSync(`/proc/${n}/stat`, "utf8"), end = stat.lastIndexOf(")"), fields = stat.slice(end + 2).trim().split(/\s+/);
      const startTime = fields[19], pgid = Number(fields[2]);
      const env = fs.readFileSync(`/proc/${n}/environ`, "utf8").split("\0").find(v => v.startsWith("AGTOP_JOB_ID="));
      if (fs.readFileSync(`/proc/${n}/stat`, "utf8").slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19] !== startTime) return [];
      return [{ pid, startTime, pgid, tag: env?.slice("AGTOP_JOB_ID=".length) }];
    } catch { return []; }
  });
}
export async function processSnapshotAsync(platform: NodeJS.Platform = process.platform, signal?: AbortSignal): Promise<ProcessIdentity[]> {
  if (platform !== "win32") return processSnapshotFast(platform);
  const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", powershellProcesses], { encoding: "utf8", windowsHide: true, timeout: 20000, ...(signal ? { signal } : {}) }) as { stdout: string };
  return parseWindowsSnapshot(stdout);
}
function cgroupPids(dir: string): number[] {
  const pids = fs.readFileSync(path.join(dir, "cgroup.procs"), "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
  for (const child of fs.readdirSync(dir, { withFileTypes: true })) if (child.isDirectory()) pids.push(...cgroupPids(path.join(dir, child.name)));
  return pids;
}
/** Unknown or inaccessible containment state is kept as live. */
export function isStaleJob(record: JobRecord, processes?: ProcessIdentity[], containedPids?: number[], platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (!/^\d+$/.test(record.startTime)) return false;
    const snapshot = processes ?? processSnapshot(platform);
    const root = snapshot.find(p => p.pid === record.rootPid);
    if (root?.startTime === record.startTime) return false;
    if (root && root.startTime !== record.startTime) { /* PID reuse: the recorded supervisor is dead. */ }
    else if (!root) { /* Missing supervisor. */ }
    else return false;
    if (record.mode === "win32-job-object") {
      if (platform !== "win32" || !record.jobName) return false;
      const pids = containedPids ?? windowsApi().withJob(record.jobName, 4, h => windowsApi().pids(h));
      return pids !== undefined && pids.length === 0;
    }
    if (record.mode === "linux-cgroup") {
      if (platform !== "linux" || !record.cgroupPath) return false;
      if (containedPids) return containedPids.length === 0;
      try { return cgroupPids(record.cgroupPath).length === 0; }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return true; throw e; }
    }
    if ((record.mode === "linux-env-pgid" && platform === "linux") ||
      (record.mode === "darwin-env-pgid" && platform === "darwin")) {
      return !snapshot.some(p => p.tag === record.jobId || p.pgid === record.rootPid);
    }
    return false;
  } catch { return false; }
}
export function pruneStaleJobs(dryRun = false, staleCheck = isStaleJob): string[] {
  const stale = readJobs().filter(job => staleCheck(job)).map(job => job.jobId);
  if (!dryRun) for (const id of stale) fs.rmSync(recordPath(id), { force: true });
  return stale;
}
export function writeJob(record: JobRecord): void {
  const file = recordPath(record.jobId);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(temp, file);
}
export function readJobs(): JobRecord[] {
  let files: string[];
  try { files = fs.readdirSync(stateDir()); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  const records: JobRecord[] = [];
  for (const name of files.filter(n => n.endsWith(".json"))) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(stateDir(), name), "utf8")) as JobRecord;
      validateJobId(r.jobId);
      if (r.version === 1 && name === `${r.jobId}.json` && Number.isSafeInteger(r.rootPid) && r.rootPid > 0 && typeof r.startTime === "string") records.push(r);
    } catch { /* Ignore incomplete reservations and damaged records. */ }
  }
  return records;
}
