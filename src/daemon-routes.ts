// Fleet HTTP routes (contracts 9.1 and 9.2). daemon.ts authenticates first and then delegates
// every request here; undefined means the path is not a fleet route, so the v0.1 routes run.
import * as os from "node:os";
import type { FleetService, SubmitJobRequest } from "./fleet.js";
import { FleetError } from "./fleet-errors.js";
import { selfSupervisor } from "./job-runtime.js";
import type { Caller } from "./ownership.js";
import type { AdmissionPolicy, EventsQuery, JobEventType, JobState, OutputQuery } from "./types.js";

export interface RouteContext {
  method: string;
  path: string;
  query: URLSearchParams;
  readBody(): Promise<unknown>;
}

type RouteResult = { status: number; body: unknown };

const ADMIN: Caller = { kind: "admin" };
const NON_NEGATIVE = "a non-negative integer";
const SUBMIT_FIELDS: ReadonlySet<string> = new Set(
  "jobId harness command args cwd peer extraEnv useLemonadeLocal lemonadeUrl cgroupRoot capture redact ringBytes spool visibility admission priority dependsOn resources leasePorts leaseTtlMs timeoutMs maxQueueMs".split(" "),
);
const JOB_STATES: ReadonlySet<string> = new Set(["queued", "starting", "running", "exiting", "exited", "failed", "killed", "lost"]);
const EVENT_TYPES: ReadonlySet<string> = new Set(["state", "spawn", "stdout", "stderr", "exit", "lease", "policy"]);
const DEFAULT_EVENT_TYPES: JobEventType[] = ["state", "spawn", "exit", "lease", "policy"];
const LEASE_FIELDS: ReadonlySet<string> = new Set(["port", "ttlMs", "peer", "jobId"]);
const KILL_FIELDS: ReadonlySet<string> = new Set(["detail"]);
const RENEW_FIELDS: ReadonlySet<string> = new Set(["leaseId"]);

function invalid(field: string, message: string): FleetError {
  return new FleetError("E_INVALID_REQUEST", message, { field });
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
function bodyInteger(body: Record<string, unknown>, field: string, min: number, max: number): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw invalid(field, `${field} must be an integer between ${min} and ${max}.`);
  }
  return value;
}
function optionalBodyInteger(body: Record<string, unknown>, field: string, min: number, max: number): number | undefined {
  return body[field] === undefined ? undefined : bodyInteger(body, field, min, max);
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
  catch { throw new FleetError("E_JOB_NOT_FOUND", "No such job."); }
}
function portOf(segment: string): number {
  return integerText(segment, "port", 1, 65_535);
}

/**
 * Serves contracts 9.1 and 9.2 on the existing loopback listener. Returns undefined for any
 * method/path pair this module does not own, so daemon.ts falls through to its v0.1 routes.
 */
