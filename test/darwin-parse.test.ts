import { describe, expect, test } from "bun:test";
import { parseEnvironment } from "../src/discovery.js";
import {
  DarwinScannerError, darwinIdentity, darwinTcpRows, parseDarwinPs, parseKinfoStart, parseProcArgs2,
  parseShortBsdInfo, parseSocketFdInfo, parseTaskAllInfo, parseVnodeCwd, machTicksToSeconds, readDarwinProcesses,
  type DarwinNative,
} from "../src/darwin.js";
import { collectSocketConnections } from "../src/sockets.js";
import type { RawOsProcess } from "../src/types.js";

function taskInfo(input: { pid: number; ppid: number; pgid?: number; status?: number; comm?: string; name?: string; sec?: bigint; usec?: bigint; rss?: bigint; user?: bigint; system?: bigint }): Buffer {
  const buf = Buffer.alloc(232);
  buf.writeUInt32LE(input.status ?? 2, 4);
  buf.writeUInt32LE(input.pid, 12);
  buf.writeUInt32LE(input.ppid, 16);
  Buffer.from(input.comm ?? "process").copy(buf, 48);
  Buffer.from(input.name ?? "process-name").copy(buf, 64);
  buf.writeUInt32LE(17, 96);
  buf.writeUInt32LE(input.pgid ?? 10, 100);
  buf.writeBigUInt64LE(input.sec ?? 1_700_000_000n, 120);
  buf.writeBigUInt64LE(input.usec ?? 123_456n, 128);
  buf.writeBigUInt64LE(input.rss ?? 55n * 1024n * 1024n, 144);
  buf.writeBigUInt64LE(input.user ?? 24n, 152);
  buf.writeBigUInt64LE(input.system ?? 12n, 160);
  return buf;
}

function shortInfo(input: { pid: number; ppid: number; pgid?: number; status?: number; comm?: string; uid?: number }): Buffer {
  const buf = Buffer.alloc(64);
  buf.writeUInt32LE(input.pid, 0); buf.writeUInt32LE(input.ppid, 4); buf.writeUInt32LE(input.pgid ?? 10, 8);
  buf.writeUInt32LE(input.status ?? 2, 12); Buffer.from(input.comm ?? "short-name").copy(buf, 16);
  buf.writeUInt32LE(input.uid ?? 501, 36);
  return buf;
}

function procArgs(path: string, argv: string[], env: string[]): Buffer {
  const argc = Buffer.alloc(4); argc.writeInt32LE(argv.length);
  return Buffer.concat([argc, Buffer.from(`${path}\0\0`, "utf8"), ...argv.map(arg => Buffer.from(`${arg}\0`, "utf8")),
    ...env.map(value => Buffer.from(`${value}\0`, "utf8")), Buffer.from("\0")]);
}

function kinfo(pid: number, seconds = 1_700_000_000n, micros = 123_456): Buffer {
  const buf = Buffer.alloc(648);
  buf.writeBigInt64LE(seconds, 0); buf.writeInt32LE(micros, 8); buf.writeInt32LE(pid, 40);
  return buf;
}

function socketInfo(options: { family?: number; kind?: number; protocol?: number; vflag?: number; state?: number; local?: string; remote?: string; localPort?: number; remotePort?: number }): Buffer {
  const buf = Buffer.alloc(792);
  buf.writeInt32LE(options.protocol ?? 6, 180); buf.writeInt32LE(options.family ?? 2, 184);
  buf.writeInt32LE(options.kind ?? 2, 256); buf.writeUInt16BE(options.remotePort ?? 11_434, 264);
  buf.writeUInt16BE(options.localPort ?? 50_000, 268); buf.writeUInt8(options.vflag ?? 1, 288);
  buf.writeInt32LE(options.state ?? 4, 344);
  const encode = (address: string) => {
    if (address.includes(":")) return Buffer.from(address.replace(/:/g, "").padStart(32, "0"), "hex");
    return Buffer.from(address.split(".").map(Number));
  };
  const local = encode(options.local ?? "127.0.0.1"), remote = encode(options.remote ?? "127.0.0.1");
  if (options.vflag === 2 || (options.vflag === undefined && options.family === 30)) {
    local.copy(buf, 312); remote.copy(buf, 296);
  } else {
    const local4 = local.length === 4 ? local : local.subarray(12);
    const remote4 = remote.length === 4 ? remote : remote.subarray(12);
    local4.copy(buf, 324); remote4.copy(buf, 308);
  }
  return buf;
}

function success(data: Buffer) { return { data, bytes: data.length, errno: 0 }; }

