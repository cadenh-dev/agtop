import path from "node:path";
import koffi from "koffi";
import type { TcpRow } from "./sockets.js";
import { formatIpv4, formatIpv6 } from "./net-format.js";
import { envKeys } from "./env-keys.js";
import type { RawOsProcess } from "./types.js";

const PROC_PIDLISTFDS = 1;
const PROC_PIDTASKALLINFO = 2;
const PROC_PIDTBSDINFO = 3;
const PROC_PIDVNODEPATHINFO = 9;
const PROC_PIDT_SHORTBSDINFO = 13;
const PROC_PIDFDSOCKETINFO = 3;
const PROX_FDTYPE_SOCKET = 2;
const SOCKINFO_TCP = 2;
const AF_INET = 2;
const AF_INET6 = 30;
const INI_IPV4 = 0x1;
const INI_IPV6 = 0x2;
const TSI_S_LISTEN = 1;
const TSI_S_ESTABLISHED = 4;
const SZOMB = 5;
const CTL_KERN = 1;
const KERN_ARGMAX = 8;
const KERN_PROC = 14;
const KERN_PROC_PID = 1;
const KERN_PROCARGS2 = 49;
const ESRCH = 3;
const PROC_PIDPATHINFO_MAXSIZE = 4096;
const MAXPATHLEN = 1024;
const MAXCOMLEN = 16;
const TCP_PROTOCOL = 6;
const REMEDY = "Set AGTOP_DARWIN_SCANNER=ps for the reduced read-only scanner.";

/** Layout values used by the byte readers below; checked against the macOS SDK in darwin-live.test.ts. */
export const DARWIN_ABI_LAYOUT = Object.freeze({
  "proc_bsdinfo.size": 136,
  "proc_bsdinfo.pbi_status": 4,
  "proc_bsdinfo.pbi_pid": 12,
  "proc_bsdinfo.pbi_ppid": 16,
  "proc_bsdinfo.pbi_uid": 20,
  "proc_bsdinfo.pbi_comm": 48,
  "proc_bsdinfo.pbi_name": 64,
  "proc_bsdinfo.pbi_nfiles": 96,
  "proc_bsdinfo.pbi_pgid": 100,
  "proc_bsdinfo.pbi_start_tvsec": 120,
  "proc_bsdinfo.pbi_start_tvusec": 128,
  "proc_taskinfo.size": 96,
  "proc_taskinfo.pti_resident_size": 8,
  "proc_taskinfo.pti_total_user": 16,
  "proc_taskinfo.pti_total_system": 24,
  "proc_taskallinfo.size": 232,
  "proc_taskallinfo.pbsd": 0,
  "proc_taskallinfo.ptinfo": 136,
  "proc_taskallinfo.ptinfo.pti_resident_size": 144,
  "proc_taskallinfo.ptinfo.pti_total_user": 152,
  "proc_taskallinfo.ptinfo.pti_total_system": 160,
  "proc_bsdshortinfo.size": 64,
  "proc_bsdshortinfo.pbsi_pid": 0,
  "proc_bsdshortinfo.pbsi_ppid": 4,
  "proc_bsdshortinfo.pbsi_pgid": 8,
  "proc_bsdshortinfo.pbsi_status": 12,
  "proc_bsdshortinfo.pbsi_comm": 16,
  "proc_bsdshortinfo.pbsi_uid": 36,
  "vnode_info.size": 152,
  "vnode_info_path.size": 1176,
  "vnode_info_path.vip_vi": 0,
  "vnode_info_path.vip_path": 152,
  "proc_vnodepathinfo.size": 2352,
  "proc_vnodepathinfo.pvi_cdir": 0,
  "proc_vnodepathinfo.pvi_rdir": 1176,
  "proc_vnodepathinfo.cwd_path": 152,
  "kinfo_proc.size": 648,
  "kinfo_proc.kp_proc.p_starttime.tv_sec": 0,
  "kinfo_proc.kp_proc.p_starttime.tv_usec": 8,
  "kinfo_proc.kp_proc.p_pid": 40,
  "proc_fdinfo.size": 8,
  "proc_fdinfo.proc_fd": 0,
  "proc_fdinfo.proc_fdtype": 4,
  "proc_fileinfo.size": 24,
  "socket_info.size": 768,
  "socket_info.soi_protocol": 156,
  "socket_info.soi_family": 160,
  "socket_info.soi_kind": 232,
  "socket_info.soi_proto": 240,
  "in_sockinfo.size": 80,
  "in_sockinfo.insi_fport": 0,
  "in_sockinfo.insi_lport": 4,
  "in_sockinfo.insi_vflag": 24,
  "in_sockinfo.insi_faddr": 32,
  "in_sockinfo.insi_laddr": 48,
  "tcp_sockinfo.size": 120,
  "tcp_sockinfo.tcpsi_ini": 0,
  "tcp_sockinfo.tcpsi_state": 80,
  "socket_fdinfo.size": 792,
  "socket_fdinfo.pfi": 0,
  "socket_fdinfo.psi": 24,
  "socket_fdinfo.psi.soi_protocol": 180,
  "socket_fdinfo.psi.soi_family": 184,
  "socket_fdinfo.psi.soi_kind": 256,
  "socket_fdinfo.psi.soi_proto.pri_tcp": 264,
  "socket_fdinfo.insi_fport": 264,
  "socket_fdinfo.insi_lport": 268,
  "socket_fdinfo.insi_vflag": 288,
  "socket_fdinfo.insi_faddr": 296,
  "socket_fdinfo.insi_laddr": 312,
  "socket_fdinfo.tcpsi_state": 344,
} as const);

