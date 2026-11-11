import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as https from "node:https";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { RouteContext } from "../src/daemon-routes.js";
import { FleetError } from "../src/fleet-errors.js";
import { PeerAuth } from "../src/remote/auth.js";
import { RemoteProxy, REMOTE_MAX_RESPONSE_BYTES } from "../src/remote/proxy.js";
import { PeerRegistry } from "../src/remote/registry.js";
import { handleRemoteRoute } from "../src/remote/routes.js";
import type { DaemonPeer } from "../src/types.js";

// A self-signed P-256 certificate for 127.0.0.1/localhost and its key, generated once with openssl.
// OTHER_CERT_PEM is a second self-signed certificate with the same subject and key but a different
// serial, so pinning it verifies the chain and then fails the SHA-256 fingerprint comparison.
const KEY_PEM = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEINn8dG05KSrdT0SGoVTPU1eDeQmpPjc2G9dRstDL/HKxoAoGCCqGSM49
AwEHoUQDQgAEXKQh50agpfj2LYLgiGpbXZMuG/jJtMfxVsVrFJoO5dFkCjmx7jBj
enpUlqOXZP6LLpzWftjWPkJvycyBGYMZ4Q==
-----END EC PRIVATE KEY-----`;
const CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBhjCCAS2gAwIBAgICA+kwCgYIKoZIzj0EAwIwFDESMBAGA1UEAwwJbG9jYWxo
b3N0MB4XDTI2MTExMTA2MTc0NVoXDTM2MTEwODA2MTc0NVowFDESMBAGA1UEAwwJ
bG9jYWxob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEXKQh50agpfj2LYLg
iGpbXZMuG/jJtMfxVsVrFJoO5dFkCjmx7jBjenpUlqOXZP6LLpzWftjWPkJvycyB
GYMZ4aNvMG0wHQYDVR0OBBYEFJUnplajzZ5uhDP86+dc0Th4vnoXMB8GA1UdIwQY
MBaAFJUnplajzZ5uhDP86+dc0Th4vnoXMA8GA1UdEwEB/wQFMAMBAf8wGgYDVR0R
BBMwEYIJbG9jYWxob3N0hwR/AAABMAoGCCqGSM49BAMCA0cAMEQCIAwiw8t3w1L1
cCg8w8pRXpjKfNC+5pGDYambjZpywpljAiAcBDTPLurPda7ew6CKW/WtDj+jK8re
/tzT/gW3eqPszA==
-----END CERTIFICATE-----`;
const OTHER_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBhzCCAS2gAwIBAgICA+owCgYIKoZIzj0EAwIwFDESMBAGA1UEAwwJbG9jYWxo
b3N0MB4XDTI2MTExMTA2MTc0NVoXDTM2MTEwODA2MTc0NVowFDESMBAGA1UEAwwJ
bG9jYWxob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEXKQh50agpfj2LYLg
iGpbXZMuG/jJtMfxVsVrFJoO5dFkCjmx7jBjenpUlqOXZP6LLpzWftjWPkJvycyB
GYMZ4aNvMG0wHQYDVR0OBBYEFJUnplajzZ5uhDP86+dc0Th4vnoXMB8GA1UdIwQY
MBaAFJUnplajzZ5uhDP86+dc0Th4vnoXMA8GA1UdEwEB/wQFMAMBAf8wGgYDVR0R
BBMwEYIJbG9jYWxob3N0hwR/AAABMAoGCCqGSM49BAMCA0gAMEUCIQD1w2y89GEr
BXGESvxut9BY0BEBOx+xo2Kcm0/d8BuGtAIgbdW0TnF/bfQcJ/OQ8aone1D5l3eq
/UDBVtelulUpSb4=
-----END CERTIFICATE-----`;

interface Received { method: string; pathWithQuery: string; body: string; peer: string }
type Reply = "slow" | { status: number; body: unknown; headers?: Record<string, string> } | { raw: string | Buffer; status?: number; headers?: Record<string, string> };
type Receiver = { registry: PeerRegistry; auth: PeerAuth };
const Q = new URLSearchParams();
const servers: https.Server[] = [];
let root = "", previousStateDir: string | undefined, client: PeerRegistry;

beforeEach(() => {
  previousStateDir = process.env.AGTOP_STATE_DIR;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-proxy-"));
  process.env.AGTOP_STATE_DIR = root;
  client = new PeerRegistry({ dir: path.join(root, "client") });
  client.ensureIdentity("node-a");
});
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  fs.rmSync(root, { recursive: true, force: true });
  if (previousStateDir === undefined) delete process.env.AGTOP_STATE_DIR; else process.env.AGTOP_STATE_DIR = previousStateDir;
});

const code = async (promise: Promise<unknown>): Promise<FleetError> => {
  try { await promise; } catch (error) { expect(error).toBeInstanceOf(FleetError); return error as FleetError; }
  throw new Error("Expected a FleetError.");
};
const readAll = (stream: NodeJS.ReadableStream): Promise<Buffer> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  stream.on("end", () => resolve(Buffer.concat(chunks)));
  stream.on("error", reject);
});
/** A federation peer that verifies every request with a real PeerAuth, then replies via `reply`. */
async function serve(receiver: Receiver, reply: (received: Received) => Reply | Promise<Reply>): Promise<{ port: number; received: Received[] }> {
  const received: Received[] = [];
  const server = https.createServer({ key: KEY_PEM, cert: CERT_PEM }, (req, res) => {
    res.on("error", () => undefined);
    void (async () => {
      try {
        const body = await readAll(req);
        const authenticated = receiver.auth.verify({ method: req.method ?? "", pathWithQuery: req.url ?? "", headers: req.headers, body });
        const entry = { method: req.method ?? "", pathWithQuery: req.url ?? "", body: body.toString("utf8"), peer: authenticated.id };
        received.push(entry);
        const out = await reply(entry);
        if (out === "slow") return;
        if ("raw" in out) { res.writeHead(out.status ?? 200, out.headers); res.end(out.raw); return; }
        res.writeHead(out.status, { "Content-Type": "application/json", ...out.headers });
        res.end(JSON.stringify(out.body));
      } catch (error) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      }
    })();
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  return { port: (server.address() as AddressInfo).port, received };
}
/** Starts a server with a receiver registry that trusts this client's identity, and registers it. */
async function peer(reply: (received: Received) => Reply | Promise<Reply>, options: { pin?: string | null; timeoutMs?: number } = {}) {
  const receiver: Receiver = { registry: new PeerRegistry({ dir: path.join(root, "receiver") }), auth: null as never };
  const identity = receiver.registry.ensureIdentity("node-b");
  receiver.registry.upsert({ id: "node-a", url: "https://node-a.example", publicKey: client.self()!.publicKey, scopes: [] });
  receiver.auth = new PeerAuth(receiver.registry);
  const { port, received } = await serve(receiver, reply);
  const nodeB = client.upsert({
    id: "node-b", url: `https://127.0.0.1:${port}`, publicKey: identity.publicKey, scopes: [],
    ...(options.pin === null ? {} : { tlsCertPem: options.pin ?? CERT_PEM }),
  });
  return { proxy: new RemoteProxy(client, options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), received, port, peer: nodeB };
}
async function unusedPort(): Promise<number> {
  const server = https.createServer({ key: KEY_PEM, cert: CERT_PEM });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
function ctx(method: string, target: string, body?: unknown): RouteContext {
  const at = target.indexOf("?");
  return {
    method, path: at === -1 ? target : target.slice(0, at),
    query: new URLSearchParams(at === -1 ? "" : target.slice(at + 1)),
    readBody: async () => body ?? {},
  };
}

test("GET query and POST body are signed compatibly; status and JSON body pass through", async () => {
  const { proxy, received, peer: nodeB } = await peer((req) => {
    if (req.method === "GET" && req.pathWithQuery === "/fed/v1/jobs?state=running&limit=5") return { status: 200, body: { jobs: [], nextAfter: null } };
    if (req.method === "POST" && req.pathWithQuery === "/fed/v1/jobs") return { status: 201, body: { job: { jobId: "remote-1" } } };
    return { status: 404, body: { error: "No such job.", code: "E_JOB_NOT_FOUND" } };
  });
  expect(await proxy.forward(nodeB.id, "GET", "/fed/v1/jobs", new URLSearchParams("state=running&limit=5"))).toEqual({ status: 200, body: { jobs: [], nextAfter: null } });
  expect(await proxy.forward(nodeB.id, "POST", "/fed/v1/jobs", Q, { command: "echo", args: ["hi"] })).toEqual({ status: 201, body: { job: { jobId: "remote-1" } } });
  expect(await proxy.forward(nodeB.id, "GET", "/fed/v1/jobs/missing", Q)).toEqual({ status: 404, body: { error: "No such job.", code: "E_JOB_NOT_FOUND" } });
  expect(received.map((entry) => [entry.method, entry.pathWithQuery, entry.peer])).toEqual([
    ["GET", "/fed/v1/jobs?state=running&limit=5", "node-a"],
    ["POST", "/fed/v1/jobs", "node-a"],
    ["GET", "/fed/v1/jobs/missing", "node-a"],
  ]);
  expect(received[1]!.body).toBe(JSON.stringify({ command: "echo", args: ["hi"] }));
});

test("TLS mismatch, unpinned self-signed, refused, timeout and missing identity map to contract codes", async () => {
  const mismatch = await peer(() => ({ status: 200, body: { ok: true } }), { pin: OTHER_CERT_PEM });
  expect((await code(mismatch.proxy.forward("node-b", "GET", "/fed/v1/telemetry", Q))).code).toBe("E_PEER_TLS");
  client.upsert({ id: "node-b", url: `https://127.0.0.1:${mismatch.port}`, publicKey: mismatch.peer.publicKey, scopes: [] });
  expect((await code(mismatch.proxy.forward("node-b", "GET", "/fed/v1/telemetry", Q))).code).toBe("E_PEER_TLS");
  const closed = await unusedPort();
  client.upsert({ id: "node-b", url: `https://127.0.0.1:${closed}`, publicKey: mismatch.peer.publicKey, scopes: [] });
  expect((await code(mismatch.proxy.forward("node-b", "GET", "/fed/v1/telemetry", Q))).code).toBe("E_PEER_UNREACHABLE");
  const slow = await peer(() => "slow");
  const slowProxy = new RemoteProxy(client, { timeoutMs: 100 });
  const started = Date.now();
  expect((await code(slowProxy.forward(slow.peer.id, "GET", "/fed/v1/telemetry", Q))).code).toBe("E_PEER_TIMEOUT");
  expect(Date.now() - started).toBeLessThan(2000);
  const bare = new PeerRegistry({ dir: path.join(root, "bare") });
  bare.upsert({ id: "node-b", url: "https://127.0.0.1:9", publicKey: mismatch.peer.publicKey, scopes: [] });
  expect((await code(new RemoteProxy(bare).forward("node-b", "GET", "/fed/v1/telemetry", Q))).code).toBe("E_INTERNAL");
});

test("oversized, non-JSON and redirect responses are bounded and never followed", async () => {
  const big = await peer(() => ({ raw: Buffer.alloc(REMOTE_MAX_RESPONSE_BYTES + 64, 0x61) }));
  expect((await code(big.proxy.forward(big.peer.id, "GET", "/fed/v1/telemetry", Q))).code).toBe("E_PEER_PROTOCOL");
  const text = await peer(() => ({ raw: "not json" }));
  expect((await code(text.proxy.forward(text.peer.id, "GET", "/fed/v1/telemetry", Q))).code).toBe("E_PEER_PROTOCOL");
  const redirect = await peer(() => ({ status: 302, body: { moved: true }, headers: { Location: "/fed/v1/telemetry" } }));
  expect(await redirect.proxy.forward(redirect.peer.id, "GET", "/fed/v1/telemetry", Q)).toEqual({ status: 302, body: { moved: true } });
  expect(redirect.received).toHaveLength(1);
});

test("unknown and disabled peers are E_PEER_NOT_FOUND and never contacted", async () => {
  const target = await peer(() => ({ status: 200, body: { ok: true } }));
  expect((await code(target.proxy.forward("node-x", "GET", "/fed/v1/telemetry", Q))).code).toBe("E_PEER_NOT_FOUND");
  client.upsert({ ...target.peer, enabled: false });
  expect((await code(target.proxy.forward("node-b", "GET", "/fed/v1/telemetry", Q))).code).toBe("E_PEER_NOT_FOUND");
  expect(target.received).toHaveLength(0);
});

test("peer routes list, upsert and delete; unknown body fields are rejected by name", async () => {
  const routes = { registry: client, proxy: new RemoteProxy(client) };
  expect(await handleRemoteRoute(routes, ctx("GET", "/v1/peers"))).toEqual({ status: 200, body: { self: client.self(), peers: [] } });
  const publicKey = client.self()!.publicKey;
  const created = await handleRemoteRoute(routes, ctx("POST", "/v1/peers", { id: "node-c", url: "https://node-c.example", publicKey, scopes: ["jobs:list"] }));
  const peer = (created!.body as { peer: DaemonPeer }).peer;
  expect(created!.status).toBe(201);
  expect(peer).toMatchObject({ id: "node-c", enabled: true, jobPeerPrefixes: [], scopes: ["jobs:list"] });
  const unknown = await code(handleRemoteRoute(routes, ctx("POST", "/v1/peers", { id: "node-d", bogus: true, url: "https://node-d.example", publicKey, scopes: [] })));
  expect(unknown.code).toBe("E_INVALID_REQUEST");
  expect(unknown.details).toEqual({ field: "bogus" });
  expect(await handleRemoteRoute(routes, ctx("GET", "/v1/peers/extra"))).toBeUndefined();
  expect((await code(handleRemoteRoute(routes, ctx("DELETE", "/v1/peers/node-z")))).code).toBe("E_PEER_NOT_FOUND");
  expect(await handleRemoteRoute(routes, ctx("DELETE", "/v1/peers/node-c"))).toEqual({ status: 200, body: { removed: true } });
});

test("all seven federated routes forward with the same method, path and query", async () => {
  const target = await peer((req) => ({ status: 200, body: { method: req.method, path: req.pathWithQuery } }));
  const routes = { registry: client, proxy: target.proxy };
  const cases: Array<[string, string]> = [
    ["GET", "/v1/remote/node-b/jobs"],
    ["GET", "/v1/remote/node-b/jobs/job-9"],
    ["GET", "/v1/remote/node-b/jobs/job-9/output"],
    ["GET", "/v1/remote/node-b/jobs/job-9/events"],
    ["POST", "/v1/remote/node-b/jobs/job-9/kill"],
    ["POST", "/v1/remote/node-b/jobs"],
    ["GET", "/v1/remote/node-b/telemetry"],
  ];
  for (const [method, local] of cases) {
    const forwarded = `/fed/v1${local.slice("/v1/remote/node-b".length)}`;
    expect(await handleRemoteRoute(routes, ctx(method, local, method === "POST" ? {} : undefined))).toEqual({ status: 200, body: { method, path: forwarded } });
  }
  expect(target.received.map((entry) => `${entry.method} ${entry.pathWithQuery}`)).toEqual(cases.map(([method, local]) => `${method} /fed/v1${local.slice("/v1/remote/node-b".length)}`));
});

test("only the seven federated routes are forwarded and path injection never reaches the peer", async () => {
  const target = await peer((req) => ({ status: 200, body: { echo: req.pathWithQuery, method: req.method } }));
  const routes = { registry: client, proxy: target.proxy };
  expect(await handleRemoteRoute(routes, ctx("GET", "/v1/remote/node-b/jobs/job-1/output?tail=2"))).toEqual({ status: 200, body: { echo: "/fed/v1/jobs/job-1/output?tail=2", method: "GET" } });
  const submit = await handleRemoteRoute(routes, ctx("POST", "/v1/remote/node-b/jobs", { command: "echo" }));
  expect(submit!.status).toBe(200);
  expect(target.received[1]!.body).toBe(JSON.stringify({ command: "echo" }));
  expect(await handleRemoteRoute(routes, ctx("GET", "/v1/remote/node-b/policy"))).toBeUndefined();
  expect(await handleRemoteRoute(routes, ctx("POST", "/v1/remote/node-b/telemetry"))).toBeUndefined();
  expect((await code(handleRemoteRoute(routes, ctx("GET", "/v1/remote/node-b/jobs/..%2F..%2Fv1%2Fpolicy")))).code).toBe("E_JOB_NOT_FOUND");
  expect((await code(handleRemoteRoute(routes, ctx("GET", "/v1/remote/node-b/jobs/a%2F..%2F..%2Fpolicy")))).code).toBe("E_JOB_NOT_FOUND");
  expect((await code(handleRemoteRoute(routes, ctx("GET", "/v1/remote/..%2F..%2Fv1%2Fpolicy/jobs")))).code).toBe("E_PEER_NOT_FOUND");
  expect((await code(handleRemoteRoute(routes, ctx("GET", "/v1/remote/Bad_peer/jobs")))).code).toBe("E_PEER_NOT_FOUND");
  expect(target.received).toHaveLength(2);
});
