import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { FleetError } from "../src/fleet-errors.js";
import { LeaseManager } from "../src/leases.js";
import { DEFAULT_ADMISSION_POLICY } from "../src/policy.js";
import { processSnapshot } from "../src/registry.js";
import type { ListenerInfo, PortLease, SupervisorIdentity } from "../src/types.js";

const REPO = path.resolve(import.meta.dir, "..");
const HOLDER: SupervisorIdentity = { pid: 4242, startTime: "100", surface: "library" };
const DEAD: SupervisorIdentity = { pid: 7777, startTime: "7", surface: "library" };
let root = "", dir = "", clock = 1_000_000_000_000;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-leases-"));
  dir = path.join(root, "leases");
  clock = 1_000_000_000_000;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function manager(options: { listeners?: () => ListenerInfo[]; alive?: (holder: SupervisorIdentity) => boolean } = {}): LeaseManager {
  return new LeaseManager({ dir, now: () => clock, listeners: () => [], alive: () => true, ...options });
}
function acquire(m: LeaseManager, port: number, jobId: string | null, ttlMs?: number, holder = HOLDER): PortLease {
  return m.acquire({ port, jobId, peer: "tester", sessionId: "session", holder, ...(ttlMs === undefined ? {} : { ttlMs }) });
}
function failure(fn: () => unknown): FleetError {
  try { fn(); } catch (error) { if (error instanceof FleetError) return error; throw error; }
  throw new Error("expected a FleetError");
}
function writeRaw(port: number, content: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${port}.json`);
  fs.writeFileSync(file, content);
  return file;
}

async function raceTwenty(port: number): Promise<string[]> {
  const source = pathToFileURL(path.join(REPO, "src", "leases.ts")).href;
  const script = `const { LeaseManager } = await import(${JSON.stringify(source)});
const start = Number(process.env.LEASE_START);
while (Date.now() < start) {}
try {
  new LeaseManager({ dir: process.env.LEASE_DIR, alive: () => true }).acquire({ port: ${port}, jobId: process.env.LEASE_JOB,
    peer: "tester", sessionId: "session", holder: { pid: 1, startTime: "1", surface: "library" } });
  process.stdout.write("won");
} catch (error) { process.stdout.write("lost:" + error.code); }`;
  const start = Date.now() + 2000;
  return Promise.all(Array.from({ length: 20 }, (_, index) => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], {
      env: { ...process.env, LEASE_START: String(start), LEASE_DIR: dir, LEASE_JOB: `job-${index}` },
      stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.on("error", reject);
    child.on("close", () => resolve(output));
  })));
}

test("twenty processes racing for a port with an expired lease leave exactly one winner", async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  writeRaw(3010, JSON.stringify({ leaseId: "expired-lease", port: 3010, jobId: "old-job", peer: "tester", sessionId: "session",
    holder: { pid: 1, startTime: "1", surface: "library" }, acquiredAt: past, renewedAt: past, expiresAt: past, ttlMs: 10_000 }));
  const runs = await raceTwenty(3010);
  expect(runs.filter((run) => run === "won")).toHaveLength(1);
  expect(runs.filter((run) => run === "lost:E_LEASE_CONFLICT")).toHaveLength(19);
  const leases = new LeaseManager({ dir, alive: () => true }).list();
  expect(leases).toHaveLength(1);
  expect(leases[0].jobId).toBe(`job-${runs.indexOf("won")}`);
}, 30_000);

test("twenty processes racing for one port leave exactly one winner", async () => {
  const source = pathToFileURL(path.join(REPO, "src", "leases.ts")).href;
  const script = `const { LeaseManager } = await import(${JSON.stringify(source)});
const start = Number(process.env.LEASE_START);
while (Date.now() < start) {}
try {
  new LeaseManager({ dir: process.env.LEASE_DIR, alive: () => true }).acquire({ port: 3000, jobId: process.env.LEASE_JOB,
    peer: "tester", sessionId: "session", holder: { pid: 1, startTime: "1", surface: "library" } });
  process.stdout.write("won");
} catch (error) { process.stdout.write("lost:" + error.code); }`;
  const start = Date.now() + 2000;
  const runs = await Promise.all(Array.from({ length: 20 }, (_, index) => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], {
      env: { ...process.env, LEASE_START: String(start), LEASE_DIR: dir, LEASE_JOB: `job-${index}` },
      stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.on("error", reject);
    child.on("close", () => resolve(output));
  })));
  expect(runs.filter((run) => run === "won")).toHaveLength(1);
  expect(runs.filter((run) => run === "lost:E_LEASE_CONFLICT")).toHaveLength(19);
  const leases = manager().list();
  expect(leases).toHaveLength(1);
  expect(leases[0].jobId).toBe(`job-${runs.indexOf("won")}`);
});

test("twenty managers racing on one directory leave exactly one winner", async () => {
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) => Promise.resolve().then(() => {
    try { acquire(manager(), 3001, `job-${index}`); return "won"; } catch (error) { return (error as FleetError).code; }
  })));
  expect(results.filter((result) => result === "won")).toHaveLength(1);
  expect(results.filter((result) => result === "E_LEASE_CONFLICT")).toHaveLength(19);
  expect(manager().list()).toHaveLength(1);
});

test("expired and dead-holder leases are absent and their ports acquirable again", () => {
  const m = manager({ alive: (holder) => holder.pid !== DEAD.pid });
  expect(acquire(m, 3100, "job-a", 10_000).ttlMs).toBe(10_000);
  expect(m.check(3100, "job-b")).toEqual({ kind: "lease", port: 3100, jobId: "job-a", peer: "tester", expiresAt: new Date(clock + 10_000).toISOString() });
  acquire(m, 3200, "job-dead", undefined, DEAD);
  expect(m.check(3200, "job-b")).toBeNull();
  clock += 10_001;
  expect(m.get(3100)).toBeNull();
  expect(m.get(3200)).toBeNull();
  expect(m.list()).toEqual([]);
  expect(m.check(3100, "job-b")).toBeNull();
  expect(acquire(m, 3100, "job-b").jobId).toBe("job-b");
  expect(acquire(m, 3200, "job-c").jobId).toBe("job-c");
  expect(m.list().map((lease) => lease.jobId)).toEqual(["job-b", "job-c"]);
});

test("a listener on the port conflicts unless it belongs to the same job", () => {
  const listeners: ListenerInfo[] = [{ pid: 999, address: "127.0.0.1", port: 3300, jobId: "job-b" }];
  const m = manager({ listeners: () => listeners });
  expect(m.check(3300, "job-a")).toEqual({ kind: "listener", port: 3300, pid: 999, address: "127.0.0.1", jobId: "job-b" });
  expect(m.check(3300, "job-b")).toBeNull();
  expect(m.check(3301, "job-a")).toBeNull();
  const conflict = failure(() => acquire(m, 3300, "job-a"));
  expect(conflict.code).toBe("E_LEASE_CONFLICT");
  expect(conflict.details?.holder).toEqual({ kind: "listener", port: 3300, pid: 999, address: "127.0.0.1", jobId: "job-b" });
  listeners.push({ pid: 1000, address: "0.0.0.0", port: 3302 });
  expect(m.check(3302, "job-a")).toEqual({ kind: "listener", port: 3302, pid: 1000, address: "0.0.0.0" });
  // A lease with no job (POST /v1/leases) must still see an unrelated listener that has no jobId.
  expect(m.check(3302)).toEqual({ kind: "listener", port: 3302, pid: 1000, address: "0.0.0.0" });
  expect(m.check(3300)).not.toBeNull();
  expect(m.get(3300)).toBeNull();
});

test("renew extends the same ttl and release deletes; a wrong leaseId is E_NOT_OWNER", () => {
  const m = manager();
  const lease = acquire(m, 3400, "job-a", 60_000);
  expect(failure(() => acquire(m, 3400, "job-a")).details?.holder).toMatchObject({ kind: "lease", jobId: "job-a" });
  clock += 1000;
  const renewed = m.renew(3400, lease.leaseId);
  expect(renewed).toEqual({ ...lease, renewedAt: new Date(clock).toISOString(), expiresAt: new Date(clock + 60_000).toISOString() });
  expect(m.get(3400)).toEqual(renewed);
  expect(failure(() => m.renew(3400, "wrong")).code).toBe("E_NOT_OWNER");
  expect(failure(() => m.release(3400, "wrong")).code).toBe("E_NOT_OWNER");
  expect(m.get(3400)).not.toBeNull();
  m.release(3400, lease.leaseId);
  expect(m.get(3400)).toBeNull();
  expect(fs.existsSync(path.join(dir, "3400.json"))).toBe(false);
  for (const call of [() => m.renew(3400, lease.leaseId), () => m.release(3400, lease.leaseId)]) {
    expect(failure(call).code).toBe("E_LEASE_NOT_FOUND");
  }
  expect(failure(() => m.renew(3499, "x")).code).toBe("E_LEASE_NOT_FOUND");
  acquire(m, 3401, "job-b", 10_000);
  clock += 10_001;
  expect(failure(() => m.renew(3401, "x")).code).toBe("E_LEASE_NOT_FOUND");
});

test("releaseJob and sweep delete only the files they own and return sorted ports", () => {
  const m = manager({ alive: (holder) => holder.pid !== DEAD.pid });
  acquire(m, 3502, "job-a"); acquire(m, 3500, "job-b"); acquire(m, 3501, "job-a");
  acquire(m, 3600, "expired", 10_000); acquire(m, 3601, "dead", undefined, DEAD);
  writeRaw(3503, "{not json");
  expect(m.get(3503)).toBeNull();
  expect(m.list().map((lease) => lease.port)).toEqual([3500, 3501, 3502, 3600]);
  expect(m.releaseJob("job-a")).toEqual([3501, 3502]);
  expect(m.releaseJob("job-none")).toEqual([]);
  expect(fs.existsSync(path.join(dir, "3503.json"))).toBe(true);
  clock += 10_001;
  // A fresh unreadable file may be a lease still being written: sweep leaves it alone.
  expect(m.sweep()).toEqual([3600, 3601]);
  expect(fs.existsSync(path.join(dir, "3503.json"))).toBe(true);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(dir, "3503.json"), old, old);
  expect(m.sweep()).toEqual([3503]);
  expect(fs.existsSync(path.join(dir, "3503.json"))).toBe(false);
  expect(fs.existsSync(path.join(dir, "3500.json"))).toBe(true);
  expect(m.sweep()).toEqual([]);
  expect(new LeaseManager({ dir: path.join(root, "absent"), now: () => clock }).sweep()).toEqual([]);
});

test("validation errors name the field", () => {
  const m = manager();
  for (const port of [0, 65_536, 1.5, Number.NaN, "80"]) {
    const error = failure(() => m.acquire({ port: port as number, jobId: null, peer: "t", sessionId: "s", holder: HOLDER }));
    expect(error.code).toBe("E_INVALID_REQUEST");
    expect(error.details?.field).toBe("port");
  }
  for (const ttlMs of [9_999, 86_400_001, 10_000.5, "10000"]) {
    expect(failure(() => acquire(m, 3700, "job", ttlMs as number)).details?.field).toBe("ttlMs");
  }
  expect(acquire(m, 3700, "job", 10_000).ttlMs).toBe(10_000);
  expect(acquire(m, 3701, "job", 86_400_000).ttlMs).toBe(86_400_000);
  expect(acquire(m, 3702, null).ttlMs).toBe(DEFAULT_ADMISSION_POLICY.defaultLeaseTtlMs);
});

test("the default directory is fleet/leases and the default liveness uses the process snapshot", () => {
  const previous = process.env.AGTOP_STATE_DIR;
  process.env.AGTOP_STATE_DIR = root;
  try {
    const m = new LeaseManager({ alive: () => true });
    expect(acquire(m, 3800, "job-a").ttlMs).toBe(DEFAULT_ADMISSION_POLICY.defaultLeaseTtlMs);
    expect(fs.existsSync(path.join(root, "fleet", "leases", "3800.json"))).toBe(true);
    const self = processSnapshot().find((item) => item.pid === process.pid);
    expect(self).toBeDefined();
    const live = new LeaseManager({ dir });
    acquire(live, 3900, "live", 60_000, { pid: process.pid, startTime: self!.startTime, surface: "library" });
    expect(live.get(3900)).not.toBeNull();
    acquire(live, 3901, "reused", 60_000, { pid: process.pid, startTime: `${self!.startTime}-stale`, surface: "library" });
    expect(live.get(3901)).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.AGTOP_STATE_DIR; else process.env.AGTOP_STATE_DIR = previous;
  }
});

test.skipIf(process.platform === "win32")("the lease file is mode 0600", () => {
  const m = manager();
  acquire(m, 4000, "job-a");
  expect(fs.statSync(path.join(dir, "4000.json")).mode & 0o777).toBe(0o600);
});