const PROC_BSDINFO_SIZE = DARWIN_ABI_LAYOUT["proc_bsdinfo.size"];
const PROC_TASKALLINFO_SIZE = DARWIN_ABI_LAYOUT["proc_taskallinfo.size"];
const PROC_BSDSHORTINFO_SIZE = DARWIN_ABI_LAYOUT["proc_bsdshortinfo.size"];
const PROC_VNODEPATHINFO_SIZE = DARWIN_ABI_LAYOUT["proc_vnodepathinfo.size"];
const KINFO_PROC_SIZE = DARWIN_ABI_LAYOUT["kinfo_proc.size"];
const PROC_FDINFO_SIZE = DARWIN_ABI_LAYOUT["proc_fdinfo.size"];
const SOCKET_FDINFO_SIZE = DARWIN_ABI_LAYOUT["socket_fdinfo.size"];

type NativeFn = (...args: any[]) => any;
type KoffiRuntime = {
  load(name: string): { func(signature: string): NativeFn };
  errno(): number;
};

export class DarwinScannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DarwinScannerError";
  }
}

export interface DarwinNative {
  listAllPids(): number[];
  pidInfo(pid: number, flavor: number, size: number): { data: Buffer; bytes: number; errno: number };
  pidFdInfo(pid: number, fd: number, flavor: number, size: number): { data: Buffer; bytes: number; errno: number };
  pidPath(pid: number): string | undefined;
  procArgs(pid: number): Buffer | undefined;
  kinfoProc(pid: number): Buffer | undefined;
  readonly timebase: { numer: number; denom: number };
}

export interface DarwinProcessRecord {
  pid: number;
  ppid: number;
  pgid: number;
  status: number;
  name: string;
  execPath?: string;
  argv?: string[];
  env: string[];
  cwd?: string;
  startTime: string;
  cpuSeconds: number;
  residentBytes: number;
  restricted: boolean;
}

function needSize(buf: Buffer, size: number, label: string): void {
  if (buf.length < size) throw new DarwinScannerError(`${label} buffer is truncated (${buf.length} bytes; need ${size}).`);
}

function cString(buf: Buffer, offset: number, length: number): string {
  const end = Math.min(buf.length, offset + length);
  const nul = buf.indexOf(0, offset);
  return buf.toString("utf8", offset, nul >= offset && nul < end ? nul : end);
}

function startFromBsd(buf: Buffer): string {
  const seconds = buf.readBigUInt64LE(DARWIN_ABI_LAYOUT["proc_bsdinfo.pbi_start_tvsec"]);
  const micros = buf.readBigUInt64LE(DARWIN_ABI_LAYOUT["proc_bsdinfo.pbi_start_tvusec"]);
  return String(seconds * 1_000_000n + micros);
}

export function parseTaskAllInfo(buf: Buffer): {
  pid: number; ppid: number; pgid: number; uid: number; status: number; comm: string; name: string;
  nfiles: number; startTime: string; residentBytes: bigint; userTicks: bigint; systemTicks: bigint;
} {
  needSize(buf, PROC_TASKALLINFO_SIZE, "proc_taskallinfo");
  return {
    status: buf.readUInt32LE(DARWIN_ABI_LAYOUT["proc_bsdinfo.pbi_status"]),
    pid: buf.readUInt32LE(DARWIN_ABI_LAYOUT["proc_bsdinfo.pbi_pid"]),
    ppid: buf.readUInt32LE(DARWIN_ABI_LAYOUT["proc_bsdinfo.pbi_ppid"]),
    uid: buf.readUInt32LE(DARWIN_ABI_LAYOUT["proc_bsdinfo.pbi_uid"]),
    comm: cString(buf, DARWIN_ABI_LAYOUT["proc_bsdinfo.pbi_comm"], MAXCOMLEN),
    name: cString(buf, DARWIN_ABI_LAYOUT["proc_bsdinfo.pbi_name"], 32),
    nfiles: buf.readUInt32LE(DARWIN_ABI_LAYOUT["proc_bsdinfo.pbi_nfiles"]),
    pgid: buf.readUInt32LE(DARWIN_ABI_LAYOUT["proc_bsdinfo.pbi_pgid"]), startTime: startFromBsd(buf),
    residentBytes: buf.readBigUInt64LE(DARWIN_ABI_LAYOUT["proc_taskallinfo.ptinfo.pti_resident_size"]),
    userTicks: buf.readBigUInt64LE(DARWIN_ABI_LAYOUT["proc_taskallinfo.ptinfo.pti_total_user"]),
    systemTicks: buf.readBigUInt64LE(DARWIN_ABI_LAYOUT["proc_taskallinfo.ptinfo.pti_total_system"]),
  };
}

