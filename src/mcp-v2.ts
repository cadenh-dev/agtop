// Fleet-aware MCP tools and resources (contracts 10). Every call goes through FleetService;
// this module never imports the runtime, scheduler, queue, leases, policy, event store or index.
import * as path from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { renderOutputText } from "./capture.js";
import { FleetError } from "./fleet-errors.js";
import type { FleetService, JobView } from "./fleet.js";
import { harnessLabel, harnesses } from "./harnesses.js";
import { isTerminal } from "./job-state.js";
import { formatEndpoint } from "./net-format.js";
import type { Caller } from "./ownership.js";
import { pruneStaleJobs, validateJobId } from "./registry.js";
import type { AgentProcess, AgentProcessTree, HarnessType, JobEventType, JobSummaryV2 } from "./types.js";

const OUTPUT_STREAMS = new Set(["stdout", "stderr", "both"]);
const LIFECYCLE_TYPES: JobEventType[] = ["state", "spawn", "exit", "lease", "policy"];

export interface FleetToolHelpers {
  /** The v0.1 peer label, appended from request metadata. */
  peerFor(extra: { _meta?: Record<string, unknown> }, requested?: string): string;
  /** The process snapshot for status and list (never called on a scheduler or lease path). */
  trees(): Promise<AgentProcessTree[]>;
}

export interface FleetResources {
  close(): void;
}

export function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

