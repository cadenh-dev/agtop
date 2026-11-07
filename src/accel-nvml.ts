import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import type { AcceleratorDevice, AcceleratorStatus, RawOsProcess } from "./types.js";
import type { AcceleratorProvider, RawEngineSample } from "./accelerators.js";

export const NVML_SUCCESS = 0;
export const NVML_ERROR_NOT_FOUND = 6;
export const NVML_ERROR_INSUFFICIENT_SIZE = 7;
export const NVML_ERROR_NOT_SUPPORTED = 3;
const PROCESS_INFO_SIZE = 24;
const UTILIZATION_SAMPLE_SIZE = 32;

export interface NvmlUtilizationSample { pid: number; timestamp: bigint; smUtil: number; memUtil: number; encUtil: number; decUtil: number }
export interface NvmlProcessInfo { pid: number; usedGpuMemory: bigint; gpuInstanceId: number; computeInstanceId: number }

/** Decode nvmlProcessUtilizationSample_t (32 bytes on Linux x86_64). */
export function decodeNvmlUtilizationSample(buffer: Buffer, offset = 0): NvmlUtilizationSample {
  if (buffer.length - offset < UTILIZATION_SAMPLE_SIZE) throw new RangeError("NVML utilization sample is truncated");
  return { pid: buffer.readUInt32LE(offset), timestamp: buffer.readBigUInt64LE(offset + 8), smUtil: buffer.readUInt32LE(offset + 16),
    memUtil: buffer.readUInt32LE(offset + 20), encUtil: buffer.readUInt32LE(offset + 24), decUtil: buffer.readUInt32LE(offset + 28) };
}

/** Decode nvmlProcessInfo_v3_t: pid, aligned uint64 memory, and two instance ids (24 bytes). */
export function decodeNvmlProcessInfo(buffer: Buffer, offset = 0): NvmlProcessInfo {
  if (buffer.length - offset < PROCESS_INFO_SIZE) throw new RangeError("NVML process info is truncated");
  return { pid: buffer.readUInt32LE(offset), usedGpuMemory: buffer.readBigUInt64LE(offset + 8),
    gpuInstanceId: buffer.readUInt32LE(offset + 16), computeInstanceId: buffer.readUInt32LE(offset + 20) };
}

export interface NvmlProcessSample extends NvmlUtilizationSample {}
export interface NvmlBinding {
  init(): number;
  shutdown?(): void;
  deviceCount(): { code: number; count: number };
  deviceAt(index: number): { code: number; handle?: unknown };
  uuid(handle: unknown): { code: number; value?: string };
  name(handle: unknown): { code: number; value?: string };
  utilization(handle: unknown): { code: number; gpu?: number; memory?: number };
  processUtilization(handle: unknown, lastSeen: bigint, capacity?: number): { code: number; count: number; samples: NvmlProcessSample[] };
  computeProcesses(handle: unknown, capacity?: number): { code: number; count: number; processes: NvmlProcessInfo[] };
  graphicsProcesses(handle: unknown, capacity?: number): { code: number; count: number; processes: NvmlProcessInfo[] };
}
export interface NvmlProviderOptions {
  exists?: () => Promise<boolean>;
  load?: () => NvmlBinding;
}