export function parseShortBsdInfo(buf: Buffer): { pid: number; ppid: number; pgid: number; status: number; comm: string; uid: number } {
  needSize(buf, PROC_BSDSHORTINFO_SIZE, "proc_bsdshortinfo");
  return {
    pid: buf.readUInt32LE(DARWIN_ABI_LAYOUT["proc_bsdshortinfo.pbsi_pid"]),
    ppid: buf.readUInt32LE(DARWIN_ABI_LAYOUT["proc_bsdshortinfo.pbsi_ppid"]),
    pgid: buf.readUInt32LE(DARWIN_ABI_LAYOUT["proc_bsdshortinfo.pbsi_pgid"]),
    status: buf.readUInt32LE(DARWIN_ABI_LAYOUT["proc_bsdshortinfo.pbsi_status"]),
    comm: cString(buf, DARWIN_ABI_LAYOUT["proc_bsdshortinfo.pbsi_comm"], MAXCOMLEN),
    uid: buf.readUInt32LE(DARWIN_ABI_LAYOUT["proc_bsdshortinfo.pbsi_uid"]),
  };
}

export function parseVnodeCwd(buf: Buffer): string | undefined {
  if (buf.length < 152) return;
  const offset = DARWIN_ABI_LAYOUT["proc_vnodepathinfo.cwd_path"];
  const raw = cString(buf, offset, Math.min(MAXPATHLEN, buf.length - offset));
  return raw || undefined;
}

export function parseSocketFdInfo(buf: Buffer): {
  family: number; state: number; localAddress: string; localPort: number; remoteAddress: string; remotePort: number;
} | undefined {
  if (buf.length < SOCKET_FDINFO_SIZE) return;
  const protocol = buf.readInt32LE(DARWIN_ABI_LAYOUT["socket_fdinfo.psi.soi_protocol"]);
  const family = buf.readInt32LE(DARWIN_ABI_LAYOUT["socket_fdinfo.psi.soi_family"]);
  const kind = buf.readInt32LE(DARWIN_ABI_LAYOUT["socket_fdinfo.psi.soi_kind"]);
  const vflag = buf.readUInt8(DARWIN_ABI_LAYOUT["socket_fdinfo.insi_vflag"]);
  if (kind !== SOCKINFO_TCP || protocol !== TCP_PROTOCOL || (family !== AF_INET && family !== AF_INET6)) return;
  const localPort = buf.readUInt16BE(DARWIN_ABI_LAYOUT["socket_fdinfo.insi_lport"]);
  const remotePort = buf.readUInt16BE(DARWIN_ABI_LAYOUT["socket_fdinfo.insi_fport"]);
  const state = buf.readInt32LE(DARWIN_ABI_LAYOUT["socket_fdinfo.tcpsi_state"]);
  if (vflag & INI_IPV6) {
    return {
      family, state, localAddress: formatIpv6(buf.subarray(DARWIN_ABI_LAYOUT["socket_fdinfo.insi_laddr"], DARWIN_ABI_LAYOUT["socket_fdinfo.insi_laddr"] + 16)), localPort,
      remoteAddress: formatIpv6(buf.subarray(DARWIN_ABI_LAYOUT["socket_fdinfo.insi_faddr"], DARWIN_ABI_LAYOUT["socket_fdinfo.insi_faddr"] + 16)), remotePort,
    };
  }
  if (vflag & INI_IPV4) {
    return {
      family, state, localAddress: formatIpv4(buf.subarray(DARWIN_ABI_LAYOUT["socket_fdinfo.insi_laddr"] + 12, DARWIN_ABI_LAYOUT["socket_fdinfo.insi_laddr"] + 16)), localPort,
      remoteAddress: formatIpv4(buf.subarray(DARWIN_ABI_LAYOUT["socket_fdinfo.insi_faddr"] + 12, DARWIN_ABI_LAYOUT["socket_fdinfo.insi_faddr"] + 16)), remotePort,
    };
  }
  return;
}

export function parseKinfoStart(buf: Buffer, pid: number): string | undefined {
  if (buf.length < KINFO_PROC_SIZE || buf.readInt32LE(DARWIN_ABI_LAYOUT["kinfo_proc.kp_proc.p_pid"]) !== pid) return;
  const seconds = buf.readBigInt64LE(DARWIN_ABI_LAYOUT["kinfo_proc.kp_proc.p_starttime.tv_sec"]);
  const micros = buf.readInt32LE(DARWIN_ABI_LAYOUT["kinfo_proc.kp_proc.p_starttime.tv_usec"]);
  if (seconds < 0n || micros < 0 || micros >= 1_000_000) return;
  return String(seconds * 1_000_000n + BigInt(micros));
}

