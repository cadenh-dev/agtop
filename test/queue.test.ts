import { describe, expect, test } from "bun:test";
import { FleetError } from "../src/fleet-errors.js";
import type { AdmissionInput, PolicyBlock } from "../src/queue.js";
import { effectivePriority, orderQueue, planAdmission, validateDependencies } from "../src/queue.js";
import type { AdmissionPolicy, JobRecordV2, LeaseHolder, QueueEntry } from "../src/types.js";

/** Contract 2.5 defaults; src/policy.ts (Unit 3.2) does not exist yet. */
const POLICY: AdmissionPolicy = {
  maxRunning: 8, maxRunningPerPeer: 4, maxRunningPerHarness: 4, harnessLimits: {}, maxQueued: 200,
  gpuBusyPercent: 85, gpuResumePercent: 70, npuBusyPercent: 85, npuResumePercent: 70,
  minFreeMemoryMb: 1024, resumeFreeMemoryMb: 1536, agingIntervalMs: 30_000, agingStep: 1,
  agingMaxBoost: 50, defaultLeaseTtlMs: 600_000, pollMs: 1000,
};
const T0 = "2026-01-01T00:00:00.000Z", NOW = Date.parse(T0), OWN = 100, FOREIGN = 999;
type Snapshot = Pick<JobRecordV2, "state" | "exitCode">;

function entry(jobId: string, overrides: Partial<QueueEntry> = {}): QueueEntry {
  return { jobId, peer: "local", harness: "claude-code", priority: 0, dependsOn: [], resources: {}, leasePorts: [], redact: false, enqueuedAt: T0, maxQueueMs: 0, sessionId: "s", supervisorPid: OWN, ...overrides };
}
const running = (total = 0, peers: Array<[string, number]> = [], harnesses: Array<[string, number]> = []) =>
  ({ total, perPeer: new Map(peers), perHarness: new Map(harnesses) });

function makeInput(queued: QueueEntry[], jobs: Record<string, Snapshot> = {}, overrides: Partial<AdmissionInput> = {}): AdmissionInput {
  return { nowMs: NOW, policy: POLICY, ownSupervisorPid: OWN, queued, job: (id) => jobs[id], running: running(), leaseCheck: () => null, policyBlocks: () => [], ...overrides };
}

function errorOf(run: () => void): FleetError {
  try { run(); } catch (error) { if (error instanceof FleetError) return error; throw error; }
  throw new Error("expected a FleetError");
}

describe("ordering and aging", () => {
  test("aging arithmetic and agingMaxBoost cap", () => {
    const aged = entry("j", { priority: 5 });
    expect([29_999, 30_000, 90_000, 600_000, 6_000_000].map((ms) => effectivePriority(aged, POLICY, NOW + ms))).toEqual([5, 6, 8, 25, 55]);
    expect(effectivePriority(aged, { ...POLICY, agingStep: 0 }, NOW + 600_000)).toBe(5);
    expect(effectivePriority(aged, { ...POLICY, agingMaxBoost: 0 }, NOW + 600_000)).toBe(5);
  });
  test("effective priority, then enqueuedAt, then jobId, on a copy", () => {
    expect(orderQueue([entry("b", { priority: 2, enqueuedAt: "2026-01-01T00:01:30.000Z" }), entry("a")], POLICY, NOW + 120_000).map((e) => e.jobId)).toEqual(["a", "b"]);
    expect(orderQueue([entry("a", { enqueuedAt: "2026-01-01T00:00:01.000Z" }), entry("z")], POLICY, NOW).map((e) => e.jobId)).toEqual(["z", "a"]);
    const input = [entry("b"), entry("a")];
    expect(orderQueue(input, POLICY, NOW).map((e) => e.jobId)).toEqual(["a", "b"]);
    expect(input.map((e) => e.jobId)).toEqual(["b", "a"]);
  });
});

describe("dependency validation", () => {
  const known = (graph: Record<string, string[]>) => (id: string) => (graph[id] === undefined ? undefined : { dependsOn: graph[id] });
  test("unknown ids are reported together", () => {
    const error = errorOf(() => validateDependencies("j", ["x", "y"], () => undefined));
    expect([error.code, error.details]).toEqual(["E_DEPENDENCY_NOT_FOUND", { jobIds: ["x", "y"] }]);
  });
  test("self-reference and cycles are rejected, acyclic graphs pass", () => {
    const code = (dependsOn: string[], graph: Record<string, string[]> = {}) => errorOf(() => validateDependencies("j", dependsOn, known(graph))).code;
    expect([code(["j"]), code(["a"], { a: ["b"], b: ["a"] }), code(["a"], { a: ["b"], b: ["c"], c: ["a"] })]).toEqual(["E_DEPENDENCY_CYCLE", "E_DEPENDENCY_CYCLE", "E_DEPENDENCY_CYCLE"]);
    expect(() => validateDependencies("j", ["a", "b"], known({ a: ["c"], b: ["c"], c: [] }))).not.toThrow();
  });
});

