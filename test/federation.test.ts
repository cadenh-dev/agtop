import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import * as https from "node:https";
import { createServer as createNetServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { readAudit } from "../src/audit.js";
import { startDaemon } from "../src/daemon.js";
import { FleetService, type SubmitJobRequest } from "../src/fleet.js";
import { FleetError } from "../src/fleet-errors.js";
import type { Caller } from "../src/ownership.js";
import { PeerAuth, signRequest } from "../src/remote/auth.js";
import { RemoteProxy } from "../src/remote/proxy.js";
import { PeerRegistry } from "../src/remote/registry.js";
import { startFederationListener, type FederationListener } from "../src/remote/server.js";
import type { DaemonPeer, FleetErrorBody, FleetErrorCode, PeerScope } from "../src/types.js";

// TEST ONLY: a throwaway self-signed localhost certificate and key for these tests. Never use elsewhere.
const KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgv9FEHasI/qBCOqgs
SIHiTMYog+je7WJg1Zks2/ATYxmhRANCAARqNYcWBQ6N0+a+hjiYLy7Ab2nBTGHn
cu4NWkZodCnFjyI0aokfl/bGDp8DuSEBu0P8bVEl1cC+24LDY4TX59rG
-----END PRIVATE KEY-----`;
const CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBmTCCAT+gAwIBAgIUQ77NVZ6prHU37i49scOpm6fq9ekwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTExMTA2NTUxM1oXDTM2MTEwODA2
NTUxM1owFDESMBAGA1UEAwwJbG9jYWxob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEajWHFgUOjdPmvoY4mC8uwG9pwUxh53LuDVpGaHQpxY8iNGqJH5f2xg6f
A7khAbtD/G1RJdXAvtuCw2OE1+faxqNvMG0wHQYDVR0OBBYEFOUU20BCiQVAPksn
o3/Gi8pnpBKhMB8GA1UdIwQYMBaAFOUU20BCiQVAPksno3/Gi8pnpBKhMBoGA1Ud
EQQTMBGCCWxvY2FsaG9zdIcEfwAAATAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49
BAMCA0gAMEUCIEx2dYcDsfF4ZVpe9VE2EdupRmO+cC7+48X4w6oD8NA4AiEA1bRr
TOzOL6esWRgfi4WJop0dVzOUU4KXPDtuNl4JOZA=
-----END CERTIFICATE-----`;

const ALL: PeerScope[] = ["jobs:list", "jobs:read", "jobs:output", "jobs:events", "jobs:submit", "jobs:kill", "jobs:kill-any", "telemetry:read"];
const ADMIN: Caller = { kind: "admin" };
const Q = new URLSearchParams();
const fleets: FleetService[] = [];
const listeners: FederationListener[] = [];
const daemons: Array<Awaited<ReturnType<typeof startDaemon>>> = [];
let root = "", certFile = "", keyFile = "", previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.AGTOP_STATE_DIR;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-federation-"));
  process.env.AGTOP_STATE_DIR = root;
  certFile = path.join(root, "cert.pem"); keyFile = path.join(root, "key.pem");
  fs.writeFileSync(certFile, CERT_PEM); fs.writeFileSync(keyFile, KEY_PEM);
});
afterEach(async () => {
  for (const listener of listeners.splice(0)) await listener.close().catch(() => undefined);
  for (const daemon of daemons.splice(0)) await daemon.close().catch(() => undefined);
  for (const fleet of fleets.splice(0)) await fleet.close().catch(() => undefined);
  fs.rmSync(root, { recursive: true, force: true });
  if (previousStateDir === undefined) delete process.env.AGTOP_STATE_DIR; else process.env.AGTOP_STATE_DIR = previousStateDir;
});

async function openFleet(): Promise<FleetService> {
  const fleet = await FleetService.open({ surface: "library", guard: { accelerators: () => undefined, freeMemoryMb: () => 100_000 } });
  fleets.push(fleet);
  return fleet;
}
const nodeJob = (extra: Record<string, unknown> = {}): SubmitJobRequest => ({ command: process.execPath, args: ["-e", "0"], ...extra });
const aliveJob = (extra: Record<string, unknown> = {}): SubmitJobRequest => ({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], ...extra });

