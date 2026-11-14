// Fleet CLI surface (contracts 16): jobs, logs, events, queue, leases and submit.
// Read-only commands open FleetService as the admin (the OS user owning the state directory)
// and always close it, so no scheduler timer outlives a command. submit only talks HTTP to the
// local daemon; the CLI never supervises a fleet job itself.
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { renderOutputText } from "./capture.js";
import { FleetService, type SubmitJobRequest } from "./fleet.js";
import { isTerminal } from "./job-state.js";
import type { Caller } from "./ownership.js";
import { stateDir } from "./registry.js";
import type { JobEvent, JobSummaryV2, OutputPage, QueueEntryView, ResourceRequest } from "./types.js";

const ADMIN: Caller = { kind: "admin" };
const pollMs = 500;
const defaultPort = 13_309;
const JOB_STATES = new Set(["queued", "starting", "running", "exiting", "exited", "failed", "killed", "lost"]);

const JOBS_USAGE = "Usage: agtop jobs [--state S[,S...]] [--json]";
const LOGS_USAGE = "Usage: agtop logs JOB_ID [--stream stdout|stderr|both] [--tail N] [--since SEQ] [--follow] [--json]";
const EVENTS_USAGE = "Usage: agtop events JOB_ID [--since SEQ] [--json]";
const QUEUE_USAGE = "Usage: agtop queue [--json]";
const LEASES_USAGE = "Usage: agtop leases [--json]";
const SUBMIT_USAGE = "Usage: agtop submit [--port 13309] [run options] [--priority N] [--depends-on ID] [--lease-port P] [--gpu] [--npu] [--memory-mb N] [--timeout MS] [--no-capture] [--no-redact] -- COMMAND [ARGS...]";

type FlagKind = "flag" | "value" | "multi";
interface Parsed { flags: Map<string, string[]>; rest: string[] }