function fakeNative(pids: number[], overrides: Partial<DarwinNative> & { pidInfo?: DarwinNative["pidInfo"] } = {}): DarwinNative {
  const ownTask = taskInfo({ pid: process.pid, ppid: process.ppid, comm: "bun", name: "Bun" });
  const ownShort = shortInfo({ pid: process.pid, ppid: process.ppid });
  const native: DarwinNative = {
    timebase: { numer: 125, denom: 3 },
    listAllPids: () => pids,
    pidInfo: (pid, flavor) => {
      if (pid === process.pid && flavor === 2) return success(ownTask);
      if (pid === process.pid && flavor === 13) return success(ownShort);
      return { data: Buffer.alloc(0), bytes: 0, errno: 3 };
    },
    pidFdInfo: () => ({ data: Buffer.alloc(0), bytes: 0, errno: 3 }),
    pidPath: () => undefined,
    procArgs: () => undefined,
    kinfoProc: pid => kinfo(pid),
    ...overrides,
  };
  return native;
}

describe("Darwin fixed-layout parsing", () => {
  test("parses task-all-info offsets, NUL-trimmed names, identity, RSS, and Mach ticks", () => {
    const parsed = parseTaskAllInfo(taskInfo({ pid: 123, ppid: 45, pgid: 44, status: 3, comm: "my-comm", name: "full-process-name", sec: 1_700_000_000n, usec: 7n, rss: 8n * 1024n * 1024n, user: 24n, system: 12n }));
    expect(parsed).toMatchObject({ pid: 123, ppid: 45, pgid: 44, status: 3, comm: "my-comm", name: "full-process-name", nfiles: 17, startTime: "1700000000000007", residentBytes: 8n * 1024n * 1024n, userTicks: 24n, systemTicks: 12n });
    expect(machTicksToSeconds(parsed.userTicks, parsed.systemTicks, { numer: 125, denom: 3 })).toBe(0.0000015);
    expect(machTicksToSeconds(7n, 3n, { numer: 1, denom: 1 })).toBe(0.00000001);
    expect(() => machTicksToSeconds(1n, 1n, { numer: 1, denom: 0 })).toThrow(DarwinScannerError);
  });

  test("parses short BSD fields and cwd at offset 152, including a full MAXPATHLEN path", () => {
    expect(parseShortBsdInfo(shortInfo({ pid: 15, ppid: 4, pgid: 3, status: 4, comm: "short-comm", uid: 501 }))).toEqual({
      pid: 15, ppid: 4, pgid: 3, status: 4, comm: "short-comm", uid: 501,
    });
    const cwd = Buffer.alloc(2352); Buffer.from("/Users/test/work\0").copy(cwd, 152);
    expect(parseVnodeCwd(cwd)).toBe("/Users/test/work");
    const full = Buffer.alloc(152 + 1024, 0x61);
    expect(parseVnodeCwd(full)).toBe("a".repeat(1024));
    expect(parseVnodeCwd(Buffer.alloc(100))).toBeUndefined();
  });

  test("parses KERN_PROCARGS2 padding, empty and Unicode argv, and environment", () => {
    const parsed = parseProcArgs2(procArgs("/Applications/Aгtop.app/Contents/MacOS/agtop", ["agtop", "--empty", "", "雪"], ["AGTOP_JOB_ID=live-x", "PATH=/bin"]), 2048);
    expect(parsed).toEqual({ execPath: "/Applications/Aгtop.app/Contents/MacOS/agtop", argv: ["agtop", "--empty", "", "雪"], env: ["AGTOP_JOB_ID=live-x", "PATH=/bin"] });
    expect(parseEnvironment(parsed!.env.join("\0"))).toEqual({ AGTOP_JOB_ID: "live-x" });
  });

  test("bounds malformed and truncated KERN_PROCARGS2 input", () => {
    const args = procArgs("/bin/tool", ["tool", "partial", "not-present"], []);
    const argsEnd = args.indexOf(Buffer.from("partial")) + 3;
    expect(parseProcArgs2(args, argsEnd)).toEqual({ execPath: "/bin/tool", argv: ["tool", "par"], env: [] });
    const withEnv = procArgs("/bin/tool", ["tool"], ["AGTOP_JOB_ID=x", "OPENAI_BASE_URL=http://local"]);
    const envEnd = withEnv.indexOf(Buffer.from("http://local")) + 4;
    expect(parseProcArgs2(withEnv, envEnd)).toEqual({ execPath: "/bin/tool", argv: ["tool"], env: ["AGTOP_JOB_ID=x", "OPENAI_BASE_URL=http"] });
    const negative = procArgs("/bin/tool", ["tool"], []); negative.writeInt32LE(-1, 0);
    const huge = procArgs("/bin/tool", ["tool"], []); huge.writeInt32LE(65_537, 0);
    expect(parseProcArgs2(negative, negative.length)).toBeUndefined();
    expect(parseProcArgs2(huge, huge.length)).toBeUndefined();
    expect(parseProcArgs2(Buffer.from([0, 0, 0, 0, 1, 2, 3]), 7)).toBeUndefined();
    expect(parseProcArgs2(Buffer.from([0, 0, 0, 0, 47, 98]), 6)).toBeUndefined();
  });

  test("decodes TCP IPv4, IPv6, dual-stack wildcard, and IPv4-over-IPv6 socket info", () => {
    expect(parseSocketFdInfo(socketInfo({ family: 2, vflag: 1, state: 4, local: "127.0.0.1", remote: "127.0.0.1", localPort: 50_000, remotePort: 11_434 }))).toEqual({
      family: 2, state: 4, localAddress: "127.0.0.1", localPort: 50_000, remoteAddress: "127.0.0.1", remotePort: 11_434,
    });
    expect(parseSocketFdInfo(socketInfo({ family: 30, vflag: 2, state: 1, local: "::1", remote: "::1", localPort: 8080 }))).toMatchObject({ family: 30, state: 1, localAddress: "0:0:0:0:0:0:0:1", localPort: 8080, remoteAddress: "0:0:0:0:0:0:0:1" });
    const wildcard = parseSocketFdInfo(socketInfo({ family: 30, vflag: 2, state: 1, local: "::", remote: "::", localPort: 80 }));
    expect(wildcard?.localAddress).toBe("0:0:0:0:0:0:0:0");
    expect(parseSocketFdInfo(socketInfo({ family: 30, vflag: 1, state: 4, local: "127.0.0.1", remote: "127.0.0.1" }))).toMatchObject({ family: 30, localAddress: "127.0.0.1", remoteAddress: "127.0.0.1" });
  });

  test("ignores non-TCP socket kinds, UDP, unsupported families, and truncated fdinfo", () => {
    expect(parseSocketFdInfo(socketInfo({ kind: 1 }))).toBeUndefined();
    expect(parseSocketFdInfo(socketInfo({ protocol: 17 }))).toBeUndefined();
    expect(parseSocketFdInfo(socketInfo({ family: 10 }))).toBeUndefined();
    expect(parseSocketFdInfo(Buffer.alloc(791))).toBeUndefined();
  });

  test("parses kinfo start time and rejects mismatched PID or invalid data", () => {
    expect(parseKinfoStart(kinfo(51, 1_700_000_000n, 765_432), 51)).toBe("1700000000765432");
    expect(parseKinfoStart(kinfo(51), 52)).toBeUndefined();
    const invalid = kinfo(51); invalid.writeInt32LE(1_000_000, 8);
    expect(parseKinfoStart(invalid, 51)).toBeUndefined();
    expect(parseKinfoStart(Buffer.alloc(647), 51)).toBeUndefined();
  });
});