async function federation(options: { scopes?: PeerScope[]; prefixes?: string[]; fleet?: FleetService } = {}) {
  const fleet = options.fleet ?? await openFleet();
  const serverRegistry = new PeerRegistry(), identity = serverRegistry.ensureIdentity("node-a");
  const clientRegistry = new PeerRegistry({ dir: path.join(root, "client") }), clientIdentity = clientRegistry.ensureIdentity("node-b");
  const grant = (scopes: PeerScope[], prefixes: string[] = []): DaemonPeer => serverRegistry.upsert({
    id: "node-b", url: "https://node-b.example", publicKey: clientIdentity.publicKey, scopes, jobPeerPrefixes: prefixes,
  });
  grant(options.scopes ?? [...ALL], options.prefixes ?? []);
  const listener = await startFederationListener({
    fleet, registry: serverRegistry, auth: new PeerAuth(serverRegistry), port: 0, host: "127.0.0.1", certFile, keyFile,
  });
  listeners.push(listener);
  clientRegistry.upsert({ id: "node-a", url: `https://127.0.0.1:${listener.port}`, publicKey: identity.publicKey, scopes: [], tlsCertPem: CERT_PEM });
  const proxy = new RemoteProxy(clientRegistry);
  return { fleet, listener, proxy, serverRegistry, clientRegistry, clientPublicKey: clientIdentity.publicKey, grant };
}
type Ctx = Awaited<ReturnType<typeof federation>>;

async function fed(proxy: RemoteProxy, method: "GET" | "POST", path: string, options: { query?: string; body?: unknown } = {}) {
  return proxy.forward("node-a", method, path, new URLSearchParams(options.query ?? ""), options.body);
}
function failed(result: { status: number; body: unknown }, status: number, code: FleetErrorCode): void {
  expect([result.status, (result.body as FleetErrorBody).code]).toEqual([status, code]);
}
async function rejected(fn: () => Promise<unknown>): Promise<FleetError> {
  try { await fn(); } catch (error) { expect(error).toBeInstanceOf(FleetError); return error as FleetError; }
  throw new Error("Expected a FleetError.");
}
function tlsRequest(port: number, method: string, target: string, options: { headers?: Record<string, string>; body?: Buffer } = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: "127.0.0.1", port, method, path: target, ca: [CERT_PEM], headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject); req.end(options.body);
  });
}
function httpCall(port: number, method: string, target: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path: target, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject); req.end(body);
  });
}
async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function portBindable(port: number): Promise<boolean> {
  const server = createNetServer();
  try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); }); return true; }
  catch { return false; }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test("hello returns the caller's granted scopes and every route enforces its scope", async () => {
  const ctx = await federation();
  expect((await fed(ctx.proxy, "GET", "/fed/v1/hello")).body).toEqual({ id: "node-a", version: "0.2.0", scopes: ALL });
  ctx.grant([]);
  expect((await fed(ctx.proxy, "GET", "/fed/v1/hello")).body).toEqual({ id: "node-a", version: "0.2.0", scopes: [] });
  const cases: Array<[() => Promise<{ status: number; body: unknown }>, PeerScope[]]> = [
    [() => fed(ctx.proxy, "GET", "/fed/v1/jobs"), ["jobs:list"]],
    [() => fed(ctx.proxy, "GET", "/fed/v1/jobs/some-job"), ["jobs:read"]],
    [() => fed(ctx.proxy, "GET", "/fed/v1/jobs/some-job/output"), ["jobs:output"]],
    [() => fed(ctx.proxy, "GET", "/fed/v1/jobs/some-job/events"), ["jobs:events"]],
    [() => fed(ctx.proxy, "POST", "/fed/v1/jobs", { body: { command: "echo" } }), ["jobs:submit"]],
    [() => fed(ctx.proxy, "POST", "/fed/v1/jobs/some-job/kill", { body: {} }), ["jobs:kill", "jobs:kill-any"]],
    [() => fed(ctx.proxy, "GET", "/fed/v1/telemetry"), ["telemetry:read"]],
  ];
  for (const [call, missing] of cases) {
    ctx.grant(ALL.filter((granted) => !missing.includes(granted)));
    const result = await call();
    expect([missing[0], result.status]).toEqual([missing[0], 403]);
    expect(result.body).toMatchObject({ code: "E_FORBIDDEN_SCOPE", details: { scope: missing[0] } });
  }
  ctx.grant([...ALL]);
  expect((await fed(ctx.proxy, "GET", "/fed/v1/jobs")).status).toBe(200);
  failed(await fed(ctx.proxy, "GET", "/fed/v1/nope"), 404, "E_ROUTE_NOT_FOUND");
});

