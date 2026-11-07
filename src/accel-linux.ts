import { promises as fs } from "node:fs";
import type { AcceleratorDevice, AcceleratorStatus, RawOsProcess } from "./types.js";
import type { AcceleratorProvider, RawEngineSample } from "./accelerators.js";

type MemoryField = { region: string; bytes: number; type: "resident" | "total" | "memory" };
export interface DrmFdinfo {
  driver?: string;
  pdev?: string;
  clientId?: string;
  engines: Map<string, bigint>;
  capacities: Map<string, number>;
  memory: MemoryField[];
}

/** Parse standardized DRM fdinfo counters. Unknown and malformed fields are ignored. */
export function parseDrmFdinfo(text: string): DrmFdinfo {
  const result: DrmFdinfo = { engines: new Map(), capacities: new Map(), memory: [] };
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([^:]+):\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    if (key === "drm-driver") { if (value) result.driver = value; continue; }
    if (key === "drm-pdev") { if (value) result.pdev = value; continue; }
    if (key === "drm-client-id") { if (/^\d+$/.test(value)) result.clientId = value; continue; }
    let field = /^drm-engine-capacity-(.+)$/.exec(key);
    if (field) { if (/^\d+$/.test(value) && Number(value) > 0) result.capacities.set(field[1], Number(value)); continue; }
    field = /^drm-engine-(.+)$/.exec(key);
    if (field) {
      const v = /^(\d+)\s+ns$/.exec(value);
      if (v) result.engines.set(field[1], BigInt(v[1]));
      continue;
    }
    field = /^drm-(resident|total|memory)-(.+)$/.exec(key);
    if (!field) continue;
    const v = /^(\d+)(?:\s+(KiB|MiB))?$/.exec(value);
    if (!v) continue;
    const multiplier = v[2] === "KiB" ? 1024 : v[2] === "MiB" ? 1024 ** 2 : 1;
    result.memory.push({ type: field[1] as MemoryField["type"], region: field[2], bytes: Number(v[1]) * multiplier });
  }
  return result;
}

export interface LinuxAccelFs {
  readdir(path: string): Promise<string[]>;
  readlink(path: string): Promise<string>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
}
const nodeFs: LinuxAccelFs = {
  readdir: path => fs.readdir(path),
  readlink: path => fs.readlink(path),
  readFile: (path, encoding) => fs.readFile(path, encoding),
};
function code(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }
function vendorFor(driver: string): string | undefined {
  if (/^(?:amdgpu|amdxdna)/i.test(driver)) return "amd";
  if (/^(?:i915|xe|ivpu|intel_vpu)/i.test(driver)) return "intel";
  if (/^(?:nouveau|nova)/i.test(driver)) return "nvidia";
  if (/^msm/i.test(driver)) return "qualcomm";
  if (/^(?:panfrost|panthor)/i.test(driver)) return "arm";
  return undefined;
}
function isNpu(driver: string, path: string): boolean {
  return path.startsWith("/dev/accel/") || /^(?:amdxdna|amdxdna_accel_driver|ivpu|intel_vpu)$/i.test(driver);
}
function memoryFor(info: DrmFdinfo): number | undefined {
  for (const region of ["vram", "local"]) {
    const fields = info.memory.filter(item => item.region.toLowerCase() === region);
    const resident = fields.find(item => item.type === "resident") ?? fields.find(item => item.type === "memory");
    const total = fields.find(item => item.type === "total");
    if (resident ?? total) return (resident ?? total)!.bytes;
  }
  return undefined;
}
function errno(error: unknown, codes: string[]): boolean { return codes.includes(code(error) ?? ""); }

