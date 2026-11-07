import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AcceleratorSampler, getAcceleratorSnapshot, type AcceleratorProvider, type RawEngineSample } from "../src/accelerators.js";
import type { AgentProcess, AgentProcessTree } from "../src/types.js";
import { listAgentTrees } from "../src/manager.js";

function processRecord(pid: number, startTime = `start-${pid}`): AgentProcess {
  return { pid, ppid: 0, name: `p${pid}`, cmdline: "", startTime, cpuSeconds: 0, cpuPercent: 0,
    memoryMb: 1, role: "agent", roleSource: "fallback", roleEvidence: "test" };
}
function tree(...processes: AgentProcess[]): AgentProcessTree {
  return { jobId: "job", harness: "claude-code", backend: "unknown", backendEvidence: "test", userOrPeer: "test",
    rootPid: processes[0]?.pid ?? 1, containmentMode: "passive-ppid", totalCpuPercent: 0, totalMemoryMb: 1,
    processes, roleCounts: { agent: processes.length } };
}
function provider(samples: RawEngineSample[] | (() => RawEngineSample[]), source: AcceleratorProvider["source"] = "linux-drm-fdinfo"): AcceleratorProvider {
  return { source, async sample() { return { samples: typeof samples === "function" ? samples() : samples, devices: [], status: [] }; } };
}

