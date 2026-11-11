// Peer registry and this daemon's Ed25519 identity (contracts 11.1). <fleet>/federation holds
// identity.json, identity.key and peers.json. peers.json is shared with `agtop peers`, so reads
// are stat-cheap and lastSeenAt is re-read immediately before the atomic rename, never cached back.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { audit } from "../audit.js";
import { fleetDir } from "../event-store.js";
import { FleetError } from "../fleet-errors.js";
import { assertPrivateFile, createPrivateFileExclusive, ensurePrivateDir, hardenWindowsAcl, writePrivateFileAtomic } from "../secure-fs.js";
import type { DaemonPeer, LocalIdentity, PeerScope } from "../types.js";

type PeerInput = Pick<DaemonPeer, "id" | "url" | "publicKey" | "scopes"> & Partial<Pick<DaemonPeer, "label" | "tlsCertPem" | "jobPeerPrefixes" | "enabled">>;
interface FileStamp { mtimeNs: bigint; size: bigint; ino: bigint }
const PEER_ID_RE = /^[a-z0-9][a-z0-9-]{2,62}$/;
const PEER_SCOPES: ReadonlySet<string> = new Set<PeerScope>(["jobs:list", "jobs:read", "jobs:output", "jobs:events", "jobs:submit", "jobs:kill", "jobs:kill-any", "telemetry:read"]);
const RAW_PUBLIC_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
/** Imports a peer's raw 32-byte base64 Ed25519 public key (contracts 11.1). */
export function importRawPublicKey(raw: string): crypto.KeyObject {
  return crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw, "base64")]), format: "der", type: "spki" });
}
const SEEN_FLUSH_MS = 60_000;
const MAX_PREFIXES = 16, MAX_PREFIX_LENGTH = 200, MAX_CERT_LENGTH = 16_384;

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
function invalid(field: string, message: string): never { throw new FleetError("E_INVALID_REQUEST", message, { field }); }
const clonePeer = (peer: DaemonPeer): DaemonPeer => ({ ...peer, scopes: [...peer.scopes], jobPeerPrefixes: [...peer.jobPeerPrefixes] });
function validateId(id: unknown): string {
  if (typeof id !== "string" || !PEER_ID_RE.test(id)) invalid("id", "id must match /^[a-z0-9][a-z0-9-]{2,62}$/.");
  return id;
}
/** https only, no path beyond "/", no query, no credentials; stored as the origin (no trailing slash). */
function validateUrl(value: unknown): string {
  if (typeof value !== "string") invalid("url", "url must be a string.");
  let url: URL;
  try { url = new URL(value); } catch { invalid("url", "url must be a valid URL."); }
  if (url.protocol !== "https:") invalid("url", "url must use https.");
  if (url.pathname !== "/") invalid("url", "url must not include a path.");
  if (url.search !== "") invalid("url", "url must not include a query.");
  if (url.hash !== "") invalid("url", "url must not include a fragment.");
  if (url.username !== "" || url.password !== "") invalid("url", "url must not include credentials.");
  return url.origin;
}
function validatePublicKey(value: unknown): string {
  if (typeof value !== "string" || !RAW_PUBLIC_KEY_RE.test(value)) invalid("publicKey", "publicKey must be a standard base64 Ed25519 public key (32 bytes).");
  if (Buffer.from(value, "base64").length !== 32) invalid("publicKey", "publicKey must decode to exactly 32 bytes.");
  return value;
}
function validateScopes(value: unknown): PeerScope[] {
  if (!Array.isArray(value)) invalid("scopes", "scopes must be an array of peer scopes.");
  const scopes: PeerScope[] = [];
  for (const scope of value) {
    if (typeof scope !== "string" || !PEER_SCOPES.has(scope)) invalid("scopes", `Unknown peer scope: ${String(scope)}.`);
    if (scopes.includes(scope as PeerScope)) invalid("scopes", `Duplicate peer scope: ${scope}.`);
    scopes.push(scope as PeerScope);
  }
  return scopes;
}
function validatePrefixes(value: unknown): string[] {
  if (!Array.isArray(value)) invalid("jobPeerPrefixes", "jobPeerPrefixes must be an array of strings.");
  if (value.length > MAX_PREFIXES) invalid("jobPeerPrefixes", `jobPeerPrefixes may hold at most ${MAX_PREFIXES} entries.`);
  return value.map((prefix) => {
    if (typeof prefix !== "string" || prefix.length < 1 || prefix.length > MAX_PREFIX_LENGTH) invalid("jobPeerPrefixes", `Each jobPeerPrefixes entry must be 1-${MAX_PREFIX_LENGTH} characters.`);
    return prefix;
  });
}
function validateCertificate(value: unknown): string {
  if (typeof value !== "string") invalid("tlsCertPem", "tlsCertPem must be a PEM string.");
  if (value.length > MAX_CERT_LENGTH) invalid("tlsCertPem", `tlsCertPem must be at most ${MAX_CERT_LENGTH} characters.`);
  try { new crypto.X509Certificate(value); } catch { invalid("tlsCertPem", "tlsCertPem must be a valid PEM certificate."); }
  return value;
}
/** Raw 32-byte Ed25519 public key from the SPKI DER (the last 32 bytes), standard base64. */
function rawPublicKey(privateKey: crypto.KeyObject): string {
  const spki = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return spki.subarray(spki.length - 32).toString("base64");
}
/** os.hostname() lowercased, non [a-z0-9-] replaced by "-", trimmed to 63 (contracts 11.1). */
function defaultIdentityId(): string { return os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63); }
export class PeerRegistry {
  private readonly dir: string;
  private readonly identityPath: string;
  private readonly keyPath: string;
  private readonly peersPath: string;
  private cache: DaemonPeer[] | null = null;
  private stamp: FileStamp | null = null;
  /** lastSeenAt values not yet written. Overlaid on list()/get() and merged at flush time. */
  private pendingSeen = new Map<string, string>();
  private lastSeenFlushMs = 0;