export async function handleFleetRoute(fleet: FleetService, ctx: RouteContext): Promise<RouteResult | undefined> {
  try {
    return await dispatch(fleet, ctx);
  } catch (error) {
    if (error instanceof FleetError) throw error;
    // E_INTERNAL: the cause goes to stderr, the response stays generic (contracts 2.7).
    console.error(`agtop daemon fleet route: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    throw new FleetError("E_INTERNAL", "Internal error.");
  }
}

async function dispatch(fleet: FleetService, ctx: RouteContext): Promise<RouteResult | undefined> {
  const { method, path, query } = ctx;
  if (method === "GET" && path === "/v1/jobs") {
    const states = statesParam(query), peer = query.get("peer"), harness = query.get("harness");
    const owner = query.get("owner"), after = query.get("after");
    await fleet.awaitFirstScan(); // only waits once, right after the daemon starts
    return { status: 200, body: fleet.list({
      ...(states === undefined ? {} : { states }),
      ...(peer === null ? {} : { peer }),
      ...(harness === null ? {} : { harness }),
      ...(owner === null ? {} : { ownerSessionId: owner }),
      limit: integerParam(query, "limit", 1, 500, 100),
      ...(after === null ? {} : { after }),
    }, ADMIN) };
  }
  if (method === "POST" && path === "/v1/jobs") return submitJob(fleet, ctx);
  if (method === "GET" && path === "/v1/queue") return { status: 200, body: fleet.queue() };
  if (method === "GET" && path === "/v1/policy") return { status: 200, body: { policy: fleet.queue().policy } };
  if (method === "PUT" && path === "/v1/policy") return putPolicy(fleet, ctx);
  if (method === "GET" && path === "/v1/leases") return { status: 200, body: { leases: fleet.leases.list() } };
  if (method === "POST" && path === "/v1/leases") return createLease(fleet, ctx);
  const renew = /^\/v1\/leases\/([^/]+)\/renew$/.exec(path);
  if (method === "POST" && renew !== null) return renewLease(fleet, portOf(renew[1]!), ctx);
  const release = /^\/v1\/leases\/([^/]+)$/.exec(path);
  if (method === "DELETE" && release !== null) return deleteLease(fleet, portOf(release[1]!), query);
  const output = /^\/v1\/jobs\/([^/]+)\/output$/.exec(path);
  if (method === "GET" && output !== null) return { status: 200, body: readOutput(fleet, jobIdOf(output[1]!), query) };
  const events = /^\/v1\/jobs\/([^/]+)\/events$/.exec(path);
  if (method === "GET" && events !== null) return { status: 200, body: readEvents(fleet, jobIdOf(events[1]!), query) };
  const kill = /^\/v1\/jobs\/([^/]+)\/kill$/.exec(path);
  if (method === "POST" && kill !== null) return killJob(fleet, jobIdOf(kill[1]!), ctx);
  const job = /^\/v1\/jobs\/([^/]+)$/.exec(path);
  if (method === "GET" && job !== null) {
    // The owner token hash never leaves the state directory, as in events (contracts 10.2).
    const view = fleet.get(jobIdOf(job[1]!), ADMIN);
    const record = view.record === undefined ? undefined : { ...view.record, owner: { ...view.record.owner, tokenHash: "" } };
    return { status: 200, body: record === undefined ? view : { ...view, record } };
  }
  return undefined;
}

async function submitJob(fleet: FleetService, ctx: RouteContext): Promise<RouteResult> {
  const request = bodyObject(await ctx.readBody(), SUBMIT_FIELDS) as unknown as SubmitJobRequest;
  const job = await fleet.submit(request, ADMIN);
  return { status: job.state === "queued" ? 202 : 201, body: { job } };
}

async function killJob(fleet: FleetService, jobId: string, ctx: RouteContext): Promise<RouteResult> {
  const body = bodyObject(await ctx.readBody(), KILL_FIELDS);
  const detail = body.detail === undefined ? undefined : stringField(body, "detail", 500);
  const outcome = await fleet.kill(jobId, ADMIN, detail);
  if (outcome.result !== null && (outcome.result.failedPids.length > 0 || outcome.result.errors.length > 0)) {
    throw new FleetError("E_KILL_INCOMPLETE", "Some processes survived the kill.", { result: outcome.result });
  }
  return { status: 200, body: outcome };
}

function readOutput(fleet: FleetService, jobId: string, query: URLSearchParams): unknown {
  const tail = optionalIntegerParam(query, "tail", 1, 10_000);
  const parsed: OutputQuery = {
    stream: enumParam(query, "stream", ["stdout", "stderr", "both"], "both") as OutputQuery["stream"],
    since: integerParam(query, "since", 0, Number.MAX_SAFE_INTEGER, 0, NON_NEGATIVE),
    limit: integerParam(query, "limit", 1, 1000, 200),
    maxBytes: integerParam(query, "maxBytes", 1, 4_194_304, 1_048_576),
    encoding: enumParam(query, "encoding", ["utf8", "base64"], "utf8") as OutputQuery["encoding"],
    ...(tail === undefined ? {} : { tail }),
  };
  return fleet.output(jobId, parsed, ADMIN);
}

function readEvents(fleet: FleetService, jobId: string, query: URLSearchParams): unknown {
  const types = typesParam(query);
  const parsed: EventsQuery = {
    since: integerParam(query, "since", 0, Number.MAX_SAFE_INTEGER, 0, NON_NEGATIVE),
    limit: integerParam(query, "limit", 1, 1000, 200),
    types: types ?? DEFAULT_EVENT_TYPES,
  };
  return fleet.events(jobId, parsed, ADMIN);
}

async function putPolicy(fleet: FleetService, ctx: RouteContext): Promise<RouteResult> {
  // parseAdmissionPolicy validates the complete object and names its first unknown property.
  const policy = (await ctx.readBody()) as AdmissionPolicy;
  fleet.setPolicy(policy);
  return { status: 200, body: { policy: fleet.queue().policy } };
}

async function createLease(fleet: FleetService, ctx: RouteContext): Promise<RouteResult> {
  const body = bodyObject(await ctx.readBody(), LEASE_FIELDS);
  const port = bodyInteger(body, "port", 1, 65_535);
  const ttlMs = optionalBodyInteger(body, "ttlMs", 10_000, 86_400_000);
  const peer = body.peer === undefined ? os.userInfo().username : stringField(body, "peer", 200);
  const jobId = body.jobId === undefined ? null : stringField(body, "jobId", 80);
  const lease = fleet.leases.acquire({ port, jobId, peer, sessionId: "daemon", holder: selfSupervisor("daemon"),
    ...(ttlMs === undefined ? {} : { ttlMs }) });
  return { status: 201, body: { lease } };
}

async function renewLease(fleet: FleetService, port: number, ctx: RouteContext): Promise<RouteResult> {
  const body = bodyObject(await ctx.readBody(), RENEW_FIELDS);
  const leaseId = stringField(body, "leaseId", 200);
  return { status: 200, body: { lease: fleet.leases.renew(port, leaseId) } };
}

function deleteLease(fleet: FleetService, port: number, query: URLSearchParams): RouteResult {
  const supplied = query.get("leaseId") ?? undefined;
  const lease = fleet.leases.get(port);
  if (lease === null) throw new FleetError("E_LEASE_NOT_FOUND", `No lease for port ${port}`);
  if (supplied !== undefined && lease.leaseId !== supplied) throw new FleetError("E_NOT_OWNER", `Lease ${supplied} does not hold port ${port}`);
  // release() deletes only this exact leaseId under the per-port lock. If another process took the
  // port after the read, report it instead of retrying: a retry would release the newcomer's lease.
  try { fleet.leases.release(port, lease.leaseId); }
  catch (error) {
    if (supplied === undefined && error instanceof FleetError && error.code === "E_NOT_OWNER") {
      throw new FleetError("E_LEASE_CONFLICT", `The lease on port ${port} changed while it was being released; read it again`, { port });
    }
    throw error;
  }
  return { status: 200, body: { released: true } };
}
