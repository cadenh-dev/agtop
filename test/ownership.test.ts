import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { FleetService } from "../src/fleet.js";
import { FleetError } from "../src/fleet-errors.js";
import { selfSupervisor, type SessionIdentity } from "../src/job-runtime.js";
import { assertAllowed, canKill, canReadOutput, canSee, canSeeCommand, isOwner, type Caller } from "../src/ownership.js";
import type { DaemonPeer, JobRecordV2, ManagedAgent } from "../src/types.js";

const hash = (token: string): string => createHash("sha256").update(token).digest("hex");
const TOKEN = "t1".padEnd(40, "x");
function record(overrides: Partial<JobRecordV2> = {}): JobRecordV2 {
  return {
    version: 2, jobId: "job", state: "running", stateReason: "spawned", harness: "custom", command: "echo", args: [], cwd: "/tmp", peer: "team-a", backend: "unknown",
    owner: { sessionId: "s1", tokenHash: hash(TOKEN), surface: "mcp" }, visibility: "owner", supervisor: { pid: 1, startTime: "1", surface: "mcp" }, containment: null,
    capture: { kind: "pipe", ringBytes: 65_536, spool: "tail", spoolMaxBytes: 1_048_576, redact: true },
    queue: { admission: "immediate", priority: 0, dependsOn: [], resources: {}, leasePorts: [], leaseTtlMs: 0, timeoutMs: 0, maxQueueMs: 0 },
    envKeys: [], createdAt: "2026-01-01T00:00:00.000Z", startedAt: null, exitedAt: null, exitCode: null, signal: null, lastSeq: 0, outputBytes: { stdout: 0, stderr: 0 }, error: null, ...overrides,
  };
}
const session = (id: string, token = TOKEN, peer = "team-a"): Caller =>
  ({ kind: "session", session: { sessionId: id, ownerToken: token, tokenHash: hash(token) }, peer });
const peer = (id: string, extra: Partial<DaemonPeer> = {}): Caller =>
  ({ kind: "peer", peer: { id, url: "https://x", publicKey: "", scopes: [], jobPeerPrefixes: [], enabled: true, addedAt: "", lastSeenAt: null, ...extra } });
const admin: Caller = { kind: "admin" };
const owner = session("s1"), other = session("s2"), wrong = session("s1", "t2".padEnd(40, "y"));
const ownerRecord = record();
const peerRecord = record({ owner: { sessionId: "peer:p1", tokenHash: "", surface: "remote", remotePeerId: "p1" }, peer: "someone" });

test("isOwner follows the access table, including empty and wrong hashes", () => {
  expect(isOwner(ownerRecord, admin)).toBe(false);
  expect(isOwner(ownerRecord, owner)).toBe(true);
  expect(isOwner(ownerRecord, wrong)).toBe(false); expect(isOwner(ownerRecord, other)).toBe(false);
  expect(isOwner(record({ owner: { sessionId: "s1", tokenHash: "", surface: "mcp" } }), owner)).toBe(false);
  expect(isOwner(record({ owner: { sessionId: "s1", tokenHash: "abc", surface: "mcp" } }), owner)).toBe(false);
  expect(isOwner(peerRecord, peer("p1"))).toBe(true); expect(isOwner(peerRecord, peer("p2"))).toBe(false);
});

test("canSee and canSeeCommand follow the access table", () => {
  expect(canSee(ownerRecord, admin)).toBe(true); expect(canSee(ownerRecord, other)).toBe(true);
  expect(canSee(ownerRecord, peer("p2"))).toBe(false);
  expect(canSee(ownerRecord, peer("p2", { jobPeerPrefixes: ["team-"] }))).toBe(true);
  expect(canSee(peerRecord, peer("p1"))).toBe(true);
  expect(canSeeCommand(ownerRecord, admin)).toBe(true); expect(canSeeCommand(ownerRecord, owner)).toBe(true);
  expect(canSeeCommand(ownerRecord, wrong)).toBe(false); expect(canSeeCommand(ownerRecord, other)).toBe(false);
  expect(canSeeCommand(peerRecord, peer("p1"))).toBe(true);
  expect(canSeeCommand(ownerRecord, peer("p2", { jobPeerPrefixes: ["team-"] }))).toBe(false);
});

test("canReadOutput honours visibility for sessions and peers", () => {
  expect(canReadOutput(ownerRecord, admin)).toBe(true); expect(canReadOutput(ownerRecord, owner)).toBe(true);
  expect(canReadOutput(ownerRecord, wrong)).toBe(false); expect(canReadOutput(ownerRecord, other)).toBe(false);
  const all = record({ visibility: "all" });
  expect(canReadOutput(all, other)).toBe(true);
  expect(canReadOutput(all, peer("p2", { jobPeerPrefixes: ["team-"] }))).toBe(true);
  const peerVisible = record({ visibility: "peer", peer: "team-a" });
  expect(canReadOutput(peerVisible, session("s2", TOKEN, "team-a"))).toBe(true);
  expect(canReadOutput(peerVisible, session("s2", TOKEN, "team-b"))).toBe(false);
  expect(canReadOutput(peerVisible, peer("p2", { jobPeerPrefixes: ["team-"] }))).toBe(false);
  expect(canReadOutput(peerRecord, peer("p1"))).toBe(true);
});

