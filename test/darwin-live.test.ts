import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { darwinIdentity, darwinTcpRows, DARWIN_ABI_LAYOUT, readDarwinProcesses } from "../src/darwin.js";
import { scanDarwinProcesses } from "../src/discovery.js";

const children: ReturnType<typeof Bun.spawn>[] = [];
function spawnBun(code: string, env: Record<string, string> = {}, stdout: "ignore" | "pipe" = "ignore") {
  const child = Bun.spawn([process.execPath, "-e", code], {
    env: { ...process.env, ...env }, stdin: "ignore", stdout, stderr: "ignore",
  });
  children.push(child);
  return child;
}
async function stop(child: ReturnType<typeof Bun.spawn> | undefined): Promise<void> {
  if (!child) return;
  try { child.kill("SIGKILL"); } catch { /* already exited */ }
  await child.exited.catch(() => undefined);
}
async function readLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const next = await reader.read();
    if (next.done) break;
    text += new TextDecoder().decode(next.value);
  }
  void reader.cancel();
  return text.trim();
}
async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, timeout = 4_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== undefined) return result;
    await delay(40);
  }
  throw new Error("Timed out waiting for the Darwin process/socket snapshot.");
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(stop));
});

describe("live Darwin process discovery", () => {
  test.skipIf(process.platform !== "darwin")("matches child execve argv and this process cwd and identity, and records scan timing", async () => {
    const started = performance.now();
    const processes = readDarwinProcesses();
    const elapsedMs = performance.now() - started;
    const current = processes.find(record => record.pid === process.pid);
    expect(current).toBeDefined();
    expect(current!.cwd).toBe(fs.realpathSync(process.cwd()));
    expect(current!.startTime).toBe(darwinIdentity(process.pid)!);
    const code = "setInterval(() => {}, 1000)";
    const argv = [process.execPath, "-e", code, "--", "a b", "", "雪"];
    const child = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    children.push(child);
    const childRecord = await waitFor(() => readDarwinProcesses().find(record => record.pid === child.pid));
    expect(childRecord.argv).toEqual(argv);
    console.info(`Darwin libproc scan: ${processes.length} readable processes in ${elapsedMs.toFixed(1)} ms`);
  }, 20_000);

  test.skipIf(process.platform !== "darwin")("reads inherited AGTOP tags from a child process", async () => {
    const child = spawnBun("setInterval(() => {}, 1000)", { AGTOP_JOB_ID: "live-x" });
    const rows = await waitFor(() => {
      return scanDarwinProcesses().then(processes => processes.find(record => record.pid === child.pid));
    });
    expect(rows.envTags?.AGTOP_JOB_ID).toBe("live-x");
  }, 20_000);

  test.skipIf(process.platform !== "darwin")("converts Mach ticks to CPU seconds and reports resident memory", async () => {
    const child = spawnBun("const end = Date.now() + 5000; while (Date.now() < end) {} setInterval(() => {}, 1000)");
    const first = readDarwinProcesses().find(record => record.pid === child.pid);
    expect(first).toBeDefined();
    await delay(1_000);
    const second = readDarwinProcesses().find(record => record.pid === child.pid);
    expect(second).toBeDefined();
    expect(second!.cpuSeconds - first!.cpuSeconds).toBeGreaterThanOrEqual(0.2);
    expect(second!.residentBytes).toBeGreaterThan(1_048_576);
  }, 15_000);

  test.skipIf(process.platform !== "darwin")("attributes listener and established client TCP rows to their PIDs", async () => {
    const server = spawnBun("const net = require('node:net'); const server = net.createServer(() => {}); server.listen(0, '127.0.0.1', () => console.log(server.address().port)); setInterval(() => {}, 1000)", {}, "pipe");
    const port = Number(await readLine(server.stdout!));
    expect(port).toBeGreaterThan(0);
    const client = spawnBun(`const net = require('node:net'); net.connect(${port}, '127.0.0.1'); setInterval(() => {}, 1000)`);
    const rows = await waitFor(() => {
      const current = darwinTcpRows([server.pid, client.pid]);
      return current.some(row => row.pid === server.pid && row.state === 2 && row.localPort === port) &&
        current.some(row => row.pid === client.pid && row.state === 5 && row.remotePort === port) ? current : undefined;
    });
    expect(rows).toContainEqual(expect.objectContaining({ pid: server.pid, state: 2, localAddress: "127.0.0.1", localPort: port }));
    expect(rows).toContainEqual(expect.objectContaining({ pid: client.pid, state: 5, remoteAddress: "127.0.0.1", remotePort: port }));
  }, 20_000);

  test.skipIf(process.platform !== "darwin")("attributes IPv6 loopback listener and client addresses at the libproc offsets", async () => {
    const server = spawnBun("const net = require('node:net'); const server = net.createServer(() => {}); server.listen(0, '::1', () => console.log(server.address().port)); setInterval(() => {}, 1000)", {}, "pipe");
    const port = Number(await readLine(server.stdout!));
    expect(port).toBeGreaterThan(0);
    const client = spawnBun(`const net = require('node:net'); net.connect(${port}, '::1'); setInterval(() => {}, 1000)`);
    const rows = await waitFor(() => {
      const current = darwinTcpRows([server.pid, client.pid]);
      return current.some(row => row.pid === server.pid && row.state === 2 && row.localPort === port) &&
        current.some(row => row.pid === client.pid && row.state === 5 && row.remotePort === port) ? current : undefined;
    });
    expect(rows).toContainEqual(expect.objectContaining({ pid: server.pid, state: 2, localAddress: "0:0:0:0:0:0:0:1", localPort: port }));
    expect(rows).toContainEqual(expect.objectContaining({ pid: client.pid, state: 5, remoteAddress: "0:0:0:0:0:0:0:1", remotePort: port }));
  }, 20_000);

  test.skipIf(process.platform !== "darwin")("keeps launchd as a reduced record for non-root scans and agrees with ps process groups", () => {
    const child = spawnBun("setInterval(() => {}, 1000)");
    const processRecord = readDarwinProcesses().find(record => record.pid === child.pid);
    expect(processRecord).toBeDefined();
    const ps = execFileSync("/bin/ps", ["-o", "ppid=,pgid=", "-p", String(child.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim().split(/\s+/).map(Number);
    expect([processRecord!.ppid, processRecord!.pgid]).toEqual(ps);
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      const launchd = readDarwinProcesses().find(record => record.pid === 1);
      expect(launchd).toMatchObject({ restricted: true });
      expect(launchd!.startTime).not.toBe("0");
    }
  }, 20_000);

  const ccAvailable = process.platform === "darwin" && spawnSync("cc", ["--version"], { encoding: "utf8" }).status === 0;
  test.skipIf(process.platform !== "darwin" || !ccAvailable)("matches all used libproc layouts against the macOS SDK headers", () => {
    const source = String.raw`
#include <stddef.h>
#include <stdio.h>
#include <sys/types.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>

#define P(name, value) printf(name "=%zu\n", (size_t)(value))

int main(void) {
  P("proc_bsdinfo.size", sizeof(struct proc_bsdinfo));
  P("proc_bsdinfo.pbi_status", offsetof(struct proc_bsdinfo, pbi_status));
  P("proc_bsdinfo.pbi_pid", offsetof(struct proc_bsdinfo, pbi_pid));
  P("proc_bsdinfo.pbi_ppid", offsetof(struct proc_bsdinfo, pbi_ppid));
  P("proc_bsdinfo.pbi_uid", offsetof(struct proc_bsdinfo, pbi_uid));
  P("proc_bsdinfo.pbi_comm", offsetof(struct proc_bsdinfo, pbi_comm));
  P("proc_bsdinfo.pbi_name", offsetof(struct proc_bsdinfo, pbi_name));
  P("proc_bsdinfo.pbi_nfiles", offsetof(struct proc_bsdinfo, pbi_nfiles));
  P("proc_bsdinfo.pbi_pgid", offsetof(struct proc_bsdinfo, pbi_pgid));
  P("proc_bsdinfo.pbi_start_tvsec", offsetof(struct proc_bsdinfo, pbi_start_tvsec));
  P("proc_bsdinfo.pbi_start_tvusec", offsetof(struct proc_bsdinfo, pbi_start_tvusec));
  P("proc_taskinfo.size", sizeof(struct proc_taskinfo));
  P("proc_taskinfo.pti_resident_size", offsetof(struct proc_taskinfo, pti_resident_size));
  P("proc_taskinfo.pti_total_user", offsetof(struct proc_taskinfo, pti_total_user));
  P("proc_taskinfo.pti_total_system", offsetof(struct proc_taskinfo, pti_total_system));
  P("proc_taskallinfo.size", sizeof(struct proc_taskallinfo));
  P("proc_taskallinfo.pbsd", offsetof(struct proc_taskallinfo, pbsd));
  P("proc_taskallinfo.ptinfo", offsetof(struct proc_taskallinfo, ptinfo));
  P("proc_taskallinfo.ptinfo.pti_resident_size", offsetof(struct proc_taskallinfo, ptinfo) + offsetof(struct proc_taskinfo, pti_resident_size));
  P("proc_taskallinfo.ptinfo.pti_total_user", offsetof(struct proc_taskallinfo, ptinfo) + offsetof(struct proc_taskinfo, pti_total_user));
  P("proc_taskallinfo.ptinfo.pti_total_system", offsetof(struct proc_taskallinfo, ptinfo) + offsetof(struct proc_taskinfo, pti_total_system));
  P("proc_bsdshortinfo.size", sizeof(struct proc_bsdshortinfo));
  P("proc_bsdshortinfo.pbsi_pid", offsetof(struct proc_bsdshortinfo, pbsi_pid));
  P("proc_bsdshortinfo.pbsi_ppid", offsetof(struct proc_bsdshortinfo, pbsi_ppid));
  P("proc_bsdshortinfo.pbsi_pgid", offsetof(struct proc_bsdshortinfo, pbsi_pgid));
  P("proc_bsdshortinfo.pbsi_status", offsetof(struct proc_bsdshortinfo, pbsi_status));
  P("proc_bsdshortinfo.pbsi_comm", offsetof(struct proc_bsdshortinfo, pbsi_comm));
  P("proc_bsdshortinfo.pbsi_uid", offsetof(struct proc_bsdshortinfo, pbsi_uid));
  P("vnode_info.size", sizeof(struct vnode_info));
  P("vnode_info_path.size", sizeof(struct vnode_info_path));
  P("vnode_info_path.vip_vi", offsetof(struct vnode_info_path, vip_vi));
  P("vnode_info_path.vip_path", offsetof(struct vnode_info_path, vip_path));
  P("proc_vnodepathinfo.size", sizeof(struct proc_vnodepathinfo));
  P("proc_vnodepathinfo.pvi_cdir", offsetof(struct proc_vnodepathinfo, pvi_cdir));
  P("proc_vnodepathinfo.pvi_rdir", offsetof(struct proc_vnodepathinfo, pvi_rdir));
  P("proc_vnodepathinfo.cwd_path", offsetof(struct proc_vnodepathinfo, pvi_cdir) + offsetof(struct vnode_info_path, vip_path));
  P("kinfo_proc.size", sizeof(struct kinfo_proc));
  P("kinfo_proc.kp_proc.p_starttime.tv_sec", offsetof(struct kinfo_proc, kp_proc.p_starttime.tv_sec));
  P("kinfo_proc.kp_proc.p_starttime.tv_usec", offsetof(struct kinfo_proc, kp_proc.p_starttime.tv_usec));
  P("kinfo_proc.kp_proc.p_pid", offsetof(struct kinfo_proc, kp_proc.p_pid));
  P("proc_fdinfo.size", sizeof(struct proc_fdinfo));
  P("proc_fdinfo.proc_fd", offsetof(struct proc_fdinfo, proc_fd));
  P("proc_fdinfo.proc_fdtype", offsetof(struct proc_fdinfo, proc_fdtype));
  P("proc_fileinfo.size", sizeof(struct proc_fileinfo));
  P("socket_info.size", sizeof(struct socket_info));
  P("socket_info.soi_protocol", offsetof(struct socket_info, soi_protocol));
  P("socket_info.soi_family", offsetof(struct socket_info, soi_family));
  P("socket_info.soi_kind", offsetof(struct socket_info, soi_kind));
  P("socket_info.soi_proto", offsetof(struct socket_info, soi_proto));
  P("in_sockinfo.size", sizeof(struct in_sockinfo));
  P("in_sockinfo.insi_fport", offsetof(struct in_sockinfo, insi_fport));
  P("in_sockinfo.insi_lport", offsetof(struct in_sockinfo, insi_lport));
  P("in_sockinfo.insi_vflag", offsetof(struct in_sockinfo, insi_vflag));
  P("in_sockinfo.insi_faddr", offsetof(struct in_sockinfo, insi_faddr));
  P("in_sockinfo.insi_laddr", offsetof(struct in_sockinfo, insi_laddr));
  P("tcp_sockinfo.size", sizeof(struct tcp_sockinfo));
  P("tcp_sockinfo.tcpsi_ini", offsetof(struct tcp_sockinfo, tcpsi_ini));
  P("tcp_sockinfo.tcpsi_state", offsetof(struct tcp_sockinfo, tcpsi_state));
  P("socket_fdinfo.size", sizeof(struct socket_fdinfo));
  P("socket_fdinfo.pfi", offsetof(struct socket_fdinfo, pfi));
  P("socket_fdinfo.psi", offsetof(struct socket_fdinfo, psi));
  P("socket_fdinfo.psi.soi_protocol", offsetof(struct socket_fdinfo, psi) + offsetof(struct socket_info, soi_protocol));
  P("socket_fdinfo.psi.soi_family", offsetof(struct socket_fdinfo, psi) + offsetof(struct socket_info, soi_family));
  P("socket_fdinfo.psi.soi_kind", offsetof(struct socket_fdinfo, psi) + offsetof(struct socket_info, soi_kind));
  P("socket_fdinfo.psi.soi_proto.pri_tcp", offsetof(struct socket_fdinfo, psi) + offsetof(struct socket_info, soi_proto));
  P("socket_fdinfo.insi_fport", offsetof(struct socket_fdinfo, psi) + offsetof(struct socket_info, soi_proto) + offsetof(struct tcp_sockinfo, tcpsi_ini) + offsetof(struct in_sockinfo, insi_fport));
  P("socket_fdinfo.insi_lport", offsetof(struct socket_fdinfo, psi) + offsetof(struct socket_info, soi_proto) + offsetof(struct tcp_sockinfo, tcpsi_ini) + offsetof(struct in_sockinfo, insi_lport));
  P("socket_fdinfo.insi_vflag", offsetof(struct socket_fdinfo, psi) + offsetof(struct socket_info, soi_proto) + offsetof(struct tcp_sockinfo, tcpsi_ini) + offsetof(struct in_sockinfo, insi_vflag));
  P("socket_fdinfo.insi_faddr", offsetof(struct socket_fdinfo, psi) + offsetof(struct socket_info, soi_proto) + offsetof(struct tcp_sockinfo, tcpsi_ini) + offsetof(struct in_sockinfo, insi_faddr));
  P("socket_fdinfo.insi_laddr", offsetof(struct socket_fdinfo, psi) + offsetof(struct socket_info, soi_proto) + offsetof(struct tcp_sockinfo, tcpsi_ini) + offsetof(struct in_sockinfo, insi_laddr));
  P("socket_fdinfo.tcpsi_state", offsetof(struct socket_fdinfo, psi) + offsetof(struct socket_info, soi_proto) + offsetof(struct tcp_sockinfo, tcpsi_state));
  return 0;
}
`;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-darwin-abi-"));
    const sourcePath = path.join(directory, "layout.c");
    const executablePath = path.join(directory, "layout");
    try {
      fs.writeFileSync(sourcePath, source);
      execFileSync("cc", [sourcePath, "-o", executablePath], { stdio: "pipe" });
      const output = execFileSync(executablePath, [], { encoding: "utf8" });
      const actual = Object.fromEntries(output.trim().split(/\r?\n/).map(line => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), Number(line.slice(separator + 1))];
      }));
      expect(actual).toEqual(DARWIN_ABI_LAYOUT);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
