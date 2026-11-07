import type {
  AcceleratorDevice, AcceleratorKind, AcceleratorSnapshot, AcceleratorSource, AcceleratorStatus,
  AcceleratorUsage, AgentProcessTree, RawOsProcess,
} from "./types.js";

export interface RawEngineSample {
  pid: number;
  startTime?: string;
  deviceId: string;
  kind: AcceleratorKind;
  engine: string;
  busyNs?: bigint;
  percent?: number;
  memoryBytes?: number;
  clientKey?: string;
}

export interface AcceleratorProvider {
  readonly source: AcceleratorSource;
  sample(pids: ReadonlySet<number>, processes: ReadonlyMap<number, RawOsProcess>): Promise<{
    samples: RawEngineSample[];
    devices: AcceleratorDevice[];
    status: AcceleratorStatus[];
  }>;
  close?(): void;
}

type ProviderLoad = { providers: AcceleratorProvider[]; status: AcceleratorStatus[] };
let latestSnapshot: AcceleratorSnapshot | undefined;

/** Returns the most recent completed accelerator sample, if sampling has run. */
export function getAcceleratorSnapshot(): AcceleratorSnapshot | undefined { return latestSnapshot; }

const sourceFor: Record<string, AcceleratorSource> = {
  "./accel-linux.js": "linux-drm-fdinfo", "./accel-nvml.js": "nvml",
  "./accel-windows.js": "windows-pdh", "./accel-darwin.js": "darwin-iokit",
};

/** Load platform providers only when the first sample is requested. */
export async function providersFor(platform: string): Promise<ProviderLoad> {
  const modules: string[] = platform === "linux" ? ["./accel-linux.js", "./accel-nvml.js"]
    : platform === "win32" ? ["./accel-windows.js"]
      : platform === "darwin" ? ["./accel-darwin.js"] : [];
  const providers: AcceleratorProvider[] = [];
  const status: AcceleratorStatus[] = [];
  await Promise.all(modules.map(async specifier => {
    try {
      const mod = await import(specifier) as { createProvider(): AcceleratorProvider | undefined };
      const provider = mod.createProvider();
      if (provider) providers.push(provider);
    } catch {
      status.push({ source: sourceFor[specifier], kind: "any", available: false, reason: "load-failed", message: "Accelerator provider could not be loaded." });
    }
  }));
  return { providers, status };
}

type PreviousCounter = { busyNs: bigint; at: number };
function round1(value: number): number { return Math.round(value * 10) / 10; }
function clamp(value: number): number { return Math.max(0, Math.min(100, value)); }

export class AcceleratorSampler {
  private providers: AcceleratorProvider[];
  private providerLoadStatus: AcceleratorStatus[];
  private readonly previous = new Map<string, PreviousCounter>();
  private constructorPromise?: Promise<void>;

  constructor(providers: AcceleratorProvider[] = [], loadStatus: AcceleratorStatus[] = []) {
    this.providers = providers;
    this.providerLoadStatus = loadStatus;
  }

  private async ensureProviders(): Promise<void> {
    if (!this.constructorPromise) this.constructorPromise = providersFor(process.platform).then(result => {
      if (!this.providers.length) this.providers = result.providers;
      this.providerLoadStatus = [...this.providerLoadStatus, ...result.status];
    });
    await this.constructorPromise;
  }

