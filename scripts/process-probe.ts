import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

export interface ProcessProbe {
  pid: number;
  ppid: number;
  name: string;
  cmdline: string;
  state?: string;
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
  if (process.platform === "darwin") {
    const output = execFileSync("/bin/ps", ["-axww", "-o", "pid=,ppid=,stat=,command="], {
      encoding: "utf8", timeout: 20_000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C" },
    });
    const result: ProcessProbe[] = [];
    for (const line of output.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]), ppid = Number(match[2]), state = match[3], cmdline = match[4].trim();
      if (!Number.isSafeInteger(pid) || pid <= 0 || /Z/.test(state) || !cmdline.includes(marker)) continue;
      result.push({ pid, ppid, name: path.basename(cmdline.split(/\s+/, 1)[0] || ""), cmdline, state });
    }
    return result;
  }
  const result: ProcessProbe[] = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").replace(/\0/g, " ").trim();
      if (!cmdline.includes(marker)) continue;
      const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      // A killed process can remain visible as a zombie until its parent reaps it.
      if (fields[0] === "Z" || fields[0] === "X") continue;
      result.push({ pid: Number(entry), ppid: Number(fields[1]), name: path.basename(cmdline.split(" ")[0] || ""), cmdline, state: fields[0] });
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