export function failure(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** v0.1 tool failures keep their bare "agtop: message" shape; the new tools use "<CODE>: <message>". */
function legacyFailure(error: unknown): string {
  return `agtop: ${error instanceof Error ? error.message : String(error)}`;
}

/** Fixed output/events failure texts from contracts 10.2. */
function readFailure(error: unknown, jobId: string): string {
  if (error instanceof FleetError) {
    if (error.code === "E_JOB_NOT_FOUND") return `agtop: E_JOB_NOT_FOUND: no job named ${jobId}.`;
    return `agtop: ${error.code}: ${error.message}`;
  }
  return legacyFailure(error);
}

export function summary(tree: AgentProcessTree, isOwned = false) {
  return {
    jobId: tree.jobId,
    harness: tree.harness,
    label: harnessLabel(tree.harness),
    rootPid: tree.rootPid,
    rootStartTime: tree.processes.find(p => p.pid === tree.rootPid)?.startTime,
    containmentMode: tree.containmentMode,
    roleCounts: tree.roleCounts,
    backend: tree.backend,
    backendEvidence: tree.backendEvidence,
    peer: tree.userOrPeer,
    cpuPercent: Number(tree.totalCpuPercent.toFixed(1)),
    memoryMb: Number(tree.totalMemoryMb.toFixed(1)),
    gpuPercent: tree.gpuPercent,
    npuPercent: tree.npuPercent,
    gpuMemoryMb: tree.gpuMemoryMb,
    listening: [...new Set(tree.processes.flatMap(p => (p.listeningSockets ?? []).map(socket => formatEndpoint(socket.address, socket.port))))],
    processCount: tree.processes.length,
    git: tree.git
      ? { repoRoot: tree.git.repoRoot, branch: tree.git.branch, isWorktree: tree.git.isWorktree }
      : undefined,
    owned: isOwned,
  };
}

export function ownedProcessSummary(p: AgentProcess) {
  return {
    pid: p.pid, ppid: p.ppid, name: p.name, cmdline: p.cmdline,
    cpuPercent: Number(p.cpuPercent.toFixed(1)), memoryMb: Number(p.memoryMb.toFixed(1)),
    role: p.role, roleEvidence: p.roleEvidence, accelerators: p.accelerators,
    listening: (p.listeningSockets ?? []).map(socket => formatEndpoint(socket.address, socket.port)),
  };
}

export function statusPayload(tree: AgentProcessTree, isOwned: boolean, includeProcesses: boolean): Record<string, unknown> {
  const value: Record<string, unknown> = summary(tree, isOwned);
  if (includeProcesses && isOwned) value.processes = tree.processes.map(ownedProcessSummary);
  else if (includeProcesses) value.note = "Process details are only available for jobs created by this MCP session.";
  return value;
}

export function cleanupResults<T>(
  jobs: Array<{ jobId: string; alreadyExited?: boolean; exitCode?: number }>,
  settled: PromiseSettledResult<T>[],
): Array<Record<string, unknown>> {
  let activeIndex = 0;
  return jobs.map(({ jobId, alreadyExited, exitCode }) => {
    if (alreadyExited) return { jobId, alreadyExited: true, exitCode };
    const result = settled[activeIndex++];
    if (!result) return { jobId, error: "Missing termination result" };
    if (result.status === "rejected") return { jobId, error: result.reason instanceof Error ? result.reason.message : String(result.reason) };
    return { jobId, ...(result.value as object) };
  });
}

function mayRead(job: JobSummaryV2, caller: Caller): boolean {
  if (caller.kind === "admin") return true;
  if (caller.kind === "session") {
    return job.owned || job.visibility === "all" || (job.visibility === "peer" && job.peer === caller.peer);
  }
  return job.owned || job.visibility === "all";
}

function addedStatusFields(view: JobView, caller: Caller): Record<string, unknown> {
  const job = view.job;
  const value: Record<string, unknown> = { outputBytes: job.outputBytes, lastSeq: job.lastSeq };
  if (mayRead(job, caller)) {
    value.state = job.state;
    value.stateReason = job.stateReason;
    value.captured = job.captured;
    if (view.queue !== undefined) value.queue = view.queue;
    if (view.leases.length > 0) value.leases = view.leases;
    if (job.captured) value.truncation = view.truncation;
  }
  return value;
}

function ownedFields(view: JobView): Record<string, unknown> {
  const job = view.job, record = view.record;
  return {
    jobId: job.jobId,
    harness: job.harness,
    label: harnessLabel(job.harness),
    peer: job.peer,
    command: record?.command,
    cwd: record?.cwd,
    createdAt: job.createdAt,
    exited: isTerminal(job.state),
    exitCode: job.exitCode,
    exitedAt: job.exitedAt ?? undefined,
    error: record?.error ?? undefined,
    owned: true,
  };
}

function fleetRow(job: JobSummaryV2): Record<string, unknown> {
  return {
    jobId: job.jobId, harness: job.harness, label: harnessLabel(job.harness), rootPid: null, containmentMode: null,
    roleCounts: {}, backend: "unknown", backendEvidence: "", peer: job.peer,
    cpuPercent: 0, memoryMb: 0, gpuPercent: 0, npuPercent: 0, gpuMemoryMb: 0, listening: [], processCount: 0,
    owned: job.owned, state: job.state, captured: job.captured, outputBytes: job.outputBytes, lastSeq: job.lastSeq,
  };
}

function matchesQuery(row: Record<string, unknown>, query: string | undefined): boolean {
  if (!query) return true;
  const roleCounts = (row.roleCounts ?? {}) as Record<string, number>;
  const git = row.git as { repoRoot?: string; branch?: string } | undefined;
  return [
    row.jobId, row.harness, row.label, row.peer, row.backend, row.containmentMode, row.state, git?.repoRoot, git?.branch,
    ...Object.keys(roleCounts),
  ].some(value => typeof value === "string" && value.toLowerCase().includes(query));
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref(); });
}