test("unsigned, tampered, bearer-token and non-federation requests are refused", async () => {
  const ctx = await federation();
  const unsigned = await tlsRequest(ctx.listener.port, "GET", "/fed/v1/hello");
  failed({ status: unsigned.status, body: JSON.parse(unsigned.body) }, 401, "E_UNAUTHORIZED");
  const bearer = await tlsRequest(ctx.listener.port, "GET", "/fed/v1/hello", { headers: { authorization: `Bearer ${"x".repeat(32)}` } });
  failed({ status: bearer.status, body: JSON.parse(bearer.body) }, 401, "E_UNAUTHORIZED");
  const wrongAudience = signRequest(ctx.clientRegistry.privateKey(), {
    method: "GET", pathWithQuery: "/fed/v1/hello", senderId: "node-b", audienceId: "node-x", body: Buffer.alloc(0),
  });
  const tampered = await tlsRequest(ctx.listener.port, "GET", "/fed/v1/hello", { headers: { ...wrongAudience } });
  failed({ status: tampered.status, body: JSON.parse(tampered.body) }, 401, "E_SIGNATURE_INVALID");
  for (const target of ["/v1/jobs", "/fed/v2/hello", "/"]) {
    const outside = await tlsRequest(ctx.listener.port, "GET", target);
    failed({ status: outside.status, body: JSON.parse(outside.body) }, 404, "E_ROUTE_NOT_FOUND");
  }
});

test("lists only visible jobs, reports invisible ones as E_JOB_NOT_FOUND, and submits as the peer", async () => {
  const ctx = await federation();
  await ctx.fleet.submit(nodeJob({ jobId: "local-job", peer: "local-user" }), ADMIN);
  await ctx.fleet.wait("local-job", 8000);
  const submitted = await fed(ctx.proxy, "POST", "/fed/v1/jobs", { body: nodeJob({ jobId: "remote-job" }) });
  expect(submitted.status).toBe(201);
  const job = (submitted.body as { job: Record<string, unknown> }).job;
  expect(job).toMatchObject({ jobId: "remote-job", owned: true, ownerSessionId: "peer:node-b", surface: "remote" });
  expect(String(job.peer).startsWith("peer:node-b")).toBe(true);
  await ctx.fleet.wait("remote-job", 8000);

  const list = await fed(ctx.proxy, "GET", "/fed/v1/jobs");
  const ids = (list.body as { jobs: Array<{ jobId: string }> }).jobs.map((entry) => entry.jobId);
  expect(ids).toContain("remote-job"); expect(ids).not.toContain("local-job");
  expect(ctx.fleet.list({}, ADMIN).jobs.map((entry) => entry.jobId).sort()).toEqual(["local-job", "remote-job"]);

  const view = await fed(ctx.proxy, "GET", "/fed/v1/jobs/remote-job");
  const record = (view.body as { record: { owner: unknown } }).record;
  expect(record.owner).toEqual({ sessionId: "peer:node-b", tokenHash: "", surface: "remote", remotePeerId: "node-b" });
  const audit = readAudit(200).filter((entry) => entry.event === "peer-submit" && entry.jobId === "remote-job");
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ actor: "peer:node-b", peerId: "node-b", jobId: "remote-job" });

  for (const [method, target] of [["GET", "/fed/v1/jobs/local-job"], ["GET", "/fed/v1/jobs/local-job/output"],
    ["GET", "/fed/v1/jobs/local-job/events"], ["POST", "/fed/v1/jobs/local-job/kill"]] as const) {
    const result = await fed(ctx.proxy, method, target, method === "POST" ? { body: {} } : {});
    expect([target, result.status]).toEqual([target, 404]);
    expect((result.body as FleetErrorBody).code).toBe("E_JOB_NOT_FOUND");
  }
}, 15_000);

test("peer submissions cannot set redact:false, extraEnv or cgroupRoot", async () => {
  const ctx = await federation();
  const cases: Array<[Record<string, unknown>, string]> = [[{ redact: false }, "redact"], [{ extraEnv: { A: "b" } }, "extraEnv"], [{ cgroupRoot: "/tmp/x" }, "cgroupRoot"]];
  for (const [extra, field] of cases) {
    const result = await fed(ctx.proxy, "POST", "/fed/v1/jobs", { body: nodeJob({ jobId: `bad-${field}`, ...extra }) });
    expect([field, result.status]).toEqual([field, 400]);
    expect(result.body).toMatchObject({ code: "E_INVALID_REQUEST", details: { field } });
  }
  expect(ctx.fleet.list({}, ADMIN).jobs.filter((entry) => entry.jobId.startsWith("bad-"))).toHaveLength(0);
});