  async sample(trees: AgentProcessTree[], at = performance.now()): Promise<AcceleratorSnapshot> {
    const disabled = process.env.AGTOP_ACCELERATORS === "0";
    if (disabled) {
      for (const tree of trees) {
        delete tree.gpuPercent; delete tree.npuPercent; delete tree.gpuMemoryMb;
        for (const proc of tree.processes) delete proc.accelerators;
      }
      this.previous.clear();
      const snapshot: AcceleratorSnapshot = { devices: [], status: [{ source: "none", kind: "any", available: false, reason: "disabled" }], sampledAt: at };
      latestSnapshot = snapshot;
      return snapshot;
    }

    await this.ensureProviders();
    const processes = new Map<number, RawOsProcess>();
    for (const tree of trees) for (const proc of tree.processes) processes.set(proc.pid, proc);
    const pids = new Set(processes.keys());
    const collected = await Promise.all(this.providers.map(async provider => {
      try { return { provider, result: await provider.sample(pids, processes) }; }
      catch { return { provider, error: true as const }; }
    }));

    const statuses = [...this.providerLoadStatus];
    const devices = new Map<string, AcceleratorDevice>();
    const raw: RawEngineSample[] = [];
    for (const item of collected) {
      if ("error" in item) {
        statuses.push({ source: item.provider.source, kind: "any", available: false, reason: "error", message: "Accelerator provider sampling failed." });
        continue;
      }
      raw.push(...item.result.samples.filter(sample => pids.has(sample.pid)));
      for (const device of item.result.devices) devices.set(device.id, device);
      statuses.push(...item.result.status);
    }

    // Resolve shared client keys to one in-tree PID while preserving distinct engines.
    const owner = new Map<string, number>();
    for (const sample of raw) if (sample.clientKey) owner.set(sample.clientKey, Math.min(owner.get(sample.clientKey) ?? sample.pid, sample.pid));
    const chosen = new Map<string, RawEngineSample>();
    for (const sample of raw) {
      if (sample.clientKey && owner.get(sample.clientKey) !== sample.pid) continue;
      const startTime = sample.startTime ?? processes.get(sample.pid)?.startTime ?? "";
      const key = `${sample.pid}|${startTime}|${sample.deviceId}|${sample.engine}|${sample.clientKey ?? ""}`;
      const old = chosen.get(key);
      if (!old || (sample.memoryBytes ?? -1) > (old.memoryBytes ?? -1)) chosen.set(key, sample);
    }

    const usageByPid = new Map<number, Map<string, { kind: AcceleratorKind; engineValues: Map<string, number> }>>();
    const memoryByPidDevice = new Map<number, Map<string, Map<string, number>>>();
    const liveKeys = new Set<string>();
    for (const [key, sample] of chosen) {
      liveKeys.add(key);
      const process = processes.get(sample.pid)!;
      const startTime = sample.startTime ?? process.startTime;
      let utilization: number | undefined;
      if (sample.percent !== undefined && Number.isFinite(sample.percent)) utilization = clamp(sample.percent);
      else if (sample.busyNs !== undefined) {
        const prev = this.previous.get(key);
        if (prev && sample.busyNs >= prev.busyNs && at > prev.at) {
          utilization = Number(sample.busyNs - prev.busyNs) / ((at - prev.at) * 1e6) * 100;
        }
        this.previous.set(key, { busyNs: sample.busyNs, at });
      }
      let byDevice = usageByPid.get(sample.pid);
      if (!byDevice) usageByPid.set(sample.pid, byDevice = new Map());
      let entry = byDevice.get(sample.deviceId);
      if (!entry) byDevice.set(sample.deviceId, entry = { kind: sample.kind, engineValues: new Map() });
      if (utilization !== undefined) entry.engineValues.set(sample.engine, utilization);
      if (sample.memoryBytes !== undefined && Number.isFinite(sample.memoryBytes)) {
        const memKey = sample.clientKey ? `${sample.deviceId}|${sample.clientKey}` : `${sample.deviceId}|${sample.engine}|${sample.pid}|${startTime}`;
        let byProcess = memoryByPidDevice.get(sample.pid); if (!byProcess) memoryByPidDevice.set(sample.pid, byProcess = new Map());
        let clients = byProcess.get(sample.deviceId); if (!clients) byProcess.set(sample.deviceId, clients = new Map());
        const priorMemory = clients.get(memKey);
        if (priorMemory === undefined || sample.memoryBytes > priorMemory) clients.set(memKey, sample.memoryBytes);
      }
    }

    // Prune disappeared PIDs and stale identities; a changed startTime naturally gets a new key.
    for (const key of this.previous.keys()) if (!liveKeys.has(key) || !pids.has(Number(key.split("|", 1)[0]))) this.previous.delete(key);

    for (const tree of trees) {
      delete tree.gpuPercent; delete tree.npuPercent; delete tree.gpuMemoryMb;
      const treeByKind = new Map<AcceleratorKind, Map<string, number>>();
      let gpuMemory = 0; let hasGpuMemory = false;
      for (const proc of tree.processes) {
        delete proc.accelerators;
        const usages: AcceleratorUsage[] = [];
        const byDevice = usageByPid.get(proc.pid);
        for (const [deviceId, entry] of byDevice ?? []) {
          let maximum: number | undefined; let engine: string | undefined;
          for (const [name, value] of entry.engineValues) if (maximum === undefined || value > maximum) { maximum = value; engine = name; }
          const clientMemory = memoryByPidDevice.get(proc.pid)?.get(deviceId);
          const memTotal = [...(clientMemory?.values() ?? [])].reduce((sum, value) => sum + value, 0);
          const hasMemory = !!clientMemory?.size;
          if (maximum !== undefined || hasMemory) usages.push({ deviceId, kind: entry.kind,
            ...(maximum === undefined ? {} : { utilizationPercent: round1(clamp(maximum)), engine }),
            ...(hasMemory ? { memoryBytes: memTotal } : {}) });
          if (maximum !== undefined) {
            let perDevice = treeByKind.get(entry.kind); if (!perDevice) treeByKind.set(entry.kind, perDevice = new Map());
            perDevice.set(deviceId, (perDevice.get(deviceId) ?? 0) + round1(clamp(maximum)));
          }
          if (entry.kind === "gpu" && hasMemory) { gpuMemory += memTotal; hasGpuMemory = true; }
        }
        if (usages.length) proc.accelerators = usages;
      }
      const totalFor = (kind: AcceleratorKind) => {
        const values = [...(treeByKind.get(kind)?.values() ?? [])];
        return values.length ? round1(Math.max(...values.map(clamp))) : undefined;
      };
      const gpu = totalFor("gpu"); const npu = totalFor("npu");
      if (gpu !== undefined) tree.gpuPercent = gpu;
      if (npu !== undefined) tree.npuPercent = npu;
      if (hasGpuMemory) tree.gpuMemoryMb = gpuMemory / 1048576;
    }

    const snapshot: AcceleratorSnapshot = { devices: [...devices.values()], status: statuses, sampledAt: at };
    latestSnapshot = snapshot;
    return snapshot;
  }
}

export const accelSampler = new AcceleratorSampler();
