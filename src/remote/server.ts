// Federation listener (contracts 11.3, threat model 6.5). A separate TLS 1.3 server serves only
// /fed/v1/*; every request is signed by the peer and checked against the peer's scopes before any
// fleet state is read or changed. The loopback daemon token has no meaning on this port.
import * as fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import { getAcceleratorSnapshot } from "../accelerators.js";
import { audit } from "../audit.js";
import { fleetDir } from "../event-store.js";
import { FleetError, FLEET_ERROR_STATUS } from "../fleet-errors.js";
import type { FleetService, JobView, SubmitJobRequest } from "../fleet.js";
import { RUNNING_STATES } from "../job-state.js";
import type { Caller } from "../ownership.js";
import { assertPrivateFile, hardenWindowsAcl } from "../secure-fs.js";
import type { DaemonPeer, EventsQuery, JobEventType, JobState, OutputQuery } from "../types.js";
import type { PeerAuth } from "./auth.js";
import type { PeerRegistry } from "./registry.js";

export interface FederationListenerOptions {
  fleet: FleetService; registry: PeerRegistry; auth: PeerAuth;
  port: number; host?: string;
  certFile: string; keyFile: string;
}
export interface FederationListener { port: number; close(): Promise<void> }

const VERSION = "0.2.0";
const BODY_LIMIT = 65_536;
const TIMEOUT_MS = 10_000;
const FEDERATION_PREFIX = "/fed/v1/";
const ADMIN: Caller = { kind: "admin" };
const NON_NEGATIVE = "a non-negative integer";
const SUBMIT_FIELDS: ReadonlySet<string> = new Set(
  "jobId harness command args cwd peer extraEnv useLemonadeLocal lemonadeUrl cgroupRoot capture redact ringBytes spool visibility admission priority dependsOn resources leasePorts leaseTtlMs timeoutMs maxQueueMs".split(" "),
);
const KILL_FIELDS: ReadonlySet<string> = new Set(["detail"]);
const JOB_STATES: ReadonlySet<string> = new Set(["queued", "starting", "running", "exiting", "exited", "failed", "killed", "lost"]);
const EVENT_TYPES: ReadonlySet<string> = new Set(["state", "spawn", "stdout", "stderr", "exit", "lease", "policy"]);
const DEFAULT_EVENT_TYPES: JobEventType[] = ["state", "spawn", "exit", "lease", "policy"];

type RouteResult = { status: number; body: unknown };

