// Peers and remote proxy routes (contracts 9.3). Unit 5.4 calls this after handleFleetRoute and
// before the v0.1 routes; undefined means the path is not ours. Only the seven routes in the 9.3
// table are forwarded, and peer/job IDs are pattern-checked before a peer path is built.
import type { RouteContext } from "../daemon-routes.js";
import { FleetError } from "../fleet-errors.js";
import type { DaemonPeer } from "../types.js";
import type { RemoteProxy } from "./proxy.js";
import type { PeerRegistry } from "./registry.js";

type RouteResult = { status: number; body: unknown };
type RemoteCall = { peerId: string; method: "GET" | "POST"; path: string };
export interface RemoteRouteDeps { registry: PeerRegistry; proxy: RemoteProxy }

const PEER_FIELDS: ReadonlySet<string> = new Set(["id", "url", "publicKey", "scopes", "label", "tlsCertPem", "jobPeerPrefixes", "enabled"]);
const PEER_ID_RE = /^[a-z0-9][a-z0-9-]{2,62}$/;
const JOB_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const REMOTE_PREFIX = "/v1/remote/";
const JOB_ACTIONS: Readonly<Record<string, "GET" | "POST">> = { output: "GET", events: "GET", kill: "POST" };

function invalid(field: string, message: string): FleetError {
  return new FleetError("E_INVALID_REQUEST", message, { field });
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Unknown top-level body fields are rejected by name (contracts 9.4, also for POST /v1/peers). */
function bodyObject(value: unknown, allowed: ReadonlySet<string>): Record<string, unknown> {
  if (!isObject(value)) throw invalid("body", "Request body must be a JSON object.");
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw invalid(key, `Unknown property: ${key}.`);
  return value;
}
function peerIdOrThrow(peerId: string): string {
  if (!PEER_ID_RE.test(peerId)) throw new FleetError("E_PEER_NOT_FOUND", "No such peer.");
  return peerId;
}
/** Decodes and validates a job ID, then rebuilds the segment so no encoded slash reaches the peer. */
function jobCall(peerId: string, method: "GET" | "POST", segment: string, suffix = ""): RemoteCall {
  peerIdOrThrow(peerId);
  let jobId: string;
  try { jobId = decodeURIComponent(segment); }
  catch { throw new FleetError("E_JOB_NOT_FOUND", "No such job."); }
  if (!JOB_ID_RE.test(jobId)) throw new FleetError("E_JOB_NOT_FOUND", "No such job.");
  return { peerId, method, path: `/fed/v1/jobs/${encodeURIComponent(jobId)}${suffix}` };
}
function plainCall(peerId: string, method: "GET" | "POST", path: string): RemoteCall {
  return { peerId: peerIdOrThrow(peerId), method, path: `/fed/v1/${path}` };
}

/**
 * Matches exactly the 9.3 remote table against a raw request path. Returns undefined for any
 * other shape (the caller falls through to 404). IDs are validated inside the builders.
 */
function remoteCall(method: string, path: string): RemoteCall | undefined {
  if (!path.startsWith(REMOTE_PREFIX)) return undefined;
  const segments = path.slice(REMOTE_PREFIX.length).split("/");
  const [peerId, resource, id, action] = segments;
  if (peerId === undefined || resource === undefined) return undefined;
  if (segments.length === 2 && resource === "jobs" && (method === "GET" || method === "POST")) {
    return plainCall(peerId, method, "jobs");
  }
  if (segments.length === 2 && resource === "telemetry" && method === "GET") return plainCall(peerId, "GET", "telemetry");
  if (segments.length === 3 && resource === "jobs" && id !== undefined && method === "GET") return jobCall(peerId, "GET", id);
  if (segments.length === 4 && resource === "jobs" && id !== undefined && action !== undefined && JOB_ACTIONS[action] === method) {
    return jobCall(peerId, method as "GET" | "POST", id, `/${action}`);
  }
  return undefined;
}

async function dispatch(deps: RemoteRouteDeps, ctx: RouteContext): Promise<RouteResult | undefined> {
  const { method, path } = ctx;
  if (path === "/v1/peers") {
    if (method === "GET") return { status: 200, body: { self: deps.registry.self(), peers: deps.registry.list() } };
    if (method === "POST") {
      const body = bodyObject(await ctx.readBody(), PEER_FIELDS);
      const peer: DaemonPeer = deps.registry.upsert(body as Parameters<PeerRegistry["upsert"]>[0]);
      return { status: 201, body: { peer } };
    }
  }
  const removed = /^\/v1\/peers\/([^/]+)$/.exec(path);
  if (method === "DELETE" && removed !== null) {
    if (!deps.registry.remove(peerIdOrThrow(removed[1]!))) throw new FleetError("E_PEER_NOT_FOUND", "No such peer.");
    return { status: 200, body: { removed: true } };
  }
  const call = remoteCall(method, path);
  if (call === undefined) return undefined;
  // POST bodies are forwarded verbatim; GET routes never touch the request body.
  return deps.proxy.forward(call.peerId, call.method, call.path, ctx.query, call.method === "POST" ? await ctx.readBody() : undefined);
}

/** Serves contracts 9.3. Non-Fleet throws become E_INTERNAL, as in handleFleetRoute. */
export async function handleRemoteRoute(deps: RemoteRouteDeps, ctx: RouteContext): Promise<RouteResult | undefined> {
  try {
    return await dispatch(deps, ctx);
  } catch (error) {
    if (error instanceof FleetError) throw error;
    console.error(`agtop daemon remote route: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    throw new FleetError("E_INTERNAL", "Internal error.");
  }
}
