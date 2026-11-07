import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { CpuSampler, parseEnvironment, parseLinuxStat } from "../src/discovery.js";
import { correlateTrees } from "../src/trees.js";
import type { JobRecord, RawOsProcess } from "../src/types.js";

const root = path.resolve(import.meta.dir, "..");

function proc(pid: number, ppid = 0, name = "node", startTime = "1"): RawOsProcess {
  return { pid, ppid, name, cmdline: name, startTime, cpuSeconds: 0, cpuPercent: 0, memoryMb: 1 };
}
function job(partial: Pick<JobRecord, "jobId" | "rootPid" | "harness" | "startTime"> & Partial<JobRecord>): JobRecord {
  return {
    version: 1, peer: "peer", cwd: os.tmpdir(), backend: "unknown", mode: "linux-env-pgid",
    createdAt: "2020-01-01T00:00:00.000Z", ...partial,
  };
}
/** Build a /proc stat line. `patch` keys are field indexes after the comm (0 = state, 21 = rss pages). */
function statLine(pid: number, comm: string, patch: Record<number, string> = {}): string {
  const fields = Array.from({ length: 22 }, () => "0");
  fields[0] = "S"; fields[1] = "40"; fields[2] = "41";
  fields[11] = "100"; fields[12] = "50"; fields[19] = "5000"; fields[21] = "256";
  for (const [key, value] of Object.entries(patch)) fields[Number(key)] = value;
  return `${pid} (${comm}) ${fields.join(" ")} 1 2 3 4\n`;
}

describe("parseLinuxStat edges", () => {
  test("parses comm values that contain spaces, parentheses, and ) ( sequences", () => {
    const spaced = parseLinuxStat(statLine(7, "worker (busy) box"), 100, 4096);
    expect(spaced).toMatchObject({ pid: 7, ppid: 40, pgid: 41, name: "worker (busy) box", state: "S", startTime: "5000", cpuSeconds: 1.5 });
    expect(parseLinuxStat(statLine(8, "x) (y"), 100, 4096).name).toBe("x) (y");
    expect(parseLinuxStat(statLine(9, ") ("), 100, 4096).name).toBe(") (");
    expect(parseLinuxStat(statLine(10, ""), 100, 4096).name).toBe("");
  });

  test("rejects truncated and garbage stat lines", () => {
    expect(() => parseLinuxStat("", 100, 4096)).toThrow("Malformed /proc stat");
    expect(() => parseLinuxStat("42 (command without a close", 100, 4096)).toThrow("Malformed /proc stat");
    expect(() => parseLinuxStat("42 (name) S 1 2", 100, 4096)).toThrow("Malformed /proc stat");
    expect(() => parseLinuxStat("not a stat line", 100, 4096)).toThrow("Malformed /proc stat");
    expect(() => parseLinuxStat("))))", 100, 4096)).toThrow("Malformed /proc stat");
  });

  test("converts RSS from pages to MiB and clamps a negative page count", () => {
    expect(parseLinuxStat(statLine(1, "a", { 21: "512" }), 100, 4096).memoryMb).toBe(2);
    expect(parseLinuxStat(statLine(1, "a", { 21: "256" }), 100, 4096).memoryMb).toBe(1);
    expect(parseLinuxStat(statLine(1, "a", { 21: "0" }), 100, 4096).memoryMb).toBe(0);
    expect(parseLinuxStat(statLine(1, "a", { 21: "-8" }), 100, 4096).memoryMb).toBe(0);
    expect(parseLinuxStat(statLine(1, "a", { 11: "0", 12: "0" }), 50, 4096).cpuSeconds).toBe(0);
  });

  test("rejects a closing ')' with no opening '('", () => {
    expect(() => parseLinuxStat(`42 name) ${Array(22).fill("0").join(" ")}`, 100, 4096)).toThrow("Malformed /proc stat");
  });
});

