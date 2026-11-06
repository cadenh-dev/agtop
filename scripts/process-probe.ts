import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

export interface ProcessProbe {
  pid: number;
  ppid: number;
  name: string;
  cmdline: string;
}

/** Find processes whose command line contains a unique test marker. */
export function findByMarker(marker: string): ProcessProbe[] {
  if (process.platform === "win32") {
    const quoted = marker.replace(/'/g, "''");
    const script = `$ErrorActionPreference='SilentlyContinue'; @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${quoted}*' } | Select-Object ProcessId,ParentProcessId,Name,CommandLine) | ConvertTo-Json -Compress`;
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
    const parsed = JSON.parse(output.trim() || "[]") as unknown;
    const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    return rows.map((row: any) => ({
      pid: Number(row.ProcessId),
      ppid: Number(row.ParentProcessId),
      name: String(row.Name || ""),
      cmdline: String(row.CommandLine || ""),
    })).filter(process => process.pid > 0);
  }
  const result: ProcessProbe[] = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").replace(/\0/g, " ").trim();
      if (!cmdline.includes(marker)) continue;
      const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[1]);
      result.push({ pid: Number(entry), ppid, name: path.basename(cmdline.split(" ")[0] || ""), cmdline });
    } catch { /* process exited */ }
  }
  return result;
}

/** Best-effort cleanup for benchmark leftovers. */
export function killByMarker(marker: string): number[] {
  const killed: number[] = [];
  for (const probe of findByMarker(marker)) {
    try {
      process.kill(probe.pid, "SIGKILL");
      killed.push(probe.pid);
    } catch { /* already gone */ }
  }
  return killed;
}
