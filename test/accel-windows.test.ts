import { describe, expect, test } from "bun:test";
import { scanWindowsProcesses } from "../src/discovery.js";
import { createProvider, decodeFormattedCounterItems, parseEngineInstance, parseMemoryInstance, type FormattedCounterItem, type PdhBinding, type PdhArrayResult } from "../src/accel-windows.js";
import type { RawOsProcess } from "../src/types.js";

const validItem = (name: string, value: number, status = 0): FormattedCounterItem => ({ name, status, value });

function fakePdh(engineBySample: FormattedCounterItem[][], memoryBySample: FormattedCounterItem[][]): PdhBinding & { paths: string[]; closeCount: number } {
  const paths: string[] = [];
  let sampleIndex = -1;
  let closeCount = 0;
  const engine = { name: "engine" };
  const memory = { name: "memory" };
  const empty: PdhArrayResult = { status: 0, items: [] };
  return {
    paths,
    get closeCount() { return closeCount; },
    openQuery: () => ({ status: 0, query: { name: "query" } }),
    addEnglishCounter(_query, path) {
      paths.push(path);
      return { status: 0, counter: path.includes("GPU Engine") ? engine : memory };
    },
    collectQueryData: () => { sampleIndex++; return 0; },
    getFormattedCounterArray(counter) {
      const rows = counter === engine ? engineBySample[sampleIndex] : memoryBySample[sampleIndex];
      return rows ? { status: 0, items: rows } : empty;
    },
    closeQuery: () => { closeCount++; return 0; },
  };
}

describe("Windows accelerator instance parsing", () => {
  test("parses Intel and Parsec-looking LUIDs and normalizes hexadecimal", () => {
    expect(parseEngineInstance("pid_10368_luid_0x00000000_0x0000963c_phys_0_eng_0_engtype_3d")).toEqual({
      pid: 10368, luid: "0x00000000_0x0000963c", phys: 0, engIndex: 0, engType: "3d",
    });
    expect(parseEngineInstance("pid_13376_luid_0x00000000_0x00009968_phys_0_eng_4_engtype_VideoDecode")).toEqual({
      pid: 13376, luid: "0x00000000_0x00009968", phys: 0, engIndex: 4, engType: "videodecode",
    });
    expect(parseEngineInstance("pid_23_luid_0_963C_phys_0_eng_11_engtype_")?.engType).toBe("unknown");
    expect(parseMemoryInstance("pid_13376_luid_0x00000000_0x00009968_phys_0")).toEqual({
      pid: 13376, luid: "0x00000000_0x00009968", phys: 0,
    });
  });

  test("rejects malformed, overflowing, and unrelated PDH names", () => {
    for (const name of [
      "",
      "pid_x_luid_0x00000000_0x0000963c_phys_0_eng_0_engtype_3d",
      "pid_0_luid_0x00000000_0x0000963c_phys_0_eng_0_engtype_3d",
      "pid_4_luid_0x100000000_0x0000963c_phys_0_eng_0_engtype_3d",
      "pid_4_luid_0x00000000_0x0000963c_phys_0_eng_0_engtype_3d#1",
      "other(pid_4_luid_0x00000000_0x0000963c_phys_0)",
    ]) {
      expect(parseEngineInstance(name)).toBeUndefined();
      expect(parseMemoryInstance(name)).toBeUndefined();
    }
  });
});

describe("Windows PDH formatted counter decoding", () => {
  test.skipIf(process.arch !== "x64")("decodes the verified x64 item layout and follows each name pointer", () => {
    const buffer = Buffer.alloc(48);
    buffer.writeBigUInt64LE(0x1010n, 0);
    buffer.writeUInt32LE(0, 8);
    buffer.writeDoubleLE(37.25, 16);
    buffer.writeBigUInt64LE(0x2020n, 24);
    buffer.writeUInt32LE(2, 32);
    buffer.writeDoubleLE(91.5, 40);
    const names = new Map<bigint, string>([
      [0x1010n, "pid_42_luid_0x00000000_0x0000963c_phys_0_eng_0_engtype_3d"],
      [0x2020n, "pid_42_luid_0x00000000_0x0000963c_phys_0_eng_1_engtype_compute"],
    ]);
    expect(decodeFormattedCounterItems(buffer, 2, pointer => names.get(pointer) ?? null)).toEqual([
      { name: "pid_42_luid_0x00000000_0x0000963c_phys_0_eng_0_engtype_3d", status: 0, value: 37.25 },
      { name: "pid_42_luid_0x00000000_0x0000963c_phys_0_eng_1_engtype_compute", status: 2, value: 91.5 },
    ]);
    expect(() => decodeFormattedCounterItems(buffer, 3, () => null)).toThrow(RangeError);
  });
});