describe("parseEnvironment edges", () => {
  test("an empty or disallowed block is unknown tags", () => {
    expect(parseEnvironment("")).toEqual({});
    expect(parseEnvironment("\0\0")).toEqual({});
    expect(parseEnvironment("PATH=/bin\0HOME=/home\0OPENAI_API_KEY=secret\0")).toEqual({});
    expect(parseEnvironment("AGTOP_JOB_ID=\0OPENAI_BASE_URL=http://127.0.0.1:13305/v1?x=1\0AGTOP_JOB_IDX=nope\0")).toEqual({
      AGTOP_JOB_ID: "",
      OPENAI_BASE_URL: "http://127.0.0.1:13305/v1?x=1",
    });
  });

  test("ignores allowlist lookalikes without an equals sign", () => {
    expect(parseEnvironment("AGTOP_JOB_IDX\0")).toEqual({});
    expect(parseEnvironment("OPENAI_BASE_URLX\0")).toEqual({});
  });
});

describe("CpuSampler edges", () => {
  test("reports 0% when the sample clock moves backwards", () => {
    const sampler = new CpuSampler();
    sampler.sample([{ ...proc(1), cpuSeconds: 2 }], 5_000);
    expect(sampler.sample([{ ...proc(1), cpuSeconds: 9 }], 1_000)[0].cpuPercent).toBe(0);
  });

  test("reports 0% when the CPU counter resets, then rates the next interval from the new baseline", () => {
    const sampler = new CpuSampler();
    sampler.sample([{ ...proc(1), cpuSeconds: 5 }], 0);
    expect(sampler.sample([{ ...proc(1), cpuSeconds: 1 }], 1_000)[0].cpuPercent).toBe(0);
    expect(sampler.sample([{ ...proc(1), cpuSeconds: 2 }], 2_000)[0].cpuPercent).toBe(100);
  });

  test("reports 0% for a zero-length sample interval", () => {
    const sampler = new CpuSampler();
    sampler.sample([{ ...proc(1), cpuSeconds: 1 }], 1_000);
    const sample = sampler.sample([{ ...proc(1), cpuSeconds: 50 }], 1_000)[0];
    expect(sample.cpuPercent).toBe(0);
    expect(Number.isFinite(sample.cpuPercent)).toBe(true);
  });

  test("drops CPU history when a PID is reused with a new start time", () => {
    const sampler = new CpuSampler();
    sampler.sample([
      { ...proc(1, 0, "node", "100"), cpuSeconds: 4 },
      { ...proc(2, 0, "node", "100"), cpuSeconds: 1 },
    ], 0);
    const reused = sampler.sample([
      { ...proc(1, 0, "node", "900"), cpuSeconds: 40 },
      { ...proc(2, 0, "node", "100"), cpuSeconds: 2 },
    ], 1_000);
    expect(reused.find(p => p.pid === 1)?.cpuPercent).toBe(0);
    expect(reused.find(p => p.pid === 2)?.cpuPercent).toBe(100);
    expect(sampler.sample([{ ...proc(1, 0, "node", "900"), cpuSeconds: 40.5 }], 1_500)[0].cpuPercent).toBe(100);
  });
});