describe("Darwin ps fallback parsing", () => {
  test("parses padded lstart, process time forms, spaced commands, and skips zombies", () => {
    const lines = [
      "10 1 2 256 1:23.45 Fri Nov  7 01:02:03 2026 S /usr/local/bin/node app.js with spaces",
      "11 1 2 2048 1:02:03.40 Sat Nov 8 01:02:03 2025 R /bin/sleep 10",
      "12 1 2 0 2-03:04:05.67 Sun Dec  9 02:03:04 2024 S /bin/task",
      "13 1 2 0 0:00.00 Mon Jan 1 00:00:00 2024 Z /bin/zombie",
      "not a ps row",
    ].join("\n");
    const rows = parseDarwinPs(lines);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ pid: 10, ppid: 1, pgid: 2, name: "node", cmdline: "/usr/local/bin/node app.js with spaces", cpuSeconds: 83.45, memoryMb: 0.25, startTime: String(new Date(2026, 10, 7, 1, 2, 3).getTime() * 1000) });
    expect(rows[1]?.cpuSeconds).toBeCloseTo(3723.4);
    expect(rows[2]?.cpuSeconds).toBeCloseTo(183_845.67);
  });

  test("drops invalid dates, malformed times, and non-process rows", () => {
    expect(parseDarwinPs([
      "1 0 1 1 bogus Fri Nov 7 01:02:03 2026 S /bin/a",
      "2 0 2 1 0:00.00 Fri Foo 7 01:02:03 2026 S /bin/b",
      "3 0 3 1 0:00.00 Fri Feb 31 01:02:03 2026 S /bin/c",
    ].join("\n"))).toEqual([]);
  });
});

