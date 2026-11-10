import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAcceleratorSnapshot } from "./accelerators.js";
import { fleetDir } from "./event-store.js";
import { FleetError } from "./fleet-errors.js";
import { ensurePrivateDir, writePrivateFileAtomic } from "./secure-fs.js";
import type { PolicyBlock } from "./queue.js";
import type { AcceleratorKind, AcceleratorSnapshot, AdmissionPolicy, GuardState, PolicyRule, ResourceRequest } from "./types.js";

export type { PolicyBlock } from "./queue.js";

/** The policy used when no fleet/policy.json override exists. Contracts 2.5. */
export const DEFAULT_ADMISSION_POLICY: AdmissionPolicy = {
  maxRunning: 8, maxRunningPerPeer: 4, maxRunningPerHarness: 4, harnessLimits: {}, maxQueued: 200,
  gpuBusyPercent: 85, gpuResumePercent: 70, npuBusyPercent: 85, npuResumePercent: 70, minFreeMemoryMb: 1024, resumeFreeMemoryMb: 1536,
  agingIntervalMs: 30_000, agingStep: 1, agingMaxBoost: 50, defaultLeaseTtlMs: 600_000, pollMs: 1000,
};

/** Integer fields and their contracts 2.5 ranges. */
const INT_RULES: Array<[field: string, min: number, max: number]> = [
  ["maxRunning", 1, 256], ["maxRunningPerPeer", 1, 256], ["maxRunningPerHarness", 1, 256], ["maxQueued", 1, 10_000],
  ["gpuBusyPercent", 1, 100], ["gpuResumePercent", 1, 100], ["npuBusyPercent", 1, 100], ["npuResumePercent", 1, 100],
  ["minFreeMemoryMb", 0, 1_048_576], ["resumeFreeMemoryMb", 0, 1_048_576], ["agingIntervalMs", 1000, 3_600_000],
  ["agingStep", 0, 100], ["agingMaxBoost", 0, 200], ["defaultLeaseTtlMs", 10_000, 86_400_000], ["pollMs", 250, 60_000],
];
const FIELD_SET = new Set([...INT_RULES.map(([field]) => field), "harnessLimits"]);

function invalid(message: string, field: string): FleetError {
  return new FleetError("E_INVALID_REQUEST", message, { field });
}
function intField(input: Record<string, unknown>, field: string, min: number, max: number): number {
  const value = input[field];
  if (!Object.hasOwn(input, field) || typeof value !== "number" || !Number.isInteger(value)) throw invalid(`AdmissionPolicy.${field} must be an integer.`, field);
  if (value < min || value > max) throw invalid(`AdmissionPolicy.${field} must be between ${min} and ${max}.`, field);
  return value;
}
function limitsField(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("AdmissionPolicy.harnessLimits must be an object.", "harnessLimits");
  const limits: Record<string, number> = {};
  for (const [harness, limit] of Object.entries(value)) {
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 256) {
      throw invalid(`AdmissionPolicy.harnessLimits.${harness} must be an integer between 1 and 256.`, "harnessLimits");
    }
    limits[harness] = limit;
  }
  return limits;
}

/** Returns a complete, validated policy or throws FleetError("E_INVALID_REQUEST", …, { field }). */
export function parseAdmissionPolicy(value: unknown): AdmissionPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("AdmissionPolicy must be an object.", "policy");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!FIELD_SET.has(key)) throw invalid(`Unknown admission policy property: ${key}.`, key);
  if (!Object.hasOwn(input, "harnessLimits")) throw invalid("AdmissionPolicy.harnessLimits is required.", "harnessLimits");
  const values: Record<string, number> = {};
  for (const [field, min, max] of INT_RULES) values[field] = intField(input, field, min, max);
  if (values.gpuResumePercent >= values.gpuBusyPercent) throw invalid("AdmissionPolicy.gpuResumePercent must be less than gpuBusyPercent.", "gpuResumePercent");
  if (values.npuResumePercent >= values.npuBusyPercent) throw invalid("AdmissionPolicy.npuResumePercent must be less than npuBusyPercent.", "npuResumePercent");
  if (values.resumeFreeMemoryMb < values.minFreeMemoryMb) throw invalid("AdmissionPolicy.resumeFreeMemoryMb must be at least minFreeMemoryMb.", "resumeFreeMemoryMb");
  return { ...values, harnessLimits: limitsField(input.harnessLimits) } as AdmissionPolicy;
}

/** fleet/policy.json merged over the defaults; the defaults when the file is absent. */
export function loadAdmissionPolicy(): AdmissionPolicy {
  const file = path.join(fleetDir(), "policy.json");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseAdmissionPolicy({ ...DEFAULT_ADMISSION_POLICY });
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid("fleet/policy.json is not valid JSON.", "policy");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalid("fleet/policy.json must contain a JSON object.", "policy");
  return parseAdmissionPolicy({ ...DEFAULT_ADMISSION_POLICY, ...(parsed as Record<string, unknown>) });
}

/** Validates, then writes fleet/policy.json atomically with mode 0600. */
export function saveAdmissionPolicy(policy: AdmissionPolicy): void {
  const validated = parseAdmissionPolicy(policy);
  ensurePrivateDir(fleetDir());
  writePrivateFileAtomic(path.join(fleetDir(), "policy.json"), `${JSON.stringify(validated, null, 2)}\n`);
}