describe("correlateTrees edges", () => {
  test("keeps a harness orphan and ignores a non-agent whose parent is gone", () => {
    expect(correlateTrees([proc(8, 999, "sleep", "10")], [])).toEqual([]);
    const trees = correlateTrees([proc(9, 8, "node", "11"), proc(8, 999, "codex", "10")], []);
    expect(trees).toHaveLength(1);
    expect(trees[0].rootPid).toBe(8);
    expect(trees[0].harness).toBe("codex");
    expect(trees[0].processes.map(p => p.pid)).toEqual([8, 9]);
  });

  test("builds self-parent and cycle trees without duplicating a PID or looping", () => {
    const self = correlateTrees([proc(5, 5, "codex", "10"), proc(6, 5, "node", "11")], []);
    expect(self).toHaveLength(1);
    expect(self[0].processes.map(p => p.pid)).toEqual([5, 6]);
    expect(correlateTrees([proc(2, 3, "sleep", "1"), proc(3, 2, "sleep", "1")], [])).toEqual([]);
    const cycle = correlateTrees([
      proc(2, 4, "sleep", "10"),
      proc(4, 3, "sleep", "10"),
      proc(3, 2, "codex", "10"),
    ], []);
    expect(cycle).toHaveLength(1);
    expect(cycle[0].processes.map(p => p.pid).sort((a, b) => a - b)).toEqual([2, 3, 4]);
  });

  test("builds a 10000-deep chain without overflowing the stack", () => {
    const depth = 10_000;
    const processes = [proc(1, 0, "codex", "1")];
    for (let pid = 2; pid <= depth; pid++) processes.push(proc(pid, pid - 1, "node", String(pid)));
    const trees = correlateTrees(processes, []);
    expect(trees).toHaveLength(1);
    expect(trees[0].rootPid).toBe(1);
    expect(trees[0].processes).toHaveLength(depth);
    expect(trees[0].processes[0]?.pid).toBe(1);
    expect(trees[0].processes[depth - 1]?.pid).toBe(depth);
  });

  test("keeps tagged descendants on a managed job after the intermediate shell exits", () => {
    // manager.ts members() is not exported. For linux-env-pgid it keeps every
    // live process whose AGTOP_JOB_ID matches, including descendants reparented
    // after shell pid 20 exits. correlateTrees is the nearest exported function.
    const tags = { AGTOP_JOB_ID: "job-a", AGTOP_HARNESS: "codex" };
    const root = { ...proc(10, 1, "codex", "100"), pgid: 10, envTags: tags };
    const worker = { ...proc(30, 1, "node", "300"), pgid: 30, envTags: tags };
    const grand = { ...proc(40, 30, "node", "400"), envTags: tags };
    const passive = proc(50, 1, "claude", "500");
    const record = job({ jobId: "job-a", rootPid: 10, harness: "codex", startTime: "100" });
    const managed = correlateTrees([passive, worker, grand, root], [record], new Map([["job-a", [10, 30, 40]]]));
    const managedTree = managed.find(tree => tree.jobId === "job-a");
    expect(managedTree?.processes.map(p => p.pid).sort((a, b) => a - b)).toEqual([10, 30, 40]);
    expect(managedTree?.rootPid).toBe(10);
    expect(managed.find(tree => tree.rootPid === 50)?.processes.map(p => p.pid)).toEqual([50]);

    const taggedOnly = correlateTrees([worker, grand], []);
    expect(taggedOnly.map(tree => tree.jobId)).toEqual(["unmanaged-job-a"]);
    expect(taggedOnly[0]?.harness).toBe("codex");
    expect(taggedOnly[0]?.processes.map(p => p.pid).sort((a, b) => a - b)).toEqual([30, 40]);
  });

  test("attributes an agent nested inside another agent to its own job", () => {
    const outerTags = { AGTOP_JOB_ID: "outer", AGTOP_HARNESS: "claude-code" };
    const innerTags = { AGTOP_JOB_ID: "inner", AGTOP_HARNESS: "codex" };
    const processes = [
      { ...proc(40, 30, "node", "40"), envTags: innerTags },
      { ...proc(20, 10, "bash", "20"), envTags: outerTags },
      { ...proc(10, 1, "claude", "10"), envTags: outerTags },
      { ...proc(30, 20, "codex", "30"), envTags: innerTags },
    ];
    const jobs = [
      job({ jobId: "outer", rootPid: 10, harness: "claude-code", startTime: "10" }),
      job({ jobId: "inner", rootPid: 30, harness: "codex", startTime: "30" }),
    ];
    const trees = correlateTrees(processes, jobs, new Map([["outer", [10, 20]], ["inner", [30, 40]]]));
    const byId = Object.fromEntries(trees.map(tree => [tree.jobId, tree.processes.map(p => p.pid).sort((a, b) => a - b)]));
    expect(byId).toEqual({ outer: [10, 20], inner: [30, 40] });
    expect(trees.find(tree => tree.jobId === "inner")?.harness).toBe("codex");
    expect(trees.find(tree => tree.jobId === "outer")?.harness).toBe("claude-code");

    const tagged = correlateTrees(processes, []);
    const taggedIds = Object.fromEntries(tagged.map(tree => [tree.jobId, tree.processes.map(p => p.pid).sort((a, b) => a - b)]));
    expect(taggedIds).toEqual({ "unmanaged-inner": [30, 40], "unmanaged-outer": [10, 20] });
  });

  test("assigns overlapping managed members to the most specific job independent of job order", () => {
    const processes = [proc(10, 1, "claude", "10"), proc(20, 10, "bash", "20"), proc(30, 20, "codex", "30"), proc(40, 30, "node", "40")];
    const jobs = [
      job({ jobId: "outer", rootPid: 10, harness: "claude-code", startTime: "10", mode: "win32-job-object" }),
      job({ jobId: "inner", rootPid: 30, harness: "codex", startTime: "30", mode: "win32-job-object" }),
    ];
    const trees = correlateTrees(processes, jobs, new Map([["outer", [10, 20, 30, 40]], ["inner", [30, 40]]]));
    const byId = Object.fromEntries(trees.map(tree => [tree.jobId, tree.processes.map(p => p.pid)]));
    expect(byId.outer).toEqual([10, 20]);
    expect(byId.inner).toEqual([30, 40]);
    const reversed = correlateTrees(processes, [...jobs].reverse(), new Map([["outer", [10, 20, 30, 40]], ["inner", [30, 40]]]));
    expect(Object.fromEntries(reversed.map(tree => [tree.jobId, tree.processes.map(p => p.pid)]))).toEqual(byId);
  });

  test("keeps parent links when either process start time is unknown", () => {
    const trees = correlateTrees([proc(10, 1, "codex", "1700000000000"), proc(11, 10, "node", "0")], []);
    expect(trees[0]?.processes.map(p => p.pid)).toEqual([10, 11]);
    const reused = correlateTrees([proc(10, 1, "codex", "1700000000000"), proc(11, 10, "node", "1600000000000")], []);
    expect(reused[0]?.processes.map(p => p.pid)).toEqual([10]);
  });
});