  constructor(options: { dir?: string } = {}) {
    this.dir = options.dir ?? path.join(fleetDir(), "federation");
    this.identityPath = path.join(this.dir, "identity.json");
    this.keyPath = path.join(this.dir, "identity.key");
    this.peersPath = path.join(this.dir, "peers.json");
  }

  /**
   * Creates identity.key with an exclusive create, so two processes converge on one key: the
   * loser re-reads the winner's file. An identity that already exists is returned untouched.
   */
  ensureIdentity(id?: string): LocalIdentity {
    if (id !== undefined) validateId(id);
    ensurePrivateDir(this.dir);
    let key = this.tryReadKey();
    if (key === null) {
      const pair = crypto.generateKeyPairSync("ed25519");
      const pem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
      if (createPrivateFileExclusive(this.keyPath, pem)) {
        key = pair.privateKey;
        if (process.platform === "win32") {
          // Threat model 4.2: a failed ACL hardening is audited and warned; the listener (5.4) refuses to start.
          const result = hardenWindowsAcl(this.keyPath);
          if (!result.ok) {
            process.stderr.write(`agtop: could not restrict access to ${this.keyPath}; the federation listener will refuse to start\n`);
            audit({ event: "acl-hardening-failed", actor: "admin", detail: `${this.keyPath}: ${result.message ?? "icacls failed"}` });
          }
        }
      } else key = this.readKeyAfterRace();
    }
    const publicKey = rawPublicKey(key), existing = this.readIdentitySettled();
    if (existing !== null) {
      if (existing.publicKey === publicKey) return existing;
      // identity.key was rotated (delete it, then `agtop peers init`): keep the id, publish the new key.
      const next = { id: existing.id, publicKey };
      writePrivateFileAtomic(this.identityPath, `${JSON.stringify(next, null, 2)}\n`);
      return next;
    }
    const wanted = id ?? defaultIdentityId();
    validateId(wanted);
    const candidate = { id: wanted, publicKey };
    if (createPrivateFileExclusive(this.identityPath, `${JSON.stringify(candidate, null, 2)}\n`)) return candidate;
    // The winner may still be writing identity.json between its exclusive create and close.
    const winner = this.readIdentitySettled();
    if (winner === null) throw new FleetError("E_INTERNAL", `Cannot read the federation identity at ${this.identityPath}.`);
    return winner;
  }