export interface DarwinTimebase { numer: number; denom: number }
export function machTicksToSeconds(userTicks: bigint, systemTicks: bigint, timebase: DarwinTimebase): number {
  if (!Number.isInteger(timebase.numer) || timebase.numer < 0 || !Number.isInteger(timebase.denom) || timebase.denom <= 0) {
    throw new DarwinScannerError("mach_timebase_info returned an invalid timebase (denom must be greater than zero). " + REMEDY);
  }
  const nanoseconds = (userTicks + systemTicks) * BigInt(timebase.numer) / BigInt(timebase.denom);
  return Number(nanoseconds) / 1e9;
}

export function parseProcArgs2(buf: Buffer, length: number): { execPath: string; argv: string[]; env: string[] } | undefined {
  const requestedLength = Number.isFinite(length) ? Math.max(0, Math.floor(length)) : 0;
  const end = Math.min(buf.length, requestedLength);
  if (end < 5) return;
  const argc = buf.readInt32LE(0);
  if (argc < 0 || argc > 65_536) return;
  let cursor = 4;
  const pathEnd = buf.indexOf(0, cursor);
  if (pathEnd < cursor || pathEnd >= end) return;
  const execPath = buf.toString("utf8", cursor, pathEnd);
  if (!execPath) return;
  // KERN_PROCARGS2 can include a variable run of NUL padding after exec_path.
  // An empty argv[0] is indistinguishable from this padding, so it is skipped. In that case,
  // the first environment string is read as an argument and appears in cmdline without passing
  // through the environment allowlist, the same limitation as ps and psutil.
  cursor = pathEnd + 1;
  while (cursor < end && buf[cursor] === 0) cursor++;
  const argv: string[] = [];
  for (let i = 0; i < argc; i++) {
    if (cursor >= end) break;
    const nul = buf.indexOf(0, cursor);
    if (nul < 0 || nul >= end) {
      argv.push(buf.toString("utf8", cursor, end));
      cursor = end;
      break;
    }
    argv.push(buf.toString("utf8", cursor, nul));
    cursor = nul + 1;
  }
  const env: string[] = [];
  while (cursor < end) {
    const nul = buf.indexOf(0, cursor);
    const stop = nul < 0 || nul >= end ? end : nul;
    if (stop === cursor) break;
    env.push(buf.toString("utf8", cursor, stop));
    if (stop === end) break;
    cursor = stop + 1;
  }
  return { execPath, argv, env };
}

function abiFailure(call: string, detail: string): never {
  throw new DarwinScannerError(`${call} ABI self-check failed (${detail}). ${REMEDY}`);
}

const checkedNatives = new WeakSet<object>();
function checkAbi(native: DarwinNative): void {
  if (checkedNatives.has(native as object)) return;
  if (!Number.isInteger(native.timebase.numer) || native.timebase.numer < 0 ||
    !Number.isInteger(native.timebase.denom) || native.timebase.denom <= 0) {
    abiFailure("mach_timebase_info", `invalid timebase ${native.timebase.numer}/${native.timebase.denom}`);
  }
  let task: ReturnType<DarwinNative["pidInfo"]>;
  try { task = native.pidInfo(process.pid, PROC_PIDTASKALLINFO, PROC_TASKALLINFO_SIZE); }
  catch (error) { abiFailure("proc_pidinfo(PROC_PIDTASKALLINFO)", String(error)); }
  if (task.bytes !== PROC_TASKALLINFO_SIZE) {
    abiFailure("proc_pidinfo(PROC_PIDTASKALLINFO)", `${task.bytes} bytes, errno ${task.errno}; expected ${PROC_TASKALLINFO_SIZE}`);
  }
  let info: ReturnType<typeof parseTaskAllInfo>;
  try { info = parseTaskAllInfo(task.data); } catch (error) { abiFailure("proc_pidinfo(PROC_PIDTASKALLINFO)", String(error)); }
  if (info!.pid !== process.pid || info!.ppid !== process.ppid) {
    abiFailure("proc_pidinfo(PROC_PIDTASKALLINFO)", `reported pid/ppid ${info!.pid}/${info!.ppid}; expected ${process.pid}/${process.ppid}`);
  }
  let kinfo: Buffer | undefined;
  try { kinfo = native.kinfoProc(process.pid); }
  catch (error) { abiFailure("sysctl(KERN_PROC_PID)", String(error)); }
  const identity = kinfo && parseKinfoStart(kinfo, process.pid);
  if (identity !== info!.startTime) {
    abiFailure("sysctl(KERN_PROC_PID)", `reported start time ${identity ?? "unavailable"}; expected ${info!.startTime}`);
  }
  let short: ReturnType<DarwinNative["pidInfo"]>;
  try { short = native.pidInfo(process.pid, PROC_PIDT_SHORTBSDINFO, PROC_BSDSHORTINFO_SIZE); }
  catch (error) { abiFailure("proc_pidinfo(PROC_PIDT_SHORTBSDINFO)", String(error)); }
  if (short.bytes !== PROC_BSDSHORTINFO_SIZE) {
    abiFailure("proc_pidinfo(PROC_PIDT_SHORTBSDINFO)", `${short.bytes} bytes, errno ${short.errno}; expected ${PROC_BSDSHORTINFO_SIZE}`);
  }
  let shortInfo: ReturnType<typeof parseShortBsdInfo>;
  try { shortInfo = parseShortBsdInfo(short.data); }
  catch (error) { abiFailure("proc_pidinfo(PROC_PIDT_SHORTBSDINFO)", String(error)); }
  const expectedUid = typeof process.geteuid === "function" ? process.geteuid()
    : typeof process.getuid === "function" ? process.getuid() : undefined;
  if (expectedUid !== undefined && info!.uid !== expectedUid) {
    abiFailure("proc_pidinfo(PROC_PIDTASKALLINFO)", `reported pbi_uid ${info!.uid}; expected ${expectedUid}`);
  }
  if (shortInfo!.pid !== process.pid || shortInfo!.ppid !== process.ppid ||
    (expectedUid !== undefined && shortInfo!.uid !== expectedUid)) {
    abiFailure("proc_pidinfo(PROC_PIDT_SHORTBSDINFO)",
      `reported pid/ppid/uid ${shortInfo!.pid}/${shortInfo!.ppid}/${shortInfo!.uid}; expected ${process.pid}/${process.ppid}/${expectedUid ?? "current uid"}`);
  }
  checkedNatives.add(native as object);
}