export function createProvider(injectedFs: LinuxAccelFs): AcceleratorProvider;
export function createProvider(): AcceleratorProvider | undefined;
export function createProvider(injectedFs?: LinuxAccelFs): AcceleratorProvider | undefined {
  if (!injectedFs && process.platform !== "linux") return undefined;
  const providerFs = injectedFs ?? nodeFs;
  return {
    source: "linux-drm-fdinfo",
    async sample(pids: ReadonlySet<number>, _processes: ReadonlyMap<number, RawOsProcess>) {
      const samples: RawEngineSample[] = [];
      const devices = new Map<string, AcceleratorDevice>();
      let permissionDenied = false;
      let foundFd = false;
      for (const pid of pids) {
        let fds: string[];
        try { fds = await providerFs.readdir(`/proc/${pid}/fd`); }
        catch (error) {
          if (errno(error, ["EACCES", "EPERM"])) permissionDenied = true;
          continue;
        }
        let deniedPid = false;
        const pidSamples: RawEngineSample[] = [];
        const seenClients = new Set<string>();
        for (const fd of fds) {
          let target: string;
          try { target = await providerFs.readlink(`/proc/${pid}/fd/${fd}`); }
          catch (error) { if (errno(error, ["EACCES", "EPERM"])) deniedPid = true; continue; }
          if (!target.startsWith("/dev/dri/") && !target.startsWith("/dev/accel/")) continue;
          foundFd = true;
          let text: string;
          try { text = await providerFs.readFile(`/proc/${pid}/fdinfo/${fd}`, "utf8"); }
          catch (error) { if (errno(error, ["EACCES", "EPERM"])) deniedPid = true; continue; }
          const info = parseDrmFdinfo(text);
          if (!info.driver || !info.pdev) continue;
          const kind = isNpu(info.driver, target) ? "npu" : "gpu";
          const deviceId = `drm:${info.pdev}`;
          devices.set(deviceId, { id: deviceId, kind, name: `${info.driver} ${info.pdev}`, ...(vendorFor(info.driver) ? { vendor: vendorFor(info.driver) } : {}) });
          if (!info.clientId) continue;
          const clientKey = `${info.pdev}:${info.clientId}`;
          if (seenClients.has(clientKey)) continue;
          seenClients.add(clientKey);
          const memoryBytes = memoryFor(info);
          const engines = [...info.engines.entries()];
          if (!engines.length) {
            if (memoryBytes !== undefined) pidSamples.push({ pid, deviceId, kind, engine: "memory", memoryBytes, clientKey });
          } else {
            for (let i = 0; i < engines.length; i++) {
              const [engine, counter] = engines[i];
              const capacity = info.capacities.get(engine) ?? 1;
              pidSamples.push({ pid, deviceId, kind, engine, busyNs: counter / BigInt(capacity), clientKey,
                ...(i === 0 && memoryBytes !== undefined ? { memoryBytes } : {}) });
            }
          }
        }
        if (deniedPid) permissionDenied = true;
        else samples.push(...pidSamples);
      }
      const statuses: AcceleratorStatus[] = [];
      if (permissionDenied) statuses.push({ source: "linux-drm-fdinfo", kind: "any", available: true, reason: "permission-denied", message: "Some processes belong to other users; their GPU usage is not visible." });
      if (!foundFd) {
        const hasDeviceNodes = await hasNodes(providerFs, "/dev/dri") || await hasNodes(providerFs, "/dev/accel");
        if (!hasDeviceNodes) statuses.push({ source: "linux-drm-fdinfo", kind: "any", available: false, reason: "no-devices" });
        else statuses.push({ source: "linux-drm-fdinfo", kind: "any", available: true });
      }
      if ([...devices.values()].some(device => device.kind === "npu" && /^(?:ivpu|intel_vpu)$/i.test(device.name ?? ""))) {
        statuses.push({ source: "linux-drm-fdinfo", kind: "npu", available: true, message: "Engine time is not exposed by this driver." });
      }
      return { samples, devices: [...devices.values()], status: statuses };
    },
  };
}

async function hasNodes(injectedFs: LinuxAccelFs, path: string): Promise<boolean> {
  try { return (await injectedFs.readdir(path)).length > 0; } catch { return false; }
}
