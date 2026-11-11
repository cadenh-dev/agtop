// Per-peer Ed25519 request signing (contracts 11.2, ADR-005). A request carries four headers; the
// signature covers a canonical eight-line string including method, path+query, timestamp, nonce,
// both peer IDs and the body hash. The nonce cache is per peer, in memory and touched only after
// the signature verifies, so unauthenticated traffic cannot grow it.
import * as crypto from "node:crypto";
import { audit } from "../audit.js";
import { FleetError } from "../fleet-errors.js";
import type { DaemonPeer, FleetErrorCode, PeerAuthHeaders, PeerScope } from "../types.js";
import { importRawPublicKey, PeerRegistry } from "./registry.js";

export const SIGNATURE_VERSION = "AGTOP-ED25519-V1";
export const MAX_SKEW_MS = 60_000, NONCE_TTL_MS = 120_000, NONCE_CACHE_MAX = 4096;
/** Upper bound on per-peer nonce caches; removed peers are also dropped when verify sees them gone. */
const MAX_PEER_CACHES = 1024;
const PEER_ID_RE = /^[a-z0-9][a-z0-9-]{2,62}$/;
const TIMESTAMP_RE = /^\d{13}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
const SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/;
const HEADER_PEER = "X-Agtop-Peer", HEADER_TIMESTAMP = "X-Agtop-Timestamp";
const HEADER_NONCE = "X-Agtop-Nonce", HEADER_SIGNATURE = "X-Agtop-Signature";

export interface SignedRequestInput {
  /** Uppercase HTTP method. */
  method: string;
  /** Exactly as sent on the request line, e.g. "/fed/v1/jobs/a/output?tail=100". */
  pathWithQuery: string;
  timestampMs: number;
  nonce: string;
  /** X-Agtop-Peer. */
  senderId: string;
  /** The receiving daemon's LocalIdentity.id. */
  audienceId: string;
  /** Empty buffer when there is no body. */
  body: Buffer;
}
type SignRequestInput = Omit<SignedRequestInput, "timestampMs" | "nonce"> & { timestampMs?: number; nonce?: string };
type HeaderMap = Record<string, string | string[] | undefined>;
interface HeaderLookup { present: boolean; malformed: boolean; value: string }

/** The eight-line canonical request: no trailing newline, UTF-8, METHOD uppercased. */
export function canonicalRequest(input: SignedRequestInput): string {
  return [
    SIGNATURE_VERSION,
    input.method.toUpperCase(),
    input.pathWithQuery,
    String(input.timestampMs),
    input.nonce,
    input.senderId,
    input.audienceId,
    crypto.createHash("sha256").update(input.body).digest("hex"),
  ].join("\n");
}

/** Signs a request and returns the four headers a federation peer expects. */
export function signRequest(privateKey: crypto.KeyObject, input: SignRequestInput): PeerAuthHeaders {
  const timestampMs = input.timestampMs ?? Date.now();
  const nonce = input.nonce ?? crypto.randomBytes(16).toString("base64url");
  const signature = crypto.sign(null, Buffer.from(canonicalRequest({ ...input, timestampMs, nonce }), "utf8"), privateKey);
  return {
    "X-Agtop-Peer": input.senderId,
    "X-Agtop-Timestamp": String(timestampMs),
    "X-Agtop-Nonce": nonce,
    "X-Agtop-Signature": signature.toString("base64url"),
  };
}

/** Case-insensitive header lookup. Node lowercases incoming names; direct callers may not. */
function lookupHeader(headers: HeaderMap, name: string): HeaderLookup {
  const wanted = name.toLowerCase(), values: Array<string | undefined> = [];
  let present = false, malformed = false;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    present = true;
    const value = headers[key];
    if (Array.isArray(value)) malformed = true; else values.push(value);
  }
  if (!present) return { present: false, malformed: false, value: "" };
  if (malformed || values.length > 1) return { present: true, malformed: true, value: "" };
  if (values.length === 0 || values[0] === undefined) return { present: false, malformed: false, value: "" };
  return { present: true, malformed: false, value: values[0]! };
}

export class PeerAuth {
  private readonly registry: PeerRegistry;
  private readonly now: () => number;
  /** Per-peer nonce -> insertion time. Map order is refreshed on use, so the first key is the LRU. */
  private readonly nonces = new Map<string, Map<string, number>>();

  constructor(registry: PeerRegistry, options: { now?: () => number } = {}) {
    this.registry = registry;
    this.now = options.now ?? Date.now;
  }

