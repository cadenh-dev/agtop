import { describe, expect, test } from "bun:test";
import { createProvider, decodeNvmlProcessInfo, decodeNvmlUtilizationSample, NVML_ERROR_INSUFFICIENT_SIZE, NVML_ERROR_NOT_FOUND, NVML_ERROR_NOT_SUPPORTED, NVML_SUCCESS, type NvmlBinding, type NvmlProcessSample, type NvmlProcessInfo } from "../src/accel-nvml.js";

describe("NVML struct decoders", () => {
  test("decodes process utilization samples with x64 timestamp alignment", () => {
    const bytes = Buffer.alloc(32);
    bytes.writeUInt32LE(42, 0); bytes.writeBigUInt64LE(123456n, 8);
    bytes.writeUInt32LE(67, 16); bytes.writeUInt32LE(8, 20); bytes.writeUInt32LE(3, 24); bytes.writeUInt32LE(2, 28);
    expect(decodeNvmlUtilizationSample(bytes)).toEqual({ pid: 42, timestamp: 123456n, smUtil: 67, memUtil: 8, encUtil: 3, decUtil: 2 });
  });
  test("decodes v3 process memory records and rejects truncated input", () => {
    const bytes = Buffer.alloc(24);
    bytes.writeUInt32LE(99, 0); bytes.writeBigUInt64LE(512n * 1024n, 8); bytes.writeUInt32LE(4, 16); bytes.writeUInt32LE(5, 20);
    expect(decodeNvmlProcessInfo(bytes)).toEqual({ pid: 99, usedGpuMemory: 512n * 1024n, gpuInstanceId: 4, computeInstanceId: 5 });
    expect(() => decodeNvmlProcessInfo(Buffer.alloc(23))).toThrow(RangeError);
  });
});

function fakeBinding(config: { processCode?: number; supported?: boolean; samples?: NvmlProcessSample[]; compute?: NvmlProcessInfo[]; graphics?: NvmlProcessInfo[] } = {}): NvmlBinding {
  return {
    init: () => NVML_SUCCESS,
    deviceCount: () => ({ code: NVML_SUCCESS, count: 1 }),
    deviceAt: () => ({ code: NVML_SUCCESS, handle: "dev" }),
    uuid: () => ({ code: NVML_SUCCESS, value: "GPU-test" }),
    name: () => ({ code: NVML_SUCCESS, value: "Test NVIDIA" }),
    utilization: () => ({ code: NVML_SUCCESS, gpu: 25, memory: 30 }),
    processUtilization(_handle, _lastSeen, capacity) {
      if (config.supported === false) return { code: NVML_ERROR_NOT_SUPPORTED, count: 0, samples: [] };
      if (!capacity) return { code: NVML_ERROR_INSUFFICIENT_SIZE, count: config.samples?.length ?? 1, samples: [] };
      return { code: config.processCode ?? NVML_SUCCESS, count: config.samples?.length ?? 1, samples: config.samples ?? [{ pid: 10, timestamp: 900n, smUtil: 61, memUtil: 10, encUtil: 0, decUtil: 0 }] };
    },
    computeProcesses(_handle, capacity) {
      if (!capacity) return { code: NVML_ERROR_INSUFFICIENT_SIZE, count: config.compute?.length ?? 1, processes: [] };
      return { code: NVML_SUCCESS, count: config.compute?.length ?? 1, processes: config.compute ?? [{ pid: 10, usedGpuMemory: 4096n, gpuInstanceId: 0, computeInstanceId: 0 }] };
    },
    graphicsProcesses(_handle, capacity) {
      if (!capacity) return { code: NVML_ERROR_INSUFFICIENT_SIZE, count: config.graphics?.length ?? 0, processes: [] };
      return { code: NVML_SUCCESS, count: config.graphics?.length ?? 0, processes: config.graphics ?? [] };
    },
  };
}