  self(): LocalIdentity | null {
    try { return this.readIdentity(); } catch { return null; }
  }
  /** The Ed25519 key; refuses a key that other users can read (POSIX) or an unreadable/missing key. */
  privateKey(): crypto.KeyObject {
    let pem: Buffer;
    try { assertPrivateFile(this.keyPath); pem = fs.readFileSync(this.keyPath); }
    catch (error) { throw this.internal("load the federation identity key", error); }
    try { return crypto.createPrivateKey(pem); }
    catch (error) { throw this.internal("parse the federation identity key", error); }
  }
  list(): DaemonPeer[] { return this.visiblePeers().map(clonePeer); }
  get(id: string): DaemonPeer | undefined {
    const peer = this.visiblePeers().find((candidate) => candidate.id === id);
    return peer === undefined ? undefined : clonePeer(peer);
  }

  /** Full replacement with contract defaults; addedAt and lastSeenAt survive an update. */
  upsert(input: PeerInput): DaemonPeer {
    if (input === null || typeof input !== "object") invalid("id", "Peer input must be an object.");
    const id = validateId(input.id), url = validateUrl(input.url), publicKey = validatePublicKey(input.publicKey);
    const scopes = validateScopes(input.scopes);
    const jobPeerPrefixes = input.jobPeerPrefixes === undefined ? [] : validatePrefixes(input.jobPeerPrefixes);
    const tlsCertPem = input.tlsCertPem === undefined ? undefined : validateCertificate(input.tlsCertPem);
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") invalid("enabled", "enabled must be a boolean.");
    if (input.label !== undefined && typeof input.label !== "string") invalid("label", "label must be a string.");
    const peers = this.readPeersFromDisk(), index = peers.findIndex((peer) => peer.id === id);
    const existing = index === -1 ? undefined : peers[index]!;
    const peer: DaemonPeer = {
      id, url, publicKey, scopes, jobPeerPrefixes, enabled: input.enabled ?? true,
      ...(input.label === undefined ? {} : { label: input.label }),
      ...(tlsCertPem === undefined ? {} : { tlsCertPem }),
      addedAt: existing?.addedAt ?? new Date().toISOString(),
      lastSeenAt: existing?.lastSeenAt ?? null,
    };
    if (index === -1) peers.push(peer); else peers[index] = peer;
    this.writePeers(peers);
    // Threat model section 6: peer additions and removals are audited (an update counts as an add).
    audit({ event: "peer-added", actor: "admin", peerId: id, detail: `scopes: ${scopes.join(",") || "none"}; enabled: ${peer.enabled}` });
    return clonePeer(peer);
  }

  remove(id: string): boolean {
    const peers = this.readPeersFromDisk(), next = peers.filter((peer) => peer.id !== id);
    if (next.length === peers.length) return false;
    this.pendingSeen.delete(id);
    this.writePeers(next);
    audit({ event: "peer-removed", actor: "admin", peerId: id });
    return true;
  }

  /** Buffers lastSeenAt; flushes at most once a minute, lazily, with no timer. */
  touch(id: string, at: Date): void {
    const seenAt = at.toISOString(), previous = this.pendingSeen.get(id);
    if (previous === undefined || seenAt > previous) this.pendingSeen.set(id, seenAt);
    const now = Date.now();
    if (now - this.lastSeenFlushMs >= SEEN_FLUSH_MS) this.flushSeen(now);
  }
  private flushSeen(now: number): void {
    this.lastSeenFlushMs = now;
    if (this.pendingSeen.size === 0) return;
    let peers: DaemonPeer[];
    try { peers = this.readPeersFromDisk(); }
    catch { return; } // keep the pending values; the next flush is a minute away
    const pending = this.pendingSeen;
    this.pendingSeen = new Map();
    let changed = false;
    for (const peer of peers) {
      const seenAt = pending.get(peer.id);
      if (seenAt !== undefined && (peer.lastSeenAt === null || seenAt > peer.lastSeenAt)) { peer.lastSeenAt = seenAt; changed = true; }
    }
    if (!changed) { this.cache = peers; this.stamp = null; return; }
    try {
      // The re-read above is the closest we can get to the rename without a lock. A peer added,
      // edited or removed by another process between that read and writePrivateFileAtomic's
      // rename is overwritten; the window is exactly read/merge/stringify/rename. A cached list
      // is never written back, so a removed peer is not resurrected and an added one is not lost
      // outside that window.
      this.writePeers(peers);
    } catch { this.pendingSeen = pending; }
  }

