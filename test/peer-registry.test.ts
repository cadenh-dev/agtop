import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { peersCommand } from "../src/cli-peers.js";
import { readAudit } from "../src/audit.js";
import { parseDaemonOptions } from "../src/cli.js";
import { FleetError } from "../src/fleet-errors.js";
import { PeerRegistry } from "../src/remote/registry.js";

const IS_WINDOWS = process.platform === "win32";
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const CERT = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIQOGQu9fpsuaBPClaeVvwKJTANBgkqhkiG9w0BAQsFADAZMRcwFQYDVQQD
DA5wZWVyLWIuZXhhbXBsZTAeFw0yNjExMTEwNTA0MzJaFw0zNjExMTEwNTE0MzJaMBkxFzAVBgNV
BAMMDnBlZXItYi5leGFtcGxlMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAynhTZ14P
Ni1gdIw/feOBqBiYNapyNR2LF9DC+zDzVM47duOx2owX8uQ5dzvNyf1CwEHpYYaYpxsMWq04d/Ai
AjnQ+shaQXKFhL+TFbx442SvpYmOeWG94AuR/UWs1BXPA44IPinT6fbfE307WEFignyM6VwDh/FL
QZadNsOmNyYrAizAxuNl4IfC73Ud1kxY8O9+fE/8aXqkECqTFq9YraIUCuo9CAvH2ItybfheWu+f
qKoPYN277y8ewVaUNvWwZJoY4zFPYI9Olm1rUZQX5Z2ASh238z6A+4WdncwOmGyybSIwCh9dVFmY
7r+53Y/NjJpVd6bto0da1hgELv96mQIDAQABo2swaTAOBgNVHQ8BAf8EBAMCBaAwHQYDVR0lBBYw
FAYIKwYBBQUHAwIGCCsGAQUFBwMBMBkGA1UdEQQSMBCCDnBlZXItYi5leGFtcGxlMB0GA1UdDgQW
BBT60KrZIClTvfn/PxvymddBljPeWjANBgkqhkiG9w0BAQsFAAOCAQEANoErBVbxF8KPoW5bL1TO
qe/fgh3eFkOGddvV+6z2FHRxStvx4I21oqZtQQg77KXuZok9ByOUsKnCkUKUkVCCrAYKlLhHRKcH
FLkNCTQHsiCEiTZXP9gCgYkWbvB8X6U+ZOw9l+O5xzHedjtLOYZWk9igDUKhNMhCj2XX201mjKFb
wH2hHZl+gAUSoJrvRfJIs9rzsVca9dLKkePjz9ETlkcLa2ncfOEEEtH1IJw0akh0zyQ+E5nJVDfZ
I6F8ns72uabf5a0+X6YZEO7fco7kk1/ZuYGvVt/f37846k20qmoTh9/hUSzrHvl//+c48AbyhisQ
T5wCKeVwBH8NcMQobg==
-----END CERTIFICATE-----`;
const PEER_KEY = (() => {
  const der = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
  return der.subarray(der.length - 32).toString("base64");
})();
type PeerInput = Parameters<PeerRegistry["upsert"]>[0];
const peer = (overrides: Record<string, unknown> = {}): PeerInput =>
  ({ id: "peer-b", url: "https://peer-b.example:13310", publicKey: PEER_KEY, scopes: ["jobs:list"], ...overrides } as PeerInput);

let root = "", previousStateDir: string | undefined;
const dir = (): string => path.join(root, "federation");
const keyFile = (): string => path.join(dir(), "identity.key");
const peersFile = (): string => path.join(dir(), "peers.json");
const diskPeers = (): Array<{ id: string; lastSeenAt: string | null }> => JSON.parse(fs.readFileSync(peersFile(), "utf8"));
const forceFlush = (registry: PeerRegistry): void => { (registry as unknown as { lastSeenFlushMs: number }).lastSeenFlushMs = 0; };
const throwsFleet = (fn: () => unknown): FleetError => {
  let error: unknown; try { fn(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(FleetError); return error as FleetError;
};

beforeEach(() => {
  previousStateDir = process.env.AGTOP_STATE_DIR;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-peers-"));
  process.env.AGTOP_STATE_DIR = root;
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (previousStateDir === undefined) delete process.env.AGTOP_STATE_DIR; else process.env.AGTOP_STATE_DIR = previousStateDir;
});

test("identity is created once, is idempotent, and its key round-trips", () => {
  const registry = new PeerRegistry({ dir: dir() });
  expect(throwsFleet(() => registry.privateKey()).code).toBe("E_INTERNAL");
  expect(registry.self()).toBeNull();
  const first = registry.ensureIdentity("node-a");
  expect(first.id).toBe("node-a"); expect(first.publicKey).toHaveLength(44); expect(registry.self()).toEqual(first);
  expect(new PeerRegistry({ dir: dir() }).ensureIdentity("node-b")).toEqual(first); // never replaced
  const publicKey = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(first.publicKey, "base64")]), format: "der", type: "spki" });
  const message = Buffer.from("peer registry");
  expect(verify(null, message, publicKey, sign(null, message, registry.privateKey()))).toBe(true);
});
test("eight processes calling ensureIdentity together end with one identity", async () => {
  // Separate processes: in one process the synchronous calls would only run one after another.
  const script = path.join(root, "ensure-identity.ts");
  const registryUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/remote/registry.ts")).href;
  fs.writeFileSync(script, [
    `import { PeerRegistry } from ${JSON.stringify(registryUrl)};`,
    "const id = new PeerRegistry({ dir: process.argv[2] }).ensureIdentity(process.argv[3]);",
    "process.stdout.write(JSON.stringify(id));",
  ].join("\n"));
  const outputs = await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise<string>((resolve, reject) => {
    execFile(process.execPath, [script, dir(), `node-${index}`], { timeout: 20_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}\n${stderr}`)); else resolve(stdout);
    });
  })));
  const identities = outputs.map((text) => JSON.parse(text) as { id: string; publicKey: string });
  for (const identity of identities) expect(identity).toEqual(identities[0]!);
  expect(JSON.parse(fs.readFileSync(path.join(dir(), "identity.json"), "utf8"))).toEqual(identities[0]);
  expect(new PeerRegistry({ dir: dir() }).ensureIdentity()).toEqual(identities[0]!);
}, 30_000);
test("adding and removing a peer writes audit records", () => {
  const registry = new PeerRegistry({ dir: dir() });
  registry.upsert(peer());
  expect(registry.remove("peer-b")).toBe(true);
  expect(registry.remove("peer-b")).toBe(false);
  const events = readAudit().filter((record) => record.peerId === "peer-b").map((record) => record.event);
  expect(events).toEqual(["peer-added", "peer-removed"]);
});
test("upsert enforces every documented validation rule", () => {
  const registry = new PeerRegistry({ dir: dir() });
  const fails = (input: unknown, field: string): void => {
    const error = throwsFleet(() => registry.upsert(input as never));
    expect(error.code).toBe("E_INVALID_REQUEST"); expect(error.details).toEqual({ field });
  };
  fails(peer({ id: "AB" }), "id");
  fails(peer({ url: "not a url" }), "url");
  fails(peer({ url: "http://peer-b.example" }), "url");
  fails(peer({ url: "https://peer-b.example/api" }), "url");
  fails(peer({ url: "https://peer-b.example/?x=1" }), "url");
  fails(peer({ url: "https://user:pass@peer-b.example" }), "url");
  fails(peer({ url: "https://peer-b.example/#frag" }), "url");
  fails(peer({ publicKey: "AAAA" }), "publicKey");
  fails(peer({ scopes: ["jobs:list", "jobs:list"] }), "scopes");
  fails(peer({ scopes: ["jobs:everything"] }), "scopes");
  fails(peer({ jobPeerPrefixes: Array.from({ length: 17 }, (_, index) => `p${index}`) }), "jobPeerPrefixes");
  fails(peer({ jobPeerPrefixes: [""] }), "jobPeerPrefixes");
  fails(peer({ tlsCertPem: "x".repeat(16_385) }), "tlsCertPem");
  fails(peer({ tlsCertPem: "not a certificate" }), "tlsCertPem");
  expect(registry.upsert(peer({ url: "https://peer-b.example:13310/" })).url).toBe("https://peer-b.example:13310");
  expect(registry.list()).toHaveLength(1);
});

