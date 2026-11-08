import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { probeLemonade } from "./backend.js";
import { pruneStaleJobs } from "./registry.js";
import { searchHarnesses, harnesses, harnessLabel } from "./harnesses.js";
import { killAgentTree, listAgentTrees, spawnContainedAgent } from "./manager.js";
import { getAcceleratorSnapshot } from "./accelerators.js";
import { formatEndpoint } from "./net-format.js";
import type { AgentProcess, AgentProcessTree, HarnessType, ManagedAgent } from "./types.js";

const VERSION = "0.1.0";

export const formatListeningEndpoint = formatEndpoint;

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

interface OwnedJob {
  agent: ManagedAgent;
  harness: HarnessType;
  command: string;
  cwd: string;
  peer: string;
  createdAt: number;
  exitCode?: number;
  exitedAt?: number;
  error?: string;
}

const owned = new Map<string, OwnedJob>();

const instructions = `agtop provides task-scoped OS containment and classifies process roles. Use "run" for long-lived helpers or subagents that must not outlive the task; it returns a job ID. Use "wait" to wait for exit, "status" to inspect roles and listening ports for owned jobs, and "kill" or "cleanup" before finishing. "list" shows shared agent jobs, peers, ports, and CPU, memory, GPU, and NPU totals; check it before heavy or port-binding work and avoid duplicating or killing another agent's job. "kill" only accepts jobs created by this MCP session. "run" discards stdout and stderr, so use the normal shell for commands whose output you need. If "wait" times out, the job is still running. agtop manages process lifetimes; it is not a security sandbox.`;

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function failure(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function peerFor(extra: { _meta?: Record<string, unknown> }, requested?: string, fallback = "mcp"): string {
  if (requested?.trim()) return requested.trim().slice(0, 200);
  const session = extra._meta?.["ai.opencode/sessionID"] ?? extra._meta?.sessionId;
  const base = process.env.AGTOP_PEER || fallback;
  return (typeof session === "string" && session ? `${base}:${session}` : base).slice(0, 200);
}

export function summary(tree: AgentProcessTree) {
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
    listening: [...new Set(tree.processes.flatMap(p => (p.listeningSockets ?? []).map(socket => formatListeningEndpoint(socket.address, socket.port))))],
    processCount: tree.processes.length,
    git: tree.git
      ? { repoRoot: tree.git.repoRoot, branch: tree.git.branch, isWorktree: tree.git.isWorktree }
      : undefined,
    owned: owned.has(tree.jobId),
  };
}

export function ownedProcessSummary(p: AgentProcess) {
  return {
    pid: p.pid, ppid: p.ppid, name: p.name, cmdline: p.cmdline,
    cpuPercent: Number(p.cpuPercent.toFixed(1)), memoryMb: Number(p.memoryMb.toFixed(1)),
    role: p.role, roleEvidence: p.roleEvidence, accelerators: p.accelerators,
    listening: (p.listeningSockets ?? []).map(socket => formatListeningEndpoint(socket.address, socket.port)),
  };
}

export function statusPayload(tree: AgentProcessTree, isOwned: boolean, includeProcesses: boolean): Record<string, unknown> {
  const value: Record<string, unknown> = summary(tree);
  if (includeProcesses && isOwned) value.processes = tree.processes.map(ownedProcessSummary);
  else if (includeProcesses) value.note = "Process details are only available for jobs created by this MCP session.";
  return value;
}

function ownedSummary(jobId: string, job: OwnedJob) {
  return {
    jobId,
    harness: job.harness,
    label: harnessLabel(job.harness),
    peer: job.peer,
    command: job.command,
    cwd: job.cwd,
    createdAt: new Date(job.createdAt).toISOString(),
    exited: job.exitCode !== undefined || job.error !== undefined,
    exitCode: job.exitCode,
    exitedAt: job.exitedAt ? new Date(job.exitedAt).toISOString() : undefined,
    error: job.error,
    owned: true,
  };
}