function createNative(): DarwinNative {
  const runtime = koffi as unknown as KoffiRuntime;
  let lib: ReturnType<KoffiRuntime["load"]>;
  try { lib = runtime.load("/usr/lib/libSystem.B.dylib"); }
  catch (error) { throw new DarwinScannerError(`Could not load /usr/lib/libSystem.B.dylib: ${String(error)}. ${REMEDY}`); }
  const proc_listallpids = lib.func("int proc_listallpids(void *buffer, int buffersize)");
  const proc_pidinfo = lib.func("int proc_pidinfo(int pid, int flavor, uint64 arg, void *buffer, int buffersize)");
  const proc_pidfdinfo = lib.func("int proc_pidfdinfo(int pid, int fd, int flavor, void *buffer, int buffersize)");
  const proc_pidpath = lib.func("int proc_pidpath(int pid, void *buffer, uint32 buffersize)");
  const sysctl = lib.func("int sysctl(int *name, uint32 namelen, void *oldp, _Inout_ size_t *oldlenp, void *newp, size_t newlen)");
  const mach_timebase_info = lib.func("int mach_timebase_info(void *info)");

  const callInfo = (pid: number, flavor: number, size: number) => {
    const data = Buffer.alloc(size);
    const bytes = proc_pidinfo(pid, flavor, 0, size === 0 ? null : data, size) as number;
    const error = bytes === 0 || bytes === -1 ? runtime.errno() : 0;
    return { data, bytes, errno: error };
  };
  const callFdInfo = (pid: number, fd: number, flavor: number, size: number) => {
    const data = Buffer.alloc(size);
    const bytes = proc_pidfdinfo(pid, fd, flavor, data, size) as number;
    const error = bytes === 0 || bytes === -1 ? runtime.errno() : 0;
    return { data, bytes, errno: error };
  };
  const mibCall = (mib: number[], data: Buffer | null, capacity: number) => {
    const oldlen = [capacity];
    const result = sysctl(Int32Array.from(mib), mib.length, data, oldlen, null, 0) as number;
    const error = result === 0 || result === -1 ? runtime.errno() : 0;
    return { result, errno: error, length: Number(oldlen[0]) };
  };

  let argmax: number | undefined;
  let argsBuffer: Buffer | undefined;
  const timebaseBuffer = Buffer.alloc(8);
  const timebaseResult = mach_timebase_info(timebaseBuffer) as number;
  const timebaseErrno = timebaseResult === 0 || timebaseResult === -1 ? runtime.errno() : 0;
  if (timebaseResult !== 0) throw new DarwinScannerError(`mach_timebase_info failed (result ${timebaseResult}, errno ${timebaseErrno}). ${REMEDY}`);
  const timebase = { numer: timebaseBuffer.readUInt32LE(0), denom: timebaseBuffer.readUInt32LE(4) };
  if (!timebase.denom) throw new DarwinScannerError(`mach_timebase_info returned denom 0. ${REMEDY}`);

  const native: DarwinNative = {
    timebase,
    listAllPids() {
      const first = proc_listallpids(null, 0) as number;
      const firstErrno = first <= 0 ? runtime.errno() : 0;
      if (first <= 0) throw new DarwinScannerError(`proc_listallpids sizing call failed (result ${first}, errno ${firstErrno}). ${REMEDY}`);
      let capacity = first + 64;
      for (let attempt = 0; attempt < 4; attempt++) {
        const data = Buffer.alloc(capacity * 4);
        const count = proc_listallpids(data, data.length) as number;
        const error = count <= 0 ? runtime.errno() : 0;
        if (count <= 0) throw new DarwinScannerError(`proc_listallpids failed (result ${count}, errno ${error}). ${REMEDY}`);
        if (count >= capacity) { capacity *= 2; continue; }
        const pids: number[] = [];
        for (let i = 0; i < count; i++) {
          const pid = data.readInt32LE(i * 4);
          if (pid > 0) pids.push(pid);
        }
        return [...new Set(pids)];
      }
      throw new DarwinScannerError(`proc_listallpids kept filling the buffer after four attempts. ${REMEDY}`);
    },
    pidInfo: callInfo,
    pidFdInfo: callFdInfo,
    pidPath(pid) {
      const data = Buffer.alloc(PROC_PIDPATHINFO_MAXSIZE);
      const bytes = proc_pidpath(pid, data, data.length) as number;
      if (bytes <= 0) {
        const error = runtime.errno();
        throw new DarwinScannerError(`proc_pidpath(${pid}) failed (result ${bytes}, errno ${error}). ${REMEDY}`);
      }
      return cString(data, 0, Math.min(bytes, data.length)) || undefined;
    },
    procArgs(pid) {
      if (argmax === undefined) {
        const max = Buffer.alloc(4);
        const query = mibCall([CTL_KERN, KERN_ARGMAX], max, max.length);
        const reported = query.result === 0 && query.length >= 4 ? max.readUInt32LE(0) : 0;
        argmax = reported ? Math.min(4 * 1024 * 1024, Math.max(64 * 1024, reported)) : 1024 * 1024;
        argsBuffer = Buffer.alloc(argmax);
      }
      const buffer = argsBuffer!;
      const result = mibCall([CTL_KERN, KERN_PROCARGS2, pid], buffer, buffer.length);
      if (result.result !== 0) return;
      return Buffer.from(buffer.subarray(0, Math.min(result.length, buffer.length)));
    },
    kinfoProc(pid) {
      const data = Buffer.alloc(KINFO_PROC_SIZE);
      const result = mibCall([CTL_KERN, KERN_PROC, KERN_PROC_PID, pid], data, data.length);
      if (result.result !== 0 || result.length < KINFO_PROC_SIZE) return;
      return data.subarray(0, KINFO_PROC_SIZE);
    },
  };
  return native;
}