describe("dependency states", () => {
  const plan = (state: JobRecordV2["state"], exitCode: number | null = null, overrides: Partial<QueueEntry> = {}) =>
    planAdmission(makeInput([entry("j", { dependsOn: ["d"], ...overrides })], { d: { state, exitCode } }));
  test("exited 0 admits; nonzero, failed, killed, lost and missing fail", () => {
    expect(plan("exited", 0).admit).toEqual(["j"]);
    expect(plan("exited", 7).fail).toEqual([{ jobId: "j", reason: "dependency-failed", detail: "dependency d exited with code 7" }]);
    for (const state of ["failed", "killed", "lost"] as const) {
      expect(plan(state).fail).toEqual([{ jobId: "j", reason: "dependency-failed", detail: `dependency d is ${state}` }]);
    }
    expect(planAdmission(makeInput([entry("j", { dependsOn: ["ghost"] })])).fail[0].detail).toBe("dependency ghost does not exist");
  });
  test("a dependency that has not exited blocks instead of failing", () => {
    for (const state of ["queued", "starting", "running", "exiting"] as const) {
      const result = plan(state);
      expect([result.admit, result.fail, result.views[0].blockedBy]).toEqual([[], [], [{ kind: "dependency", jobIds: ["d"] }]]);
    }
  });
  test("a foreign dependent is never failed", () => {
    const result = plan("failed", 1, { supervisorPid: FOREIGN });
    expect([result.admit, result.fail]).toEqual([[], []]);
    expect(result.views[0].blockedBy).toEqual([{ kind: "dependency", jobIds: ["d"] }]);
  });
});

describe("caps and leases", () => {
  test("global, peer and harness caps", () => {
    const global = planAdmission(makeInput([entry("a"), entry("b")], {}, { policy: { ...POLICY, maxRunning: 2 }, running: running(1) }));
    expect([global.admit, global.views[1].blockedBy]).toEqual([["a"], [{ kind: "cap", cap: "global", limit: 2, running: 2 }]]);
    const peer = planAdmission(makeInput([entry("a", { peer: "p" }), entry("b", { peer: "p" }), entry("c", { peer: "q" })], {}, { policy: { ...POLICY, maxRunningPerPeer: 1 } }));
    expect([peer.admit, peer.views[1].blockedBy]).toEqual([["a", "c"], [{ kind: "cap", cap: "peer", limit: 1, running: 1 }]]);
    const harness = planAdmission(makeInput([entry("a"), entry("b")], {}, { policy: { ...POLICY, maxRunningPerHarness: 1 } }));
    expect([harness.admit, harness.views[1].blockedBy]).toEqual([["a"], [{ kind: "cap", cap: "harness", limit: 1, running: 1 }]]);
  });
  test("harnessLimits overrides maxRunningPerHarness", () => {
    const policy = { ...POLICY, maxRunningPerHarness: 1, harnessLimits: { "claude-code": 2 } };
    expect(planAdmission(makeInput([entry("a"), entry("b")], {}, { policy })).admit).toEqual(["a", "b"]);
  });
  test("a claim earlier in the pass blocks the same port", () => {
    const plan = planAdmission(makeInput([entry("a", { leasePorts: [4100] }), entry("b", { leasePorts: [4100] })]));
    expect(plan.admit).toEqual(["a"]);
    expect(plan.views[1].blockedBy).toEqual([{ kind: "lease", port: 4100, holder: { kind: "lease", port: 4100, jobId: "a", peer: "local", expiresAt: new Date(NOW + POLICY.defaultLeaseTtlMs).toISOString() } }]);
  });
  test("a leaseCheck conflict blocks with the reported holder", () => {
    const holder: LeaseHolder = { kind: "listener", port: 5000, pid: 42, address: "127.0.0.1", jobId: "other" };
    const calls: Array<[number, string]> = [];
    const plan = planAdmission(makeInput([entry("a", { leasePorts: [5000] })], {}, { leaseCheck: (port, jobId) => (calls.push([port, jobId]), holder) }));
    expect([plan.admit, calls, plan.views[0].blockedBy]).toEqual([[], [[5000, "a"]], [{ kind: "lease", port: 5000, holder }]]);
  });
});