function nativeBinding(): NvmlBinding {
  // Imported only after /dev/nvidiactl is found and the provider is sampled.
  const koffi = requireKoffi();
  const lib = koffi.load("libnvidia-ml.so.1");
  const nvmlUtil = koffi.struct("agtop_nvmlUtilization_t", { gpu: "uint32_t", memory: "uint32_t" });
  const get = (sig: string) => lib.func(sig) as (...args: any[]) => any;
  const init = get("int nvmlInit_v2(void)");
  const shutdown = get("int nvmlShutdown(void)");
  const getCount = get("int nvmlDeviceGetCount_v2(_Out_ uint32_t *count)");
  const getHandle = get("int nvmlDeviceGetHandleByIndex_v2(uint32_t index, _Out_ void **device)");
  const getUuid = get("int nvmlDeviceGetUUID(void *device, _Out_ char *uuid, uint32_t length)");
  const getName = get("int nvmlDeviceGetName(void *device, _Out_ char *name, uint32_t length)");
  const getUtil = get("int nvmlDeviceGetUtilizationRates(void *device, _Out_ agtop_nvmlUtilization_t *utilization)");
  const getProcUtil = get("int nvmlDeviceGetProcessUtilization(void *device, _Out_ uint8_t *samples, _Inout_ uint32_t *count, uint64_t lastSeenTimestamp)");
  const getCompute = get("int nvmlDeviceGetComputeRunningProcesses_v3(void *device, _Inout_ uint32_t *count, _Out_ uint8_t *infos)");
  const getGraphics = get("int nvmlDeviceGetGraphicsRunningProcesses_v3(void *device, _Inout_ uint32_t *count, _Out_ uint8_t *infos)");
  const readCString = (buf: Buffer) => buf.toString("utf8", 0, Math.max(0, buf.indexOf(0)));
  return {
    init: () => init(), shutdown: () => shutdown(),
    deviceCount() { const out = [0]; const code = getCount(out); return { code, count: out[0] }; },
    deviceAt(index) { const out = [null]; const code = getHandle(index, out); return { code, handle: out[0] }; },
    uuid(handle) { const buf = Buffer.alloc(96); const code = getUuid(handle, buf, buf.length); return { code, value: code === 0 ? readCString(buf) : undefined }; },
    name(handle) { const buf = Buffer.alloc(96); const code = getName(handle, buf, buf.length); return { code, value: code === 0 ? readCString(buf) : undefined }; },
    utilization(handle) { const out: { gpu?: number; memory?: number } = {}; const code = getUtil(handle, out); return { code, ...out }; },
    processUtilization(handle, lastSeen, capacity = 0) {
      const count = [capacity]; const buf = Buffer.alloc(Math.max(1, capacity) * UTILIZATION_SAMPLE_SIZE);
      const code = getProcUtil(handle, buf, count, lastSeen);
      const samples = Array.from({ length: code === 0 ? count[0] : 0 }, (_, i) => decodeNvmlUtilizationSample(buf, i * UTILIZATION_SAMPLE_SIZE));
      return { code, count: count[0], samples };
    },
    computeProcesses(handle, capacity = 0) {
      const count = [capacity]; const buf = Buffer.alloc(Math.max(1, capacity) * PROCESS_INFO_SIZE);
      const code = getCompute(handle, count, buf);
      const processes = Array.from({ length: code === 0 ? count[0] : 0 }, (_, i) => decodeNvmlProcessInfo(buf, i * PROCESS_INFO_SIZE));
      return { code, count: count[0], processes };
    },
    graphicsProcesses(handle, capacity = 0) {
      const count = [capacity]; const buf = Buffer.alloc(Math.max(1, capacity) * PROCESS_INFO_SIZE);
      const code = getGraphics(handle, count, buf);
      const processes = Array.from({ length: code === 0 ? count[0] : 0 }, (_, i) => decodeNvmlProcessInfo(buf, i * PROCESS_INFO_SIZE));
      return { code, count: count[0], processes };
    },
  };
}

// Avoid top-level native module work; require is available in Bun/Node ESM through createRequire.
let koffiCache: typeof import("koffi") | undefined;
function requireKoffi(): typeof import("koffi") {
  if (koffiCache) return koffiCache;
  // createRequire is reached only from sample(), so importing this provider remains side-effect free.
  koffiCache = createRequire(import.meta.url)("koffi") as typeof import("koffi");
  return koffiCache;
}