let memoizedNative: DarwinNative | undefined;
export function nativeDarwin(): DarwinNative {
  if (process.platform !== "darwin") throw new DarwinScannerError("The libproc scanner is available only on macOS.");
  if (memoizedNative) return memoizedNative;
  try {
    const native = createNative();
    checkAbi(native);
    memoizedNative = native;
    return native;
  } catch (error) {
    if (error instanceof DarwinScannerError) throw error;
    throw new DarwinScannerError(`macOS libproc initialization failed: ${String(error)}. ${REMEDY}`);
  }
}

function readBsdInfo(buf: Buffer): { pid: number; ppid: number; pgid: number; status: number; startTime: string } {
  needSize(buf, PROC_BSDINFO_SIZE, "proc_bsdinfo");
  return {
    pid: buf.readUInt32LE(DARWIN_ABI_LAYOUT["proc_bsdinfo.pbi_pid"]),
    ppid: buf.readUInt32LE(DARWIN_ABI_LAYOUT["proc_bsdinfo.pbi_ppid"]),
    status: buf.readUInt32LE(DARWIN_ABI_LAYOUT["proc_bsdinfo.pbi_status"]),
    pgid: buf.readUInt32LE(DARWIN_ABI_LAYOUT["proc_bsdinfo.pbi_pgid"]), startTime: startFromBsd(buf),
  };
}

function filteredDarwinEnvironment(env: string[]): string[] {
  return env.filter(entry => {
    const eq = entry.indexOf("=");
    return eq >= 0 && envKeys.has(entry.slice(0, eq));
  });
}