describe("policy and anti-starvation", () => {
  const memoryBlock: PolicyBlock = { rule: "memory-low", measured: 500, threshold: 13024 };
  const memoryGuard = (r: { memoryMb?: number }) => (r.memoryMb !== undefined && r.memoryMb >= 8000 ? [memoryBlock] : []);
  test("a policy block starves lower-ranked entries of the same kind only", () => {
    const plan = planAdmission(makeInput([entry("big", { priority: 10, resources: { memoryMb: 9000 } }), entry("small", { priority: 1, resources: { memoryMb: 100 } }), entry("cpu")], {}, { policyBlocks: memoryGuard }));
    expect([plan.admit, plan.views[0].blockedBy, plan.views[1].blockedBy]).toEqual([["cpu"], [{ kind: "policy", ...memoryBlock }], [{ kind: "outranked", byJobId: "big" }]]);
  });
  test("another kind and dependency blocks do not hold lower-ranked entries back", () => {
    const guarded = planAdmission(makeInput([entry("gpu", { priority: 10, resources: { gpu: true } }), entry("npu", { priority: 1, resources: { npu: true } })], {}, { policyBlocks: (r) => (r.gpu ? [{ rule: "gpu-busy", measured: 99, threshold: 85 }] : []) }));
    expect(guarded.admit).toEqual(["npu"]);
    const dependent = planAdmission(makeInput([entry("blocked", { priority: 5, dependsOn: ["d"] }), entry("later", { priority: 1 })], { d: { state: "running", exitCode: null } }));
    expect(dependent.admit).toEqual(["later"]);
  });
});

describe("ownership, timeout, views and determinism", () => {
  test("foreign entries consume capacity but are never admitted or failed", () => {
    const plan = planAdmission(makeInput([entry("f", { supervisorPid: FOREIGN }), entry("own")], {}, { policy: { ...POLICY, maxRunning: 1 } }));
    expect([plan.admit, plan.fail]).toEqual([[], []]);
    expect(plan.views.map((view) => [view.jobId, view.position])).toEqual([["f", 1], ["own", 2]]);
    expect(plan.views[1].blockedBy).toEqual([{ kind: "cap", cap: "global", limit: 1, running: 1 }]);
    const ports = planAdmission(makeInput([entry("f", { supervisorPid: FOREIGN, leasePorts: [4200] }), entry("own", { leasePorts: [4200] })]));
    expect([ports.admit, ports.views[1].blockedBy]).toEqual([[], [{ kind: "lease", port: 4200, holder: { kind: "lease", port: 4200, jobId: "f", peer: "local", expiresAt: new Date(NOW + POLICY.defaultLeaseTtlMs).toISOString() } }]]);
  });
  test("an own entry past maxQueueMs fails; maxQueueMs 0 and the exact limit admit", () => {
    expect(planAdmission(makeInput([entry("j", { maxQueueMs: 1000 })], {}, { nowMs: NOW + 5000 })).fail).toEqual([{ jobId: "j", reason: "queue-timeout", detail: "queued for 5000 ms, max 1000 ms" }]);
    expect(planAdmission(makeInput([entry("a")], {}, { nowMs: NOW + 10_000 })).admit).toEqual(["a"]);
    expect(planAdmission(makeInput([entry("b", { maxQueueMs: 1000 })], {}, { nowMs: NOW + 1000 })).admit).toEqual(["b"]);
  });
  test("a timed-out foreign entry is neither failed nor given a slot", () => {
    const plan = planAdmission(makeInput([entry("f", { supervisorPid: FOREIGN, maxQueueMs: 1000 }), entry("own")], {}, { nowMs: NOW + 5000, policy: { ...POLICY, maxRunning: 1 } }));
    expect([plan.fail, plan.admit]).toEqual([[], ["own"]]);
  });
  test("views are 1-based and unblocked when admitted", () => {
    const plan = planAdmission(makeInput([entry("b", { priority: 2 }), entry("a")]));
    expect(plan.views.map((view) => [view.jobId, view.position, view.effectivePriority, view.blockedBy])).toEqual([["b", 1, 2, []], ["a", 2, 0, []]]);
  });
  test("the same input yields the same plan and is not mutated", () => {
    const queued = [entry("b", { leasePorts: [1] }), entry("a", { resources: { gpu: true } })];
    const input = makeInput(queued, {}, { policyBlocks: (r) => (r.gpu ? [{ rule: "gpu-busy", measured: null, threshold: 85 }] : []) });
    expect(planAdmission(input)).toEqual(planAdmission(input));
    expect([queued.map((e) => e.jobId), input.running.total, input.running.perPeer.size, input.running.perHarness.size]).toEqual([["b", "a"], 0, 0, 0]);
  });
});
