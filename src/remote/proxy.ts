// Outbound federation client (contracts 11.4). One signed https request per call: the exact
// pathWithQuery that is signed is the one Node sends, and the exact bytes that are hashed are the
// ones written to the socket. Responses are bounded and must be JSON; redirects are never
// followed. A single timer covers connect plus response and is cleared on every exit path.
import * as crypto from "node:crypto";
import * as https from "node:https";
import type { ClientRequest } from "node:http";
import type { PeerCertificate } from "node:tls";
import { FleetError } from "../fleet-errors.js";
import { signRequest } from "./auth.js";
import type { PeerRegistry } from "./registry.js";

export const REMOTE_TIMEOUT_MS = 10_000, REMOTE_MAX_RESPONSE_BYTES = 8_388_608;
const MAX_REQUEST_BODY_BYTES = 65_536;
const FEDERATION_PREFIX = "/fed/v1/";

type ForwardResult = { status: number; body: unknown };
type ProxyOptions = { timeoutMs?: number; request?: typeof https.request };

/** TLS alert/certificate codes that must surface as E_PEER_TLS, not as a generic transport error. */
const TLS_CODES: ReadonlySet<string> = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_TLS_HANDSHAKE_TIMEOUT", "EPROTO",
]);

function invalidPath(message: string): FleetError {
  return new FleetError("E_INVALID_REQUEST", message, { field: "path" });
}

/** Rejects path traversal and embedded queries before the path is resolved against the peer URL. */
function assertSafePath(path: string): void {
  if (!path.startsWith(FEDERATION_PREFIX)) throw invalidPath("Remote paths must start with /fed/v1/.");
  if (path.includes("?") || path.includes("#") || path.includes("\\") || path.includes("\0")) {
    throw invalidPath("Remote paths must not carry a query, fragment, backslash or NUL.");
  }
  for (const segment of path.slice(FEDERATION_PREFIX.length).split("/")) {
    let decoded: string;
    try { decoded = decodeURIComponent(segment); }
    catch { throw invalidPath("Remote path contains invalid percent-encoding."); }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) {
      throw invalidPath("Remote path contains a forbidden segment.");
    }
  }
}

/** Serializes once: the same Buffer is hashed for the signature and written as the request body. */
function serializeBody(body: unknown): Buffer | undefined {
  if (body === undefined) return undefined;
  let text: string | undefined;
  try { text = JSON.stringify(body); }
  catch { throw new FleetError("E_INVALID_REQUEST", "Request body is not JSON-serializable.", { field: "body" }); }
  if (text === undefined) throw new FleetError("E_INVALID_REQUEST", "Request body is not JSON-serializable.", { field: "body" });
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > MAX_REQUEST_BODY_BYTES) {
    throw new FleetError("E_BODY_TOO_LARGE", `Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes.`, { field: "body" });
  }
  return bytes;
}

/** Connection, DNS and TLS failures become the contract's E_PEER_* codes. */
function transportError(peerId: string, error: unknown): FleetError {
  if (error instanceof FleetError) return error;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (message === "certificate mismatch" || (typeof code === "string" && (TLS_CODES.has(code) || code.startsWith("ERR_SSL")))) {
    return new FleetError("E_PEER_TLS", `TLS verification with peer ${peerId} failed: ${message}`);
  }
  return new FleetError("E_PEER_UNREACHABLE", `Peer ${peerId} is unreachable: ${message}`);
}

/**
 * Forwards one JSON request to a federation peer. Resolves with the peer's status and parsed JSON
 * body, unchanged; rejects with FleetError E_PEER_*. The promise settles exactly once and clears
 * its timer, listeners and socket on every path (contracts 11.4).
 */
export class RemoteProxy {
  private readonly registry: PeerRegistry;
  private readonly timeoutMs: number;
  private readonly request: typeof https.request;

  constructor(registry: PeerRegistry, options: ProxyOptions = {}) {
    this.registry = registry;
    this.timeoutMs = options.timeoutMs ?? REMOTE_TIMEOUT_MS;
    this.request = options.request ?? https.request;
  }

  async forward(peerId: string, method: "GET" | "POST", path: string, query: URLSearchParams, body?: unknown): Promise<ForwardResult> {
    const peer = this.registry.get(peerId);
    if (peer === undefined || !peer.enabled) throw new FleetError("E_PEER_NOT_FOUND", `No enabled peer ${peerId}.`);
    // Without an identity nothing can be signed: fail closed before any network or filesystem read.
    const self = this.registry.self();
    if (self === null) throw new FleetError("E_INTERNAL", "Cannot sign a federation request without a local identity.");
    assertSafePath(path);
    const payload = serializeBody(body);
    const suffix = query.toString();
    const pathWithQuery = suffix === "" ? path : `${path}?${suffix}`;
    const privateKey = this.registry.privateKey();
    const headers: Record<string, string | number> = {
      ...signRequest(privateKey, { method, pathWithQuery, senderId: self.id, audienceId: peer.id, body: payload ?? Buffer.alloc(0) }),
      "Content-Type": "application/json",
    };
    if (payload !== undefined) headers["Content-Length"] = payload.length;
    const pinned = peer.tlsCertPem === undefined ? undefined : new crypto.X509Certificate(peer.tlsCertPem);
    const options: https.RequestOptions = {
      method, path: pathWithQuery, headers, agent: false,
      ...(pinned === undefined ? {} : {
        ca: [peer.tlsCertPem!],
        checkServerIdentity: (_host: string, cert: PeerCertificate) =>
          cert.fingerprint256 === pinned.fingerprint256 ? undefined : new Error("certificate mismatch"),
      }),
    };
    const url = new URL(path, peer.url);
    return new Promise<ForwardResult>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let req: ClientRequest | undefined;
      const finish = (error: FleetError | null, result?: ForwardResult): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
        if (error !== null) { req?.destroy(); reject(error); }
        else resolve(result!);
      };
      timer = setTimeout(() => finish(new FleetError("E_PEER_TIMEOUT", `Peer ${peerId} did not respond within ${this.timeoutMs} ms.`)), this.timeoutMs);
      try {
        req = this.request(url, options, (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            if (settled) return;
            size += chunk.length;
            if (size > REMOTE_MAX_RESPONSE_BYTES) {
              finish(new FleetError("E_PEER_PROTOCOL", `Peer ${peerId} response exceeds ${REMOTE_MAX_RESPONSE_BYTES} bytes.`));
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", (error) => finish(transportError(peerId, error)));
          res.on("end", () => {
            if (settled) return;
            let parsed: unknown;
            try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
            catch { finish(new FleetError("E_PEER_PROTOCOL", `Peer ${peerId} response was not JSON.`)); return; }
            finish(null, { status: res.statusCode ?? 0, body: parsed });
          });
          res.on("close", () => {
            if (!res.complete) finish(new FleetError("E_PEER_UNREACHABLE", `Peer ${peerId} closed the connection before the response completed.`));
          });
        });
      } catch (error) {
        finish(transportError(peerId, error));
        return;
      }
      req.once("error", (error) => finish(transportError(peerId, error)));
      if (payload === undefined) req.end(); else req.end(payload);
    });
  }
}