function loadFailureStatus(): AcceleratorStatus { return { source: "nvml", kind: "gpu", available: false, reason: "load-failed", message: "NVIDIA monitoring library could not be loaded." }; }
export function createProvider(options: NvmlProviderOptions): AcceleratorProvider;
export function createProvider(): AcceleratorProvider | undefined;
export function createProvider(options?: NvmlProviderOptions): AcceleratorProvider | undefined {
  if (!options && process.platform !== "linux") return undefined;
  options ??= {};
  const exists = options.exists ?? (async () => { try { await access("/dev/nvidiactl"); return true; } catch { return false; } });
  let binding: NvmlBinding | undefined;
  let loadAttempted = false;
  let initialized = false;
  const lastSeen = new Map<string, bigint>();
  return {
    source: "nvml",
    async sample(pids: ReadonlySet<number>, _processes: ReadonlyMap<number, RawOsProcess>) {
      if (!await exists()) return { samples: [], devices: [], status: [] };
      try {
        if (!loadAttempted) { loadAttempted = true; binding = (options.load ?? nativeBinding)(); }
        if (!binding) throw new Error("NVML binding unavailable");
      } catch { return { samples: [], devices: [], status: [loadFailureStatus()] }; }
      if (!initialized) {
        if (binding.init() !== NVML_SUCCESS) return { samples: [], devices: [], status: [{ source: "nvml", kind: "gpu", available: false, reason: "error", message: "NVIDIA monitoring initialization failed." }] };
        initialized = true;
      }
      const countResult = binding.deviceCount();
      if (countResult.code !== NVML_SUCCESS) return { samples: [], devices: [], status: [{ source: "nvml", kind: "gpu", available: false, reason: "error", message: "NVIDIA device enumeration failed." }] };
      const samples: RawEngineSample[] = [];
      const devices: AcceleratorDevice[] = [];
      const status: AcceleratorStatus[] = [];
      for (let i = 0; i < countResult.count; i++) {
        const got = binding.deviceAt(i);
        if (got.code !== NVML_SUCCESS || got.handle === undefined) continue;
        const handle = got.handle;
        const uuid = binding.uuid(handle);
        if (uuid.code !== NVML_SUCCESS || !uuid.value) continue;
        const deviceId = `nvml:${uuid.value}`;
        const name = binding.name(handle);
        const util = binding.utilization(handle);
        devices.push({ id: deviceId, kind: "gpu", ...(name.code === 0 && name.value ? { name: name.value } : {}), vendor: "nvidia",
          ...(util.code === 0 && util.gpu !== undefined ? { utilizationPercent: Math.max(0, Math.min(100, util.gpu)) } : {}) });
        const priorSeen = lastSeen.get(deviceId) ?? 0n;
        let procUtil = binding.processUtilization(handle, priorSeen);
        if (procUtil.code === NVML_ERROR_INSUFFICIENT_SIZE && procUtil.count > 0) procUtil = binding.processUtilization(handle, priorSeen, procUtil.count);
        if (procUtil.code === NVML_ERROR_NOT_SUPPORTED) {
          status.push({ source: "nvml", kind: "gpu", available: false, reason: "not-supported", message: "Per-process GPU utilization is not supported by this NVIDIA device." });
          const getFullProcesses = (read: NvmlBinding["computeProcesses"]) => {
            const initial = read.call(binding, handle);
            return initial.code === NVML_ERROR_INSUFFICIENT_SIZE && initial.count > 0 ? read.call(binding, handle, initial.count) : initial;
          };
          const compute = getFullProcesses(binding.computeProcesses);
          const graphics = getFullProcesses(binding.graphicsProcesses);
          const memoryByPid = new Map<number, bigint>();
          for (const result of [compute, graphics]) if (result.code === NVML_SUCCESS) for (const proc of result.processes) {
            if (!pids.has(proc.pid) || proc.usedGpuMemory >= 0xffffffffffffffffn) continue;
            if (proc.usedGpuMemory > (memoryByPid.get(proc.pid) ?? -1n)) memoryByPid.set(proc.pid, proc.usedGpuMemory);
          }
          for (const [pid, memoryBytes] of memoryByPid) samples.push({ pid, deviceId, kind: "gpu", engine: "memory", memoryBytes: Number(memoryBytes) });
        } else if (procUtil.code === NVML_SUCCESS) {
          const newestByPid = new Map<number, NvmlProcessSample>();
          let newestTimestamp = priorSeen;
          for (const sample of procUtil.samples) {
            if (sample.timestamp > newestTimestamp) newestTimestamp = sample.timestamp;
            const previous = newestByPid.get(sample.pid);
            if (!previous || sample.timestamp > previous.timestamp) newestByPid.set(sample.pid, sample);
          }
          if (newestTimestamp > priorSeen) lastSeen.set(deviceId, newestTimestamp);
          for (const sample of newestByPid.values()) if (pids.has(sample.pid))
            samples.push({ pid: sample.pid, deviceId, kind: "gpu", engine: "compute", percent: sample.smUtil });
        } else if (procUtil.code !== NVML_ERROR_NOT_FOUND) {
          status.push({ source: "nvml", kind: "gpu", available: false, reason: "error", message: "NVIDIA process utilization could not be read." });
        }
      }
      return { samples, devices, status };
    },
    close() { if (initialized) { binding?.shutdown?.(); initialized = false; } },
  };
}