describe("NVML provider", () => {
  test("reports device utilization and per-process compute samples", async () => {
    const provider = createProvider({ exists: async () => true, load: () => fakeBinding() });
    const result = await provider.sample(new Set([10]), new Map());
    expect(result.devices[0]).toMatchObject({ id: "nvml:GPU-test", name: "Test NVIDIA", vendor: "nvidia", utilizationPercent: 25 });
    expect(result.samples).toEqual([{ pid: 10, deviceId: "nvml:GPU-test", kind: "gpu", engine: "compute", percent: 61 }]);
  });
  test("NOT_SUPPORTED falls back to process memory and emits status", async () => {
    const provider = createProvider({ exists: async () => true, load: () => fakeBinding({ supported: false }) });
    const result = await provider.sample(new Set([10]), new Map());
    expect(result.samples).toEqual([{ pid: 10, deviceId: "nvml:GPU-test", kind: "gpu", engine: "memory", memoryBytes: 4096 }]);
    expect(result.status[0]).toMatchObject({ available: false, reason: "not-supported" });
  });
  test("NOT_FOUND means an empty utilization interval with no status", async () => {
    const provider = createProvider({ exists: async () => true, load: () => fakeBinding({ processCode: NVML_ERROR_NOT_FOUND }) });
    const result = await provider.sample(new Set([10]), new Map());
    expect(result.samples).toEqual([]);
    expect(result.status).toEqual([]);
  });
  test("emits only the newest utilization sample per PID and advances lastSeen", async () => {
    let observedLastSeen = -1n;
    const provider = createProvider({ exists: async () => true, load: () => {
      const binding = fakeBinding({ samples: [
        { pid: 10, timestamp: 100n, smUtil: 90, memUtil: 0, encUtil: 0, decUtil: 0 },
        { pid: 10, timestamp: 200n, smUtil: 10, memUtil: 0, encUtil: 0, decUtil: 0 },
      ] });
      const read = binding.processUtilization.bind(binding);
      binding.processUtilization = (handle, lastSeen, capacity) => { observedLastSeen = lastSeen; return read(handle, lastSeen, capacity); };
      return binding;
    } });
    const result = await provider.sample(new Set([10]), new Map());
    expect(result.samples).toEqual([{ pid: 10, deviceId: "nvml:GPU-test", kind: "gpu", engine: "compute", percent: 10 }]);
    await provider.sample(new Set([10]), new Map());
    expect(observedLastSeen).toBe(200n);
  });
  test("NOT_SUPPORTED merges compute and graphics process memory by PID", async () => {
    const provider = createProvider({ exists: async () => true, load: () => fakeBinding({ supported: false,
      compute: [{ pid: 10, usedGpuMemory: 4096n, gpuInstanceId: 0, computeInstanceId: 0 }],
      graphics: [{ pid: 10, usedGpuMemory: 8192n, gpuInstanceId: 0, computeInstanceId: 0 }, { pid: 11, usedGpuMemory: 2048n, gpuInstanceId: 0, computeInstanceId: 0 }],
    }) });
    const result = await provider.sample(new Set([10, 11]), new Map());
    expect(result.samples).toEqual([
      { pid: 10, deviceId: "nvml:GPU-test", kind: "gpu", engine: "memory", memoryBytes: 8192 },
      { pid: 11, deviceId: "nvml:GPU-test", kind: "gpu", engine: "memory", memoryBytes: 2048 },
    ]);
  });
  test("load failure is reported only when the NVIDIA control node exists", async () => {
    const absent = await createProvider({ exists: async () => false, load: () => { throw new Error("not loaded"); } }).sample(new Set(), new Map());
    const present = await createProvider({ exists: async () => true, load: () => { throw new Error("not loaded"); } }).sample(new Set(), new Map());
    expect(absent.status).toEqual([]);
    expect(present.status[0]).toMatchObject({ source: "nvml", available: false, reason: "load-failed" });
  });
});
