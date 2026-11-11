import { afterEach, beforeEach, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readAudit } from "../src/audit.js";
import { FleetError } from "../src/fleet-errors.js";
import { canonicalRequest, MAX_SKEW_MS, NONCE_CACHE_MAX, NONCE_TTL_MS, PeerAuth, signRequest } from "../src/remote/auth.js";
import { PeerRegistry } from "../src/remote/registry.js";
import type { FleetErrorCode, PeerAuthHeaders } from "../src/types.js";

const CLOCK = 1_762_819_200_000;
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const keyFromSeed = (hex: string): crypto.KeyObject =>
  crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(hex, "hex")]), format: "der", type: "pkcs8" });
const rawPublicKey = (key: crypto.KeyObject): string => {
  const publicKey = key.type === "private" ? crypto.createPublicKey(key) : key;
  const der = publicKey.export({ format: "der", type: "spki" });
  return der.subarray(der.length - 32).toString("base64");
};
const nonceAt = (index: number): string => `n${String(index).padStart(21, "0")}`;
const BASE = { method: "GET", pathWithQuery: "/fed/v1/jobs?state=running", body: Buffer.alloc(0) };
type SignInput = { method?: string; pathWithQuery?: string; timestampMs?: number; nonce?: string; senderId?: string; audienceId?: string; body?: Buffer };
type Headers = Record<string, string | string[] | undefined>;
type Signed = PeerAuthHeaders & Headers;

let root = "", previousStateDir: string | undefined, registry: PeerRegistry, auth: PeerAuth;
let sender: crypto.KeyPairKeyObjectResult, other: crypto.KeyPairKeyObjectResult, clock = CLOCK, nonceSeq = 0;
const signWith = (privateKey: crypto.KeyObject, input: SignInput = {}): Headers =>
  ({ ...signRequest(privateKey, { ...BASE, timestampMs: clock, nonce: nonceAt(++nonceSeq), senderId: "node-b", audienceId: "node-a", ...input }) });
const sign = (input: SignInput = {}): Signed => signWith(sender.privateKey, input) as Signed;
const request = (headers: Headers, overrides: { method?: string; pathWithQuery?: string; body?: Buffer } = {}) =>
  ({ ...BASE, headers, ...overrides });