// Cmdline splitting, environ permission errors, the readdir/read race, and CIM
// row mapping are not exported. They are covered through scanLinuxProcesses and
// scanWindowsProcesses. The mock runs in a child bun test so it cannot leak
// into later files (bun test shares one module registry by default).
type CimRow = {
  ProcessId: number; ParentProcessId: number; Name: string | null;
  CommandLine?: string | null; WorkingSetSize?: number | null;
  KernelModeTime?: number | null; UserModeTime?: number | null;
  Start?: string | number | null;
};
type LinuxProc = {
  stat?: string; statError?: string;
  statSequence?: Array<{ text?: string; error?: string }>;
  cmdline?: string; environ?: string; environError?: string;
  cwd?: string; cgroup?: string;
};
type ScannerStep = {
  id: string; op: "windows" | "linux";
  stdout?: string; error?: string;
  procs?: Record<string, LinuxProc>;
  readdirError?: string; getconfError?: string;
};
type StepResult = {
  id: string;
  rows?: Array<RawOsProcess & { argv?: string[] }>;
  error?: string;
};

const windowsRows: CimRow[] = [
  { ProcessId: 1, ParentProcessId: 0, Name: "a.exe", CommandLine: null, WorkingSetSize: 2_097_152, KernelModeTime: 2_500_000, UserModeTime: 2_500_000, Start: null },
  { ProcessId: 2, ParentProcessId: 1, Name: "b.exe", CommandLine: "", WorkingSetSize: null, KernelModeTime: null, UserModeTime: null },
  { ProcessId: 3, ParentProcessId: 1, Name: "c.exe", CommandLine: "c.exe --flag", WorkingSetSize: 0, KernelModeTime: 0, UserModeTime: 0, Start: "2024-01-01T00:00:00.000Z" },
  { ProcessId: 4, ParentProcessId: 1, Name: "d.exe", CommandLine: "d.exe", WorkingSetSize: 512, KernelModeTime: 0, UserModeTime: 0, Start: "/Date(1700000000000)/" },
  { ProcessId: 5, ParentProcessId: 1, Name: "e.exe", CommandLine: "e.exe", WorkingSetSize: 1_048_576, KernelModeTime: 10_000_000, UserModeTime: 0, Start: "1700000000000" },
  { ProcessId: 7, ParentProcessId: 1, Name: null, CommandLine: null, WorkingSetSize: 0, KernelModeTime: 0, UserModeTime: 0, Start: "" },
  { ProcessId: 0, ParentProcessId: 0, Name: "Idle", CommandLine: "Idle", WorkingSetSize: 0, KernelModeTime: 0, UserModeTime: 0, Start: "1" },
  { ProcessId: -3, ParentProcessId: 0, Name: "neg.exe", CommandLine: "neg.exe", WorkingSetSize: 0, KernelModeTime: 0, UserModeTime: 0, Start: "1" },
];