test("a peer kills its own job with jobs:kill; another peer's job needs jobs:kill-any and is audited", async () => {
  const ctx = await federation({ scopes: ["jobs:list", "jobs:read", "jobs:submit", "jobs:kill"], prefixes: ["shared-"] });
  expect((await fed(ctx.proxy, "POST", "/fed/v1/jobs", { body: aliveJob({ jobId: "own-job" }) })).status).toBe(201);
  const killed = await fed(ctx.proxy, "POST", "/fed/v1/jobs/own-job/kill", { body: { detail: "stop" } });
  expect(killed.status).toBe(200);
  expect((killed.body as { job: { state: string } }).job.state).toBe("killed");
  expect(readAudit(200).filter((entry) => entry.event === "peer-kill" && entry.jobId === "own-job")).toHaveLength(1);

  await ctx.fleet.submit(aliveJob({ jobId: "shared-job", peer: "shared-1" }), ADMIN);
  const denied = await fed(ctx.proxy, "POST", "/fed/v1/jobs/shared-job/kill", { body: {} });
  failed(denied, 403, "E_FORBIDDEN_SCOPE");
  expect(denied.body).toMatchObject({ details: { scope: "jobs:kill-any" } });
  ctx.grant(["jobs:list", "jobs:read", "jobs:submit", "jobs:kill", "jobs:kill-any"], ["shared-"]);
  expect((await fed(ctx.proxy, "POST", "/fed/v1/jobs/shared-job/kill", { body: {} })).status).toBe(200);
  expect(readAudit(200).filter((entry) => entry.event === "peer-kill" && entry.jobId === "shared-job")).toHaveLength(1);
}, 15_000);

test("events blank the owner token hash; visibility all grants output", async () => {
  const ctx = await federation({ scopes: ["jobs:list", "jobs:read", "jobs:output", "jobs:events"], prefixes: ["shared-"] });
  await ctx.fleet.submit({ ...nodeJob({ jobId: "visible-job", peer: "shared-1", args: ["-e", "console.log('hello-from-job')"] }), visibility: "all" }, ADMIN);
  await ctx.fleet.wait("visible-job", 8000);
  const events = await fed(ctx.proxy, "GET", "/fed/v1/jobs/visible-job/events", { query: "types=state" });
  expect(events.status).toBe(200);
  const state = (events.body as { events: Array<{ record?: { owner: { tokenHash: string; sessionId: string } } }> }).events.find((event) => event.record !== undefined);
  expect(state?.record?.owner.tokenHash).toBe("");
  expect(state?.record?.owner.sessionId.length).toBeGreaterThan(0);
  const output = await fed(ctx.proxy, "GET", "/fed/v1/jobs/visible-job/output");
  expect(output.status).toBe(200);
  expect((output.body as { chunks: Array<{ data: string }> }).chunks.some((chunk) => chunk.data.includes("hello-from-job"))).toBe(true);
}, 15_000);

test("telemetry reports accelerators, running, queued and guards", async () => {
  const ctx = await federation({ scopes: ["telemetry:read"] });
  const result = await fed(ctx.proxy, "GET", "/fed/v1/telemetry");
  expect(result.status).toBe(200);
  const body = result.body as { accelerators: null | { devices: unknown[] }; running: number; queued: number; guards: unknown[] };
  expect(typeof body.running).toBe("number"); expect(typeof body.queued).toBe("number");
  expect(Array.isArray(body.guards)).toBe(true);
  expect(body.accelerators === null || Array.isArray(body.accelerators.devices)).toBe(true);
});

test("a body over 65536 bytes is E_BODY_TOO_LARGE", async () => {
  const ctx = await federation();
  const big = Buffer.alloc(65_537, 0x20);
  const signed = signRequest(ctx.clientRegistry.privateKey(), {
    method: "POST", pathWithQuery: "/fed/v1/jobs", senderId: "node-b", audienceId: "node-a", body: big,
  });
  const result = await tlsRequest(ctx.listener.port, "POST", "/fed/v1/jobs", {
    headers: { ...signed, "content-type": "application/json", "content-length": String(big.length) }, body: big,
  });
  failed({ status: result.status, body: JSON.parse(result.body) }, 413, "E_BODY_TOO_LARGE");
});

