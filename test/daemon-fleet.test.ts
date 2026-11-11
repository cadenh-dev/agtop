import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { startDaemon } from "../src/daemon.js";
import { FleetService } from "../src/fleet.js";
import type { Caller } from "../src/ownership.js";
import { DEFAULT_ADMISSION_POLICY } from "../src/policy.js";

type JsonObject = Record<string, unknown>;
type HttpResult = { status: number; headers: IncomingHttpHeaders; body: string };
type TestDaemon = Awaited<ReturnType<typeof startDaemon>> & { token: string };

let root = "", previousStateDir: string | undefined;
const daemons: TestDaemon[] = [];
beforeEach(() => {
  previousStateDir = process.env.AGTOP_STATE_DIR;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-daemon-fleet-"));
  process.env.AGTOP_STATE_DIR = root;
});
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close().catch(() => undefined);
  fs.rmSync(root, { recursive: true, force: true });
  if (previousStateDir === undefined) delete process.env.AGTOP_STATE_DIR; else process.env.AGTOP_STATE_DIR = previousStateDir;
});

/** A daemon on an ephemeral port with an isolated state directory. */
async function serveFleet(): Promise<TestDaemon> {
  const daemon = await startDaemon({ port: 0, token: randomBytes(32).toString("hex") });
  const wrapped: TestDaemon = { ...daemon, token: fs.readFileSync(daemon.tokenFile, "utf8") };
  daemons.push(wrapped);
  return wrapped;
}
function call(port: number, input: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method: input.method ?? "GET", path: input.path, headers: input.headers }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (chunk: Buffer) => parts.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts).toString("utf8") }));
    });
    req.setTimeout(10_000, () => req.destroy(new Error(`timed out: ${input.method ?? "GET"} ${input.path}`)));
    req.on("error", reject);
    req.end(input.body);
  });
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const jsonHeaders = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
async function send(daemon: TestDaemon, method: string, route: string, options: { body?: unknown; raw?: string | Buffer } = {}): Promise<HttpResult> {
  const raw = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  return call(daemon.port, { method, path: route, headers: raw === undefined ? bearer(daemon.token) : jsonHeaders(daemon.token), ...(raw === undefined ? {} : { body: raw }) });
}
const json = (result: HttpResult): JsonObject => JSON.parse(result.body) as JsonObject;
const nodeJob = (extra: JsonObject = {}): JsonObject => ({ command: process.execPath, args: ["-e", "0"], ...extra });
const TERMINAL = new Set(["exited", "failed", "killed", "lost"]);
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