function invalid(field: string, message: string): FleetError {
  return new FleetError("E_INVALID_REQUEST", message, { field });
}
function noSuchJob(): FleetError {
  return new FleetError("E_JOB_NOT_FOUND", "No such job.");
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** A JSON object body; unknown top-level properties are rejected by name (contracts 9.4). */
function bodyObject(value: unknown, allowed?: ReadonlySet<string>): Record<string, unknown> {
  if (!isObject(value)) throw invalid("body", "Request body must be a JSON object.");
  if (allowed !== undefined) for (const key of Object.keys(value)) if (!allowed.has(key)) throw invalid(key, `Unknown property: ${key}.`);
  return value;
}
/** Empty bodies are `{}`; anything else must parse (contracts 9.4). */
function parseJson(buffer: Buffer): unknown {
  const text = buffer.toString("utf8");
  if (text.trim() === "") return {};
  try { return JSON.parse(text); }
  catch { throw invalid("body", "Request body must be valid JSON."); }
}
/** Every query integer must be digits only and in range (contracts 9). */
function integerText(raw: string, field: string, min: number, max: number, description?: string): number {
  const text = description ?? `an integer between ${min} and ${max}`;
  if (!/^\d+$/.test(raw)) throw invalid(field, `${field} must be ${text}.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(field, `${field} must be ${text}.`);
  return value;
}
function integerParam(query: URLSearchParams, field: string, min: number, max: number, fallback: number, description?: string): number {
  const raw = query.get(field);
  return raw === null ? fallback : integerText(raw, field, min, max, description);
}
function optionalIntegerParam(query: URLSearchParams, field: string, min: number, max: number): number | undefined {
  const raw = query.get(field);
  return raw === null ? undefined : integerText(raw, field, min, max);
}
function enumParam(query: URLSearchParams, field: string, allowed: readonly string[], fallback: string): string {
  const raw = query.get(field);
  if (raw === null) return fallback;
  if (!allowed.includes(raw)) throw invalid(field, `${field} must be one of: ${allowed.join(", ")}.`);
  return raw;
}
function stringField(body: Record<string, unknown>, field: string, maxLength: number): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw invalid(field, `${field} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value;
}
function statesParam(query: URLSearchParams): JobState[] | undefined {
  const raw = query.get("state");
  if (raw === null) return undefined;
  const states = raw.split(",");
  for (const state of states) if (!JOB_STATES.has(state)) throw invalid("state", "state must be a comma-separated list of job states.");
  return states as JobState[];
}
function typesParam(query: URLSearchParams): JobEventType[] | undefined {
  const raw = query.get("types");
  if (raw === null) return undefined;
  const types = raw.split(",");
  for (const type of types) if (!EVENT_TYPES.has(type)) throw invalid("types", "types must be a comma-separated list of job event types.");
  return types as JobEventType[];
}
function jobIdOf(segment: string): string {
  try { return decodeURIComponent(segment); }
  catch { throw noSuchJob(); }
}
/** Bounded raw body read. Nothing is parsed or authenticated until this resolves. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0, settled = false;
    const fail = (error: Error): void => { if (!settled) { settled = true; reject(error); } };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > BODY_LIMIT) { fail(new FleetError("E_BODY_TOO_LARGE", `Request body exceeds ${BODY_LIMIT} bytes.`)); return; }
      chunks.push(Buffer.from(chunk));
    });
    req.on("end", () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
    req.on("error", (error: Error) => fail(error));
    req.on("aborted", () => fail(new Error("Request aborted.")));
  });
}
function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

/** A visible job's view, with an invisible job reported as E_JOB_NOT_FOUND (contracts 11.3). */
function visibleJob(fleet: FleetService, jobId: string, caller: Caller): JobView {
  try { return fleet.get(jobId, caller); }
  catch (error) {
    if (error instanceof FleetError && error.code === "E_NOT_OWNER") throw noSuchJob();
    throw error;
  }
}
/** Maps a denial to E_JOB_NOT_FOUND only when the peer also cannot see the job. */
function mapDenied(fleet: FleetService, jobId: string, caller: Caller, error: unknown): never {
  if (error instanceof FleetError && error.code === "E_NOT_OWNER") {
    try {
      fleet.get(jobId, caller);
    } catch (probe) {
      if (probe instanceof FleetError && (probe.code === "E_NOT_OWNER" || probe.code === "E_JOB_NOT_FOUND")) throw noSuchJob();
      throw probe;
    }
  }
  throw error;
}

function listJobs(fleet: FleetService, query: URLSearchParams, caller: Caller): RouteResult {
  const states = statesParam(query), peer = query.get("peer"), harness = query.get("harness");
  const owner = query.get("owner"), after = query.get("after");
  return { status: 200, body: fleet.list({
    ...(states === undefined ? {} : { states }),
    ...(peer === null ? {} : { peer }),
    ...(harness === null ? {} : { harness }),
    ...(owner === null ? {} : { ownerSessionId: owner }),
    limit: integerParam(query, "limit", 1, 500, 100),
    ...(after === null ? {} : { after }),
  }, caller) };
}

function readOutput(fleet: FleetService, jobId: string, query: URLSearchParams, caller: Caller): RouteResult {
  const tail = optionalIntegerParam(query, "tail", 1, 10_000);
  const parsed: OutputQuery = {
    stream: enumParam(query, "stream", ["stdout", "stderr", "both"], "both") as OutputQuery["stream"],
    since: integerParam(query, "since", 0, Number.MAX_SAFE_INTEGER, 0, NON_NEGATIVE),
    limit: integerParam(query, "limit", 1, 1000, 200),
    maxBytes: integerParam(query, "maxBytes", 1, 4_194_304, 1_048_576),
    encoding: enumParam(query, "encoding", ["utf8", "base64"], "utf8") as OutputQuery["encoding"],
    ...(tail === undefined ? {} : { tail }),
  };
  try { return { status: 200, body: fleet.output(jobId, parsed, caller) }; }
  catch (error) { mapDenied(fleet, jobId, caller, error); }
}

function readEvents(fleet: FleetService, jobId: string, query: URLSearchParams, caller: Caller): RouteResult {
  const types = typesParam(query);
  const parsed: EventsQuery = {
    since: integerParam(query, "since", 0, Number.MAX_SAFE_INTEGER, 0, NON_NEGATIVE),
    limit: integerParam(query, "limit", 1, 1000, 200),
    types: types ?? DEFAULT_EVENT_TYPES,
  };
  try { return { status: 200, body: fleet.events(jobId, parsed, caller) }; }
  catch (error) { mapDenied(fleet, jobId, caller, error); }
}

async function submitJob(fleet: FleetService, peer: DaemonPeer, body: Buffer, caller: Caller): Promise<RouteResult> {
  const request = bodyObject(parseJson(body), SUBMIT_FIELDS) as unknown as SubmitJobRequest;
  const job = await fleet.submit(request, caller);
  audit({ event: "peer-submit", actor: `peer:${peer.id}`, peerId: peer.id, jobId: job.jobId });
  return { status: job.state === "queued" ? 202 : 201, body: { job } };
}

async function killJob(fleet: FleetService, peer: DaemonPeer, jobId: string, body: Buffer, caller: Caller, auth: PeerAuth): Promise<RouteResult> {
  // requireScope runs before parsing and before the service call (contracts 11.3). The route's
  // scope depends on ownership: jobs:kill for an own job, jobs:kill-any for any other visible job.
  if (!peer.scopes.includes("jobs:kill") && !peer.scopes.includes("jobs:kill-any")) auth.requireScope(peer, "jobs:kill");
  const parsed = bodyObject(parseJson(body), KILL_FIELDS);
  const detail = parsed.detail === undefined ? undefined : stringField(parsed, "detail", 500);
  const view = visibleJob(fleet, jobId, caller);
  if (!view.job.owned) auth.requireScope(peer, "jobs:kill-any");
  const outcome = await fleet.kill(jobId, caller, detail);
  audit({ event: "peer-kill", actor: `peer:${peer.id}`, peerId: peer.id, jobId, ...(detail === undefined ? {} : { detail }) });
  if (outcome.result !== null && (outcome.result.failedPids.length > 0 || outcome.result.errors.length > 0)) {
    throw new FleetError("E_KILL_INCOMPLETE", "Some processes survived the kill.", { result: outcome.result });
  }
  return { status: 200, body: outcome };
}

async function dispatch(options: {
  fleet: FleetService; auth: PeerAuth; peer: DaemonPeer; selfId: string;
  method: string; path: string; query: URLSearchParams; body: Buffer;
}): Promise<RouteResult> {
  const { fleet, auth, peer, selfId, method, path, query, body } = options;
  const caller: Caller = { kind: "peer", peer };
  if (method === "GET" && path === "/fed/v1/hello") {
    return { status: 200, body: { id: selfId, version: VERSION, scopes: [...peer.scopes] } };
  }
  if (method === "GET" && path === "/fed/v1/telemetry") {
    auth.requireScope(peer, "telemetry:read");
    const guards = fleet.queue().guards;
    const running = fleet.list({ states: [...RUNNING_STATES], limit: 500 }, ADMIN).jobs.length;
    const queued = fleet.list({ states: ["queued"], limit: 500 }, ADMIN).jobs.length;
    return { status: 200, body: { accelerators: getAcceleratorSnapshot() ?? null, running, queued, guards } };
  }
  if (path === "/fed/v1/jobs") {
    if (method === "GET") { auth.requireScope(peer, "jobs:list"); return listJobs(fleet, query, caller); }
    if (method === "POST") { auth.requireScope(peer, "jobs:submit"); return submitJob(fleet, peer, body, caller); }
  }
  const output = /^\/fed\/v1\/jobs\/([^/]+)\/output$/.exec(path);
  if (method === "GET" && output !== null) {
    auth.requireScope(peer, "jobs:output");
    return readOutput(fleet, jobIdOf(output[1]!), query, caller);
  }
  const events = /^\/fed\/v1\/jobs\/([^/]+)\/events$/.exec(path);
  if (method === "GET" && events !== null) {
    auth.requireScope(peer, "jobs:events");
    return readEvents(fleet, jobIdOf(events[1]!), query, caller);
  }
  const kill = /^\/fed\/v1\/jobs\/([^/]+)\/kill$/.exec(path);
  if (method === "POST" && kill !== null) return killJob(fleet, peer, jobIdOf(kill[1]!), body, caller, auth);
  const job = /^\/fed\/v1\/jobs\/([^/]+)$/.exec(path);
  if (method === "GET" && job !== null) {
    auth.requireScope(peer, "jobs:read");
    const jobId = jobIdOf(job[1]!), view = visibleJob(fleet, jobId, caller);
    // The owner token hash never leaves the state directory (contracts 11.3, threat model 6.5).
    if (view.record === undefined) return { status: 200, body: view };
    return { status: 200, body: { ...view, record: { ...view.record, owner: { ...view.record.owner, tokenHash: "" } } } };
  }
  throw new FleetError("E_ROUTE_NOT_FOUND", "Route not found.");
}

/**
 * Starts the federation listener. Refuses to start when the identity is missing, its key is not
 * private, or (on Windows) the key ACL could not be hardened (contracts 11.3, threat model 4.2).
 */
export async function startFederationListener(options: FederationListenerOptions): Promise<FederationListener> {
  const identity = options.registry.self();
  if (identity === null) {
    throw new FleetError("E_INTERNAL", "Cannot start the federation listener without a local identity; run `agtop peers init` first.");
  }
  // The registry's own key path is authoritative; on POSIX this also re-checks its ownership and mode.
  options.registry.privateKey();
  const keyPath = path.join(fleetDir(), "federation", "identity.key");
  try { assertPrivateFile(keyPath); }
  catch (error) {
    throw new FleetError("E_INTERNAL", `Cannot start the federation listener: ${keyPath} is not private: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (process.platform === "win32") {
    const hardened = hardenWindowsAcl(keyPath);
    if (!hardened.ok) {
      throw new FleetError("E_INTERNAL", `Cannot start the federation listener: could not restrict access to ${keyPath}: ${hardened.message ?? "icacls failed"}`);
    }
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new FleetError("E_INTERNAL", "Invalid federation port.");
  }
  let cert: Buffer, key: Buffer;
  try { cert = fs.readFileSync(options.certFile); key = fs.readFileSync(options.keyFile); }
  catch (error) {
    throw new FleetError("E_INTERNAL", `Cannot read the federation TLS files: ${error instanceof Error ? error.message : String(error)}`);
  }

  const server = https.createServer({ cert, key, minVersion: "TLSv1.3" }, (req, res) => {
    res.on("error", () => undefined);
    void (async () => {
      try {
        const url = req.url ?? "";
        // Only the federation prefix is served; the loopback /v1/* surface never appears here.
        if (!url.startsWith(FEDERATION_PREFIX)) throw new FleetError("E_ROUTE_NOT_FOUND", "Route not found.");
        const body = await readBody(req);
        // D40: the signed path is the raw request line, never a re-serialized URL.
        const peer = options.auth.verify({ method: req.method ?? "", pathWithQuery: url, headers: req.headers, body });
        const queryAt = url.indexOf("?");
        const result = await dispatch({
          fleet: options.fleet, auth: options.auth, peer, selfId: identity.id,
          method: req.method ?? "", path: queryAt === -1 ? url : url.slice(0, queryAt),
          query: new URLSearchParams(queryAt === -1 ? "" : url.slice(queryAt + 1)), body,
        });
        reply(res, result.status, result.body);
      } catch (error) {
        if (res.headersSent || res.destroyed) { res.destroy(); return; }
        if (error instanceof FleetError) { reply(res, FLEET_ERROR_STATUS[error.code], error.toBody()); return; }
        // E_INTERNAL: the cause stays on stderr; the response is generic (contracts 2.7).
        console.error(`agtop federation listener: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        reply(res, 500, { error: "Internal error.", code: "E_INTERNAL" });
      }
    })();
  });
  server.requestTimeout = TIMEOUT_MS;
  server.headersTimeout = TIMEOUT_MS;
  const host = options.host ?? "0.0.0.0";
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => { server.off("listening", onListening); reject(error); };
      const onListening = (): void => { server.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(options.port, host);
    });
  } catch (error) {
    try { server.close(); } catch { /* Never listened; nothing to release. */ }
    throw new FleetError("E_INTERNAL", `Cannot start the federation listener on ${host}:${options.port}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new FleetError("E_INTERNAL", "The federation listener has no TCP address.");
  }
  let closing: Promise<void> | undefined;
  return {
    port: address.port,
    close: () => closing ??= new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections();
      server.closeAllConnections();
    }),
  };
}