test("upsert applies defaults and keeps addedAt and lastSeenAt on update", () => {
  const registry = new PeerRegistry({ dir: dir() });
  const created = registry.upsert(peer());
  expect(created.enabled).toBe(true); expect(created.jobPeerPrefixes).toEqual([]); expect(created.lastSeenAt).toBeNull();
  registry.touch(created.id, new Date("2026-01-01T00:00:00.000Z"));
  const updated = registry.upsert(peer({ scopes: ["jobs:read"], tlsCertPem: CERT, enabled: false, jobPeerPrefixes: ["build-"] }));
  expect(updated.addedAt).toBe(created.addedAt); expect(updated.lastSeenAt).toBe("2026-01-01T00:00:00.000Z");
  expect(updated.scopes).toEqual(["jobs:read"]); expect(updated.enabled).toBe(false);
  expect(registry.get(created.id)?.jobPeerPrefixes).toEqual(["build-"]);
});
test("list reloads peers.json after another registry edits it", () => {
  const a = new PeerRegistry({ dir: dir() }), b = new PeerRegistry({ dir: dir() });
  a.upsert(peer());
  expect(a.list()[0]?.url).toBe("https://peer-b.example:13310");
  b.upsert(peer({ url: "https://peer-c.example:13310" })); // same byte length, so size alone cannot detect it
  expect(a.list()[0]?.url).toBe("https://peer-c.example:13310");
  expect(b.remove("peer-b")).toBe(true); expect(a.list()).toEqual([]); expect(b.remove("peer-b")).toBe(false);
});
test("touch flushes at most once a minute without resurrecting or dropping peers", () => {
  const a = new PeerRegistry({ dir: dir() }), b = new PeerRegistry({ dir: dir() });
  a.upsert(peer());
  a.touch("peer-b", new Date("2026-01-01T00:00:00.000Z"));
  expect(diskPeers()[0]?.lastSeenAt).toBe("2026-01-01T00:00:00.000Z");
  a.touch("peer-b", new Date("2026-01-01T00:00:10.000Z"));
  expect(diskPeers()[0]?.lastSeenAt).toBe("2026-01-01T00:00:00.000Z"); // buffered, not flushed
  expect(a.list()[0]?.lastSeenAt).toBe("2026-01-01T00:00:10.000Z"); // but visible in memory
  b.remove("peer-b");
  forceFlush(a); a.touch("peer-b", new Date("2026-01-01T00:00:20.000Z"));
  expect(diskPeers()).toEqual([]); expect(a.list()).toEqual([]); // a stale pending entry never resurrects
  b.upsert(peer({ id: "peer-c", url: "https://peer-c.example" }));
  forceFlush(a); a.touch("peer-c", new Date("2026-01-01T00:00:30.000Z"));
  expect(diskPeers().map((entry) => entry.id)).toEqual(["peer-c"]); // an edit from another writer survives
  expect(a.get("peer-c")?.lastSeenAt).toBe("2026-01-01T00:00:30.000Z");
});
describe.skipIf(IS_WINDOWS)("POSIX permissions", () => {
  test("identity.key and peers.json are 0600 and a widened key is refused", () => {
    const registry = new PeerRegistry({ dir: dir() });
    registry.ensureIdentity("node-a"); registry.upsert(peer());
    expect(fs.statSync(keyFile()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(peersFile()).mode & 0o777).toBe(0o600);
    expect(() => registry.privateKey()).not.toThrow();
    fs.chmodSync(keyFile(), 0o644);
    expect(throwsFleet(() => registry.privateKey()).code).toBe("E_INTERNAL");
  });
});

interface RunResult { code: number; stdout: string; stderr: string }
async function runPeers(...args: string[]): Promise<RunResult> {
  const out: string[] = [], err: string[] = [];
  const stdout = process.stdout.write, stderr = process.stderr.write;
  const sink = (target: string[]) => ((chunk: string | Uint8Array) => { target.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString()); return true; }) as unknown as typeof process.stdout.write;
  process.stdout.write = sink(out); process.stderr.write = sink(err); process.exitCode = 0;
  try {
    await peersCommand(args);
    return { code: Number(process.exitCode ?? 0), stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = stdout; process.stderr.write = stderr; process.exitCode = 0;
  }
}

test("peers init/add/list/remove work through the CLI surface", async () => {
  const init = await runPeers("init", "--id", "node-a");
  expect(init.code).toBe(0); expect(init.stderr).toBe("");
  const identity = JSON.parse(init.stdout) as { id: string; publicKey: string };
  expect(identity.id).toBe("node-a"); expect(identity.publicKey).toHaveLength(44); expect(init.stdout).not.toContain("PRIVATE KEY");
  const certFile = path.join(root, "peer.pem"); fs.writeFileSync(certFile, CERT);
  const added = await runPeers("add", "--id", "peer-b", "--url", "https://peer-b.example:13310/",
    "--public-key", PEER_KEY, "--scope", "jobs:list", "--scope", "telemetry:read", "--prefix", "build-", "--tls-cert", certFile);
  expect(added.code).toBe(0); expect(added.stderr).toBe("");
  const text = await runPeers("list");
  expect(text.stdout).toContain("peer-b"); expect(text.stdout).toContain("https://peer-b.example:13310");
  expect(text.stdout).toContain("jobs:list,telemetry:read"); expect(text.stdout).toContain("true");
  expect(text.stdout).not.toContain("BEGIN CERTIFICATE");
  expect((JSON.parse((await runPeers("list", "--json")).stdout) as Array<{ tlsCertPem?: string }>)[0]?.tlsCertPem).toBe(CERT);
  expect((await runPeers("remove", "peer-b")).code).toBe(0);
  expect(JSON.parse((await runPeers("list", "--json")).stdout)).toEqual([]);
  const missing = await runPeers("remove", "peer-b");
  expect(missing.code).toBe(1); expect(missing.stderr).toContain("agtop: no peer named peer-b");
  expect((await runPeers("add", "--id", "peer-b")).code).toBe(1);
});

test("daemon options parse in any order and require TLS for federation", () => {
  expect(parseDaemonOptions([])).toEqual({});
  expect(parseDaemonOptions(["--port", "13309"])).toEqual({ port: 13_309 });
  expect(parseDaemonOptions(["--tls-key", "k.pem", "--federation-port", "13310", "--port", "1234", "--tls-cert", "c.pem", "--federation-host", "0.0.0.0"]))
    .toEqual({ port: 1234, federation: { port: 13_310, host: "0.0.0.0", certFile: "c.pem", keyFile: "k.pem" } });
  const fails = (args: string[], message: RegExp): void => { expect(() => parseDaemonOptions(args)).toThrow(message); };
  fails(["--federation-port", "13310", "--tls-cert", "c.pem"], /requires both --tls-cert and --tls-key/);
  fails(["--federation-port", "13310"], /requires both --tls-cert and --tls-key/);
  fails(["--tls-cert", "c.pem", "--tls-key", "k.pem"], /require --federation-port/);
  fails(["--port", "nope"], /integer/);
  fails(["--bogus", "x"], /Unknown option/);
  fails(["--port", "1", "--port", "2"], /Duplicate/);
});
