import * as fs from "node:fs/promises";
import koffi from "koffi";
import { darwinTcpRows } from "./darwin.js";
import { formatIpv4, formatIpv6 } from "./net-format.js";
export { formatIpv4, formatIpv6 } from "./net-format.js";
import { detectHarness, harnessKind } from "./harnesses.js";
import type { ListeningSocket, RawOsProcess, SocketConnection } from "./types.js";

export interface TcpRow { pid: number; state: number; localAddress: string; localPort: number; remoteAddress: string; remotePort: number }
export interface ProcSocketRow { localAddress: string; localPort: number; remoteAddress: string; remotePort: number; state: number; inode: string }

function ipv4Hex(raw: string): string {
  const n = Number.parseInt(raw, 16) >>> 0;
  return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join(".");
}
function endpoint(raw: string): { address: string; port: number } {
  const [hex = "", port = "0"] = raw.split(":");
  return { address: ipv4Hex(hex), port: Number.parseInt(port, 16) || 0 };
}
function ipv6Hex(raw: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < 32; i += 8) {
    const word = raw.slice(i, i + 8);
    for (let j = 0; j < 8; j += 2) bytes.push(Number.parseInt(word.slice(j, j + 2), 16));
  }
  // Linux prints each 32-bit word in host byte order.
  for (let i = 0; i < 16; i += 4) [bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]] = [bytes[i + 3], bytes[i + 2], bytes[i + 1], bytes[i]];
  const words = Array.from({ length: 8 }, (_, i) => ((bytes[2 * i] << 8) | bytes[2 * i + 1]).toString(16));
  if (words.slice(0, 5).every(word => word === "0") && words[5] === "ffff") return `::ffff:${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
  return words.join(":");
}
function endpoint6(raw: string): { address: string; port: number } {
  const [hex = "", port = "0"] = raw.split(":");
  return { address: ipv6Hex(hex), port: Number.parseInt(port, 16) || 0 };
}
export function parseProcNetTcp(text: string, ipv6 = false): ProcSocketRow[] {
  return text.trim().split(/\r?\n/).slice(1).flatMap(line => {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) return [];
    const local = (ipv6 ? endpoint6 : endpoint)(f[1]), remote = (ipv6 ? endpoint6 : endpoint)(f[2]);
    return [{ localAddress: local.address, localPort: local.port, remoteAddress: remote.address, remotePort: remote.port, state: Number.parseInt(f[3], 16), inode: f[9] }];
  });
}
export function isLoopback(address: string): boolean {
  return address === "::1" || address === "0:0:0:0:0:0:0:1" || address.startsWith("127.") || address.toLowerCase().startsWith("::ffff:127.");
}
function addressText(address: string): string { return address === "0:0:0:0:0:0:0:1" ? "::1" : address; }
function isWildcard(address: string): boolean { return address === "0.0.0.0" || address === "::" || address === "0:0:0:0:0:0:0:0"; }

export function listenersByPid(rows: TcpRow[]): Map<number, ListeningSocket[]> {
  const result = new Map<number, ListeningSocket[]>();
  for (const row of rows) {
    if (row.state !== 2) continue;
    const address = row.localAddress === "0:0:0:0:0:0:0:1" ? "::1"
      : row.localAddress === "0:0:0:0:0:0:0:0" ? "::" : row.localAddress;
    const sockets = result.get(row.pid) || [];
    if (!sockets.some(socket => socket.address === address && socket.port === row.localPort)) sockets.push({ address, port: row.localPort });
    result.set(row.pid, sockets);
  }
  for (const sockets of result.values()) sockets.sort((a, b) => a.port - b.port || a.address.localeCompare(b.address));
  return result;
}

export function attributeTcpRows(rows: TcpRow[], processes: RawOsProcess[]): Map<number, SocketConnection[]> {
  const byPid = new Map(processes.map(p => [p.pid, p]));
  const listeners = rows.filter(r => r.state === 2);
  const result = new Map<number, SocketConnection[]>();
  for (const row of rows) {
    if (row.state !== 5 || !isLoopback(row.remoteAddress)) continue;
    const listener = listeners.find(l => l.localPort === row.remotePort && (l.localAddress === row.remoteAddress || isWildcard(l.localAddress)));
    const server = listener && byPid.get(listener.pid);
    const serverHarness = server && detectHarness(server);
    const connection: SocketConnection = { address: addressText(row.remoteAddress), port: row.remotePort,
      ...(serverHarness && harnessKind(serverHarness) === "server" ? { serverPid: listener!.pid, serverHarness } : {}) };
    result.set(row.pid, [...(result.get(row.pid) || []), connection]);
  }
  return result;
}

async function linuxRows(): Promise<TcpRow[]> {
  const [tcp, tcp6] = await Promise.all([fs.readFile("/proc/net/tcp", "utf8").catch(() => ""), fs.readFile("/proc/net/tcp6", "utf8").catch(() => "")]);
  const tables = [...parseProcNetTcp(tcp), ...parseProcNetTcp(tcp6, true)];
  const inodePids = new Map<string, number[]>();
  const entries = await fs.readdir("/proc").catch(() => []);
  const pids = entries.filter(s => /^\d+$/.test(s));
  let index = 0;
  await Promise.all(Array.from({ length: 16 }, async () => {
    while (index < pids.length) {
      const pid = pids[index++];
      try {
        const fds = await fs.readdir(`/proc/${pid}/fd`);
        for (const fd of fds) {
          try {
            const target = await fs.readlink(`/proc/${pid}/fd/${fd}`);
            const match = /^socket:\[(\d+)\]$/.exec(target);
            if (match) inodePids.set(match[1], [...(inodePids.get(match[1]) || []), Number(pid)]);
          } catch { /* Process exited or access denied. */ }
        }
      } catch { /* Permission denied or process exited. */ }
    }
  }));
  return tables.flatMap(row => (inodePids.get(row.inode) || []).map(pid => ({ pid, state: row.state === 1 ? 5 : row.state === 10 ? 2 : row.state, localAddress: row.localAddress, localPort: row.localPort, remoteAddress: row.remoteAddress, remotePort: row.remotePort })));
}

function windowsRows(): TcpRow[] {
  const iphlpapi = koffi.load("iphlpapi.dll");
  const getTable = iphlpapi.func("uint32 __stdcall GetExtendedTcpTable(void *table, _Inout_ uint32 *size, int order, uint32 family, int tableClass, uint32 reserved)");
  const readFamily = (family: number): TcpRow[] => {
    const size = [0];
    const first = getTable(null, size, 0, family, 5, 0);
    if (first !== 122 || size[0] < 4) return [];
    const data = Buffer.alloc(size[0]);
    if (getTable(data, size, 0, family, 5, 0) !== 0) return [];
    return parseWindowsTcpTable(data, family as 2 | 23);
  };
  try { return [...readFamily(2), ...readFamily(23)]; } catch { return []; }
}

export function parseWindowsTcpTable(data: Buffer, family: 2 | 23): TcpRow[] {
  if (data.length < 4) return [];
  const count = data.readUInt32LE(0), rowSize = family === 2 ? 24 : 56;
  const address = (bytes: Buffer) => family === 2 ? formatIpv4(bytes) : formatIpv6(bytes);
  return Array.from({ length: Math.min(count, Math.floor((data.length - 4) / rowSize)) }, (_, i) => {
    const offset = 4 + i * rowSize;
    if (family === 2) return { state: data.readUInt32LE(offset), localAddress: address(data.subarray(offset + 4, offset + 8)), localPort: data.readUInt16BE(offset + 8), remoteAddress: address(data.subarray(offset + 12, offset + 16)), remotePort: data.readUInt16BE(offset + 16), pid: data.readUInt32LE(offset + 20) };
    return { state: data.readUInt32LE(offset + 48), localAddress: address(data.subarray(offset, offset + 16)), localPort: data.readUInt16BE(offset + 20), remoteAddress: address(data.subarray(offset + 24, offset + 40)), remotePort: data.readUInt16BE(offset + 44), pid: data.readUInt32LE(offset + 52) };
  });
}

/** Attach one socket snapshot to the process snapshot. Errors only omit socket evidence. */
export async function collectSocketConnections(
  processes: RawOsProcess[],
  platform: NodeJS.Platform = process.platform,
  loadDarwinRows: typeof darwinTcpRows = darwinTcpRows,
): Promise<void> {
  try {
    const rows = platform !== process.platform ? [] : platform === "linux" ? await linuxRows()
      : platform === "win32" ? windowsRows() : platform === "darwin" ? loadDarwinRows(processes.map(proc => proc.pid)) : [];
    const byPid = new Map(processes.map(proc => [proc.pid, proc]));
    for (const [pid, connections] of attributeTcpRows(rows, processes)) {
      const proc = byPid.get(pid);
      if (proc) proc.socketConnections = connections;
    }
    for (const [pid, sockets] of listenersByPid(rows)) {
      const proc = byPid.get(pid);
      if (proc && sockets.length) proc.listeningSockets = sockets;
    }
  } catch { /* Permission denied and transient procfs/API errors degrade to unknown. */ }
}