/** Polls the job until `accept` matches its state; the daemon has no other wait route. */
async function waitForState(daemon: TestDaemon, jobId: string, accept: (state: string) => boolean, timeoutMs = 8000): Promise<JsonObject> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await send(daemon, "GET", `/v1/jobs/${encodeURIComponent(jobId)}`);
    if (result.status === 200) {
      const view = json(result);
      if (accept((view.job as { state: string }).state)) return view;
    }
    if (Date.now() >= deadline) throw new Error(`job ${jobId} did not settle: ${result.body}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("GET /v1/jobs lists, filters and pages, and validates its query", async () => {
  const daemon = await serveFleet();
  for (const jobId of ["list-a", "list-b"]) expect((await send(daemon, "POST", "/v1/jobs", { body: nodeJob({ jobId }) })).status).toBe(201);
  for (const jobId of ["list-a", "list-b"]) await waitForState(daemon, jobId, (state) => TERMINAL.has(state));

  const all = await send(daemon, "GET", "/v1/jobs");
  expect(all.status).toBe(200);
  expect(all.headers["cache-control"]).toBe("no-store");
  const page = json(all) as { jobs: Array<{ jobId: string; command?: string }>; nextAfter: string | null };
  expect(page.jobs.map((job) => job.jobId).sort()).toEqual(["list-a", "list-b"]);
  expect(page.nextAfter).toBeNull();
  expect(page.jobs.every((job) => job.command === process.execPath)).toBe(true); // admin sees command lines

  const first = await send(daemon, "GET", "/v1/jobs?limit=1");
  const one = json(first) as { jobs: Array<{ jobId: string }>; nextAfter: string | null };
  expect(one.jobs).toHaveLength(1);
  expect(one.nextAfter).toBe(one.jobs[0]!.jobId);
  expect(((await send(daemon, "GET", `/v1/jobs?limit=1&after=${one.nextAfter}`)).status)).toBe(200);

  const exited = await send(daemon, "GET", `/v1/jobs?state=exited&peer=${encodeURIComponent(os.userInfo().username)}`);
  expect(((json(exited) as { jobs: unknown[] }).jobs)).toHaveLength(2);
  expect((await send(daemon, "GET", "/v1/jobs?whatever=1")).status).toBe(200); // unknown parameters are ignored

  for (const [query, field] of [["limit=0", "limit"], ["limit=abc", "limit"], ["limit=", "limit"], ["limit=501", "limit"], ["state=bogus", "state"]] as const) {
    const rejected = await send(daemon, "GET", `/v1/jobs?${query}`);
    expect([query, rejected.status]).toEqual([query, 400]);
    expect(json(rejected)).toMatchObject({ code: "E_INVALID_REQUEST", details: { field } });
  }
});

test("POST /v1/jobs answers 201 for running and 202 for queued, and rejects bad bodies", async () => {
  const daemon = await serveFleet();
  const held = await send(daemon, "POST", "/v1/jobs", { body: nodeJob({ jobId: "held", args: ["-e", "setInterval(() => {}, 1000)"] }) });
  expect(held.status).toBe(201);
  expect((json(held).job as { state: string }).state).toBe("running");

  const queued = await send(daemon, "POST", "/v1/jobs", { body: nodeJob({ jobId: "waiting", priority: 5, dependsOn: ["held"] }) });
  expect(queued.status).toBe(202);
  expect((json(queued).job as { state: string }).state).toBe("queued");

  const unknown = await send(daemon, "POST", "/v1/jobs", { body: { command: "x", nope: true } });
  expect(unknown.status).toBe(400);
  expect(json(unknown)).toMatchObject({ code: "E_INVALID_REQUEST", details: { field: "nope" } });
  const twoUnknown = await send(daemon, "POST", "/v1/jobs", { body: { command: "x", zed: 1, alpha: 2 } });
  expect((json(twoUnknown).details as { field: string }).field).toBe("zed"); // the first unknown property wins

  const notObject = await send(daemon, "POST", "/v1/jobs", { body: [] });
  expect(notObject.status).toBe(400);
  expect(json(notObject)).toMatchObject({ code: "E_INVALID_REQUEST", details: { field: "body" } });
  const malformed = await send(daemon, "POST", "/v1/jobs", { raw: "{" });
  expect(malformed.status).toBe(400);
  expect(json(malformed)).toMatchObject({ code: "E_INVALID_REQUEST", details: { field: "body" } });

  const missingCommand = await send(daemon, "POST", "/v1/jobs", { body: { args: [] } });
  expect(missingCommand.status).toBe(400);
  expect(json(missingCommand)).toMatchObject({ details: { field: "command" } });
  const duplicate = await send(daemon, "POST", "/v1/jobs", { body: nodeJob({ jobId: "held" }) });
  expect(duplicate.status).toBe(409);
  expect(json(duplicate).code).toBe("E_JOB_EXISTS");
  const dependency = await send(daemon, "POST", "/v1/jobs", { body: nodeJob({ jobId: "ghostly", dependsOn: ["ghost"] }) });
  expect(dependency.status).toBe(422);
  expect(json(dependency).code).toBe("E_DEPENDENCY_NOT_FOUND");

  // The limit is inclusive: 65 536 bytes reach validation, 65 537 bytes are refused unread.
  const head = `{"command":"x","pad":"`, tail = `"}`, pad = 65_536 - Buffer.byteLength(head) - Buffer.byteLength(tail);
  const atLimit = await send(daemon, "POST", "/v1/jobs", { raw: head + "a".repeat(pad) + tail });
  expect(atLimit.status).toBe(400);
  expect(json(atLimit)).toMatchObject({ details: { field: "pad" } });
  const oversized = await send(daemon, "POST", "/v1/jobs", { raw: head + "a".repeat(pad + 1) + tail });
  expect(oversized.status).toBe(413);
  expect(json(oversized)).toMatchObject({ code: "E_BODY_TOO_LARGE" });

  await send(daemon, "POST", "/v1/jobs/waiting/kill", { body: {} });
  await send(daemon, "POST", "/v1/jobs/held/kill", { body: {} });
});

test("job detail, output, events, kill and job ID validation", async () => {
  const daemon = await serveFleet();
  const created = await send(daemon, "POST", "/v1/jobs", {
    body: { command: process.execPath, args: ["-e", "process.stdout.write('route-line\\n'); setTimeout(() => {}, 50)"], jobId: "out-job" },
  });
  expect(created.status).toBe(201);
  const view = await waitForState(daemon, "out-job", (state) => TERMINAL.has(state));
  expect((view.job as { state: string }).state).toBe("exited");
  expect(view.record).toBeDefined(); // admin sees the full record

  const detail = await send(daemon, "GET", "/v1/jobs/out-job");
  expect(detail.status).toBe(200);
  expect((json(detail).job as { jobId: string }).jobId).toBe("out-job");

  const output = await send(daemon, "GET", "/v1/jobs/out-job/output?stream=stdout&tail=50");
  expect(output.status).toBe(200);
  const page = json(output) as { chunks: Array<{ data: string }>; source: string };
  expect(page.source).toBe("memory");
  expect(page.chunks.map((chunk) => chunk.data).join("")).toContain("route-line");

  const events = await send(daemon, "GET", "/v1/jobs/out-job/events?types=state&limit=10");
  expect(events.status).toBe(200);
  const eventPage = json(events) as { events: Array<{ type: string }> };
  expect(eventPage.events.length).toBeGreaterThan(0);
  expect(new Set(eventPage.events.map((event) => event.type))).toEqual(new Set(["state"]));

  for (const [query, field] of [
    ["stream=stdout,stderr", "stream"], ["since=-1", "since"], ["since=abc", "since"], ["limit=0", "limit"],
    ["maxBytes=4194305", "maxBytes"], ["encoding=latin1", "encoding"], ["tail=0", "tail"], ["tail=10001", "tail"],
  ] as const) {
    const rejected = await send(daemon, "GET", `/v1/jobs/out-job/output?${query}`);
    expect([query, rejected.status]).toEqual([query, 400]);
    expect(json(rejected)).toMatchObject({ details: { field } });
  }
  for (const [query, field] of [["types=bogus", "types"], ["limit=0", "limit"], ["since=x", "since"]] as const) {
    const rejected = await send(daemon, "GET", `/v1/jobs/out-job/events?${query}`);
    expect([query, rejected.status]).toEqual([query, 400]);
    expect(json(rejected)).toMatchObject({ details: { field } });
  }

  for (const route of ["/v1/jobs/nope", "/v1/jobs/nope/output", "/v1/jobs/nope/events"]) {
    const missing = await send(daemon, "GET", route);
    expect([route, missing.status]).toEqual([route, 404]);
    expect(json(missing).code).toBe("E_JOB_NOT_FOUND");
  }
  expect((await send(daemon, "POST", "/v1/jobs/nope/kill", { body: {} })).status).toBe(404);
  for (const route of ["/v1/jobs/..%2F..%2Fetc%2Fpasswd", "/v1/jobs/%2e%2e%2f%2e%2e%2f", "/v1/jobs/%00"]) {
    const traversal = await send(daemon, "GET", route);
    expect([route, traversal.status]).toEqual([route, 404]);
    expect(json(traversal).code).toBe("E_JOB_NOT_FOUND");
  }

  await send(daemon, "POST", "/v1/jobs", { body: nodeJob({ jobId: "no-capture", capture: false }) });
  await waitForState(daemon, "no-capture", (state) => TERMINAL.has(state));
  const noOutput = await send(daemon, "GET", "/v1/jobs/no-capture/output");
  expect(noOutput.status).toBe(409);
  expect(json(noOutput).code).toBe("E_CAPTURE_DISABLED");
  expect((await send(daemon, "GET", "/v1/jobs/no-capture/events")).status).toBe(409);

  const running = await send(daemon, "POST", "/v1/jobs", { body: nodeJob({ jobId: "kill-me", args: ["-e", "setInterval(() => {}, 1000)"] }) });
  expect(running.status).toBe(201);
  const killed = await send(daemon, "POST", "/v1/jobs/kill-me/kill", { body: { detail: "stop" } });
  expect(killed.status).toBe(200);
  const killedBody = json(killed) as { job: { state: string }; result: { killedPids: number[] } | null };
  expect(killedBody.job.state).toBe("killed");
  expect(killedBody.result).not.toBeNull();
  const again = await send(daemon, "POST", "/v1/jobs/kill-me/kill", { body: {} });
  expect(again.status).toBe(200);
  expect((json(again) as { result: unknown }).result).toBeNull(); // idempotent for a terminal job
  for (const body of [{ detail: 42 }, { detail: "x".repeat(501) }]) {
    const rejected = await send(daemon, "POST", "/v1/jobs/kill-me/kill", { body });
    expect(rejected.status).toBe(400);
    expect(json(rejected)).toMatchObject({ details: { field: "detail" } });
  }
});

test("output of a spool-off job supervised elsewhere is 410", async () => {
  const caller: Caller = { kind: "admin" };
  const fleet = await FleetService.open({ surface: "library" });
  try {
    await fleet.submit({ command: process.execPath, args: ["-e", "0"], jobId: "spool-off", spool: "off" }, caller);
    await fleet.wait("spool-off", 8000);
  } finally { await fleet.close(); }
  const daemon = await serveFleet();
  const response = await send(daemon, "GET", "/v1/jobs/spool-off/output");
  expect(response.status).toBe(410);
  expect(json(response).code).toBe("E_OUTPUT_UNAVAILABLE");
});

test("queue, policy and lease routes", async () => {
  const daemon = await serveFleet();
  const queue = await send(daemon, "GET", "/v1/queue");
  expect(queue.status).toBe(200);
  const queueBody = json(queue) as { entries: unknown[]; guards: Array<{ rule: string }>; policy: { maxRunning: number } };
  expect(queueBody.entries).toEqual([]);
  expect(queueBody.guards.map((guard) => guard.rule)).toEqual(["gpu-busy", "npu-busy", "memory-low"]);
  expect(queueBody.policy.maxRunning).toBe(8);
  expect(((json(await send(daemon, "GET", "/v1/policy")).policy) as { maxRunning: number }).maxRunning).toBe(8);

  const updated = await send(daemon, "PUT", "/v1/policy", { body: { ...DEFAULT_ADMISSION_POLICY, maxRunning: 3 } });
  expect(updated.status).toBe(200);
  expect(((json(updated).policy) as { maxRunning: number }).maxRunning).toBe(3);
  expect(fs.existsSync(path.join(root, "fleet", "policy.json"))).toBe(true);
  for (const [body, field] of [
    [{ ...DEFAULT_ADMISSION_POLICY, maxRunning: 0 }, "maxRunning"],
    [{ ...DEFAULT_ADMISSION_POLICY, extra: 1 }, "extra"],
    [{ maxRunning: 3 }, "harnessLimits"],
  ] as Array<[Record<string, unknown>, string]>) {
    const rejected = await send(daemon, "PUT", "/v1/policy", { body });
    expect(rejected.status).toBe(400);
    expect(json(rejected)).toMatchObject({ code: "E_INVALID_REQUEST", details: { field } });
  }

  const created = await send(daemon, "POST", "/v1/leases", { body: { port: 47_654 } });
  expect(created.status).toBe(201);
  const lease = json(created).lease as { leaseId: string; sessionId: string; peer: string; jobId: string | null; holder: { pid: number; surface: string } };
  expect(lease).toMatchObject({ port: 47_654, sessionId: "daemon", peer: os.userInfo().username, jobId: null });
  expect(lease.holder).toMatchObject({ pid: process.pid, surface: "daemon" });
  expect((await send(daemon, "POST", "/v1/leases", { body: { port: 47_654 } })).status).toBe(409);
  const listed = json(await send(daemon, "GET", "/v1/leases")).leases as Array<{ leaseId: string }>;
  expect(listed[0]!.leaseId).toBe(lease.leaseId); // admin sees leaseId

  const wrongRenew = await send(daemon, "POST", "/v1/leases/47654/renew", { body: { leaseId: "not-it" } });
  expect(wrongRenew.status).toBe(403);
  expect(json(wrongRenew).code).toBe("E_NOT_OWNER");
  const renewed = await send(daemon, "POST", "/v1/leases/47654/renew", { body: { leaseId: lease.leaseId } });
  expect(renewed.status).toBe(200);
  expect((json(renewed).lease as { leaseId: string }).leaseId).toBe(lease.leaseId);
  const missingRenew = await send(daemon, "POST", "/v1/leases/47655/renew", { body: { leaseId: lease.leaseId } });
  expect(missingRenew.status).toBe(404);
  expect(json(missingRenew).code).toBe("E_LEASE_NOT_FOUND");
  for (const [body, field] of [
    [{ port: 0 }, "port"], [{ port: "47654" }, "port"], [{ port: 47654.5 }, "port"],
    [{ port: 47_654, ttlMs: 9_999 }, "ttlMs"], [{ port: 47_654, extra: true }, "extra"], [{}, "port"],
  ] as Array<[Record<string, unknown>, string]>) {
    const rejected = await send(daemon, "POST", "/v1/leases", { body });
    expect([JSON.stringify(body), rejected.status]).toEqual([JSON.stringify(body), 400]);
    expect(json(rejected)).toMatchObject({ details: { field } });
  }
  for (const route of ["/v1/leases/notaport/renew", "/v1/leases/70000/renew"]) {
    const rejected = await send(daemon, "POST", route, { body: { leaseId: "x" } });
    expect([route, rejected.status]).toEqual([route, 400]);
    expect(json(rejected)).toMatchObject({ details: { field: "port" } });
  }

  expect((await send(daemon, "DELETE", "/v1/leases/47654?leaseId=other")).status).toBe(403);
  const released = await send(daemon, "DELETE", `/v1/leases/47654?leaseId=${lease.leaseId}`);
  expect(released.status).toBe(200);
  expect(json(released)).toEqual({ released: true });
  expect((await send(daemon, "DELETE", "/v1/leases/47654")).status).toBe(404);
  expect((await send(daemon, "POST", "/v1/leases", { body: { port: 47_656 } })).status).toBe(201);
  expect((await send(daemon, "DELETE", "/v1/leases/47656")).status).toBe(200); // leaseId is optional for admin

  const heldLease = await send(daemon, "POST", "/v1/leases", { body: { port: 47_657 } });
  expect(heldLease.status).toBe(201);
  const blocked = await send(daemon, "POST", "/v1/jobs", { body: { ...nodeJob({ jobId: "port-blocked" }), leasePorts: [47_657], admission: "immediate" } });
  expect(blocked.status).toBe(409);
  expect(json(blocked).code).toBe("E_LEASE_CONFLICT");
  const heldLeaseId = (json(heldLease).lease as { leaseId: string }).leaseId;
  expect((await send(daemon, "DELETE", `/v1/leases/47657?leaseId=${heldLeaseId}`)).status).toBe(200);
  expect((await send(daemon, "POST", "/v1/jobs", { body: { ...nodeJob({ jobId: "port-allowed" }), leasePorts: [47_657], admission: "immediate" } })).status).toBe(201);

  expect((await send(daemon, "POST", "/v1/jobs", { body: nodeJob({ jobId: "queue-hold", args: ["-e", "setInterval(() => {}, 1000)"] }) })).status).toBe(201);
  expect((await send(daemon, "POST", "/v1/jobs", { body: nodeJob({ jobId: "queue-wait", priority: 5, dependsOn: ["queue-hold"] }) })).status).toBe(202);
  const withEntry = await send(daemon, "GET", "/v1/queue");
  expect(((json(withEntry).entries) as Array<{ jobId: string }>).some((entry) => entry.jobId === "queue-wait")).toBe(true);
  await send(daemon, "POST", "/v1/jobs/queue-wait/kill", { body: {} });
  await send(daemon, "POST", "/v1/jobs/queue-hold/kill", { body: {} });
});

test("v0.1 routes and authentication keep their exact behavior", async () => {
  const daemon = await serveFleet();
  const harnesses = await send(daemon, "GET", "/v1/harnesses");
  expect(harnesses.status).toBe(200);
  expect(Array.isArray(json(harnesses))).toBe(true);

  const unknown = await send(daemon, "GET", "/v1/no-such");
  expect(unknown.status).toBe(404);
  expect(json(unknown)).toEqual({ error: "Route not found." });
  const wrongMethod = await send(daemon, "DELETE", "/v1/jobs");
  expect(wrongMethod.status).toBe(404);
  expect(json(wrongMethod)).toEqual({ error: "Route not found." });

  const badSpawn = await send(daemon, "POST", "/v1/agents", { raw: "not json" });
  expect(badSpawn.status).toBe(400);
  expect(json(badSpawn)).toMatchObject({ error: expect.any(String) });
  expect(json(badSpawn).code).toBeUndefined(); // v0.1 keeps its { error } body

  const anonymous = await call(daemon.port, { path: "/v1/jobs" });
  expect(anonymous.status).toBe(401);
  expect(anonymous.body).toContain("Bearer token required");
  expect(anonymous.body).not.toContain(daemon.token);
  const crossOrigin = await call(daemon.port, { path: "/v1/jobs", headers: { ...bearer(daemon.token), origin: "http://evil.example" } });
  expect(crossOrigin.status).toBe(401);

  const authorized = await send(daemon, "GET", "/v1/jobs");
  expect(authorized.status).toBe(200);
  expect(authorized.body).not.toContain(daemon.token);
});

test("close() closes the fleet and stops fleet jobs", async () => {
  const daemon = await serveFleet();
  const created = await send(daemon, "POST", "/v1/jobs", {
    body: nodeJob({ jobId: "close-job", capture: false, args: ["-e", "setInterval(() => {}, 1000)"] }),
  });
  expect(created.status).toBe(201);
  const pid = (json(created).job as { rootPid: number }).rootPid;
  expect(alive(pid)).toBe(true);
  await daemon.close();
  expect(alive(pid)).toBe(false);
  await daemon.close();
}, 20000);

test("review fixes: tokenHash hidden, strict kill/renew bodies, no retry after a lease takeover", async () => {
  const daemon = await serveFleet();
  const created = await send(daemon, "POST", "/v1/jobs", { body: nodeJob({ jobId: "hash-job", capture: false }) });
  expect(created.status).toBe(201);
  const detail = json(await send(daemon, "GET", "/v1/jobs/hash-job")) as { record: { owner: { tokenHash: string } } };
  expect(detail.record.owner.tokenHash).toBe("");
  const kill = await send(daemon, "POST", "/v1/jobs/hash-job/kill", { body: { detail: "x", extra: 1 } });
  expect(kill.status).toBe(400); expect((json(kill).details as { field: string }).field).toBe("extra");
  const renew = await send(daemon, "POST", "/v1/leases/47655/renew", { body: { leaseId: "a", extra: 1 } });
  expect(renew.status).toBe(400); expect((json(renew).details as { field: string }).field).toBe("extra");

  // Another process takes the port between the route's read and its release: the newcomer must survive.
  const { handleFleetRoute } = await import("../src/daemon-routes.js");
  const { FleetError } = await import("../src/fleet-errors.js");
  const released: string[] = [];
  let current = "old";
  const fake = { leases: {
    get: () => ({ port: 47656, leaseId: current }),
    release: (_port: number, leaseId: string) => {
      if (leaseId === "old") { current = "new"; throw new FleetError("E_NOT_OWNER", "replaced"); }
      released.push(leaseId);
    },
  } } as unknown as FleetService;
  const ctx = { method: "DELETE", path: "/v1/leases/47656", query: new URLSearchParams(), readBody: async () => ({}) };
  const error = await handleFleetRoute(fake, ctx).then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(FleetError);
  expect((error as InstanceType<typeof FleetError>).code).toBe("E_LEASE_CONFLICT");
  expect(released).toEqual([]);
}, 20000);