describe("accelerator sampling core", () => {
  test("busy counters need two samples and report delta over wall time", async () => {
    let busy = 10_000_000_000n;
    const sampler = new AcceleratorSampler([provider(() => [{ pid: 1, deviceId: "d0", kind: "gpu", engine: "compute", busyNs: busy }])]);
    const t = tree(processRecord(1));
    await sampler.sample([t], 1000);
    expect(t.processes[0].accelerators?.[0]?.utilizationPercent).toBeUndefined();
    busy += 250_000_000n;
    await sampler.sample([t], 1500);
    expect(t.processes[0].accelerators?.[0]?.utilizationPercent).toBe(50);
  });

  test("percent passes through; max engine, argmax, clamp and device memory sum", async () => {
    const samples: RawEngineSample[] = [
      { pid: 1, deviceId: "d0", kind: "gpu", engine: "3d", percent: 35.27, memoryBytes: 100 },
      { pid: 1, deviceId: "d0", kind: "gpu", engine: "compute", percent: 62.24, memoryBytes: 100 },
      { pid: 1, deviceId: "d1", kind: "gpu", engine: "copy", percent: 150 },
    ];
    const t = tree(processRecord(1)); const sampler = new AcceleratorSampler([provider(samples)]);
    await sampler.sample([t], 1000);
    expect(t.processes[0].accelerators).toEqual([
      { deviceId: "d0", kind: "gpu", utilizationPercent: 62.2, engine: "compute", memoryBytes: 200 },
      { deviceId: "d1", kind: "gpu", utilizationPercent: 100, engine: "copy" },
    ]);
  });

  test("same-engine collisions keep the greatest percent and memory", async () => {
    const t = tree(processRecord(1));
    await new AcceleratorSampler([provider([
      { pid: 1, deviceId: "d", kind: "gpu", engine: "3d", percent: 10, memoryBytes: 100 },
      { pid: 1, deviceId: "d", kind: "gpu", engine: "3d", percent: 80, memoryBytes: 50 },
    ])]).sample([t], 1000);
    expect(t.processes[0].accelerators?.[0]).toMatchObject({ utilizationPercent: 80, engine: "3d", memoryBytes: 100 });
  });

  test("timed-out providers do not block other results", async () => {
    const hung: AcceleratorProvider = { source: "nvml", sample: () => new Promise(() => {}) };
    const t = tree(processRecord(1));
    const snapshot = await new AcceleratorSampler([
      hung, provider([{ pid: 1, deviceId: "d", kind: "gpu", engine: "3d", percent: 42 }]),
    ], [], 20).sample([t], 1000);
    expect(snapshot.status).toContainEqual(expect.objectContaining({ source: "nvml", available: false, reason: "timeout", message: "Accelerator provider timed out." }));
    expect(t.processes[0].accelerators?.[0]?.utilizationPercent).toBe(42);
  });

  test("shared client key is attributed once to the lowest in-tree PID", async () => {
    const samples: RawEngineSample[] = [
      { pid: 2, deviceId: "d", kind: "gpu", engine: "compute", percent: 80, memoryBytes: 400, clientKey: "shared" },
      { pid: 1, deviceId: "d", kind: "gpu", engine: "compute", percent: 30, memoryBytes: 400, clientKey: "shared" },
    ];
    const t = tree(processRecord(1), processRecord(2)); await new AcceleratorSampler([provider(samples)]).sample([t], 1000);
    expect(t.processes[0].accelerators?.[0]?.utilizationPercent).toBe(30);
    expect(t.processes[0].accelerators?.[0]?.memoryBytes).toBe(400);
    expect(t.processes[1].accelerators).toBeUndefined();
  });

  test("counter reset and changed process start time do not produce utilization", async () => {
    let sample: RawEngineSample = { pid: 1, startTime: "old", deviceId: "d", kind: "gpu", engine: "gfx", busyNs: 5_000_000_000n };
    const t = tree(processRecord(1, "old")); const sampler = new AcceleratorSampler([provider(() => [sample])]);
    await sampler.sample([t], 1000);
    sample = { ...sample, busyNs: 4_000_000_000n };
    await sampler.sample([t], 2000);
    expect(t.processes[0].accelerators?.[0]?.utilizationPercent).toBeUndefined();
    sample = { ...sample, startTime: "new", busyNs: 9_000_000_000n };
    t.processes[0].startTime = "new";
    await sampler.sample([t], 3000);
    expect(t.processes[0].accelerators?.[0]?.utilizationPercent).toBeUndefined();
  });

  test("tree totals use max of clamped per-device sums and GPU memory is summed", async () => {
    const samples: RawEngineSample[] = [
      { pid: 1, deviceId: "a", kind: "gpu", engine: "3d", percent: 70, memoryBytes: 1024 * 1024 },
      { pid: 2, deviceId: "a", kind: "gpu", engine: "3d", percent: 60, memoryBytes: 2 * 1024 * 1024 },
      { pid: 1, deviceId: "b", kind: "gpu", engine: "3d", percent: 45 },
      { pid: 2, deviceId: "b", kind: "gpu", engine: "3d", percent: 35 },
      { pid: 1, deviceId: "n", kind: "npu", engine: "npu", percent: 20 },
    ];
    const t = tree(processRecord(1), processRecord(2)); await new AcceleratorSampler([provider(samples)]).sample([t], 1000);
    expect(t.gpuPercent).toBe(100);
    expect(t.npuPercent).toBe(20);
    expect(t.gpuMemoryMb).toBe(3);
  });

  test("a throwing provider yields error status and a snapshot", async () => {
    const failing: AcceleratorProvider = { source: "nvml", async sample() { throw new Error("failure"); } };
    const snapshot = await new AcceleratorSampler([failing]).sample([tree(processRecord(1))], 1234);
    expect(snapshot.sampledAt).toBe(1234);
    expect(snapshot.status).toContainEqual(expect.objectContaining({ source: "nvml", available: false, reason: "error" }));
    expect(getAcceleratorSnapshot()).toBe(snapshot);
  });

  test("AGTOP_ACCELERATORS=0 disables providers and reports disabled", async () => {
    const prior = process.env.AGTOP_ACCELERATORS;
    process.env.AGTOP_ACCELERATORS = "0";
    try {
      const snapshot = await new AcceleratorSampler([provider([{ pid: 1, deviceId: "d", kind: "gpu", engine: "3d", percent: 50 }])]).sample([tree(processRecord(1))], 55);
      expect(snapshot.status).toEqual([{ source: "none", kind: "any", available: false, reason: "disabled" }]);
      expect(snapshot.devices).toEqual([]);
    } finally { if (prior === undefined) delete process.env.AGTOP_ACCELERATORS; else process.env.AGTOP_ACCELERATORS = prior; }
  });

  test("imports core and empty platform stubs without native dependencies", async () => {
    const modules = await Promise.all(["../src/accel-linux.js", "../src/accel-nvml.js", "../src/accel-windows.js", "../src/accel-darwin.js"].map(path => import(path)));
    expect(modules.every(mod => typeof mod.createProvider === "function")).toBe(true);
    const code = readFileSync(new URL("../src/accelerators.ts", import.meta.url), "utf8") + modules.map((_, i) =>
      readFileSync(new URL(["../src/accel-linux.ts", "../src/accel-nvml.ts", "../src/accel-windows.ts", "../src/accel-darwin.ts"][i], import.meta.url), "utf8")).join("\n");
    expect(code).not.toMatch(/from\s+["']koffi["']|require\(["']koffi["']\)/);
  });

  test("literal provider imports are included in a Bun bundle", async () => {
    const outdir = mkdtempSync(join(tmpdir(), "agtop-accelerators-bundle-"));
    try {
      const result = await Bun.build({ entrypoints: [fileURLToPath(new URL("../src/accelerators.ts", import.meta.url))], target: "bun", outdir });
      expect(result.success).toBe(true);
      const bundle = result.outputs.map(output => readFileSync(output.path, "utf8")).join("\n");
      expect(bundle).toContain("// src/accel-windows.ts");
    } finally { rmSync(outdir, { recursive: true, force: true }); }
  });

  test("listAgentTrees remains available when no provider is installed", async () => {
    expect(await listAgentTrees()).toBeInstanceOf(Array);
  }, 30000);

  test("sampler overhead with fake provider stays below the 5 ms target", async () => {
    const t = tree(processRecord(1));
    const sampler = new AcceleratorSampler([provider([{ pid: 1, deviceId: "d", kind: "gpu", engine: "3d", percent: 20 }])]);
    await sampler.sample([t], 0); // warm the provider path
    const start = performance.now();
    for (let i = 1; i <= 200; i++) await sampler.sample([t], i);
    const averageMs = (performance.now() - start) / 200;
    console.log(`Fake-provider sampler overhead: ${averageMs.toFixed(4)} ms/snapshot (200 snapshots).`);
    expect(averageMs).toBeLessThan(5);
  });
});
