import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_ADMISSION_POLICY, ResourcePolicyGuard, loadAdmissionPolicy, parseAdmissionPolicy, saveAdmissionPolicy } from "../src/policy.js";
import { FleetError } from "../src/fleet-errors.js";
import type { AcceleratorKind, AcceleratorSnapshot, AdmissionPolicy } from "../src/types.js";
const IS_WINDOWS = process.platform === "win32";
let stateDir: string;
let previousStateDir: string | undefined;
beforeEach(() => { previousStateDir = process.env.AGTOP_STATE_DIR; stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-policy-")); process.env.AGTOP_STATE_DIR = stateDir; });
afterEach(() => { if (previousStateDir === undefined) delete process.env.AGTOP_STATE_DIR; else process.env.AGTOP_STATE_DIR = previousStateDir; fs.rmSync(stateDir, { recursive: true, force: true }); });
function policy(overrides: Partial<AdmissionPolicy> = {}): AdmissionPolicy {
  return { ...DEFAULT_ADMISSION_POLICY, ...overrides, harnessLimits: { ...DEFAULT_ADMISSION_POLICY.harnessLimits, ...overrides.harnessLimits } };
}
function snapshot(devices: Array<{ kind: AcceleratorKind; utilizationPercent?: number }>): AcceleratorSnapshot {
  return { devices: devices.map((device, index) => ({ id: `${device.kind}-${index}`, ...device })), status: [], sampledAt: 0 };
}
function harness(initial: { gpu?: number; npu?: number; free?: number } = {}) {
  const values = { gpu: initial.gpu, npu: initial.npu, free: initial.free ?? 10_000 };
  const devices = (): Array<{ kind: AcceleratorKind; utilizationPercent?: number }> => {
    const list: Array<{ kind: AcceleratorKind; utilizationPercent?: number }> = [];
    if (values.gpu !== undefined) list.push({ kind: "gpu", utilizationPercent: values.gpu });
    if (values.npu !== undefined) list.push({ kind: "npu", utilizationPercent: values.npu });
    return list;
  };
  const guard = new ResourcePolicyGuard(policy(), {
    accelerators: () => (devices().length === 0 ? undefined : snapshot(devices())), freeMemoryMb: () => values.free, now: () => 1_000,
  });
  return { values, guard };
}
function failure(fn: () => unknown): FleetError {
  try { fn(); } catch (error) { expect(error).toBeInstanceOf(FleetError); return error as FleetError; }
  throw new Error("expected FleetError");
}
const policyFile = (): string => path.join(stateDir, "fleet", "policy.json");
function writePolicyFile(text: string): void {
  fs.mkdirSync(path.dirname(policyFile()), { recursive: true });
  fs.writeFileSync(policyFile(), text);
}

describe("admission policy", () => {
  test("DEFAULT_ADMISSION_POLICY matches contracts 2.5", () => {
    expect(DEFAULT_ADMISSION_POLICY).toEqual({
      maxRunning: 8, maxRunningPerPeer: 4, maxRunningPerHarness: 4, harnessLimits: {}, maxQueued: 200,
      gpuBusyPercent: 85, gpuResumePercent: 70, npuBusyPercent: 85, npuResumePercent: 70,
      minFreeMemoryMb: 1024, resumeFreeMemoryMb: 1536,
      agingIntervalMs: 30_000, agingStep: 1, agingMaxBoost: 50, defaultLeaseTtlMs: 600_000, pollMs: 1000,
    });
  });
  test("parse accepts a detached copy, rejects unknown and missing fields and non-objects", () => {
    const parsed = parseAdmissionPolicy(policy({ maxRunning: 12, harnessLimits: { opencode: 2 } }));
    expect(parsed).toEqual(policy({ maxRunning: 12, harnessLimits: { opencode: 2 } }));
    expect(parsed).not.toBe(DEFAULT_ADMISSION_POLICY);
    const unknown = failure(() => parseAdmissionPolicy({ ...policy(), firstUnknown: 1, secondUnknown: 2 }));
    expect(unknown.code).toBe("E_INVALID_REQUEST");
    expect(unknown.details?.field).toBe("firstUnknown");
    const missing = policy();
    delete (missing as Partial<AdmissionPolicy>).pollMs;
    expect(failure(() => parseAdmissionPolicy(missing)).details?.field).toBe("pollMs");
    expect(failure(() => parseAdmissionPolicy(null)).code).toBe("E_INVALID_REQUEST");
    expect(failure(() => parseAdmissionPolicy([])).code).toBe("E_INVALID_REQUEST");
  });
  test("non-integer and out-of-range values name their field", () => {
    const cases: Array<[string, unknown]> = [
      ["maxRunning", 0], ["maxRunning", 257], ["maxRunning", 1.5], ["maxRunningPerPeer", 0], ["maxRunningPerHarness", 257],
      ["maxQueued", 0], ["maxQueued", 10_001], ["gpuBusyPercent", 0], ["gpuBusyPercent", 101], ["gpuResumePercent", 0],
      ["npuBusyPercent", 101], ["npuResumePercent", 0], ["minFreeMemoryMb", -1], ["minFreeMemoryMb", 1_048_577],
      ["resumeFreeMemoryMb", 1_048_577], ["agingIntervalMs", 999], ["agingIntervalMs", 3_600_001], ["agingStep", -1],
      ["agingStep", 101], ["agingMaxBoost", -1], ["agingMaxBoost", 201], ["defaultLeaseTtlMs", 9_999],
      ["defaultLeaseTtlMs", 86_400_001], ["pollMs", 249], ["pollMs", 60_001],
    ];
    for (const [field, value] of cases) {
      const error = failure(() => parseAdmissionPolicy({ ...policy(), [field]: value }));
      expect(error.code).toBe("E_INVALID_REQUEST");
      expect(error.details?.field).toBe(field);
    }
  });
  test("resume thresholds, memory resume and harnessLimits are validated", () => {
    expect(failure(() => parseAdmissionPolicy(policy({ gpuResumePercent: 85 }))).details?.field).toBe("gpuResumePercent");
    expect(failure(() => parseAdmissionPolicy(policy({ npuResumePercent: 90 }))).details?.field).toBe("npuResumePercent");
    expect(failure(() => parseAdmissionPolicy(policy({ minFreeMemoryMb: 1024, resumeFreeMemoryMb: 1023 }))).details?.field).toBe("resumeFreeMemoryMb");
    for (const harnessLimits of [{ opencode: 0 }, { opencode: 257 }, { opencode: 2.5 }, [1], null]) {
      const error = failure(() => parseAdmissionPolicy({ ...policy(), harnessLimits }));
      expect(error.code).toBe("E_INVALID_REQUEST");
      expect(error.details?.field).toBe("harnessLimits");
    }
  });
});

describe("ResourcePolicyGuard", () => {
  test("GPU and NPU close at busy, stay closed between thresholds, open at resume", () => {
    const gpu = harness({ gpu: 95 });
    expect(gpu.guard.sample()).toEqual([{ rule: "gpu-busy", decision: "defer", measured: 95, threshold: 85 }]);
    expect(gpu.guard.state()[0]).toEqual({ rule: "gpu-busy", closed: true, measured: 95, changedAt: new Date(1_000).toISOString() });
    gpu.values.gpu = 80;
    expect(gpu.guard.sample()).toEqual([]);
    gpu.values.gpu = 85;
    expect(gpu.guard.sample()).toEqual([]);
    expect(gpu.guard.state()[0].closed).toBe(true);
    gpu.values.gpu = 70;
    expect(gpu.guard.sample()).toEqual([{ rule: "gpu-busy", decision: "resume", measured: 70, threshold: 70 }]);
    gpu.values.gpu = 60;
    expect(gpu.guard.sample()).toEqual([]);
    const npu = harness({ npu: 90 });
    expect(npu.guard.sample()[0]).toMatchObject({ rule: "npu-busy", decision: "defer", measured: 90, threshold: 85 });
    npu.values.npu = 75;
    expect(npu.guard.sample()).toEqual([]);
    npu.values.npu = 69;
    expect(npu.guard.sample()[0]).toMatchObject({ rule: "npu-busy", decision: "resume", measured: 69, threshold: 70 });
  });
  test("memory closes below min, stays closed between thresholds, opens at resume", () => {
    const { values, guard } = harness({ free: 1000 });
    expect(guard.sample()).toEqual([{ rule: "memory-low", decision: "defer", measured: 1000, threshold: 1024 }]);
    expect(guard.state()[2]).toMatchObject({ rule: "memory-low", closed: true, measured: 1000 });
    values.free = 1200;
    expect(guard.sample()).toEqual([]);
    expect(guard.state()[2].closed).toBe(true);
    values.free = 1536;
    expect(guard.sample()).toEqual([{ rule: "memory-low", decision: "resume", measured: 1536, threshold: 1536 }]);
    expect(guard.state()[2].closed).toBe(false);
    values.free = 3000;
    expect(guard.sample()).toEqual([]);
  });
  test("a null measurement opens a closed guard; other kinds and non-numeric values are ignored", () => {
    const { values, guard } = harness({ gpu: 99 });
    expect(guard.sample()[0]).toMatchObject({ rule: "gpu-busy", decision: "defer" });
    values.gpu = undefined;
    expect(guard.sample()[0]).toEqual({ rule: "gpu-busy", decision: "resume", measured: null, threshold: 70 });
    expect(guard.state()[0]).toMatchObject({ rule: "gpu-busy", closed: false, measured: null });
    const offKind = harness({ npu: 10 });
    expect(offKind.guard.sample()).toEqual([]);
    expect(offKind.guard.state()[0]).toMatchObject({ rule: "gpu-busy", closed: false, measured: null });
    const multi = new ResourcePolicyGuard(policy(), {
      accelerators: () => snapshot([{ kind: "gpu", utilizationPercent: 40 }, { kind: "gpu", utilizationPercent: 92 }, { kind: "gpu", utilizationPercent: 10 }, { kind: "gpu" }]),
      freeMemoryMb: () => 10_000, now: () => 0,
    });
    expect(multi.sample()[0]).toMatchObject({ rule: "gpu-busy", decision: "defer", measured: 92 });
  });
  test("before the first sample every guard is open; evaluate blocks only matching kinds", () => {
    const { values, guard } = harness({ gpu: 95, npu: 95 });
    expect(guard.state().map((state) => state.closed)).toEqual([false, false, false]);
    expect(guard.evaluate({ gpu: true, npu: true, memoryMb: 1_000_000 })).toEqual([]);
    guard.sample();
    expect(guard.evaluate({})).toEqual([]);
    expect(guard.evaluate({ gpu: true })).toEqual([{ rule: "gpu-busy", measured: 95, threshold: 85 }]);
    expect(guard.evaluate({ npu: true })).toEqual([{ rule: "npu-busy", measured: 95, threshold: 85 }]);
    expect(guard.evaluate({ gpu: true, npu: true })).toEqual([
      { rule: "gpu-busy", measured: 95, threshold: 85 }, { rule: "npu-busy", measured: 95, threshold: 85 },
    ]);
    values.gpu = 10;
    values.npu = 10;
    guard.sample();
    expect(guard.evaluate({ gpu: true, npu: true })).toEqual([]);
  });
  test("memoryMb arithmetic and a closed memory guard", () => {
    const open = harness({ free: 2000 });
    open.guard.sample();
    expect(open.guard.evaluate({})).toEqual([]);
    expect(open.guard.evaluate({ memoryMb: 500 })).toEqual([]);
    expect(open.guard.evaluate({ memoryMb: 1500 })).toEqual([{ rule: "memory-low", measured: 2000, threshold: 1024 + 1500 }]);
    expect(open.guard.evaluate({ gpu: true, memoryMb: 2500 })).toEqual([{ rule: "memory-low", measured: 2000, threshold: 1024 + 2500 }]);
    const closed = harness({ free: 500 });
    closed.guard.sample();
    for (const request of [{}, { gpu: true }]) {
      expect(closed.guard.evaluate(request)).toEqual([{ rule: "memory-low", measured: 500, threshold: 1024 }]);
    }
    expect(closed.guard.evaluate({ memoryMb: 10 })).toEqual([
      { rule: "memory-low", measured: 500, threshold: 1024 },
      { rule: "memory-low", measured: 500, threshold: 1024 + 10 },
    ]);
  });
  test("setPolicy changes the thresholds used by the next sample", () => {
    const { values, guard } = harness({ gpu: 60 });
    guard.sample();
    expect(guard.state()[0].closed).toBe(false);
    guard.setPolicy(policy({ gpuBusyPercent: 50, gpuResumePercent: 40 }));
    values.gpu = 55;
    expect(guard.sample()[0]).toMatchObject({ rule: "gpu-busy", decision: "defer", threshold: 50 });
  });
});
describe("AdmissionPolicy file", () => {
  test("defaults when absent, merge of a partial file, round trip and mode 0600", () => {
    expect(loadAdmissionPolicy()).toEqual(DEFAULT_ADMISSION_POLICY);
    writePolicyFile(JSON.stringify({ maxRunning: 3, harnessLimits: { opencode: 2 } }));
    expect(loadAdmissionPolicy()).toEqual(policy({ maxRunning: 3, harnessLimits: { opencode: 2 } }));
    const saved = policy({ maxRunning: 12, pollMs: 500 });
    saveAdmissionPolicy(saved);
    expect(loadAdmissionPolicy()).toEqual(saved);
    if (!IS_WINDOWS) expect(fs.statSync(policyFile()).mode & 0o777).toBe(0o600);
  });
  test("invalid JSON and invalid values are rejected instead of falling back", () => {
    writePolicyFile("{not json");
    expect(failure(() => loadAdmissionPolicy()).code).toBe("E_INVALID_REQUEST");
    writePolicyFile(JSON.stringify({ maxRunning: 0 }));
    const rangeError = failure(() => loadAdmissionPolicy());
    expect(rangeError.code).toBe("E_INVALID_REQUEST");
    expect(rangeError.details?.field).toBe("maxRunning");
    writePolicyFile(JSON.stringify({ surprise: true }));
    const unknownError = failure(() => loadAdmissionPolicy());
    expect(unknownError.code).toBe("E_INVALID_REQUEST");
    expect(unknownError.details?.field).toBe("surprise");
  });
  test("validates before writing", () => {
    expect(() => saveAdmissionPolicy(policy({ maxRunning: 0 }))).toThrow(FleetError);
    expect(fs.existsSync(policyFile())).toBe(false);
  });
});