export interface PolicyTransition { rule: PolicyRule; decision: "defer" | "resume"; measured: number; threshold: number }
interface GuardProbes { accelerators: () => AcceleratorSnapshot | undefined; freeMemoryMb: () => number; now: () => number }
interface GuardCell { closed: boolean; measured: number | null; changedAt: string }
const RULES: readonly PolicyRule[] = ["gpu-busy", "npu-busy", "memory-low"];

/** Largest measured utilization of one device kind, or null when no device reports a number. */
function measureKind(snapshot: AcceleratorSnapshot | undefined, kind: AcceleratorKind): number | null {
  if (snapshot === undefined) return null;
  let measured: number | null = null;
  for (const device of snapshot.devices) {
    if (device.kind !== kind) continue;
    const value = device.utilizationPercent;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (measured === null || value > measured) measured = value;
  }
  return measured;
}

/** GPU/NPU/memory admission guard with hysteresis; it never suspends, throttles or signals a process. */
export class ResourcePolicyGuard {
  private policy: AdmissionPolicy;
  private readonly probes: GuardProbes;
  private readonly cells: Record<PolicyRule, GuardCell>;
  private lastFreeMemoryMb: number | null = null;

  constructor(policy: AdmissionPolicy, probes?: {
    accelerators?: () => AcceleratorSnapshot | undefined; freeMemoryMb?: () => number; now?: () => number;
  }) {
    this.policy = policy;
    this.probes = {
      accelerators: probes?.accelerators ?? getAcceleratorSnapshot,
      freeMemoryMb: probes?.freeMemoryMb ?? (() => os.freemem() / 1_048_576),
      now: probes?.now ?? Date.now,
    };
    const changedAt = new Date(this.probes.now()).toISOString();
    this.cells = {
      "gpu-busy": { closed: false, measured: null, changedAt },
      "npu-busy": { closed: false, measured: null, changedAt },
      "memory-low": { closed: false, measured: null, changedAt },
    };
  }

  setPolicy(policy: AdmissionPolicy): void {
    this.policy = policy;
  }

  /** Samples once and updates hysteresis state. Call once per scheduler tick. */
  sample(): PolicyTransition[] {
    const snapshot = this.probes.accelerators();
    const gpu = measureKind(snapshot, "gpu");
    const npu = measureKind(snapshot, "npu");
    const free = this.probes.freeMemoryMb();
    this.lastFreeMemoryMb = Number.isFinite(free) ? free : null;
    const transitions: PolicyTransition[] = [];
    this.apply("gpu-busy", gpu, gpu !== null && gpu >= this.policy.gpuBusyPercent,
      gpu === null || gpu <= this.policy.gpuResumePercent, this.policy.gpuBusyPercent, this.policy.gpuResumePercent, transitions);
    this.apply("npu-busy", npu, npu !== null && npu >= this.policy.npuBusyPercent,
      npu === null || npu <= this.policy.npuResumePercent, this.policy.npuBusyPercent, this.policy.npuResumePercent, transitions);
    this.apply("memory-low", this.lastFreeMemoryMb,
      this.lastFreeMemoryMb !== null && this.lastFreeMemoryMb < this.policy.minFreeMemoryMb,
      this.lastFreeMemoryMb === null || this.lastFreeMemoryMb >= this.policy.resumeFreeMemoryMb,
      this.policy.minFreeMemoryMb, this.policy.resumeFreeMemoryMb, transitions);
    return transitions;
  }

  private apply(
    rule: PolicyRule, measured: number | null, close: boolean, open: boolean,
    closeThreshold: number, openThreshold: number, transitions: PolicyTransition[],
  ): void {
    const cell = this.cells[rule];
    const closed = cell.closed ? !open : close;
    cell.measured = measured;
    if (closed === cell.closed) return;
    cell.closed = closed;
    cell.changedAt = new Date(this.probes.now()).toISOString();
    // PolicyTransition.measured is a number; an unmeasurable value is reported as 0.
    transitions.push({ rule, decision: closed ? "defer" : "resume", measured: measured ?? 0, threshold: closed ? closeThreshold : openThreshold });
  }

  /** Pure with respect to the last sample. */
  evaluate(resources: ResourceRequest): PolicyBlock[] {
    const blocks: PolicyBlock[] = [];
    const gpu = this.cells["gpu-busy"];
    const npu = this.cells["npu-busy"];
    const memory = this.cells["memory-low"];
    if (resources.gpu === true && gpu.closed) blocks.push({ rule: "gpu-busy", measured: gpu.measured, threshold: this.policy.gpuBusyPercent });
    if (resources.npu === true && npu.closed) blocks.push({ rule: "npu-busy", measured: npu.measured, threshold: this.policy.npuBusyPercent });
    if (memory.closed) blocks.push({ rule: "memory-low", measured: memory.measured, threshold: this.policy.minFreeMemoryMb });
    if (resources.memoryMb !== undefined && this.lastFreeMemoryMb !== null
      && this.lastFreeMemoryMb - resources.memoryMb < this.policy.minFreeMemoryMb) {
      blocks.push({ rule: "memory-low", measured: this.lastFreeMemoryMb, threshold: this.policy.minFreeMemoryMb + resources.memoryMb });
    }
    return blocks;
  }

  state(): GuardState[] {
    return RULES.map((rule) => {
      const cell = this.cells[rule];
      return { rule, closed: cell.closed, measured: cell.measured, changedAt: cell.changedAt };
    });
  }
}