const scannerSteps: ScannerStep[] = [
  { id: "rows", op: "windows", stdout: JSON.stringify(windowsRows) },
  { id: "single", op: "windows", stdout: JSON.stringify({ ProcessId: 9, ParentProcessId: 2, Name: "only.exe", CommandLine: null, WorkingSetSize: 1_048_576, KernelModeTime: 0, UserModeTime: 0, Start: 1_700_000_000_000 }) },
  { id: "bom", op: "windows", stdout: `\uFEFF${JSON.stringify([{ ProcessId: 6, ParentProcessId: 1, Name: "bom.exe", CommandLine: null, WorkingSetSize: 0, KernelModeTime: 0, UserModeTime: 0, Start: "42" }])}` },
  { id: "null-json", op: "windows", stdout: "null" },
  { id: "empty", op: "windows", stdout: "" },
  { id: "bad-json", op: "windows", stdout: "not-json" },
  { id: "ps-fail", op: "windows", error: "CIM unavailable" },
  {
    id: "linux", op: "linux", procs: {
      "10": {
        stat: statLine(10, ") ("),
        cmdline: "node\0\0--eval\0\0code\0",
        environError: "EACCES",
        cwd: "/work",
        cgroup: "0::/user.slice/agtop\n",
      },
      "20": { statError: "ENOENT" },
      "30": { statSequence: [{ text: statLine(30, "old", { 19: "5000" }) }, { text: statLine(30, "new", { 19: "9999" }) }] },
      "40": { stat: statLine(40, "sleeper"), cmdline: "\0\0", environ: "" },
      "50": {
        stat: statLine(50, "codex"),
        cmdline: "codex\0",
        environ: "PATH=/bin\0AGTOP_JOB_ID=job-a\0AGTOP_HARNESS=codex\0OPENAI_API_KEY=secret\0",
      },
    },
  },
  { id: "all-exited", op: "linux", procs: { "1": { statError: "ENOENT" }, "2": { statError: "ENOENT" } } },
  { id: "readdir-fail", op: "linux", readdirError: "EIO", procs: {} },
];

