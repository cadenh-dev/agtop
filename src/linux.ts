import * as fs from "node:fs";
import koffi from "koffi";
import { linuxIdentity } from "./discovery.js";

type PidfdOps = {
  open(pid: number): number;
  send(fd: number, signal: number): number;
};

function loadPidfdOps(): PidfdOps | undefined {
  try {
    const libc = koffi.load("libc.so.6");
    return {
      open: libc.func("int pidfd_open(int pid, unsigned int flags)"),
      send: libc.func("int pidfd_send_signal(int pidfd, int sig, void *info, unsigned int flags)"),
    };
  } catch { return undefined; }
}

const pidfdOps = process.platform === "linux" ? loadPidfdOps() : undefined;

/** Signal only the process instance whose /proc start time was observed. */
export async function signalLinuxProcess(pid: number, expectedStartTime: string, signal: number,
  ops: PidfdOps | undefined = pidfdOps, identity: (pid: number) => Promise<string | undefined> = linuxIdentity): Promise<"pidfd" | "fallback" | "reused"> {
  if (ops) {
    const fd = ops.open(pid);
    if (fd >= 0) {
      try {
        if (await identity(pid) !== expectedStartTime) return "reused";
        if (ops.send(fd, signal) === 0) return "pidfd";
        // Unsupported syscall or a transient pidfd failure: retain the legacy
        // identity-checked path. Permission failures surface there as well.
      } finally { fs.closeSync(fd); }
    }
  }
  if (await identity(pid) !== expectedStartTime) return "reused";
  process.kill(pid, signal);
  return "fallback";
}
