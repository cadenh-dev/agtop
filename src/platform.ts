import { scanDarwinProcesses, scanLinuxProcesses, scanWindowsProcesses, linuxIdentity } from "./discovery.js";
import { darwinIdentity, darwinScannerMode } from "./darwin.js";
import { signalLinuxProcess } from "./linux.js";
import type { ContainmentMode, RawOsProcess } from "./types.js";

export type SignalOutcome = "pidfd" | "fallback" | "checked" | "reused";

export interface PosixOps {
  platform: "linux" | "darwin";
  fallbackMode: "linux-env-pgid" | "darwin-env-pgid";
  scan(): Promise<RawOsProcess[]>;
  identity(pid: number): Promise<string | undefined>;
  signal(pid: number, expectedStartTime: string, signal: number): Promise<SignalOutcome>;
  /** Throws in AGTOP_DARWIN_SCANNER=ps mode; no-op otherwise. */
  assertWritable(): void;
}

export function assertSupportedPlatform(platform: NodeJS.Platform = process.platform): void {
  if (!["win32", "linux", "darwin"].includes(platform)) throw new Error("agtop supports Windows, Linux, and macOS.");
}

export function scanProcesses(platform: NodeJS.Platform = process.platform): Promise<RawOsProcess[]> {
  if (platform === "win32") return scanWindowsProcesses();
  if (platform === "linux") return scanLinuxProcesses();
  if (platform === "darwin") return scanDarwinProcesses();
  throw new Error("agtop supports Windows, Linux, and macOS.");
}

export function isPgidMode(mode: ContainmentMode): mode is "linux-env-pgid" | "darwin-env-pgid" {
  return mode === "linux-env-pgid" || mode === "darwin-env-pgid";
}

export async function signalDarwinProcess(pid: number, expectedStartTime: string, signal: number,
  identity: (pid: number) => string | undefined = darwinIdentity): Promise<"checked" | "reused"> {
  // Darwin has no pidfd, so PID reuse can still occur between this check and kill().
  if (identity(pid) !== expectedStartTime) return "reused";
  process.kill(pid, signal);
  return "checked";
}

export function posixOps(platform: NodeJS.Platform = process.platform): PosixOps {
  if (platform === "linux") {
    return {
      platform,
      fallbackMode: "linux-env-pgid",
      scan: scanLinuxProcesses,
      identity: linuxIdentity,
      signal: (pid, expectedStartTime, signal) => signalLinuxProcess(pid, expectedStartTime, signal),
      assertWritable() {},
    };
  }
  if (platform === "darwin") {
    return {
      platform,
      fallbackMode: "darwin-env-pgid",
      scan: scanDarwinProcesses,
      identity: async pid => darwinIdentity(pid),
      signal: (pid, expectedStartTime, signal) => signalDarwinProcess(pid, expectedStartTime, signal),
      assertWritable() {
        if (darwinScannerMode() === "ps") throw new Error("Process containment is unavailable when AGTOP_DARWIN_SCANNER=ps.");
      },
    };
  }
  throw new Error("POSIX process operations are unavailable on Windows.");
}