test("the listener refuses to start without an identity or with a group-readable key", async () => {
  const fleet = await openFleet();
  const bare = new PeerRegistry();
  const missing = await rejected(() => startFederationListener({ fleet, registry: bare, auth: new PeerAuth(bare), port: 0, host: "127.0.0.1", certFile, keyFile }));
  expect(missing.code).toBe("E_INTERNAL");
  if (process.platform === "win32") return;
  const registry = new PeerRegistry(); registry.ensureIdentity("node-a");
  fs.chmodSync(path.join(root, "fleet", "federation", "identity.key"), 0o644);
  const exposed = await rejected(() => startFederationListener({ fleet, registry, auth: new PeerAuth(registry), port: 0, host: "127.0.0.1", certFile, keyFile }));
  expect(exposed.code).toBe("E_INTERNAL");
});

test("a daemon with federation serves both listeners, never /fed on loopback, and close stops both", async () => {
  const registry = new PeerRegistry(), identity = registry.ensureIdentity("node-a");
  const clientRegistry = new PeerRegistry({ dir: path.join(root, "client") });
  const federationPort = await freePort();
  registry.upsert({ id: "node-b", url: "https://node-b.example", publicKey: clientRegistry.ensureIdentity("node-b").publicKey, scopes: ["jobs:list"] });
  clientRegistry.upsert({ id: "node-a", url: `https://127.0.0.1:${federationPort}`, publicKey: identity.publicKey, scopes: [], tlsCertPem: CERT_PEM });
  const token = randomBytes(32).toString("hex"), bearer = { authorization: `Bearer ${token}` };
  const daemon = await startDaemon({ port: 0, token, federation: { port: federationPort, host: "127.0.0.1", certFile, keyFile } });
  daemons.push(daemon);
  expect((await httpCall(daemon.port, "GET", "/v1/jobs", bearer)).status).toBe(200);
  const proxy = new RemoteProxy(clientRegistry);
  expect(await proxy.forward("node-a", "GET", "/fed/v1/hello", Q)).toMatchObject({ status: 200, body: { id: "node-a", version: "0.2.0" } });
  const loopbackFed = await httpCall(daemon.port, "GET", "/fed/v1/hello", bearer);
  expect(loopbackFed.status).toBe(404);
  await daemon.close();
  expect(fs.existsSync(daemon.tokenFile)).toBe(false);
  await expect(tlsRequest(federationPort, "GET", "/fed/v1/hello")).rejects.toBeDefined();
  await expect(httpCall(daemon.port, "GET", "/v1/jobs", bearer)).rejects.toBeDefined();
});

test("GET and POST /v1/remote/node-a/* through the loopback daemon reach its federation listener", async () => {
  const registry = new PeerRegistry(), identity = registry.ensureIdentity("node-a");
  const federationPort = await freePort(), token = randomBytes(32).toString("hex");
  const daemon = await startDaemon({ port: 0, token, federation: { port: federationPort, host: "127.0.0.1", certFile, keyFile } });
  daemons.push(daemon);
  registry.upsert({
    id: "node-a", url: `https://127.0.0.1:${federationPort}`, publicKey: identity.publicKey,
    scopes: ["jobs:list", "jobs:read", "jobs:submit"], tlsCertPem: CERT_PEM,
  });
  const bearer = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const submit = await httpCall(daemon.port, "POST", "/v1/remote/node-a/jobs", bearer, JSON.stringify({ jobId: "e2e-job", command: process.execPath, args: ["-e", "0"] }));
  expect(submit.status).toBe(201);
  const list = await httpCall(daemon.port, "GET", "/v1/remote/node-a/jobs", bearer);
  expect(list.status).toBe(200);
  expect((JSON.parse(list.body) as { jobs: Array<{ jobId: string }> }).jobs.map((entry) => entry.jobId)).toContain("e2e-job");
}, 15_000);

test("a daemon whose federation listener cannot start cleans up the listener, token file and fleet", async () => {
  const port = await freePort(), token = randomBytes(32).toString("hex");
  await expect(startDaemon({ port, token, federation: { port: 0, host: "127.0.0.1", certFile, keyFile } })).rejects.toBeInstanceOf(FleetError);
  expect(fs.existsSync(path.join(root, `daemon-${port}.token`))).toBe(false);
  expect(await portBindable(port)).toBe(true);
});