const throwsFleet = (fn: () => unknown): FleetError => {
  let caught: unknown; try { fn(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(FleetError); return caught as FleetError;
};
const expectCode = (fn: () => unknown, code: FleetErrorCode): FleetError => {
  const error = throwsFleet(fn); expect(error.code).toBe(code); return error;
};
const verifyError = (headers: Headers, overrides: { method?: string; pathWithQuery?: string; body?: Buffer } | undefined, code: FleetErrorCode): FleetError =>
  expectCode(() => auth.verify(request(headers, overrides)), code);

beforeEach(() => {
  previousStateDir = process.env.AGTOP_STATE_DIR;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-auth-"));
  process.env.AGTOP_STATE_DIR = root;
  registry = new PeerRegistry({ dir: path.join(root, "federation") });
  registry.ensureIdentity("node-a");
  sender = crypto.generateKeyPairSync("ed25519");
  other = crypto.generateKeyPairSync("ed25519");
  registry.upsert({ id: "node-b", url: "https://node-b.example:13310", publicKey: rawPublicKey(sender.publicKey), scopes: ["jobs:list", "jobs:read"] });
  clock = CLOCK; nonceSeq = 0;
  auth = new PeerAuth(registry, { now: () => clock });
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (previousStateDir === undefined) delete process.env.AGTOP_STATE_DIR; else process.env.AGTOP_STATE_DIR = previousStateDir;
});

test("canonicalRequest matches the golden fixture and signRequest is deterministic", () => {
  const key = keyFromSeed("5f1d3c7a9b2e4f6081a3c5d7e9f10b2d4a6c8e0f1b3d5a7c9e2f40516273849a");
  const input = {
    method: "POST", pathWithQuery: "/fed/v1/jobs/task-1/kill?force=1", timestampMs: 1_762_819_200_000,
    nonce: "abcdefghijklmnopqrstuv", senderId: "node-b", audienceId: "node-a", body: Buffer.from("hello world"),
  };
  const canonical = [
    "AGTOP-ED25519-V1", "POST", "/fed/v1/jobs/task-1/kill?force=1", "1762819200000", "abcdefghijklmnopqrstuv",
    "node-b", "node-a", "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
  ].join("\n");
  expect(canonicalRequest(input)).toBe(canonical);
  expect(canonicalRequest({ ...input, body: Buffer.alloc(0) })).toContain(EMPTY_SHA256);
  expect(canonicalRequest({ ...input, method: "post" })).toBe(canonical); // METHOD is uppercased
  expect(canonicalRequest(input).endsWith("\n")).toBe(false);
  expect(signRequest(key, input)).toEqual({
    "X-Agtop-Peer": "node-b", "X-Agtop-Timestamp": "1762819200000", "X-Agtop-Nonce": "abcdefghijklmnopqrstuv",
    "X-Agtop-Signature": "C8S9kaU99I7g34eR5HEluazkUlSb3DucEfxmbhndWmhkqum4YHi7Jn9jslue0ompVADHC1MEqgvQhQEay-jNBA",
  });
});

test("sign and verify round trip: GET with query, POST with body, lowercase header names", () => {
  const get = sign({ pathWithQuery: "/fed/v1/jobs?state=running&tail=100" });
  expect(get["X-Agtop-Nonce"]).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(get["X-Agtop-Signature"]).toMatch(/^[A-Za-z0-9_-]{86}$/);
  expect(auth.verify(request(get, { pathWithQuery: "/fed/v1/jobs?state=running&tail=100" })).id).toBe("node-b");
  const body = Buffer.from('{"command":"sleep","args":["1"]}');
  const post = sign({ method: "POST", pathWithQuery: "/fed/v1/jobs", body });
  const lower = Object.fromEntries(Object.entries(post).map(([name, value]) => [name.toLowerCase(), value]));
  expect(auth.verify({ method: "POST", pathWithQuery: "/fed/v1/jobs", headers: lower, body }).id).toBe("node-b");
  expect(registry.get("node-b")?.lastSeenAt).toBe(new Date(clock).toISOString());
});

test("step 1: missing headers are E_UNAUTHORIZED; array and malformed values are E_SIGNATURE_INVALID", () => {
  const valid = sign();
  for (const name of Object.keys(valid)) {
    const headers: Headers = { ...valid }; delete headers[name];
    expect(verifyError(headers, undefined, "E_UNAUTHORIZED").code).toBe("E_UNAUTHORIZED");
  }
  for (const value of [["node-b"], []]) {
    expect(verifyError({ ...valid, "X-Agtop-Peer": value }, undefined, "E_SIGNATURE_INVALID").code).toBe("E_SIGNATURE_INVALID");
  }
  for (const [name, value] of [
    ["X-Agtop-Peer", "AB"], ["X-Agtop-Peer", "node_b"],
    ["X-Agtop-Timestamp", "12345"], ["X-Agtop-Timestamp", "123456789012x"],
    ["X-Agtop-Nonce", "short"], ["X-Agtop-Nonce", "A".repeat(23)],
    ["X-Agtop-Signature", "x".repeat(85)], ["X-Agtop-Signature", "x".repeat(87)],
  ] as Array<[string, string]>) {
    expect(verifyError({ ...valid, [name]: value }, undefined, "E_SIGNATURE_INVALID").code).toBe("E_SIGNATURE_INVALID");
  }
});

test("step 2: unknown and disabled peers are indistinguishable E_SIGNATURE_INVALID", () => {
  const unknown = verifyError(sign({ senderId: "node-x" }), undefined, "E_SIGNATURE_INVALID");
  registry.upsert({ id: "node-b", url: "https://node-b.example:13310", publicKey: rawPublicKey(sender.publicKey), scopes: [], enabled: false });
  const disabled = verifyError(sign(), undefined, "E_SIGNATURE_INVALID");
  expect(unknown.message).toBe(disabled.message);
});

test("step 3: the skew window is inclusive; skew precedes signature checks but not header checks", () => {
  expect(auth.verify(request(sign({ timestampMs: clock - MAX_SKEW_MS }))).id).toBe("node-b");
  expect(auth.verify(request(sign({ timestampMs: clock + MAX_SKEW_MS }))).id).toBe("node-b");
  expect(verifyError(sign({ timestampMs: clock - MAX_SKEW_MS - 1 }), undefined, "E_CLOCK_SKEW").details).toEqual({ serverTimeMs: clock });
  expect(verifyError(sign({ timestampMs: clock + MAX_SKEW_MS + 1 }), undefined, "E_CLOCK_SKEW").details).toEqual({ serverTimeMs: clock });
  // A request that is both stale and signed by the wrong key reports skew, because step 3 runs before step 4.
  expect(verifyError(signWith(other.privateKey, { timestampMs: clock - MAX_SKEW_MS - 1 }), undefined, "E_CLOCK_SKEW").code).toBe("E_CLOCK_SKEW");
  // A malformed signature reports E_SIGNATURE_INVALID even when the timestamp is stale, because step 1 runs first.
  const staleTimestamp = String(clock - MAX_SKEW_MS - 1);
  expect(verifyError({ ...sign(), "X-Agtop-Timestamp": staleTimestamp, "X-Agtop-Signature": "!".repeat(86) }, undefined, "E_SIGNATURE_INVALID").code).toBe("E_SIGNATURE_INVALID");
});

test("step 4: every covered field is bound into the signature", () => {
  const valid = sign();
  const flipped = (valid["X-Agtop-Signature"][0] === "A" ? "B" : "A") + valid["X-Agtop-Signature"].slice(1);
  const cases = [
    () => request(valid, { method: "POST" }),
    () => request(valid, { pathWithQuery: "/fed/v1/jobs/other?state=running" }),
    () => request(valid, { pathWithQuery: "/fed/v1/jobs?state=exited" }),
    () => request(valid, { body: Buffer.from("{}") }),
    () => request({ ...valid, "X-Agtop-Timestamp": String(clock + 1) }),
    () => request({ ...valid, "X-Agtop-Nonce": "A".repeat(22) }),
    () => request({ ...valid, "X-Agtop-Signature": flipped }),
    () => request(signWith(other.privateKey)),
    () => request(sign({ audienceId: "node-c" })),
  ];
  for (const make of cases) expectCode(() => auth.verify(make()), "E_SIGNATURE_INVALID");
});

test("step 4 fails closed with E_SIGNATURE_INVALID when the receiver has no identity", () => {
  // Interpretation: 11.2 does not name a code for self() === null. Deny with the generic auth error.
  const noIdentity = new PeerRegistry({ dir: path.join(root, "no-identity") });
  noIdentity.upsert({ id: "node-b", url: "https://node-b.example:13310", publicKey: rawPublicKey(sender.publicKey), scopes: [] });
  const unauthenticated = new PeerAuth(noIdentity, { now: () => clock });
  expectCode(() => unauthenticated.verify(request(sign())), "E_SIGNATURE_INVALID");
});

test("step 5: replay is E_REPLAY and a bad signature never consumes a nonce", () => {
  const nonce = nonceAt(900);
  verifyError(signWith(other.privateKey, { nonce }), undefined, "E_SIGNATURE_INVALID");
  expect(auth.verify(request(sign({ nonce }))).id).toBe("node-b");
  expect(verifyError(sign({ nonce }), undefined, "E_REPLAY").code).toBe("E_REPLAY");
});

test("step 5: the nonce cache is bounded and expires lazily after NONCE_TTL_MS", () => {
  for (let index = 0; index < NONCE_CACHE_MAX; index++) {
    expect(auth.verify(request(sign({ nonce: nonceAt(index) }))).id).toBe("node-b");
  }
  expect(verifyError(sign({ nonce: "z".repeat(22) }), undefined, "E_REPLAY_CACHE_FULL").code).toBe("E_REPLAY_CACHE_FULL");
  clock += NONCE_TTL_MS + 1;
  expect(auth.verify(request(sign({ nonce: "z".repeat(22) }))).id).toBe("node-b");
});

test("a removed peer's replay cache is dropped", () => {
  auth.verify(request(sign()));
  const caches = (auth as unknown as { nonces: Map<string, Map<string, number>> }).nonces;
  expect(caches.size).toBe(1);
  expect(registry.remove("node-b")).toBe(true);
  expect(verifyError(sign(), undefined, "E_SIGNATURE_INVALID").code).toBe("E_SIGNATURE_INVALID");
  expect(caches.size).toBe(0);
});

test("a malformed stored public key fails closed instead of throwing", () => {
  const peersFile = path.join(root, "federation", "peers.json");
  const peers = JSON.parse(fs.readFileSync(peersFile, "utf8")) as Array<Record<string, unknown>>;
  peers[0]!.publicKey = "not-a-valid-key";
  fs.writeFileSync(peersFile, `${JSON.stringify(peers, null, 2)}\n`);
  expect(verifyError(sign(), undefined, "E_SIGNATURE_INVALID").code).toBe("E_SIGNATURE_INVALID");
});

test("every authentication failure is audited with its code, never the signature, nonce or body", () => {
  const body = Buffer.from("top-secret-body-bytes");
  const tampered = sign({ nonce: "C".repeat(22) });
  verifyError({ ...tampered, "X-Agtop-Signature": "x".repeat(86) }, { body }, "E_SIGNATURE_INVALID");
  verifyError(sign({ timestampMs: clock - MAX_SKEW_MS - 1, nonce: "D".repeat(22) }), undefined, "E_CLOCK_SKEW");
  verifyError(sign({ senderId: "node-x", nonce: "E".repeat(22) }), undefined, "E_SIGNATURE_INVALID");
  const missing: Headers = { ...sign({ nonce: "F".repeat(22) }) }; delete missing["X-Agtop-Nonce"];
  verifyError(missing, undefined, "E_UNAUTHORIZED");
  const anonymous: Headers = { ...sign({ nonce: "G".repeat(22) }) }; delete anonymous["X-Agtop-Peer"];
  verifyError(anonymous, undefined, "E_UNAUTHORIZED");
  const records = readAudit().filter((record) => record.event === "peer-auth-failed");
  expect(records.map((record) => record.code)).toEqual(["E_SIGNATURE_INVALID", "E_CLOCK_SKEW", "E_SIGNATURE_INVALID", "E_UNAUTHORIZED", "E_UNAUTHORIZED"]);
  expect(records.map((record) => record.actor)).toEqual(["node-b", "node-b", "node-x", "node-b", "unknown"]);
  expect(records.map((record) => record.peerId)).toEqual(["node-b", "node-b", "node-x", "node-b", undefined]);
  const text = JSON.stringify(records);
  expect(text).not.toContain(tampered["X-Agtop-Signature"]);
  expect(text).not.toContain("x".repeat(86));
  expect(text).not.toContain("C".repeat(22));
  expect(text).not.toContain("top-secret-body-bytes");
});

test("requireScope passes for a granted scope and reports the missing scope in details", () => {
  const peer = registry.get("node-b")!;
  expect(() => auth.requireScope(peer, "jobs:list")).not.toThrow();
  const error = expectCode(() => auth.requireScope(peer, "telemetry:read"), "E_FORBIDDEN_SCOPE");
  expect(error.details).toEqual({ scope: "telemetry:read" });
});