const childSource = String.raw`
import { mock, test } from "bun:test";
import { promisify } from "node:util";
import * as fs from "node:fs";

const custom = promisify.custom;
const state: { ps: { stdout?: string; error?: string } | null; linux: any; getconfError: string } = { ps: null, linux: null, getconfError: "" };
function execFile(file: string, args?: unknown, options?: unknown, cb?: unknown) {
  const callback = (typeof args === "function" ? args : typeof options === "function" ? options : cb) as (err: Error | null, stdout?: string, stderr?: string) => void;
  const argv = Array.isArray(args) ? args : [];
  if (file === "getconf") {
    if (state.getconfError) { callback(new Error(state.getconfError)); return; }
    callback(null, (argv[0] === "CLK_TCK" ? "100" : "4096") + "\n", "");
    return;
  }
  if (String(file).toLowerCase().includes("powershell")) {
    if (state.ps?.error) { callback(new Error(state.ps.error)); return; }
    callback(null, state.ps?.stdout ?? "[]", "");
    return;
  }
  callback(new Error("unexpected " + file));
}
(execFile as unknown as Record<symbol, unknown>)[custom] = (file: string, args?: unknown, options?: unknown) => new Promise((resolve, reject) => {
  execFile(file, args, options, (err, stdout, stderr) => err ? reject(err) : resolve({ stdout, stderr }));
});
function fail(code: string): Error { return Object.assign(new Error(code), { code }); }
async function readFile(file: string) {
  const match = /^\/proc\/(\d+)\/(stat|cmdline|environ|cgroup)$/.exec(file);
  if (!match) throw fail("ENOENT");
  const proc = state.linux.procs[match[1]];
  if (!proc) throw fail("ENOENT");
  const field = match[2];
  if (field === "stat") {
    const seen = proc._n || 0;
    proc._n = seen + 1;
    if (proc.statSequence) {
      const item = proc.statSequence[Math.min(seen, proc.statSequence.length - 1)];
      if (item.error) throw fail(item.error);
      return item.text;
    }
    if (proc.statError) throw fail(proc.statError);
    return proc.stat;
  }
  if (proc[field + "Error"]) throw fail(proc[field + "Error"]);
  if (proc[field] === undefined) throw fail("ENOENT");
  return proc[field];
}
async function readdir() {
  if (state.linux?.readdirError) throw fail(state.linux.readdirError);
  return Object.keys(state.linux.procs || {});
}
async function readlink(file: string) {
  const match = /^\/proc\/(\d+)\/cwd$/.exec(file);
  if (!match) throw fail("ENOENT");
  const proc = state.linux.procs[match[1]];
  if (!proc || proc.cwd === undefined) throw fail("ENOENT");
  return proc.cwd;
}
mock.module("node:child_process", () => ({ execFile }));
mock.module("node:fs/promises", () => ({ readFile, readdir, readlink }));

test("run", async () => {
  const discovery = await import(process.env.DISCOVERY!);
  const fixture = JSON.parse(fs.readFileSync(process.env.FIXTURE_FILE!, "utf8"));
  const results = [];
  for (const step of fixture.steps) {
    if (step.op === "windows") {
      state.ps = step;
      try { results.push({ id: step.id, rows: await discovery.scanWindowsProcesses() }); }
      catch (error) { results.push({ id: step.id, error: error instanceof Error ? error.message : String(error) }); }
    } else {
      state.linux = step;
      state.getconfError = step.getconfError || "";
      try { results.push({ id: step.id, rows: await discovery.scanLinuxProcesses() }); }
      catch (error) { results.push({ id: step.id, error: error instanceof Error ? error.message : String(error) }); }
    }
  }
  fs.writeFileSync(process.env.OUT_FILE!, JSON.stringify(results));
});
`;

async function runScanner(steps: ScannerStep[]): Promise<StepResult[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-edge-"));
  const fixture = path.join(dir, "fixture.json");
  const out = path.join(dir, "out.json");
  const child = path.join(dir, "scan.test.ts");
  fs.writeFileSync(fixture, JSON.stringify({ steps }));
  fs.writeFileSync(child, childSource);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.FIXTURE_FILE = fixture;
  env.OUT_FILE = out;
  env.DISCOVERY = pathToFileURL(path.join(root, "src", "discovery.ts")).href;
  const subprocess = Bun.spawn({ cmd: [process.execPath, "test", child], cwd: root, env, stdout: "pipe", stderr: "pipe" });
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ]);
    if (code !== 0 || !fs.existsSync(out)) {
      throw new Error(`scanner fixture exited ${code}\n${stdout.slice(-2000)}\n${stderr.slice(-2000)}`);
    }
    return JSON.parse(fs.readFileSync(out, "utf8")) as StepResult[];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let scannerPending: Promise<Map<string, StepResult>> | undefined;
function scannerMap(): Promise<Map<string, StepResult>> {
  return scannerPending ??= runScanner(scannerSteps).then(rows => new Map(rows.map(row => [row.id, row])));
}
function taken(map: Map<string, StepResult>, id: string): StepResult {
  const found = map.get(id);
  if (!found) throw new Error(`missing scanner fixture ${id}`);
  return found;
}