async function stopOwned(): Promise<void> {
  const jobs = [...owned.values()].filter(job => job.exitCode === undefined);
  if (!jobs.length) return;
  const started = Date.now();
  process.stderr.write(`agtop mcp: stopping ${jobs.length} owned job(s)\n`);
  const results = await Promise.allSettled(jobs.map(job => job.agent.terminate()));
  const failures = results.flatMap(result => {
    if (result.status === "rejected") return [String(result.reason)];
    return result.value.failedPids.length || result.value.errors.length
      ? [`failed ${result.value.failedPids.join(",")} ${result.value.errors.join("; ")}`]
      : [];
  });
  if (failures.length) process.stderr.write(`agtop mcp: cleanup errors: ${failures.join("; ")}\n`);
  process.stderr.write(`agtop mcp: cleanup finished in ${Date.now() - started}ms\n`);
}

export async function startMcpServer(options: { peer?: string } = {}): Promise<void> {
  const defaultPeer = options.peer?.trim() || process.env.AGTOP_PEER || "mcp";
  const server = new McpServer(
    { name: "agtop", version: VERSION },
    { capabilities: { tools: {} }, instructions },
  );

  server.registerTool("list", {
    title: "List agent trees",
    description: "List known agent trees with harness, process role counts, listening ports, worktree, CPU, memory, GPU/NPU totals, and containment mode. Command lines are omitted for jobs this session does not own.",
    inputSchema: { query: z.string().max(200).optional().describe("Filter by job, harness, role, peer, branch, backend, or containment mode.") },
    annotations: { readOnlyHint: true },
  }, async ({ query }) => {
    try {
      const q = query?.toLowerCase();
      const jobs = (await listAgentTrees()).map(summary).filter(job => !q || [
        job.jobId, job.harness, job.label, job.peer, job.backend, job.containmentMode,
        job.git?.repoRoot, job.git?.branch, ...Object.keys(job.roleCounts),
      ].some(value => value?.toLowerCase().includes(q)));
      return text({ jobs });
    } catch (e) {
      return failure(`agtop: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  server.registerTool("status", {
    title: "Inspect a job",
    description: "Inspect one job with GPU/NPU tree totals. Per-process details, including accelerator usage, are included only for jobs created by this MCP session.",
    inputSchema: {
      jobId: z.string().min(1).max(80).describe("Job ID returned by run."),
      includeProcesses: z.boolean().optional().describe("Include the process tree for an owned job."),
    },
    annotations: { readOnlyHint: true },
  }, async ({ jobId, includeProcesses }) => {
    try {
      const job = owned.get(jobId);
      const tree = (await listAgentTrees()).find(candidate => candidate.jobId === jobId);
      if (!tree) {
        return job ? text(ownedSummary(jobId, job)) : failure(`agtop: no job named ${jobId}.`);
      }
      const value = statusPayload(tree, Boolean(job), Boolean(includeProcesses));
      if (job) Object.assign(value, ownedSummary(jobId, job));
      return text(value);
    } catch (e) {
      return failure(`agtop: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  server.registerTool("run", {
    title: "Run a contained task",
    description: "Start a command in its own OS containment unit (Windows Job Object, Linux cgroup or process group, or macOS process group). Returns a job ID. Output is discarded; use this for long-lived helpers, watchers, and subagents, not for commands whose stdout you need. Use wait, status, kill, or cleanup with the returned job ID.",
    inputSchema: {
      command: z.string().min(1).max(4096).describe("Executable to launch. Script shims need an explicit interpreter."),
      args: z.array(z.string()).optional().describe("Exact argument array; no shell interpolation."),
      cwd: z.string().max(4096).optional().describe("Working directory. Defaults to the MCP server's directory."),
      harness: z.string().max(80).optional().describe("Harness ID from the harnesses tool. Defaults to custom."),
      jobId: z.string().min(1).max(80).optional().describe("Task ID to use for the job. A UUID is generated when omitted."),
      peer: z.string().max(200).optional().describe("Peer or task label for attribution. Defaults to the MCP session."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ command, args, cwd, harness, jobId, peer }, extra) => {
    const selected = (harness ?? "custom") as HarnessType;
    if (!harnesses.includes(selected)) {
      return failure(`agtop: unknown harness "${harness}". Use the harnesses tool to search ${harnesses.length} supported IDs.`);
    }
    const resolvedCwd = path.resolve(cwd ?? process.cwd());
    const label = peerFor(extra, peer, defaultPeer);
    try {
      const agent = await spawnContainedAgent({
        jobId: jobId ?? undefined,
        harness: selected,
        command,
        args: args ?? [],
        cwd: resolvedCwd,
        userOrPeer: label,
        stdio: "ignore",
      });
      const job: OwnedJob = { agent, harness: selected, command, cwd: resolvedCwd, peer: label, createdAt: Date.now() };
      owned.set(agent.jobId, job);
      void agent.exited.then(code => {
        job.exitCode = code;
        job.exitedAt = Date.now();
      }).catch(e => {
        job.error = e instanceof Error ? e.message : String(e);
        job.exitedAt = Date.now();
      });
      return text({
        jobId: agent.jobId,
        pid: agent.pid,
        harness: selected,
        label: harnessLabel(selected),
        containmentMode: agent.containmentMode,
        peer: label,
        cwd: resolvedCwd,
      });
    } catch (e) {
      return failure(`agtop: ${e instanceof Error ? e.message : String(e)}`);
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
  }, async ({ jobId, timeoutMs }) => {
    const job = owned.get(jobId);
    if (!job) return failure(`agtop: only jobs created by this MCP session can be awaited.`);
    if (job.error) return failure(`agtop: ${job.error}`);
    if (job.exitCode !== undefined) return text({ jobId, exited: true, exitCode: job.exitCode });
    const timeout = timeoutMs ?? 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        job.agent.exited.then(code => ({ exited: true as const, exitCode: code })),
        new Promise<{ exited: false; timedOut: true }>(resolve => {
          timer = setTimeout(() => resolve({ exited: false, timedOut: true }), timeout);
        }),
      ]);
      return text({ jobId, ...result });
    } catch (e) {
      return failure(`agtop: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (timer) clearTimeout(timer);
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
  }, async ({ jobId, expectedStartTime }) => {
    const job = owned.get(jobId);
    if (!job) return failure("agtop: only jobs created by this MCP session can be stopped.");
    if (job.exitCode !== undefined) return text({ jobId, alreadyExited: true, exitCode: job.exitCode });
    try {
      const result = await killAgentTree(jobId, { expectedStartTime });
      return text({ jobId, ...result });
    } catch (e) {
      return failure(`agtop: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  server.registerTool("cleanup", {
    title: "Stop all task jobs",
    description: "Terminate every job created by this MCP session and remove records proven stale. Other live jobs remain untouched.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const jobs = [...owned.entries()].map(([jobId, job]) => ({ jobId, job, alreadyExited: job.exitCode !== undefined, exitCode: job.exitCode }));
    const active = jobs.filter(item => !item.alreadyExited);
    const settled = await Promise.allSettled(active.map(item => item.job.agent.terminate()));
    const results = cleanupResults(jobs, settled);
    pruneStaleJobs();
    return text({ jobs: results });
  });

  server.registerTool("harnesses", {
    title: "Search harnesses",
    description: "List or search supported agent and local-server harness IDs.",
    inputSchema: { query: z.string().max(200).optional().describe("Filter by id, label, or kind.") },
    annotations: { readOnlyHint: true },
  }, async ({ query }) => {
    const catalog = searchHarnesses(query);
    return text({ harnesses: catalog });
  });

  server.registerTool("lemonade", {
    title: "Probe Lemonade",
    description: "Probe the local AMD Lemonade server for reachability and loaded models.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    return text(await probeLemonade());
  });

  server.registerTool("accelerators", {
    title: "Inspect GPU and NPU devices",
    description: "Show detected GPU/NPU devices and measurement availability. Does not expose per-process usage.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    try {
      let snapshot = getAcceleratorSnapshot();
      if (!snapshot) { await listAgentTrees(); snapshot = getAcceleratorSnapshot(); }
      return text(snapshot ?? { devices: [], status: [], sampledAt: performance.now() });
    } catch (e) {
      return failure(`agtop: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await stopOwned();
    try { await server.close(); } catch {}
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.stdin.once("end", () => void shutdown());
  await server.connect(new StdioServerTransport());
  process.stderr.write("agtop mcp: ready\n");
}