/** Registers run, status, list, wait, kill, cleanup, output and events (contracts 10.1 and 10.2). */
export function registerFleetTools(server: McpServer, fleet: FleetService, helpers: FleetToolHelpers): void {
  const callerFor = (extra: { _meta?: Record<string, unknown> }, requested?: string): Caller =>
    ({ kind: "session", session: fleet.session, peer: helpers.peerFor(extra, requested) });
  const queuedView = async (jobId: string, caller: Caller): Promise<JobView> => {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const view = fleet.get(jobId, caller);
      if (view.job.state !== "queued" || view.queue !== undefined) return view;
      await delay(20);
    }
    return fleet.get(jobId, caller);
  };

  server.registerTool("run", {
    title: "Run a contained task",
    description: "Start a command in its own OS containment unit (Windows Job Object, Linux cgroup or process group, or macOS process group). Returns a job ID. Stdout and stderr are captured into a bounded buffer that the output tool reads; pass capture false to discard output. Use wait, status, output, events, kill, or cleanup with the returned job ID.",
    inputSchema: {
      command: z.string().min(1).max(4096).describe("Executable to launch. Script shims need an explicit interpreter."),
      args: z.array(z.string()).optional().describe("Exact argument array; no shell interpolation."),
      cwd: z.string().max(4096).optional().describe("Working directory. Defaults to the MCP server's directory."),
      harness: z.string().max(80).optional().describe("Harness ID from the harnesses tool. Defaults to custom."),
      jobId: z.string().min(1).max(80).optional().describe("Task ID to use for the job. A UUID is generated when omitted."),
      peer: z.string().max(200).optional().describe("Peer or task label for attribution. Defaults to the MCP session."),
      capture: z.boolean().optional().describe("Capture stdout and stderr into a bounded buffer readable with the output tool. Default true."),
      redact: z.boolean().optional().describe("Redact secrets from captured output. Default true; false is audited."),
      priority: z.number().int().min(-100).max(100).optional().describe("Queue priority; higher runs first. Passing it queues the job."),
      dependsOn: z.array(z.string().min(1).max(80)).max(16).optional().describe("Job IDs that must exit with code 0 first."),
      leasePorts: z.array(z.number().int().min(1).max(65535)).max(8).optional().describe("TCP ports this job will bind; the job waits until each is free."),
      resources: z.object({ gpu: z.boolean().optional(), npu: z.boolean().optional(), memoryMb: z.number().int().min(1).max(1048576).optional() }).optional()
        .describe("Resources the job needs; the job waits while they are busy."),
      timeoutMs: z.number().int().min(0).max(604800000).optional().describe("Kill the job this long after it starts. 0 or absent: no limit."),
      visibility: z.enum(["owner", "peer", "all"]).optional().describe("Who may read this job's output. Default owner."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input, extra) => {
    const selected = (input.harness ?? "custom") as HarnessType;
    if (!harnesses.includes(selected)) {
      return failure(`agtop: unknown harness "${input.harness}". Use the harnesses tool to search ${harnesses.length} supported IDs.`);
    }
    const resolvedCwd = path.resolve(input.cwd ?? process.cwd());
    const label = helpers.peerFor(extra, input.peer);
    const caller = callerFor(extra, input.peer);
    try {
      if (input.jobId !== undefined) validateJobId(input.jobId);
      const submitted = await fleet.submit({
        jobId: input.jobId, harness: selected, command: input.command, args: input.args ?? [], cwd: resolvedCwd, peer: label,
        capture: input.capture, redact: input.redact, priority: input.priority, dependsOn: input.dependsOn,
        leasePorts: input.leasePorts, resources: input.resources, timeoutMs: input.timeoutMs, visibility: input.visibility,
      }, caller);
      notifiers.get(server)?.jobCreated(submitted.jobId);
      const view = await queuedView(submitted.jobId, caller);
      if (view.job.state === "queued") {
        return text({
          jobId: view.job.jobId, state: "queued", harness: selected, label, peer: label, cwd: resolvedCwd,
          captured: view.job.captured, queue: { position: view.queue?.position ?? 0, blockedBy: view.queue?.blockedBy ?? [] },
        });
      }
      return text({
        jobId: view.job.jobId, pid: view.job.rootPid, harness: selected, label, containmentMode: view.job.containmentMode,
        peer: label, cwd: resolvedCwd, state: view.job.state, captured: view.job.captured,
      });
    } catch (error) {
      return failure(legacyFailure(error));
    }
  });

  server.registerTool("status", {
    title: "Inspect a job",
    description: "Inspect one job with GPU/NPU tree totals and fleet state. Per-process details, including accelerator usage, are included only for jobs created by this MCP session.",
    inputSchema: {
      jobId: z.string().min(1).max(80).describe("Job ID returned by run."),
      includeProcesses: z.boolean().optional().describe("Include the process tree for an owned job."),
    },
    annotations: { readOnlyHint: true },
  }, async ({ jobId, includeProcesses }, extra) => {
    const caller = callerFor(extra);
    try {
      let view: JobView | undefined;
      try { view = fleet.get(jobId, caller); }
      catch (error) { if (!(error instanceof FleetError && error.code === "E_JOB_NOT_FOUND")) throw error; }
      const tree = (await helpers.trees()).find(candidate => candidate.jobId === jobId);
      if (tree === undefined && view === undefined) return failure(`agtop: no job named ${jobId}.`);
      if (tree === undefined) {
        const value = fleetRow(view!.job);
        return text({ ...value, ...addedStatusFields(view!, caller), ...(view!.job.owned ? ownedFields(view!) : {}) });
      }
      const owned = view?.job.owned ?? false;
      const value = statusPayload(tree, owned, Boolean(includeProcesses));
      if (view !== undefined) Object.assign(value, addedStatusFields(view, caller));
      if (view?.job.owned) Object.assign(value, ownedFields(view));
      return text(value);
    } catch (error) {
      return failure(legacyFailure(error));
    }
  });

  server.registerTool("list", {
    title: "List agent trees",
    description: "List known agent trees with harness, process role counts, listening ports, worktree, CPU, memory, GPU/NPU totals, containment mode and fleet state. Command lines are omitted for jobs this session does not own.",
    inputSchema: { query: z.string().max(200).optional().describe("Filter by job, harness, role, peer, branch, backend, or containment mode.") },
    annotations: { readOnlyHint: true },
  }, async ({ query }, extra) => {
    const caller = callerFor(extra);
    try {
      const q = query?.toLowerCase();
      const fleetJobs = fleet.list({ limit: 500 }, caller).jobs;
      const byId = new Map(fleetJobs.map(job => [job.jobId, job]));
      const jobs: Array<Record<string, unknown>> = [];
      const live = new Set<string>();
      for (const tree of await helpers.trees()) {
        live.add(tree.jobId);
        const job = byId.get(tree.jobId);
        const row = summary(tree, job?.owned ?? false);
        if (job !== undefined) Object.assign(row, { state: job.state, captured: job.captured, outputBytes: job.outputBytes, lastSeq: job.lastSeq });
        if (matchesQuery(row, q)) jobs.push(row);
      }
      for (const job of fleetJobs) {
        if (live.has(job.jobId)) continue;
        const row = fleetRow(job);
        if (matchesQuery(row, q)) jobs.push(row);
      }
      return text({ jobs });
    } catch (error) {
      return failure(legacyFailure(error));
    }
  });

  server.registerTool("wait", {
    title: "Wait for a job",
    description: "Wait for a job created by this MCP session to exit. Returns its exit code or a timeout. The job keeps running after a timeout.",
    inputSchema: {
      jobId: z.string().min(1).max(80).describe("Job ID returned by run."),
      timeoutMs: z.number().int().min(0).max(3_600_000).optional().describe("Maximum wait in milliseconds. Defaults to 60000."),
    },
    annotations: { readOnlyHint: true },
  }, async ({ jobId, timeoutMs }, extra) => {
    const caller = callerFor(extra);
    try {
      const view = fleet.get(jobId, caller);
      if (!view.job.owned) return failure("agtop: only jobs created by this MCP session can be awaited.");
      const result = await fleet.wait(jobId, timeoutMs ?? 60_000);
      return text({
        jobId, exited: result.exited, ...(result.timedOut ? { timedOut: true as const } : {}),
        ...(result.exited ? { exitCode: result.exitCode } : {}), state: result.state,
      });
    } catch (error) {
      if (error instanceof FleetError && error.code === "E_JOB_NOT_FOUND") return failure("agtop: only jobs created by this MCP session can be awaited.");
      return failure(legacyFailure(error));
    }
  });

  server.registerTool("kill", {
    title: "Stop a job",
    description: "Terminate a job created by this MCP session and report which PIDs exited. Jobs created by other sessions or discovered passively are rejected.",
    inputSchema: {
      jobId: z.string().min(1).max(80).describe("Job ID returned by run."),
      expectedStartTime: z.string().max(80).optional().describe("Creation time from a previous status call, to guard against PID reuse."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ jobId, expectedStartTime }, extra) => {
    const caller = callerFor(extra);
    try {
      const view = fleet.get(jobId, caller);
      if (!view.job.owned) return failure("agtop: only jobs created by this MCP session can be stopped.");
      const started = view.record?.containment?.startTime;
      if (expectedStartTime !== undefined && started !== undefined && started !== expectedStartTime) {
        return failure("agtop: The process identity changed. Refresh the agent tree before terminating it.");
      }
      if (isTerminal(view.job.state)) return text({ jobId, alreadyExited: true, exitCode: view.job.exitCode });
      const wasQueued = view.job.state === "queued";
      const killed = await fleet.kill(jobId, caller);
      if (wasQueued) return text({ jobId, cancelled: true, state: killed.job.state });
      if (killed.result === null) {
        if (isTerminal(killed.job.state)) return text({ jobId, alreadyExited: true, exitCode: killed.job.exitCode });
        return text({ jobId, killedPids: [], failedPids: [], errors: [] });
      }
      return text({ jobId, ...killed.result });
    } catch (error) {
      if (error instanceof FleetError && error.code === "E_JOB_NOT_FOUND") return failure("agtop: only jobs created by this MCP session can be stopped.");
      return failure(legacyFailure(error));
    }
  });

  server.registerTool("cleanup", {
    title: "Stop all task jobs",
    description: "Terminate every job created by this MCP session and remove records proven stale. Other live jobs remain untouched.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (_args, extra) => {
    const caller = callerFor(extra);
    const owned = fleet.list({ limit: 500 }, caller).jobs.filter(job => job.owned);
    const results = await Promise.all(owned.map(async job => {
      if (isTerminal(job.state)) return { jobId: job.jobId, alreadyExited: true, exitCode: job.exitCode };
      try {
        const killed = await fleet.kill(job.jobId, caller, "cleanup");
        if (job.state === "queued") return { jobId: job.jobId, cancelled: true, state: killed.job.state };
        return { jobId: job.jobId, ...(killed.result ?? {}) };
      } catch (error) {
        return { jobId: job.jobId, error: error instanceof Error ? error.message : String(error) };
      }
    }));
    if (pruneStaleJobs().length > 0) notifiers.get(server)?.listChanged();
    return text({ jobs: results });
  });

  server.registerTool("output", {
    title: "Read job output",
    description: "Read captured stdout/stderr of a job created by this MCP session. Returns the last lines by default; pass since to page forward. Output is bounded: older bytes are dropped and reported in truncation.",
    inputSchema: {
      jobId: z.string().min(1).max(80).describe("Job ID returned by run."),
      stream: z.enum(["stdout", "stderr", "both"]).optional().describe("Default both."),
      tail: z.number().int().min(1).max(2000).optional().describe("Return only the last N lines. Default 100 when since is absent."),
      since: z.number().int().min(0).optional().describe("Return chunks after this sequence number (nextSince of a previous call)."),
      maxBytes: z.number().int().min(1024).max(262144).optional().describe("Byte budget for this call. Default 65536."),
      format: z.enum(["text", "json"]).optional().describe("text (default) joins the output; json returns chunks."),
    },
    annotations: { readOnlyHint: true },
  }, async ({ jobId, stream, tail, since, maxBytes, format }, extra) => {
    try {
      const page = fleet.output(jobId, {
        stream: stream ?? "both",
        ...(tail !== undefined ? { tail } : since === undefined ? { tail: 100 } : { since }),
        ...(since !== undefined ? { since } : {}),
        maxBytes: maxBytes ?? 65_536, limit: 200,
      }, callerFor(extra));
      if (format === "json") return text(page);
      return text({
        jobId: page.jobId, state: page.state, exitCode: page.exitCode, stream: page.stream, since: page.since,
        nextSince: page.nextSince, lastSeq: page.lastSeq, hasMore: page.hasMore, outputBytes: page.outputBytes,
        truncation: page.truncation, text: renderOutputText(page),
      });
    } catch (error) {
      return failure(readFailure(error, jobId));
    }
  });

  server.registerTool("events", {
    title: "Read job events",
    description: "Read the lifecycle timeline of a job created by this MCP session: queue, start, exit, port leases, and admission decisions.",
    inputSchema: {
      jobId: z.string().min(1).max(80).describe("Job ID returned by run."),
      since: z.number().int().min(0).optional().describe("Return events after this sequence number."),
      limit: z.number().int().min(1).max(500).optional().describe("Default 100."),
      types: z.array(z.enum(["state", "spawn", "exit", "lease", "policy"])).optional().describe("Default: all lifecycle types."),
    },
    annotations: { readOnlyHint: true },
  }, async ({ jobId, since, limit, types }, extra) => {
    try {
      return text(fleet.events(jobId, {
        ...(since === undefined ? {} : { since }), limit: limit ?? 100, types: types ?? LIFECYCLE_TYPES,
      }, callerFor(extra)));
    } catch (error) {
      return failure(readFailure(error, jobId));
    }
  });
}

interface FleetNotifier {
  jobCreated(jobId: string): void;
  listChanged(): void;
}
const notifiers = new WeakMap<McpServer, FleetNotifier>();

const outputUri = (jobId: string, stream: string): string => `agtop://jobs/${jobId}/output/${stream}`;
const eventsUri = (jobId: string): string => `agtop://jobs/${jobId}/events`;
const watchedUris = (jobId: string): string[] => [outputUri(jobId, "stdout"), outputUri(jobId, "stderr"), outputUri(jobId, "both"), eventsUri(jobId)];

/** Resource templates plus subscription notifications (contracts 10.3). */
export function registerFleetResources(server: McpServer, fleet: FleetService): FleetResources {
  const caller: Caller = { kind: "session", session: fleet.session, peer: "" };
  const subscriptions = new Set<string>();
  const watches = new Map<string, number>();
  const lastSent = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const sendUpdated = (uri: string): void => {
    if (!subscriptions.has(uri) || !server.isConnected()) return;
    const now = Date.now(), previous = lastSent.get(uri) ?? 0;
    if (now - previous < 500) return;
    lastSent.set(uri, now);
    try { void server.server.sendResourceUpdated({ uri }).catch(() => undefined); } catch { /* transport closed */ }
  };
  const stopTimer = (): void => {
    if (timer === undefined) return;
    clearInterval(timer); timer = undefined;
  };
  const tick = (): void => {
    for (const [jobId, lastSeq] of watches) {
      try {
        const view = fleet.get(jobId, { kind: "admin" });
        let seq = view.job.lastSeq;
        if (view.job.captured) {
          try { seq = Math.max(seq, fleet.output(jobId, { stream: "both", limit: 1 }, { kind: "admin" }).lastSeq); } catch { /* capture disabled */ }
        }
        const terminal = isTerminal(view.job.state);
        if (seq > lastSeq || terminal) {
          if (terminal) for (const uri of watchedUris(jobId)) lastSent.delete(uri);
          watches.set(jobId, seq);
          for (const uri of watchedUris(jobId)) sendUpdated(uri);
        }
        if (terminal) watches.delete(jobId);
      } catch {
        watches.delete(jobId);
        for (const uri of watchedUris(jobId)) lastSent.delete(uri);
      }
    }
    if (watches.size === 0) stopTimer();
  };
  const notifier: FleetNotifier = {
    jobCreated(jobId: string): void {
      watches.set(jobId, 0);
      if (timer === undefined) { timer = setInterval(tick, 500); timer.unref(); }
      notifier.listChanged();
    },
    listChanged(): void {
      try { server.sendResourceListChanged(); } catch { /* transport closed */ }
    },
  };
  notifiers.set(server, notifier);

  const listJobs = (): JobSummaryV2[] => fleet.list({ limit: 500 }, caller).jobs.filter(job => mayRead(job, caller));
  const outputTemplate = new ResourceTemplate("agtop://jobs/{jobId}/output/{stream}", {
    list: () => ({ resources: listJobs().map(job => ({ uri: outputUri(job.jobId, "both"), name: `${job.jobId} output`, mimeType: "application/json" })) }),
  });
  const eventsTemplate = new ResourceTemplate("agtop://jobs/{jobId}/events", {
    list: () => ({ resources: listJobs().map(job => ({ uri: eventsUri(job.jobId), name: `${job.jobId} events`, mimeType: "application/json" })) }),
  });

  const sinceOf = (value: string | string[] | undefined): number => {
    const raw = Array.isArray(value) ? value[0] : value;
    const since = raw === undefined ? Number.NaN : Number(raw);
    if (!Number.isInteger(since) || since < 0) throw new Error("agtop: E_INVALID_REQUEST: since must be a non-negative integer.");
    return since;
  };
  const outputRead = (uri: URL, variables: Record<string, string | string[]>, cursor: boolean) => {
    const jobId = String(Array.isArray(variables.jobId) ? variables.jobId[0] : variables.jobId);
    const stream = String(Array.isArray(variables.stream) ? variables.stream[0] : variables.stream);
    try {
      if (!OUTPUT_STREAMS.has(stream)) throw new FleetError("E_INVALID_REQUEST", 'stream must be "stdout", "stderr" or "both".', { field: "stream" });
      const page = fleet.output(jobId, {
        stream: stream as "stdout" | "stderr" | "both",
        ...(cursor ? { since: sinceOf(variables.since) } : { tail: 200 }),
        maxBytes: 262_144,
      }, caller);
      const pageWithCursor = { ...page, nextUri: `agtop://jobs/${jobId}/output/${stream}/${page.nextSince}` };
      return { contents: [{ uri: uri.toString(), mimeType: "application/json", text: JSON.stringify(pageWithCursor) }] };
    } catch (error) {
      throw new Error(readFailure(error, jobId));
    }
  };
  const eventsRead = (uri: URL, variables: Record<string, string | string[]>, cursor: boolean) => {
    const jobId = String(Array.isArray(variables.jobId) ? variables.jobId[0] : variables.jobId);
    try {
      const page = fleet.events(jobId, { ...(cursor ? { since: sinceOf(variables.since) } : {}), limit: 200 }, caller);
      const pageWithCursor = { ...page, nextUri: `agtop://jobs/${jobId}/events/${page.nextSince}` };
      return { contents: [{ uri: uri.toString(), mimeType: "application/json", text: JSON.stringify(pageWithCursor) }] };
    } catch (error) {
      throw new Error(readFailure(error, jobId));
    }
  };

  server.registerResource("job-output", outputTemplate, { description: "Captured stdout/stderr for one job.", mimeType: "application/json" },
    (uri, variables) => outputRead(uri, variables, false));
  server.registerResource("job-output-since", new ResourceTemplate("agtop://jobs/{jobId}/output/{stream}/{since}", { list: undefined }),
    { description: "Captured stdout/stderr after a sequence number.", mimeType: "application/json" },
    (uri, variables) => outputRead(uri, variables, true));
  server.registerResource("job-events", eventsTemplate, { description: "Lifecycle timeline for one job.", mimeType: "application/json" },
    (uri, variables) => eventsRead(uri, variables, false));
  server.registerResource("job-events-since", new ResourceTemplate("agtop://jobs/{jobId}/events/{since}", { list: undefined }),
    { description: "Lifecycle timeline after a sequence number.", mimeType: "application/json" },
    (uri, variables) => eventsRead(uri, variables, true));

  server.server.setRequestHandler(SubscribeRequestSchema, (request) => { subscriptions.add(request.params.uri); return {}; });
  server.server.setRequestHandler(UnsubscribeRequestSchema, (request) => { subscriptions.delete(request.params.uri); return {}; });

  return {
    close(): void {
      stopTimer();
      watches.clear(); lastSent.clear(); subscriptions.clear();
      notifiers.delete(server);
    },
  };
}