describe("scanner edges", () => {
  test("Windows CIM rows map null command lines, RSS bytes, CPU time, and creation dates", async () => {
    const map = await scannerMap();
    const rows = taken(map, "rows").rows ?? [];
    expect(rows.map(row => row.pid)).toEqual([1, 2, 3, 4, 5, 7]);
    expect(rows.map(row => ({ pid: row.pid, cmdline: row.cmdline, startTime: row.startTime, cpuSeconds: row.cpuSeconds, memoryMb: row.memoryMb }))).toEqual([
      { pid: 1, cmdline: "a.exe", startTime: "0", cpuSeconds: 0.5, memoryMb: 2 },
      { pid: 2, cmdline: "b.exe", startTime: "0", cpuSeconds: 0, memoryMb: 0 },
      { pid: 3, cmdline: "c.exe --flag", startTime: "0", cpuSeconds: 0, memoryMb: 0 },
      { pid: 4, cmdline: "d.exe", startTime: "0", cpuSeconds: 0, memoryMb: 512 / 1_048_576 },
      { pid: 5, cmdline: "e.exe", startTime: "1700000000000", cpuSeconds: 1, memoryMb: 1 },
      { pid: 7, cmdline: "", startTime: "0", cpuSeconds: 0, memoryMb: 0 },
    ]);
    expect(taken(map, "single").rows).toEqual([
      { pid: 9, ppid: 2, name: "only.exe", cmdline: "only.exe", startTime: "1700000000000", cpuSeconds: 0, memoryMb: 1, cpuPercent: 0 },
    ]);
    expect(taken(map, "bom").rows?.map(row => ({ pid: row.pid, cmdline: row.cmdline, startTime: row.startTime }))).toEqual([
      { pid: 6, cmdline: "bom.exe", startTime: "42" },
    ]);
    expect(taken(map, "null-json").rows).toEqual([]);
  }, 20_000);

  test("a Windows scanner failure is an error", async () => {
    const map = await scannerMap();
    expect(taken(map, "empty").error).toBeTruthy();
    expect(taken(map, "empty").rows).toBeUndefined();
    expect(taken(map, "bad-json").error).toMatch(/JSON/);
    expect(taken(map, "ps-fail")).toMatchObject({ error: "CIM unavailable" });
    expect(taken(map, "ps-fail").rows).toBeUndefined();
  }, 20_000);

  test("Linux cmdline NULs, a denied environ, and processes that exit between listing and reading", async () => {
    const rows = taken(await scannerMap(), "linux").rows ?? [];
    expect(rows.map(row => row.pid).sort((a, b) => a - b)).toEqual([10, 40, 50]);
    const weird = rows.find(row => row.pid === 10);
    expect(weird).toMatchObject({
      name: ") (", ppid: 40, pgid: 41, cmdline: "node --eval code", argv: ["node", "--eval", "code"],
      envTags: {}, cwd: "/work", cgroup: "/user.slice/agtop", cpuSeconds: 1.5, memoryMb: 1, startTime: "5000",
    });
    const emptyArgs = rows.find(row => row.pid === 40);
    expect(emptyArgs?.argv).toEqual([]);
    expect(emptyArgs?.cmdline).toBe("sleeper");
    expect(emptyArgs?.envTags).toEqual({});
    expect(rows.find(row => row.pid === 50)?.envTags).toEqual({ AGTOP_JOB_ID: "job-a", AGTOP_HARNESS: "codex" });
    expect(rows.some(row => row.pid === 20 || row.pid === 30)).toBe(false);
  }, 20_000);

  test("a Linux scanner failure is an error and a race that removes every pid is an empty list", async () => {
    const map = await scannerMap();
    expect(taken(map, "all-exited").rows).toEqual([]);
    expect(taken(map, "all-exited").error).toBeUndefined();
    expect(taken(map, "readdir-fail").error).toBe("EIO");
    expect(taken(map, "readdir-fail").rows).toBeUndefined();
    const getconf = (await runScanner([{ id: "getconf-fail", op: "linux", getconfError: "getconf failed", procs: {} }]))[0];
    expect(getconf?.error).toBe("getconf failed");
    expect(getconf?.rows).toBeUndefined();
  }, 20_000);
});