  private readIdentity(): LocalIdentity | null {
    let text: string;
    try { text = fs.readFileSync(this.identityPath, "utf8"); }
    catch (error) { if (isMissing(error)) return null; throw this.internal("read identity.json", error); }
    try {
      const value = JSON.parse(text) as Partial<LocalIdentity> | null;
      if (typeof value?.id !== "string" || typeof value.publicKey !== "string") throw new Error("identity.json needs id and publicKey");
      return { id: value.id, publicKey: value.publicKey };
    } catch (error) { throw this.internal("parse identity.json", error); }
  }
  private tryReadKey(): crypto.KeyObject | null {
    try { return crypto.createPrivateKey(fs.readFileSync(this.keyPath)); } catch { return null; }
  }
  /** A concurrent creator may still be writing; poll briefly instead of reading a partial PEM. */
  /** readIdentity, retried for up to ~100 ms while another process is still writing identity.json. */
  private readIdentitySettled(): LocalIdentity | null {
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (let attempt = 0; ; attempt++) {
      try { return this.readIdentity(); }
      catch (error) { if (attempt >= 19) throw error; }
      Atomics.wait(pause, 0, 0, 5);
    }
  }
  private readKeyAfterRace(): crypto.KeyObject {
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (let attempt = 0; attempt < 20; attempt++) {
      const key = this.tryReadKey();
      if (key !== null) return key;
      Atomics.wait(pause, 0, 0, 5);
    }
    throw new FleetError("E_INTERNAL", `Cannot read the federation identity key at ${this.keyPath}.`);
  }
  /** Re-reads peers.json when its mtime, size or file identity differs from the last read. */
  private loadedPeers(): DaemonPeer[] {
    let stat: fs.BigIntStats;
    try { stat = fs.statSync(this.peersPath, { bigint: true }); }
    catch (error) {
      if (!isMissing(error)) throw this.internal("stat peers.json", error);
      this.cache = []; this.stamp = null;
      return [];
    }
    if (this.cache !== null && this.stamp !== null && this.stamp.mtimeNs === stat.mtimeNs && this.stamp.size === stat.size && this.stamp.ino === stat.ino) return this.cache;
    const peers = this.readPeersFromDisk();
    this.cache = peers;
    this.stamp = { mtimeNs: stat.mtimeNs, size: stat.size, ino: stat.ino };
    return peers;
  }
  /** Pending values are visible before the flush; only ids present on disk are overlaid. */
  private visiblePeers(): DaemonPeer[] {
    const peers = this.loadedPeers();
    if (this.pendingSeen.size === 0) return peers;
    return peers.map((peer) => {
      const seenAt = this.pendingSeen.get(peer.id);
      return seenAt !== undefined && (peer.lastSeenAt === null || seenAt > peer.lastSeenAt) ? { ...peer, lastSeenAt: seenAt } : peer;
    });
  }
  private readPeersFromDisk(): DaemonPeer[] {
    let text: string;
    try { text = fs.readFileSync(this.peersPath, "utf8"); }
    catch (error) { if (isMissing(error)) return []; throw this.internal("read peers.json", error); }
    let value: unknown;
    try { value = JSON.parse(text); } catch (error) { throw this.internal("parse peers.json", error); }
    if (!Array.isArray(value)) throw new FleetError("E_INTERNAL", `peers.json must contain an array: ${this.peersPath}`);
    return value as DaemonPeer[];
  }
  private writePeers(peers: DaemonPeer[]): void {
    ensurePrivateDir(this.dir);
    writePrivateFileAtomic(this.peersPath, `${JSON.stringify(peers, null, 2)}\n`);
    // The next read must hit the disk: a stat here could describe a file another writer replaced
    // after our rename, pairing a fresh mtime with stale content.
    this.cache = peers;
    this.stamp = null;
  }
  private internal(action: string, error: unknown): FleetError {
    return new FleetError("E_INTERNAL", `Cannot ${action} in ${this.dir}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