  /** Returns the authenticated peer or throws FleetError. Checks run in the contract's order. */
  verify(request: { method: string; pathWithQuery: string; headers: HeaderMap; body: Buffer }): DaemonPeer {
    const peerHeader = lookupHeader(request.headers, HEADER_PEER);
    const actor = peerHeader.present && !peerHeader.malformed && PEER_ID_RE.test(peerHeader.value) ? peerHeader.value : undefined;
    const timestampHeader = lookupHeader(request.headers, HEADER_TIMESTAMP);
    const nonceHeader = lookupHeader(request.headers, HEADER_NONCE);
    const signatureHeader = lookupHeader(request.headers, HEADER_SIGNATURE);

    // 1. All four headers present, single-valued and well-formed.
    if (!peerHeader.present || !timestampHeader.present || !nonceHeader.present || !signatureHeader.present) {
      this.reject("E_UNAUTHORIZED", "Missing federation authentication header.", actor);
    }
    if (peerHeader.malformed || timestampHeader.malformed || nonceHeader.malformed || signatureHeader.malformed
      || !PEER_ID_RE.test(peerHeader.value) || !TIMESTAMP_RE.test(timestampHeader.value)
      || !NONCE_RE.test(nonceHeader.value) || !SIGNATURE_RE.test(signatureHeader.value)) {
      this.reject("E_SIGNATURE_INVALID", "Malformed federation authentication header.", actor);
    }
    const peerId = peerHeader.value, timestampMs = Number(timestampHeader.value);

    // 2. Known and enabled peer. Unknown and disabled are deliberately indistinguishable.
    const peer = this.registry.get(peerId);
    if (peer === undefined || !peer.enabled) {
      // No state change before the signature verifies. The peer's nonce cache is kept (it expires
      // with NONCE_TTL_MS and the LRU bound), so re-enabling a peer cannot reopen a replay window.
      this.reject("E_SIGNATURE_INVALID", "Unknown or disabled peer.", actor);
    }

    // 3. Clock window.
    const nowMs = this.now();
    if (Math.abs(nowMs - timestampMs) > MAX_SKEW_MS) {
      this.reject("E_CLOCK_SKEW", "Request timestamp is outside the allowed clock skew.", actor, { serverTimeMs: nowMs });
    }

    // 4. Audience-bound signature. Without a local identity nothing can authenticate: fail closed.
    const self = this.registry.self();
    if (self === null) this.reject("E_SIGNATURE_INVALID", "Invalid request signature.", actor);
    const canonical = canonicalRequest({
      method: request.method, pathWithQuery: request.pathWithQuery, timestampMs,
      nonce: nonceHeader.value, senderId: peerId, audienceId: self.id, body: request.body,
    });
    if (!this.validSignature(peer, canonical, signatureHeader.value)) {
      this.reject("E_SIGNATURE_INVALID", "Invalid request signature.", actor);
    }

    // 5. Replay cache. Evict lazily; never touched before the signature verifies.
    const cache = this.cacheFor(peerId);
    for (const [nonce, seenAt] of cache) if (nowMs - seenAt > NONCE_TTL_MS) cache.delete(nonce);
    if (cache.has(nonceHeader.value)) this.reject("E_REPLAY", "Nonce has already been used.", actor);
    if (cache.size >= NONCE_CACHE_MAX) this.reject("E_REPLAY_CACHE_FULL", "Nonce cache is full.", actor);
    cache.set(nonceHeader.value, nowMs);

    // lastSeenAt is advisory: a failed write must not fail an authenticated request after its nonce is spent.
    try { this.registry.touch(peer.id, new Date(nowMs)); } catch { /* best effort */ }
    return peer;
  }

  /** Throws FleetError("E_FORBIDDEN_SCOPE", …, { scope }) when the peer lacks the scope. */
  requireScope(peer: DaemonPeer, scope: PeerScope): void {
    if (!peer.scopes.includes(scope)) {
      throw new FleetError("E_FORBIDDEN_SCOPE", `Peer ${peer.id} lacks the required scope ${scope}.`, { scope });
    }
  }

  /** A malformed key or signature must reject the request, never escape as a non-FleetError. */
  private validSignature(peer: DaemonPeer, canonical: string, signature: string): boolean {
    try {
      const key = importRawPublicKey(peer.publicKey);
      return crypto.verify(null, Buffer.from(canonical, "utf8"), key, Buffer.from(signature, "base64url"));
    } catch { return false; }
  }

  private cacheFor(peerId: string): Map<string, number> {
    let cache = this.nonces.get(peerId);
    if (cache !== undefined) {
      this.nonces.delete(peerId);
      this.nonces.set(peerId, cache);
      return cache;
    }
    if (this.nonces.size >= MAX_PEER_CACHES) {
      const oldest = this.nonces.keys().next().value;
      if (oldest !== undefined) this.nonces.delete(oldest);
    }
    cache = new Map();
    this.nonces.set(peerId, cache);
    return cache;
  }

  /** Records the failure then throws. The audit record never carries the signature, nonce or body. */
  private reject(code: FleetErrorCode, message: string, peerId: string | undefined, details?: Record<string, unknown>): never {
    try {
      audit({ event: "peer-auth-failed", actor: peerId ?? "unknown", ...(peerId === undefined ? {} : { peerId }), code });
    } catch {
      /* Audit failures must never turn an authentication failure into a crash. */
    }
    throw new FleetError(code, message, details);
  }
}
