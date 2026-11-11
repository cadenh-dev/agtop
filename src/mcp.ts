import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { probeLemonade } from "./backend.js";
import { searchHarnesses } from "./harnesses.js";
import { listAgentTrees } from "./manager.js";
import type { AgentProcessTree } from "./types.js";
import { getAcceleratorSnapshot } from "./accelerators.js";
import { formatEndpoint } from "./net-format.js";
import { FleetService } from "./fleet.js";
import { failure, registerFleetResources, registerFleetTools, text, type FleetToolHelpers } from "./mcp-v2.js";

export { cleanupResults, ownedProcessSummary, statusPayload, summary } from "./mcp-v2.js";

const VERSION = "0.2.0";
const TREE_SNAPSHOT_MS = 2_000;

export const formatListeningEndpoint = formatEndpoint;

const instructions = `agtop provides task-scoped OS containment and classifies process roles. Use "run" for long-lived helpers or subagents that must not outlive the task; it returns a job ID. Use "wait" to wait for exit, "status" to inspect roles, fleet state, and listening ports for owned jobs, and "kill" or "cleanup" before finishing. "run" captures stdout and stderr into a bounded buffer that "output" reads; with capture set to false it discards output. "events" reads a job's lifecycle timeline. "list" shows shared agent jobs, peers, ports, and CPU, memory, GPU, and NPU totals; check it before heavy or port-binding work and avoid duplicating or killing another agent's job. "kill" only accepts jobs created by this MCP session. Short commands whose output the agent needs still belong in the normal shell; "output" is for long-lived jobs. If "wait" times out, the job is still running. Job output is also exposed as agtop://jobs/{jobId}/output/{stream} and agtop://jobs/{jobId}/events resources; the cursor URI in nextUri pages forward. agtop manages process lifetimes; it is not a security sandbox.`;

function peerFor(extra: { _meta?: Record<string, unknown> }, requested?: string, fallback = "mcp"): string {
  if (requested?.trim()) return requested.trim().slice(0, 200);
  const session = extra._meta?.["ai.opencode/sessionID"] ?? extra._meta?.sessionId;
  const base = process.env.AGTOP_PEER || fallback;
  return (typeof session === "string" && session ? `${base}:${session}` : base).slice(0, 200);
}

export async function startMcpServer(options: { peer?: string } = {}): Promise<void> {
  const defaultPeer = options.peer?.trim() || process.env.AGTOP_PEER || "mcp";
  const fleet = await FleetService.open({ surface: "mcp" });
  const server = new McpServer(
    { name: "agtop", version: VERSION },
    { capabilities: { tools: {}, resources: { subscribe: true, listChanged: true } }, instructions },
  );
  let resources: ReturnType<typeof registerFleetResources> | undefined;
  try {
    // One process scan serves every list/status call for TREE_SNAPSHOT_MS after it finishes (landmine L7:
    // a Windows CIM scan costs ~1 s). Concurrent callers share the scan in flight; this session's own
    // run/kill/wait/cleanup drop the snapshot so its jobs are never shown stale.
    let snapshot: { trees: Promise<AgentProcessTree[]>; readyAt: number | null } | undefined;
    const trees = (): Promise<AgentProcessTree[]> => {
      const current = snapshot;
      if (current !== undefined && (current.readyAt === null || Date.now() - current.readyAt <= TREE_SNAPSHOT_MS)) return current.trees;
      const next: { trees: Promise<AgentProcessTree[]>; readyAt: number | null } = { trees: listAgentTrees(), readyAt: null };
      snapshot = next;
      next.trees.then(() => { next.readyAt = Date.now(); }, () => { if (snapshot === next) snapshot = undefined; });
      return next.trees;
    };
    const helpers: FleetToolHelpers = {
      peerFor: (extra, requested) => peerFor(extra, requested, defaultPeer),
      trees,
      invalidateTrees: () => { snapshot = undefined; },
    };
    registerFleetTools(server, fleet, helpers);
    resources = registerFleetResources(server, fleet, helpers);

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
  } catch (error) {
    resources?.close();
    await fleet.close().catch(() => undefined);
    throw error;
  }

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    resources?.close();
    try { await fleet.close(); } catch (error) { process.stderr.write(`agtop mcp: fleet shutdown failed: ${String(error)}\n`); }
    try { await server.close(); } catch {}
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.stdin.once("end", () => void shutdown());
  await server.connect(new StdioServerTransport());
  process.stderr.write("agtop mcp: ready\n");
}