describe("Windows accelerator provider", () => {
  test("classifies ComputeOnly adapters as NPUs and normal adapters as GPUs", async () => {
    const rows = [validItem("pid_42_luid_0x00000000_0x0000963c_phys_0_eng_0_engtype_compute", 11)];
    const npu = createProvider({ pdh: fakePdh([rows], [[]]), classifyAdapter: () => ({ computeOnly: true }) })!;
    const gpu = createProvider({ pdh: fakePdh([rows], [[]]), classifyAdapter: () => ({ computeOnly: false }) })!;
    try {
      expect((await npu.sample(new Set([42]), new Map())).devices).toEqual([
        { id: "luid:0x00000000_0x0000963c", kind: "npu" },
      ]);
      expect((await gpu.sample(new Set([42]), new Map())).devices).toEqual([
        { id: "luid:0x00000000_0x0000963c", kind: "gpu" },
      ]);
    } finally { npu.close?.(); gpu.close?.(); }
  });

  test("primes percentages, filters PIDs, and attaches memory once per process and device", async () => {
    const engineNames = [
      "pid_42_luid_0x00000000_0x0000963c_phys_0_eng_0_engtype_3d",
      "pid_42_luid_0x00000000_0x0000963c_phys_0_eng_1_engtype_3d",
      "pid_42_luid_0x00000000_0x0000963c_phys_0_eng_4_engtype_3d",
      "pid_42_luid_0x00000000_0x0000963c_phys_0_eng_2_engtype_copy",
      "pid_99_luid_0x00000000_0x0000963c_phys_0_eng_0_engtype_3d",
    ];
    const memoryNames = [
      "pid_42_luid_0x00000000_0x0000963c_phys_0",
      "pid_42_luid_0x00000000_0x0000963c_phys_1",
      "pid_99_luid_0x00000000_0x0000963c_phys_0",
    ];
    const pdh = fakePdh(
      [
        engineNames.map((name, i) => validItem(name, 10 + i, i === 2 ? 1 : 0)),
        engineNames.map((name, i) => validItem(name, [48, 73, 99, 16, 90][i], i === 2 ? 1 : 0)),
      ],
      [
        memoryNames.map((name, i) => validItem(name, [100, 28, 900][i])),
        memoryNames.map((name, i) => validItem(name, [128, 32, 900][i])),
      ],
    );
    let classifyCalls = 0;
    const provider = createProvider({ pdh, classifyAdapter: () => { classifyCalls++; return { computeOnly: false }; } })!;
    try {
      const first = await provider.sample(new Set([42]), new Map());
      expect(first.samples.every(sample => sample.percent === undefined)).toBe(true);
      expect(first.samples).toContainEqual(expect.objectContaining({ pid: 42, engine: "3d", memoryBytes: 128 }));
      expect(first.samples.some(sample => sample.pid === 99)).toBe(false);
      expect(first.status).toEqual([{ source: "windows-pdh", kind: "any", available: true }]);

      const second = await provider.sample(new Set([42]), new Map());
      expect(second.samples).toContainEqual(expect.objectContaining({ pid: 42, engine: "3d", percent: 73, memoryBytes: 160 }));
      expect(second.samples).toContainEqual(expect.objectContaining({ pid: 42, engine: "copy", percent: 16 }));
      expect(second.samples).toHaveLength(2);
      expect(second.samples.some(sample => sample.pid === 99)).toBe(false);
      expect(pdh.paths).toEqual(["\\GPU Engine(*)\\Utilization Percentage", "\\GPU Process Memory(*)\\Dedicated Usage"]);
      expect(classifyCalls).toBe(1);
    } finally { provider.close?.(); }
    expect(pdh.closeCount).toBe(1);
  });

  test("reports no-devices and generic errors without throwing", async () => {
    const emptyProvider = createProvider({ pdh: fakePdh([[]], [[]]) })!;
    try {
      expect((await emptyProvider.sample(new Set(), new Map())).status).toEqual([
        expect.objectContaining({ source: "windows-pdh", available: false, reason: "no-devices" }),
      ]);
    } finally { emptyProvider.close?.(); }
  });
});

test.skipIf(process.platform !== "win32")("live Windows PDH sampling returns devices and well-formed statuses", async () => {
  const provider = createProvider();
  expect(provider).toBeDefined();
  if (!provider) return;
  try {
    const processes = await scanWindowsProcesses();
    const pids = new Set<number>([process.pid]);
    for (const processInfo of processes) {
      if (/^(dwm|explorer)(\.exe)?$/i.test(processInfo.name)) pids.add(processInfo.pid);
    }
    const records = new Map<number, RawOsProcess>(processes.map(processInfo => [processInfo.pid, processInfo]));
    records.set(process.pid, processes.find(processInfo => processInfo.pid === process.pid) ?? {
      pid: process.pid, ppid: 0, name: "bun", cmdline: "", startTime: "current", cpuSeconds: 0, cpuPercent: 0,
      memoryMb: 0,
    });

    const cost: number[] = [];
    const results = [];
    for (let index = 0; index < 2; index++) {
      const start = performance.now();
      const result = await provider.sample(pids, records);
      results.push(result);
      cost.push(performance.now() - start);
      if (index === 0) await Bun.sleep(500);
    }
    const result = results.at(-1);
    expect(result).toBeDefined();
    expect(results.every(snapshot => snapshot.status.every(item => item.source === "windows-pdh" && typeof item.available === "boolean" && item.kind === "any"))).toBe(true);
    expect(result!.devices.every(device => /^luid:0x[\da-f]{8}_0x[\da-f]{8}$/.test(device.id) && ["gpu", "npu"].includes(device.kind))).toBe(true);
    expect(result!.devices.some(device => device.kind === "gpu" && device.id.startsWith("luid:"))).toBe(true);
    expect(result!.samples.every(sample => pids.has(sample.pid) && Number.isFinite(sample.memoryBytes ?? 0) && (sample.percent === undefined || Number.isFinite(sample.percent)))).toBe(true);
    console.info(`Windows PDH devices: ${JSON.stringify(result!.devices)}; per-process values: ${JSON.stringify(result!.samples.map(({ pid, deviceId, kind, engine, percent, memoryBytes }) => ({ pid, deviceId, kind, engine, percent, memoryBytes })))}`);
    console.info(`Windows PDH sample costs: ${cost.map(value => `${value.toFixed(2)} ms`).join(", ")}`);
  } finally { provider.close?.(); }
}, 30_000);
