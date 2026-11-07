import { describe, expect, test } from "bun:test";
import { attributeTcpRows, isLoopback, parseProcNetTcp, parseWindowsTcpTable } from "../src/sockets.js";
import { backendFor } from "../src/backend.js";
import type { RawOsProcess } from "../src/types.js";

const proc = (pid: number, name: string, cmdline = name): RawOsProcess => ({ pid, ppid: 0, name, cmdline, startTime: "1", cpuSeconds: 0, cpuPercent: 0, memoryMb: 1 });
const procTcp = `sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n 0: 0100007F:9C40 0100007F:2CAA 01 00000000:00000000 00:00000000 00000000 1000 0 111\n 1: 0100007F:9C41 08080808:01BB 01 00000000:00000000 00:00000000 00000000 1000 0 112\n 2: 0100007F:2CAA 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 999`;

describe("socket attribution fixtures", () => {
  test("parses proc tcp, attributes loopback connections to recognised listeners, and ignores remote peers", () => {
    const rows = parseProcNetTcp(procTcp);
    const tcpRows = rows.map(row => ({ ...row, state: row.state === 1 ? 5 : row.state === 10 ? 2 : row.state, pid: row.inode === "111" ? 10 : row.inode === "112" ? 11 : 99 }));
    const processes = [proc(10, "node"), proc(11, "node"), proc(99, "ollama", "ollama serve")];
    const conns = attributeTcpRows(tcpRows, processes);
    expect(conns.get(10)).toEqual([{ address: "127.0.0.1", port: 11434, serverPid: 99, serverHarness: "ollama" }]);
    expect(conns.has(11)).toBe(false);
    expect(backendFor([{ ...processes[0], socketConnections: conns.get(10) }])).toMatchObject({ backend: "local-engine", evidence: "socket: pid 10 -> 127.0.0.1:11434 (ollama, pid 99)" });
  });

  test("parses IPv6 loopback and leaves unknown listeners unattributed", () => {
    const ipv6 = `sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n 0: 00000000000000000000000001000000:9C40 00000000000000000000000001000000:32C8 01 0:0 00:0 0 1000 0 21\n 1: 00000000000000000000000000000000:32C8 00000000000000000000000000000000:0000 0A 0:0 00:0 0 1000 0 22`;
    const parsed = parseProcNetTcp(ipv6, true).map(row => ({ ...row, state: row.state === 1 ? 5 : row.state === 10 ? 2 : row.state, pid: row.inode === "21" ? 20 : 200 }));
    expect(isLoopback(parsed[0].localAddress)).toBe(true);
    expect(isLoopback(parsed[0].remoteAddress)).toBe(true);
    const processes = [proc(20, "node")];
    const connections = attributeTcpRows(parsed, processes).get(20)!;
    expect(connections).toEqual([{ address: "::1", port: 13000 }]);
    expect(backendFor([{ ...processes[0], socketConnections: connections }])).toMatchObject({ backend: "unknown", evidence: "socket: pid 20 -> ::1:13000 (unrecognised listener)" });
  });

  test("decodes Windows IPv4 and IPv6 owner PID table fixture rows", () => {
    const ipv4 = Buffer.alloc(4 + 24); ipv4.writeUInt32LE(1, 0); ipv4.writeUInt32LE(5, 4);
    Buffer.from([127, 0, 0, 1]).copy(ipv4, 8); ipv4.writeUInt16BE(50000, 12);
    Buffer.from([127, 0, 0, 1]).copy(ipv4, 16); ipv4.writeUInt16BE(11434, 20); ipv4.writeUInt32LE(10, 24);
    const connected = parseWindowsTcpTable(ipv4, 2)[0];
    expect(connected).toMatchObject({ state: 5, localAddress: "127.0.0.1", localPort: 50000, remoteAddress: "127.0.0.1", remotePort: 11434, pid: 10 });
    const remote = { ...connected, pid: 11, remoteAddress: "8.8.8.8", remotePort: 443 };
    const listener = { ...connected, pid: 99, state: 2, localAddress: "127.0.0.1", localPort: 11434, remoteAddress: "0.0.0.0", remotePort: 0 };
    const processes = [proc(10, "node"), proc(11, "node"), proc(99, "ollama", "ollama serve")];
    const attributed = attributeTcpRows([connected, remote, listener], processes);
    expect(attributed.get(10)).toEqual([{ address: "127.0.0.1", port: 11434, serverPid: 99, serverHarness: "ollama" }]);
    expect(attributed.has(11)).toBe(false);
    expect(backendFor([{ ...processes[0], socketConnections: attributed.get(10) }])).toMatchObject({ backend: "local-engine", evidence: "socket: pid 10 -> 127.0.0.1:11434 (ollama, pid 99)" });
    const ipv6 = Buffer.alloc(4 + 56); ipv6.writeUInt32LE(1, 0); ipv6.writeUInt32LE(5, 52); ipv6.writeUInt32LE(10, 56);
    Buffer.from("00000000000000000000000000000001", "hex").copy(ipv6, 4); ipv6.writeUInt16BE(54000, 24);
    Buffer.from("00000000000000000000000000000001", "hex").copy(ipv6, 28); ipv6.writeUInt16BE(13305, 48);
    const row = parseWindowsTcpTable(ipv6, 23)[0];
    expect(row).toMatchObject({ state: 5, localAddress: "0:0:0:0:0:0:0:1", localPort: 54000, remoteAddress: "0:0:0:0:0:0:0:1", remotePort: 13305, pid: 10 });
  });

  test("permission-like missing socket data stays unknown", () => {
    expect(backendFor([proc(123, "node")])).toEqual({ backend: "unknown", evidence: "No observable endpoint configuration or local socket" });
  });
});