/** Options before the first positional (submit), or anywhere (logs, events). */
function parse(args: string[], spec: Record<string, FlagKind>, usage: string, anywhere = false): Parsed {
  const flags = new Map<string, string[]>(), rest: string[] = [];
  const add = (name: string, value: string, multi: boolean): void => {
    if (!multi && flags.has(name)) throw new Error(`Duplicate option: ${name}. ${usage}`);
    flags.set(name, multi ? [...(flags.get(name) ?? []), value] : [value]);
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") { rest.push(...args.slice(index + 1)); break; }
    if (!arg.startsWith("--")) {
      if (!anywhere) { rest.push(...args.slice(index)); break; }
      rest.push(arg); continue;
    }
    const kind = spec[arg];
    if (kind === undefined) throw new Error(`Unknown option: ${arg}. ${usage}`);
    if (kind === "flag") { add(arg, "", false); continue; }
    const value = args[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${arg}. ${usage}`);
    index += 1; add(arg, value, kind === "multi");
  }
  return { flags, rest };
}
const single = (flags: Map<string, string[]>, name: string): string | undefined => flags.get(name)?.[0];
const has = (flags: Map<string, string[]>, name: string): boolean => flags.has(name);
function intFlag(flags: Map<string, string[]>, name: string, usage: string, min = 0, max = Number.MAX_SAFE_INTEGER): number | undefined {
  const raw = single(flags, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}. ${usage}`);
  return value;
}
const printLine = (text: string): void => { process.stdout.write(`${text}\n`); };
const printJson = (value: unknown): void => { printLine(JSON.stringify(value, null, 2)); };
/** Text rows are one line each, even when a free-text field (peer, detail) contains controls. */
const oneLine = (text: string): string => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

/** Opens the fleet as the CLI admin and closes it on every path, success or error. */
async function withFleet<T>(fn: (fleet: FleetService) => T | Promise<T>, listing = false): Promise<T> {
  // Listing commands wait for the first process scan so dead v1 jobs are not shown as running.
  const fleet = await FleetService.open({ surface: "cli", waitForFirstScan: listing });
  try { return await fn(fleet); } finally { await fleet.close(); }
}

const jobLines = (jobs: JobSummaryV2[]): string => jobs.length === 0 ? "No fleet jobs." : jobs.map((job) => [
  job.jobId, job.state, job.harness, job.peer, job.exitCode === null ? "-" : String(job.exitCode),
  `${job.outputBytes.stdout}/${job.outputBytes.stderr}`,
].join("  ")).map(oneLine).join("\n");

async function jobs(args: string[]): Promise<void> {
  const { flags, rest } = parse(args, { "--state": "value", "--json": "flag" }, JOBS_USAGE);
  if (rest.length) throw new Error(JOBS_USAGE);
  const raw = single(flags, "--state");
  const states = raw === undefined ? undefined : raw.split(",").filter(Boolean);
  if (states?.some((state) => !JOB_STATES.has(state))) throw new Error(`--state must be a comma-separated list of job states. ${JOBS_USAGE}`);
  await withFleet((fleet) => {
    const result = fleet.list(states === undefined ? {} : { states: states as JobSummaryV2["state"][] }, ADMIN);
    if (has(flags, "--json")) printJson(result); else printLine(jobLines(result.jobs));
   }, true);
}

const writePage = (page: OutputPage, asJson: boolean): void => { if (asJson) printJson(page); else process.stdout.write(renderOutputText(page)); };

async function logs(args: string[]): Promise<void> {
  const { flags, rest } = parse(args, { "--stream": "value", "--tail": "value", "--since": "value", "--follow": "flag", "--json": "flag" }, LOGS_USAGE, true);
  if (rest.length !== 1) throw new Error(LOGS_USAGE);
  const stream = single(flags, "--stream") ?? "both";
  if (stream !== "stdout" && stream !== "stderr" && stream !== "both") throw new Error(`--stream must be stdout, stderr or both. ${LOGS_USAGE}`);
  const since = intFlag(flags, "--since", LOGS_USAGE), tail = intFlag(flags, "--tail", LOGS_USAGE, 1, 10_000) ?? 100;
  const asJson = has(flags, "--json"), follow = has(flags, "--follow");
  await withFleet(async (fleet) => {
    let page = fleet.output(rest[0]!, { stream, since: since ?? 0, tail }, ADMIN);
    writePage(page, asJson);
    // The awaited delay leaves no timer behind: a failed poll rejects and close() still runs.
    while (follow && !isTerminal(page.state)) {
      await delay(pollMs);
      page = fleet.output(rest[0]!, { stream, since: page.nextSince }, ADMIN);
      writePage(page, asJson);
    }
  });
}

function eventSummary(event: JobEvent): string {
  switch (event.type) {
    case "state": return `${event.previous ?? "-"} -> ${event.state} (${event.reason})${event.detail === undefined ? "" : `: ${event.detail}`}`;
    case "spawn": return `pid ${event.pid} ${event.containmentMode} capture ${event.capture}`;
    case "stdout":
    case "stderr": return `${event.byteLength} bytes at ${event.offset}`;
    case "exit": return `exit ${event.exitCode ?? event.signal ?? "unknown"} in ${event.durationMs}ms`;
    case "lease": return `${event.action} port ${event.port}`;
    case "policy": return `${event.decision} ${event.rule}: ${event.detail}`;
  }
}

async function events(args: string[]): Promise<void> {
  const { flags, rest } = parse(args, { "--since": "value", "--json": "flag" }, EVENTS_USAGE, true);
  if (rest.length !== 1) throw new Error(EVENTS_USAGE);
  const since = intFlag(flags, "--since", EVENTS_USAGE);
  await withFleet((fleet) => {
    const page = fleet.events(rest[0]!, since === undefined ? {} : { since }, ADMIN);
    if (has(flags, "--json")) printJson(page);
    else printLine(page.events.length === 0 ? "No events." : page.events.map((event) => oneLine(`${event.seq}  ${event.timestamp}  ${event.type}  ${eventSummary(event)}`)).join("\n"));
  });
}

/**
 * `FleetService.queue()` reports this process's last scheduler pass, and a fresh CLI process has
 * not run one yet. When the state directory holds queued jobs, wait for the first poll of the
 * service this command opened (its scheduler never starts a foreign job), capped so a large
 * policy poll interval cannot hang the command. Unit 3.5 follow-up: queue() should derive the
 * views from the index instead of waiting for a pass.
 */
async function queueView(fleet: FleetService): Promise<ReturnType<FleetService["queue"]>> {
  let view = fleet.queue();
  if (view.entries.length > 0 || fleet.list({ states: ["queued"] }, ADMIN).jobs.length === 0) return view;
  const deadline = Date.now() + Math.min(view.policy.pollMs, 1_500) + 250;
  while (view.entries.length === 0 && Date.now() < deadline) { await delay(50); view = fleet.queue(); }
  return view;
}
function queueLine(entry: QueueEntryView): string {
  const blockers = entry.blockedBy.length === 0 ? "ready" : entry.blockedBy.map((block) => {
    if (block.kind === "dependency") return `dependency ${block.jobIds.join(",")}`;
    if (block.kind === "cap") return `cap ${block.cap} ${block.running}/${block.limit}`;
    if (block.kind === "lease") return `lease ${block.port}`;
    if (block.kind === "policy") return `policy ${block.rule}`;
    return `outranked by ${block.byJobId}`;
  }).join(", ");
  return oneLine(`${entry.position}  ${entry.jobId}  ${entry.harness}  ${entry.peer}  priority ${entry.effectivePriority}  ${blockers}`);
}

async function queue(args: string[]): Promise<void> {
  const { flags, rest } = parse(args, { "--json": "flag" }, QUEUE_USAGE);
  if (rest.length) throw new Error(QUEUE_USAGE);
  await withFleet(async (fleet) => {
    const view = await queueView(fleet);
    if (has(flags, "--json")) { printJson(view); return; }
    const lines = view.entries.length === 0 ? ["No queued jobs."] : view.entries.map(queueLine);
    lines.push(`Guards: ${view.guards.map((guard) => `${guard.rule} ${guard.closed ? "closed" : "open"}`).join("  ") || "none"}`);
    const policy = view.policy;
    lines.push(`Policy: maxRunning ${policy.maxRunning}  perPeer ${policy.maxRunningPerPeer}  perHarness ${policy.maxRunningPerHarness}  maxQueued ${policy.maxQueued}`);
    printLine(lines.join("\n"));
  }, true); // cap counts include migrated v1 jobs
}

async function leases(args: string[]): Promise<void> {
  const { flags, rest } = parse(args, { "--json": "flag" }, LEASES_USAGE);
  if (rest.length) throw new Error(LEASES_USAGE);
  await withFleet((fleet) => {
    const list = fleet.leases.list().map(({ leaseId: _leaseId, sessionId: _sessionId, ...lease }) => lease);
    if (has(flags, "--json")) printJson(list);
    else printLine(list.length === 0 ? "No port leases." : list.map((lease) => oneLine(
      `${lease.port}  ${lease.jobId ?? "-"}  ${lease.peer}  ${lease.holder.surface}  pid ${lease.holder.pid}  expires ${lease.expiresAt}  ttl ${lease.ttlMs}`)).join("\n"));
  });
}

const SUBMIT_FLAGS: Record<string, FlagKind> = {
  "--port": "value", "--harness": "value", "--id": "value", "--cwd": "value", "--peer": "value",
  "--lemonade": "flag", "--lemonade-url": "value", "--cgroup-root": "value",
  "--priority": "value", "--depends-on": "multi", "--lease-port": "multi", "--gpu": "flag", "--npu": "flag",
  "--memory-mb": "value", "--timeout": "value", "--no-capture": "flag", "--no-redact": "flag",
};

async function postJob(port: number, request: SubmitJobRequest): Promise<void> {
  const tokenFile = path.join(stateDir(), `daemon-${port}.token`);
  let token: string;
  try { token = fs.readFileSync(tokenFile, "utf8").trim(); }
  catch { throw new Error(`No daemon token file for port ${port}; start agtop daemon --port ${port} first.`); }
  if (token.length === 0) throw new Error(`The daemon token file for port ${port} is empty; start agtop daemon --port ${port} again.`);
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/v1/jobs`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(request), signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new Error(`Cannot reach the daemon on port ${port}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  let body: unknown;
  try { body = text.trim() === "" ? {} : JSON.parse(text); }
  catch { throw new Error(`The daemon on port ${port} returned an invalid response (HTTP ${response.status}).`); }
  if (!response.ok) {
    const reported = body !== null && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error : `The daemon on port ${port} returned HTTP ${response.status}.`;
    throw new Error(reported);
  }
  printJson(body);
}

async function submit(args: string[]): Promise<void> {
  const { flags, rest } = parse(args, SUBMIT_FLAGS, SUBMIT_USAGE);
  if (rest.length === 0) throw new Error(SUBMIT_USAGE);
  const port = intFlag(flags, "--port", SUBMIT_USAGE, 1, 65_535) ?? defaultPort;
  const request: SubmitJobRequest = { command: rest[0]!, args: rest.slice(1) };
  const harness = single(flags, "--harness"), jobId = single(flags, "--id"), cwd = single(flags, "--cwd"), peer = single(flags, "--peer");
  if (harness !== undefined) request.harness = harness as SubmitJobRequest["harness"];
  if (jobId !== undefined) request.jobId = jobId;
  if (cwd !== undefined) request.cwd = cwd;
  if (peer !== undefined) request.peer = peer;
  if (has(flags, "--lemonade")) request.useLemonadeLocal = true;
  const lemonadeUrl = single(flags, "--lemonade-url"), cgroupRoot = single(flags, "--cgroup-root");
  if (lemonadeUrl !== undefined) request.lemonadeUrl = lemonadeUrl;
  if (cgroupRoot !== undefined) request.cgroupRoot = cgroupRoot;
  const priority = intFlag(flags, "--priority", SUBMIT_USAGE, -100, 100);
  if (priority !== undefined) request.priority = priority;
  const dependsOn = flags.get("--depends-on");
  if (dependsOn !== undefined) request.dependsOn = dependsOn;
  const leasePorts = (flags.get("--lease-port") ?? []).map((raw) => {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`--lease-port must be an integer between 1 and 65535. ${SUBMIT_USAGE}`);
    return value;
  });
  if (leasePorts.length > 0) request.leasePorts = leasePorts;
  const resources: ResourceRequest = {};
  if (has(flags, "--gpu")) resources.gpu = true;
  if (has(flags, "--npu")) resources.npu = true;
  const memoryMb = intFlag(flags, "--memory-mb", SUBMIT_USAGE, 1, 1_048_576);
  if (memoryMb !== undefined) resources.memoryMb = memoryMb;
  if (Object.keys(resources).length > 0) request.resources = resources;
  const timeoutMs = intFlag(flags, "--timeout", SUBMIT_USAGE, 0, 604_800_000);
  if (timeoutMs !== undefined) request.timeoutMs = timeoutMs;
  if (has(flags, "--no-capture")) request.capture = false;
  if (has(flags, "--no-redact")) request.redact = false;
  await postJob(port, request);
}

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = { jobs, logs, events, queue, leases, submit };

/** Runs a fleet CLI command; false when the command belongs to another surface (contracts 16). */
export async function fleetCommand(command: string, args: string[]): Promise<boolean> {
  const run = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (run === undefined) return false;
  try { await run(args); }
  catch (error) {
    process.stderr.write(`agtop: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
  return true;
}