test("canKill follows the access table, including jobs:kill-any", () => {
  expect(canKill(ownerRecord, admin)).toBe(true); expect(canKill(ownerRecord, owner)).toBe(true);
  expect(canKill(ownerRecord, other)).toBe(false); expect(canKill(peerRecord, peer("p1"))).toBe(true);
  expect(canKill(ownerRecord, peer("p2"))).toBe(false);
  expect(canKill(ownerRecord, peer("p3", { jobPeerPrefixes: ["team-"], scopes: ["jobs:kill-any"] }))).toBe(true);
  expect(canKill(ownerRecord, peer("p3", { jobPeerPrefixes: ["team-"] }))).toBe(false);
});

test("assertAllowed denies with one fixed E_NOT_OWNER message per action", () => {
  assertAllowed("read", ownerRecord, owner);
  assertAllowed("output", ownerRecord, owner);
  assertAllowed("events", ownerRecord, owner);
  assertAllowed("kill", ownerRecord, owner);
  const denial = (action: "output" | "events" | "kill" | "read", caller: Caller): FleetError => {
    try { assertAllowed(action, ownerRecord, caller); }
    catch (error) { return error as FleetError; }
    throw new Error(`expected ${action} to be denied`);
  };
  for (const action of ["output", "events", "kill"] as const) {
    const error = denial(action, other);
    expect(error).toBeInstanceOf(FleetError); expect(error.code).toBe("E_NOT_OWNER");
    expect(error.message).not.toContain(TOKEN); expect(error.message).not.toContain(hash(TOKEN));
    expect(denial(action, other).message).toBe(error.message);
  }
  expect(denial("read", peer("p9")).code).toBe("E_NOT_OWNER");
});

let root = "", previousStateDir: string | undefined;
const services: FleetService[] = [];
beforeEach(() => {
  previousStateDir = process.env.AGTOP_STATE_DIR;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-owner-"));
  process.env.AGTOP_STATE_DIR = root;
});
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  fs.rmSync(root, { recursive: true, force: true });
  if (previousStateDir === undefined) delete process.env.AGTOP_STATE_DIR; else process.env.AGTOP_STATE_DIR = previousStateDir;
});
async function open(session: SessionIdentity): Promise<FleetService> {
  const spawn = (async (options: Parameters<typeof import("../src/manager.js").spawnContainedAgent>[0]) => {
    let finish!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { finish = resolve; });
    const output = { stdout: new PassThrough(), stderr: new PassThrough() };
    return {
      jobId: options.jobId!, pid: 1, containmentMode: "passive-ppid", exited, startTime: "1", output,
      terminate: async () => { output.stdout.end(); output.stderr.end(); finish(143); return { killedPids: [], failedPids: [], errors: [] }; },
    } as ManagedAgent;
  }) as typeof import("../src/manager.js").spawnContainedAgent;
  const snapshot = (): Array<{ pid: number; startTime: string }> => [{ pid: process.pid, startTime: selfSupervisor("library").startTime }];
  const capture = {
    kind: "pipe" as const,
    open: async () => ({
      posixStdio: () => ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
      windowsHandles: () => ({ stdin: 0, stdout: 0, stderr: 0 }),
      attach: () => { throw new Error("unused"); }, releaseChildEnds: () => {}, dispose: () => {},
    }),
  };
  const service = await FleetService.open({ surface: "library", session, spawn, capture, reconcile: { snapshot },
    guard: { accelerators: () => undefined, freeMemoryMb: () => 100_000 } });
  services.push(service);
  return service;
}
const as = (service: FleetService, peerLabel = "team-a"): Caller => ({ kind: "session", session: service.session, peer: peerLabel });
const codeOf = (fn: () => unknown): string | undefined => {
  try { fn(); return undefined; } catch (error) { return (error as FleetError).code; }
};

test("S3/S4: visibility is enforced from the stored record and identity requires the same token", async () => {
  const a = await open({ sessionId: "session-a", ownerToken: TOKEN, tokenHash: hash(TOKEN) });
  await a.submit({ command: "echo", jobId: "vis-all", visibility: "all" }, as(a));
  await a.submit({ command: "echo", jobId: "vis-peer", visibility: "peer" }, as(a, "team-a"));
  await a.submit({ command: "echo", jobId: "s4-owner" }, as(a));
  const b = await open({ sessionId: "session-b", ownerToken: "b".repeat(40), tokenHash: hash("b".repeat(40)) });
  expect(b.events("vis-all", {}, as(b, "someone"))).toBeDefined();
  expect(codeOf(() => b.events("vis-peer", {}, as(b, "team-a")))).toBeUndefined();
  expect(codeOf(() => b.events("vis-peer", {}, as(b, "team-b")))).toBe("E_NOT_OWNER");
  expect(a.get("vis-peer", admin).record?.visibility).toBe("peer");
  const c = await open({ sessionId: "session-a", ownerToken: TOKEN, tokenHash: hash(TOKEN) });
  expect(codeOf(() => c.events("s4-owner", {}, as(c, "anyone")))).toBeUndefined();
  const d = await open({ sessionId: "session-a", ownerToken: "d".repeat(40), tokenHash: hash("d".repeat(40)) });
  expect(codeOf(() => d.events("s4-owner", {}, as(d, "anyone")))).toBe("E_NOT_OWNER");
});