export function readDarwinProcesses(native: DarwinNative = nativeDarwin()): DarwinProcessRecord[] {
  checkAbi(native);
  let pids: number[];
  try { pids = native.listAllPids(); }
  catch (error) {
    if (error instanceof DarwinScannerError) throw error;
    throw new DarwinScannerError(`proc_listallpids failed: ${String(error)}. ${REMEDY}`);
  }
  const records: DarwinProcessRecord[] = [];
  for (const pid of pids) {
    let task: ReturnType<DarwinNative["pidInfo"]>;
    try { task = native.pidInfo(pid, PROC_PIDTASKALLINFO, PROC_TASKALLINFO_SIZE); }
    catch { continue; }
    if (task.bytes === PROC_TASKALLINFO_SIZE) {
      const bsd = parseTaskAllInfo(task.data);
      if (bsd.pid !== pid || bsd.status === SZOMB) continue;
      let execPathFromPid: string | undefined, argsBuffer: Buffer | undefined;
      try { execPathFromPid = native.pidPath(pid); } catch { /* Optional process path. */ }
      try { argsBuffer = native.procArgs(pid); } catch { /* Args are unavailable for some processes. */ }
      const args = argsBuffer ? parseProcArgs2(argsBuffer, argsBuffer.length) : undefined;
      let cwdInfo: ReturnType<DarwinNative["pidInfo"]>;
      try { cwdInfo = native.pidInfo(pid, PROC_PIDVNODEPATHINFO, PROC_VNODEPATHINFO_SIZE); }
      catch { cwdInfo = { data: Buffer.alloc(0), bytes: 0, errno: 0 }; }
      const cwd = cwdInfo.bytes === PROC_VNODEPATHINFO_SIZE ? parseVnodeCwd(cwdInfo.data) : undefined;
      let bsdAgainInfo: ReturnType<DarwinNative["pidInfo"]>;
      try { bsdAgainInfo = native.pidInfo(pid, PROC_PIDTBSDINFO, PROC_BSDINFO_SIZE); }
      catch { continue; }
      if (bsdAgainInfo.bytes !== PROC_BSDINFO_SIZE) continue;
      const bsdAgain = readBsdInfo(bsdAgainInfo.data);
      if (bsdAgain.pid !== pid || bsdAgain.startTime !== bsd.startTime) continue;
      const execPath = execPathFromPid || args?.execPath;
      const name = path.posix.basename(execPath || bsd.name || bsd.comm);
      const argv = args?.argv ?? (execPath ? [execPath] : undefined);
      records.push({ pid, ppid: bsd.ppid, pgid: bsd.pgid, status: bsd.status, name, execPath, argv,
        env: filteredDarwinEnvironment(args?.env ?? []), cwd, startTime: bsd.startTime,
        cpuSeconds: machTicksToSeconds(bsd.userTicks, bsd.systemTicks, native.timebase),
        residentBytes: Number(bsd.residentBytes), restricted: false });
      continue;
    }
    if (task.errno === ESRCH) continue;
    let shortInfo: ReturnType<DarwinNative["pidInfo"]>;
    try { shortInfo = native.pidInfo(pid, PROC_PIDT_SHORTBSDINFO, PROC_BSDSHORTINFO_SIZE); }
    catch { continue; }
    if (shortInfo.bytes !== PROC_BSDSHORTINFO_SIZE) continue;
    const short = parseShortBsdInfo(shortInfo.data);
    if (short.pid !== pid || short.status === SZOMB) continue;
    let startTime: string | undefined;
    try { startTime = darwinIdentity(pid, native); } catch { continue; }
    if (!startTime) continue;
    let execPath: string | undefined;
    try { execPath = native.pidPath(pid); } catch { /* Reduced records can omit the executable path. */ }
    records.push({ pid, ppid: short.ppid, pgid: short.pgid, status: short.status,
      name: path.posix.basename(execPath || short.comm), execPath, argv: execPath ? [execPath] : undefined,
      env: [], cwd: undefined, startTime, cpuSeconds: 0, residentBytes: 0, restricted: true });
  }
  if (!records.length) throw new DarwinScannerError(`macOS process scan returned no readable processes. ${REMEDY}`);
  return records;
}

export function darwinIdentity(pid: number, native: DarwinNative = nativeDarwin()): string | undefined {
  try {
    const data = native.kinfoProc(pid);
    return data && parseKinfoStart(data, pid);
  } catch { return; }
}

export function darwinIdentities(native: DarwinNative = nativeDarwin()): Array<{ pid: number; startTime: string; pgid?: number; tag?: string }> {
  return readDarwinProcesses(native).map(record => ({
    pid: record.pid, startTime: record.startTime, pgid: record.pgid,
    tag: record.env.find(entry => entry.startsWith("AGTOP_JOB_ID="))?.slice("AGTOP_JOB_ID=".length),
  }));
}

