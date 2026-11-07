import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RawOsProcess } from "./types.js";
import { collectSocketConnections } from "./sockets.js";
export { detectHarness, harnesses, harnessCatalog, harnessKind, harnessLabel, isLocalHarness } from "./harnesses.js";
export type { HarnessDefinition, HarnessKind, HarnessRule } from "./harnesses.js";

const exec = promisify(execFile);
let linuxUnits: Promise<{ hz: number; page: number }> | undefined;
function units() {
  return linuxUnits ??= Promise.all([exec("getconf", ["CLK_TCK"]), exec("getconf", ["PAGESIZE"])]).then(([hz, page]) => ({ hz: Number(hz.stdout), page: Number(page.stdout) }));
}
export function parseLinuxStat(raw: string, hz: number, page: number): RawOsProcess {
  const end = raw.lastIndexOf(")");
  const fields = raw.slice(end + 2).trim().split(/\s+/);
  if (end < 0 || fields.length < 22) throw new Error("Malformed /proc stat");
  const name = raw.slice(raw.indexOf("(") + 1, end);
  return { pid: Number(raw.slice(0, raw.indexOf(" "))), ppid: Number(fields[1]), pgid: Number(fields[2]), name, cmdline: name, state: fields[0],
    startTime: fields[19], cpuSeconds: (Number(fields[11]) + Number(fields[12])) / hz,
    cpuPercent: 0, memoryMb: Math.max(0, Number(fields[21])) * page / 1048576 };
}
const envKeys = new Set(["AGTOP_JOB_ID", "AGTOP_HARNESS", "AGTOP_PEER", "AGTOP_WORKTREE", "AGTOP_BACKEND", "OPENAI_API_BASE", "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL"]);
export function parseEnvironment(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of raw.split("\0")) {
    const eq = pair.indexOf("=");
    if (envKeys.has(pair.slice(0, eq))) result[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return result;
}
export async function linuxIdentity(pid: number): Promise<string | undefined> {
  try { return parseLinuxStat(await fs.readFile(`/proc/${pid}/stat`, "utf8"), 1, 1).startTime; } catch { return; }
}
export async function scanLinuxProcesses(): Promise<RawOsProcess[]> {
  const { hz, page } = await units();
  const entries = (await fs.readdir("/proc")).filter(s => /^\d+$/.test(s));
  const results: RawOsProcess[] = [];
  // Bounded workers avoid exhausting descriptors on large machines.
  let index = 0;
  await Promise.all(Array.from({ length: 16 }, async () => {
    while (index < entries.length) {
      const dir = `/proc/${entries[index++]}`;
      try {
        const p = parseLinuxStat(await fs.readFile(`${dir}/stat`, "utf8"), hz, page);
        if (p.state === "Z" || p.state === "X") continue;
        const [cmd, cwd, env, cg] = await Promise.all([
          fs.readFile(`${dir}/cmdline`, "utf8").catch(() => ""), fs.readlink(`${dir}/cwd`).catch(() => undefined),
          fs.readFile(`${dir}/environ`, "utf8").catch(() => ""), fs.readFile(`${dir}/cgroup`, "utf8").catch(() => ""),
        ]);
        if (await linuxIdentity(p.pid) !== p.startTime) continue;
        p.argv = cmd.split("\0").filter(Boolean); p.cmdline = p.argv.join(" ") || p.name;
        p.cwd = cwd; p.envTags = parseEnvironment(env); p.cgroup = /^0::(.+)$/m.exec(cg)?.[1];
        results.push(p);
      } catch { /* Permission denied or a process exited. */ }
    }
  }));
  await collectSocketConnections(results);
  return results;
}
export async function scanWindowsProcesses(): Promise<RawOsProcess[]> {
  const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize,KernelModeTime,UserModeTime,@{n='Start';e={([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds().ToString()}}) | ConvertTo-Json -Compress";
  const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 20000, maxBuffer: 32 * 1024 * 1024 });
  const parsed = JSON.parse(stdout.replace(/^\uFEFF/, "")) || [];
  const results = (Array.isArray(parsed) ? parsed : [parsed]).filter(p => p.ProcessId > 0).map(p => ({
    pid: Number(p.ProcessId), ppid: Number(p.ParentProcessId), name: p.Name || "", cmdline: p.CommandLine || p.Name || "",
    startTime: /^\d+$/.test(String(p.Start)) ? String(p.Start) : "0", cpuSeconds: (Number(p.KernelModeTime || 0) + Number(p.UserModeTime || 0)) / 1e7,
    memoryMb: Number(p.WorkingSetSize || 0) / 1048576, cpuPercent: 0,
  }));
  await collectSocketConnections(results);
  return results;
}
export class CpuSampler {
  private previous = new Map<number, { start: string; seconds: number; at: number }>();
  sample(processes: RawOsProcess[], at = performance.now()): RawOsProcess[] {
    const next = new Map<number, { start: string; seconds: number; at: number }>();
    for (const p of processes) {
      const old = this.previous.get(p.pid);
      p.cpuPercent = old?.start === p.startTime && at > old.at ? Math.max(0, (p.cpuSeconds - old.seconds) / ((at - old.at) / 1000) * 100) : 0;
      next.set(p.pid, { start: p.startTime, seconds: p.cpuSeconds, at });
    }
    this.previous = next;
    return processes;
  }
}