describe("fake libproc scans", () => {
  test("returns a reduced record on EPERM with executable path and kinfo identity", () => {
    const target = 44;
    const native = fakeNative([target], {
      pidInfo(pid, flavor) {
        if (pid === target && flavor === 2) return { data: Buffer.alloc(232), bytes: 0, errno: 1 };
        if (pid === target && flavor === 13) return success(shortInfo({ pid: target, ppid: 1, pgid: 1, comm: "daemon" }));
        return fakeNative([], {}).pidInfo(pid, flavor, 0);
      },
      pidPath: pid => pid === target ? "/usr/libexec/daemon" : undefined,
      kinfoProc: pid => kinfo(pid, 1_700_000_001n, 654_321),
    });
    const record = readDarwinProcesses(native)[0];
    expect(record).toMatchObject({ pid: target, ppid: 1, pgid: 1, name: "daemon", execPath: "/usr/libexec/daemon", argv: ["/usr/libexec/daemon"], env: [], cwd: undefined, startTime: "1700000001654321", cpuSeconds: 0, residentBytes: 0, restricted: true });
  });

  test("skips ESRCH races and a changed start time during the full-record recheck", () => {
    const gone = 45, reused = 46, stable = 47;
    const native = fakeNative([gone, reused, stable], {
      pidInfo(pid, flavor, size) {
        if (pid === process.pid && flavor === 2) return success(taskInfo({ pid, ppid: process.ppid }));
        if (pid === process.pid && flavor === 13) return success(shortInfo({ pid, ppid: process.ppid }));
        if (pid === gone && flavor === 2) return { data: Buffer.alloc(size), bytes: 0, errno: 3 };
        if ((pid === reused || pid === stable) && flavor === 2) return success(taskInfo({ pid, ppid: 1, sec: BigInt(pid) }));
        if (pid === reused && flavor === 3) return success(taskInfo({ pid, ppid: 1, sec: 999n }).subarray(0, 136));
        if (pid === stable && flavor === 3) return success(taskInfo({ pid, ppid: 1, sec: BigInt(pid) }).subarray(0, 136));
        return { data: Buffer.alloc(size), bytes: 0, errno: 3 };
      },
      pidPath: pid => pid === stable ? "/usr/bin/stable" : undefined,
    });
    expect(readDarwinProcesses(native).map(record => record.pid)).toEqual([stable]);
  });

  test("throws on zero readable records and a failing ABI self-check with remediation", () => {
    const empty = fakeNative([90]);
    expect(() => readDarwinProcesses(empty)).toThrow(/no readable processes/);
    const listingFailure = fakeNative([], { listAllPids: () => { throw new Error("enumeration failed"); } });
    expect(() => readDarwinProcesses(listingFailure)).toThrow(/proc_listallpids failed.*AGTOP_DARWIN_SCANNER=ps/);
    const abi = fakeNative([], { pidInfo: (pid, flavor, size) => flavor === 2 && pid === process.pid
      ? { data: Buffer.alloc(size), bytes: 0, errno: 12 }
      : { data: Buffer.alloc(size), bytes: 0, errno: 3 } });
    expect(() => readDarwinProcesses(abi)).toThrow(/proc_pidinfo\(PROC_PIDTASKALLINFO\).*ENOMEM|errno 12/);
    expect(() => readDarwinProcesses(abi)).toThrow(/AGTOP_DARWIN_SCANNER=ps/);
  });

  test("gets identity independent of the process scan and enumerates TCP socket fd rows", () => {
    const target = 54;
    const fdList = Buffer.alloc(64 * 8); fdList.writeInt32LE(8, 0); fdList.writeUInt32LE(2, 4);
    const native = fakeNative([], {
      kinfoProc: pid => kinfo(pid, 1_700_000_099n, 1),
      pidInfo: (pid, flavor, size) => flavor === 1 ? { data: fdList, bytes: 8, errno: 0 } : { data: Buffer.alloc(size), bytes: 0, errno: 3 },
      pidFdInfo: () => success(socketInfo({ family: 2, vflag: 1, state: 4 })),
    });
    expect(darwinIdentity(target, native)).toBe("1700000099000001");
    expect(darwinTcpRows([target], native)).toEqual([{ pid: target, state: 5, localAddress: "127.0.0.1", localPort: 50_000, remoteAddress: "127.0.0.1", remotePort: 11_434 }]);
  });
});

describe("socket platform guard", () => {
  test.skipIf(process.platform === "darwin")("does not load native Darwin sockets for another platform", async () => {
    const proc: RawOsProcess = { pid: 42, ppid: 1, name: "test", cmdline: "test", startTime: "1", cpuSeconds: 0, cpuPercent: 0, memoryMb: 0 };
    await collectSocketConnections([proc], "darwin");
    expect(proc).not.toHaveProperty("socketConnections");
    expect(proc).not.toHaveProperty("listeningSockets");
  });
});