export function darwinTcpRows(pids: number[], native: DarwinNative = nativeDarwin()): TcpRow[] {
  const rows: TcpRow[] = [];
  for (const pid of new Set(pids)) {
    const maxBytes = 65_536 * PROC_FDINFO_SIZE;
    let fdResult: { data: Buffer; bytes: number; errno: number } | undefined;
    let capacityBytes: number;
    try {
      const sizing = native.pidInfo(pid, PROC_PIDLISTFDS, 0);
      if (sizing.bytes <= 0 || sizing.bytes % PROC_FDINFO_SIZE !== 0) continue;
      capacityBytes = Math.min(maxBytes, Math.max(PROC_FDINFO_SIZE, sizing.bytes));
      while (true) {
        fdResult = native.pidInfo(pid, PROC_PIDLISTFDS, capacityBytes);
        if (fdResult.bytes !== capacityBytes || capacityBytes >= maxBytes) break;
        capacityBytes = Math.min(maxBytes, capacityBytes * 2);
      }
    } catch { continue; }
    if (!fdResult || fdResult.bytes < 0 || fdResult.bytes > capacityBytes || fdResult.bytes % PROC_FDINFO_SIZE !== 0) continue;
    const count = Math.floor(fdResult.bytes / PROC_FDINFO_SIZE);
    for (let i = 0; i < count; i++) {
      const offset = i * PROC_FDINFO_SIZE;
      const fd = fdResult.data.readInt32LE(offset);
      const type = fdResult.data.readUInt32LE(offset + 4);
      if (fd < 0 || type !== PROX_FDTYPE_SOCKET) continue;
      let socketInfo: ReturnType<DarwinNative["pidFdInfo"]>;
      try { socketInfo = native.pidFdInfo(pid, fd, PROC_PIDFDSOCKETINFO, SOCKET_FDINFO_SIZE); }
      catch { continue; }
      if (socketInfo.bytes !== SOCKET_FDINFO_SIZE) continue;
      const socket = parseSocketFdInfo(socketInfo.data);
      if (!socket) continue;
      rows.push({ pid, state: socket.state === TSI_S_LISTEN ? 2 : socket.state === TSI_S_ESTABLISHED ? 5 : 100 + socket.state,
        localAddress: socket.localAddress, localPort: socket.localPort, remoteAddress: socket.remoteAddress, remotePort: socket.remotePort });
    }
  }
  return rows;
}

export function darwinScannerMode(): "libproc" | "ps" {
  return process.env.AGTOP_DARWIN_SCANNER === "ps" ? "ps" : "libproc";
}

const MONTHS = new Map(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map((month, index) => [month, index]));
function parsePsStart(weekday: string, monthName: string, dayText: string, clock: string, yearText: string): string | undefined {
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/.test(weekday)) return;
  const month = MONTHS.get(monthName);
  const day = Number(dayText), year = Number(yearText);
  const time = /^(\d{2}):(\d{2}):(\d{2})$/.exec(clock);
  if (month === undefined || !Number.isInteger(day) || day < 1 || day > 31 || !Number.isInteger(year) || !time) return;
  const hour = Number(time[1]), minute = Number(time[2]), second = Number(time[3]);
  if (hour > 23 || minute > 59 || second > 59) return;
  const date = new Date(year, month, day, hour, minute, second, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return;
  return String(date.getTime() * 1000);
}

function parsePsTime(raw: string): number | undefined {
  let days = 0, hours = 0, minutes: number, secondsText: string;
  const dayMatch = /^(\d+)-(\d+):(\d+):(\d{2}(?:\.\d+)?)$/.exec(raw);
  if (dayMatch) {
    days = Number(dayMatch[1]); hours = Number(dayMatch[2]); minutes = Number(dayMatch[3]); secondsText = dayMatch[4];
    if (hours > 23 || minutes > 59) return;
  } else {
    const fields = raw.split(":");
    if (fields.length === 2 && /^\d+$/.test(fields[0])) { minutes = Number(fields[0]); secondsText = fields[1]; }
    else if (fields.length === 3 && /^\d+$/.test(fields[0]) && /^\d+$/.test(fields[1])) {
      hours = Number(fields[0]); minutes = Number(fields[1]); secondsText = fields[2];
    }
    else return;
    if ((fields.length === 3 && minutes > 59) || !/^\d{2}(?:\.\d+)?$/.test(secondsText!)) return;
  }
  const secMatch = /^(\d{2})(?:\.(\d+))?$/.exec(secondsText);
  if (!secMatch) return;
  const seconds = Number(secMatch[1]), fraction = Number(`0.${secMatch[2] || "0"}`);
  if (seconds > 59 || !Number.isFinite(days) || !Number.isFinite(hours) || !Number.isFinite(minutes)) return;
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds + fraction;
}

export function parseDarwinPs(stdout: string): RawOsProcess[] {
  const result: RawOsProcess[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(.*))?\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]), ppid = Number(match[2]), pgid = Number(match[3]);
    const rssKb = Number(match[4]), cpuSeconds = parsePsTime(match[5]);
    const startTime = parsePsStart(match[6], match[7], match[8], match[9], match[10]);
    const state = match[11], cmdline = match[12] || "";
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid) ||
      !Number.isFinite(rssKb) || rssKb < 0 || cpuSeconds === undefined || !startTime || /Z/.test(state)) continue;
    const firstToken = cmdline.trim().split(/\s+/, 1)[0] || "";
    const name = path.posix.basename(firstToken);
    if (!name) continue;
    result.push({ pid, ppid, pgid, name, cmdline: cmdline.trim() || name, startTime, cpuSeconds,
      cpuPercent: 0, memoryMb: rssKb / 1024, state });
  }
  return result;
}
