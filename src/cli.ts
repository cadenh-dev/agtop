#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { listAgentTrees, spawnContainedAgent, killAgentTree } from "./manager.js";
import { getAcceleratorSnapshot } from "./accelerators.js";
import { probeLemonade } from "./backend.js";
import { startDaemon } from "./daemon.js";
import { launchDesktop } from "./desktop.js";
import { fleetCommand } from "./cli-fleet.js";
import { peersCommand } from "./cli-peers.js";
import { searchHarnesses } from "./harnesses.js";
import { ROLE_ORDER, roleCatalog } from "./roles.js";
import { startMcpServer } from "./mcp.js";
import { pruneStaleJobs } from "./registry.js";
import { WATCHDOG_ARG, runWatchdog } from "./watchdog.js";
import type { AcceleratorSnapshot, AgentProcessTree, HarnessType, SpawnAgentOptions } from "./types.js";

const help = `agtop — agent-aware process manager

  agtop                       Live view (or ps when output is redirected)
  agtop top [--interval 2000]  Live process trees; q or Ctrl+C to quit
  agtop ps [--json]            Discover agents and sample CPU usage
  agtop gpu [--json]           Show GPU/NPU devices and measurement status (alias: accelerators)
  agtop run [options] -- COMMAND [ARGS...]
  agtop kill JOB_ID_OR_PID     Force-stop an agent tree
  agtop cleanup [--stale] [--dry-run] [--json]  Stop jobs or prune stale records
  agtop harnesses [QUERY] [--json]  List or search supported harnesses
  agtop roles [QUERY] [--json]      List or search process roles
  agtop jobs [--state S[,S...]] [--json]  List fleet jobs
  agtop logs JOB_ID [--stream S] [--tail N] [--since N] [--follow] [--json]
  agtop events JOB_ID [--since N] [--json]  Show a job's lifecycle events
  agtop queue [--json]        Queued jobs, guards and admission limits
  agtop leases [--json]       Port leases (lease IDs omitted)
  agtop submit [--port 13309] [options] -- COMMAND [ARGS...]  Submit a fleet job to the daemon
  agtop mcp [--peer NAME]      MCP stdio server for agent-facing task containment
  agtop lemonade [--json]      Probe local server and loaded models
  agtop daemon [--port 13309] [--federation-port N --tls-cert FILE --tls-key FILE
                [--federation-host HOST]]  Authenticated loopback HTTP API
  agtop peers init [--id ID]   Create or show this daemon's Ed25519 identity
  agtop peers list [--json]    Trusted federation peers
  agtop peers add --id ID --url URL --public-key KEY [--scope S] [--prefix P] [--tls-cert FILE]
  agtop peers remove ID        Remove a trusted federation peer
  agtop ui                    Native GPUI desktop interface

run options:
  --harness NAME   --id ID   --cwd PATH   --peer NAME
  --lemonade [--lemonade-url URL]   --cgroup-root PATH

Windows scripts need an explicit interpreter: -- cmd.exe /c codex.cmd
Linux uses a process group unless a delegated cgroup root is supplied.
macOS uses a process group with inherited tags; there is no atomic containment.
Passive tree termination and process-group fallback are best effort.
`;
function clean(s: string) { return s.replace(/[\x00-\x1f\x7f-\x9f]/g, " "); }
export function renderTrees(trees: AgentProcessTree[], snapshot: AcceleratorSnapshot | undefined = getAcceleratorSnapshot()): string {
  const unavailable = snapshot?.status.filter(status => !status.available) ?? [];
  const footer = unavailable.length
    ? `\nAccelerators: ${unavailable.map(status => `${status.kind}: unavailable${status.message ? ` (${status.message})` : status.reason ? ` (${status.reason})` : ""}`).join("; ")}\n`
    : "";
  if (!trees.length) return "No active AI agent harnesses or local engines detected.\n" + footer;
  return trees.map(t => {
    const git = t.git ? `${path.basename(t.git.repoRoot)} [${t.git.branch}]` : "worktree unknown";
    const totals = [t.gpuPercent !== undefined ? `GPU ${t.gpuPercent.toFixed(1)}%` : "", t.npuPercent !== undefined ? `NPU ${t.npuPercent.toFixed(1)}%` : "", t.gpuMemoryMb !== undefined ? `GPU mem ${t.gpuMemoryMb.toFixed(1)} MiB` : ""].filter(Boolean);
    const rows = [`${t.harness}  ${t.jobId}  PID ${t.rootPid}${totals.length ? `  ${totals.join("  ")}` : ""}`, `  ${t.totalCpuPercent.toFixed(1)}% CPU  ${t.totalMemoryMb.toFixed(1)} MiB  ${t.backend}  ${t.containmentMode}`, `  ${t.userOrPeer}  ${git}`];
    const roleSummary = ROLE_ORDER.filter(role => (t.roleCounts[role] ?? 0) > 0).map(role => `${role} ${t.roleCounts[role]}`).join(", ");
    rows.push(`  roles: ${roleSummary}`);
    const ids = new Map(t.processes.map(p => [p.pid, p]));
    for (const p of t.processes) {
      let depth = 0, parent = p.ppid; const seen = new Set<number>([p.pid]);
      while (ids.has(parent) && !seen.has(parent)) { seen.add(parent); depth++; parent = ids.get(parent)!.ppid; }
      const accel = (p.accelerators ?? []).filter(a => a.utilizationPercent !== undefined).map(a => `${a.kind} ${a.utilizationPercent!.toFixed(1)}%`);
      rows.push(`  ${"  ".repeat(Math.min(depth, 8))}${p.pid === t.rootPid ? "*" : "-"} ${p.pid} ${p.name}  ${p.role}  ${p.cpuPercent.toFixed(1)}%  ${p.memoryMb.toFixed(1)} MiB${accel.length ? `  ${accel.join("  ")}` : ""}`);
    }
    return rows.map(clean).join("\n");
  }).join("\n\n") + "\n" + footer;
}

export function renderAccelerators(snapshot: ReturnType<typeof getAcceleratorSnapshot>): string {
  const value = snapshot ?? { devices: [], status: [], sampledAt: 0 };
  const devices = value.devices.length
    ? value.devices.map(device => `${device.id}  ${device.kind}  ${device.name ?? "unknown"}  ${device.vendor ?? "unknown"}  ${device.utilizationPercent === undefined ? "" : `${device.utilizationPercent.toFixed(1)}%`}`.trimEnd())
    : ["No accelerator devices detected."];
  const statuses = value.status.length
    ? value.status.map(status => `${status.source}  ${status.kind}  ${status.available ? "available" : `unavailable${status.reason ? ` (${status.reason})` : ""}`}  ${status.message ?? ""}`.trimEnd())
    : ["No accelerator status available."];
  return `Devices\nID  KIND  NAME  VENDOR  UTIL%\n${devices.join("\n")}\n\nStatus\nSOURCE  KIND  STATUS  MESSAGE\n${statuses.join("\n")}\n`;
}
function value(args: string[], index: number): string {
  const v = args[index + 1]; if (!v || v.startsWith("--")) throw new Error(`Missing value for ${args[index]}`); return v;
}
async function top(interval: number) {
  if (!process.stdout.isTTY) { console.log(renderTrees(await listAgentTrees())); return; }
  if (!Number.isFinite(interval) || interval < 250) throw new Error("Refresh interval must be at least 250 milliseconds.");
  let stopped = false; const controller = new AbortController();
  const stop = () => { stopped = true; controller.abort(); };
  const key = (data: Buffer) => { if (data.includes(3) || /q/i.test(data.toString())) stop(); };
  const wasRaw = process.stdin.isRaw;
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  if (process.stdin.isTTY) { process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on("data", key); }
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  try {
    while (!stopped) {
      const trees = await listAgentTrees();
      const header = `agtop | ${new Date().toLocaleTimeString()} | CPU: 100% = one core | q to quit\n\n`;
      const rows = (header + renderTrees(trees)).split("\n");
      const height = process.stdout.rows || 24, width = process.stdout.columns || 100;
      const visible = rows.slice(0, height - 1).map(r => r.slice(0, Math.max(1, width - 1)));
      if (rows.length >= height) visible.push("More processes available with agtop ps --json".slice(0, width - 1));
      process.stdout.write("\x1b[H\x1b[2J" + visible.join("\n"));
      await delay(interval, undefined, { signal: controller.signal }).catch(() => {});
    }
  } finally {
    process.stdout.write("\x1b[?25h\x1b[?1049l"); process.off("SIGINT", stop); process.off("SIGTERM", stop);
    if (process.stdin.isTTY) { process.stdin.off("data", key); process.stdin.setRawMode(wasRaw || false); process.stdin.pause(); }
  }
}
const DAEMON_USAGE = "Usage: agtop daemon [--port 13309] [--federation-port N --tls-cert FILE --tls-key FILE [--federation-host HOST]]";
export interface DaemonCliOptions { port?: number; federation?: { port: number; host?: string; certFile: string; keyFile: string } }
function portOption(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`${name} must be an integer between 0 and 65535. ${DAEMON_USAGE}`);
  return port;
}
/** `agtop daemon` options in any order (contracts 16); exported so the CLI parser is testable. */
export function parseDaemonOptions(args: string[]): DaemonCliOptions {
  const names = new Set(["--port", "--federation-port", "--tls-cert", "--tls-key", "--federation-host"]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!names.has(arg)) throw new Error(`Unknown option: ${arg}. ${DAEMON_USAGE}`);
    if (values.has(arg)) throw new Error(`Duplicate option: ${arg}. ${DAEMON_USAGE}`);
    const value = args[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${arg}. ${DAEMON_USAGE}`);
    values.set(arg, value); index += 1;
  }
  const port = portOption("--port", values.get("--port"));
  const federationPort = portOption("--federation-port", values.get("--federation-port"));
  const certFile = values.get("--tls-cert"), keyFile = values.get("--tls-key"), host = values.get("--federation-host");
  if (federationPort === undefined) {
    if (certFile !== undefined || keyFile !== undefined || host !== undefined) throw new Error(`--tls-cert, --tls-key and --federation-host require --federation-port. ${DAEMON_USAGE}`);
    return port === undefined ? {} : { port };
  }
  if (certFile === undefined || keyFile === undefined) throw new Error(`--federation-port requires both --tls-cert and --tls-key. ${DAEMON_USAGE}`);
  return { ...(port === undefined ? {} : { port }), federation: { port: federationPort, ...(host === undefined ? {} : { host }), certFile, keyFile } };
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args[0] === WATCHDOG_ARG) { process.exitCode = await runWatchdog(args.slice(1)); return; }
  const [command = process.stdout.isTTY ? "top" : "ps", ...rest] = args;
  if (["help", "--help", "-h"].includes(command)) { console.log(help); return; }
  if (command === "ui") {
    if (rest.length) throw new Error("Usage: agtop ui");
    await launchDesktop(); return;
  }
  if (command === "ps") {
    if (rest.some(a => a !== "--json")) throw new Error("Usage: agtop ps [--json]");
    await listAgentTrees(); await delay(200); const trees = await listAgentTrees();
    console.log(rest.includes("--json") ? JSON.stringify(trees, null, 2) : renderTrees(trees)); return;
  }
  if (command === "gpu" || command === "accelerators") {
    if (rest.some(a => a !== "--json") || new Set(rest).size !== rest.length) throw new Error(`Usage: agtop ${command} [--json]`);
    await listAgentTrees();
    const snapshot = getAcceleratorSnapshot();
    console.log(rest.includes("--json") ? JSON.stringify(snapshot ?? { devices: [], status: [], sampledAt: 0 }, null, 2) : renderAccelerators(snapshot)); return;
  }
  if (command === "top") {
    if (rest.length && (rest.length !== 2 || rest[0] !== "--interval")) throw new Error("Usage: agtop top [--interval 2000]");
    await top(rest.length ? Number(rest[1]) : 2000); return;
  }
  if (command === "kill") {
    if (rest.length !== 1) throw new Error("Usage: agtop kill JOB_ID_OR_PID");
    const result = await killAgentTree(rest[0]); console.log(JSON.stringify(result, null, 2));
    if (result.failedPids.length || result.errors.length) process.exitCode = 1; return;
  }
  if (command === "cleanup") {
    if (rest.some(a => !["--stale", "--dry-run", "--json"].includes(a)) || new Set(rest).size !== rest.length) throw new Error("Usage: agtop cleanup [--stale] [--dry-run] [--json]");
    if (rest.includes("--stale")) {
      const jobs = pruneStaleJobs(rest.includes("--dry-run"));
      if (rest.includes("--json")) console.log(JSON.stringify({ stale: jobs, dryRun: rest.includes("--dry-run"), deleted: rest.includes("--dry-run") ? [] : jobs }, null, 2));
      else console.log(rest.includes("--dry-run") ? `Would remove ${jobs.length} stale job record(s): ${jobs.join(", ") || "none"}` : `Removed ${jobs.length} stale job record(s): ${jobs.join(", ") || "none"}`);
      return;
    }
    if (rest.includes("--dry-run") || rest.includes("--json")) throw new Error("--dry-run and --json require --stale.");
    const trees = (await listAgentTrees()).filter(t => t.containmentMode !== "passive-ppid");
    const results = [];
    for (const tree of trees) {
      const result = await killAgentTree(tree.jobId);
      results.push({ jobId: tree.jobId, ...result });
    }
    console.log(JSON.stringify(results, null, 2));
    if (results.some(r => (r.failedPids as number[]).length || (r.errors as string[]).length)) process.exitCode = 1;
    return;
  }
  if (command === "harnesses") {
    const unknown = rest.filter(arg => arg !== "--json");
    if (unknown.length > 1) throw new Error("Usage: agtop harnesses [QUERY] [--json]");
    const catalog = searchHarnesses(unknown[0]);
    if (rest.includes("--json")) console.log(JSON.stringify(catalog, null, 2));
    else if (!catalog.length) console.log(`No harnesses match "${unknown[0]}".\n`);
    else {
      const width = Math.max(...catalog.map(h => h.id.length));
      console.log(catalog.map(h => `${h.id.padEnd(width)}  ${h.kind.padEnd(6)}  ${h.label}`).join("\n") + "\n");
    }
    return;
  }
  if (command === "roles") {
    const unknown = rest.filter(arg => arg !== "--json");
    if (unknown.length > 1) throw new Error("Usage: agtop roles [QUERY] [--json]");
    const query = unknown[0]?.toLowerCase();
    const catalog = roleCatalog().filter(item => !query || [item.role, item.label, item.description, ...item.definitions]
      .some(value => value.toLowerCase().includes(query)));
    if (rest.includes("--json")) console.log(JSON.stringify(catalog, null, 2));
    else if (!catalog.length) console.log(`No roles match "${unknown[0]}".\n`);
    else {
      const width = Math.max(...catalog.map(item => item.label.length));
      console.log(catalog.map(item => `${item.role}  ${item.label.padEnd(width)}  ${item.description}`).join("\n") + "\n");
    }
    return;
  }
  if (command === "mcp") {
    if (rest.length && (rest.length !== 2 || rest[0] !== "--peer")) throw new Error("Usage: agtop mcp [--peer NAME]");
    await startMcpServer({ peer: rest.length ? rest[1] : undefined });
    return;
  }
  if (command === "lemonade") {
    if (rest.some(a => a !== "--json")) throw new Error("Usage: agtop lemonade [--json]");
    console.log(JSON.stringify(await probeLemonade(), null, 2)); return;
  }
  if (command === "run") {
    // Stop at the executable so later '--' arguments belong to the child.
    // Bun can remove the first '--' before forwarding script arguments.
    let separator = 0;
    while (rest[separator]?.startsWith("--") && rest[separator] !== "--") separator += rest[separator] === "--lemonade" ? 1 : 2;
    const commandIndex = separator + (rest[separator] === "--" ? 1 : 0);
    if (!rest[commandIndex]) throw new Error("Usage: agtop run [options] -- COMMAND [ARGS...]");
    const options: SpawnAgentOptions = { harness: "custom", command: rest[commandIndex], args: rest.slice(commandIndex + 1), stdio: "inherit" };
    const flags = rest.slice(0, separator);
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === "--lemonade") { options.useLemonadeLocal = true; continue; }
      const v = value(flags, i);
      switch (flags[i]) {
        case "--harness": options.harness = v as HarnessType; break;
        case "--id": options.jobId = v; break;
        case "--cwd": options.cwd = v; break;
        case "--peer": options.userOrPeer = v; break;
        case "--lemonade-url": options.lemonadeUrl = v; break;
        case "--cgroup-root": options.cgroupRoot = v; break;
        default: throw new Error(`Unknown option: ${flags[i]}`);
      }
      i++;
    }
    const agent = await spawnContainedAgent(options);
    console.error(`agtop: ${agent.jobId} | PID ${agent.pid} | ${agent.containmentMode}`);
    let stopping = false;
    const stop = () => { if (!stopping) { stopping = true; void agent.terminate().catch(e => console.error(String(e))); } };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    try { process.exitCode = await agent.exited; } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
    return;
  }
  if (command === "daemon") {
    const options = parseDaemonOptions(rest);
    const daemon = await startDaemon({ ...options, token: process.env.AGTOP_DAEMON_TOKEN });
    console.error(`agtop daemon: http://127.0.0.1:${daemon.port}\nBearer token file: ${daemon.tokenFile}`);
    let stopping = false;
    const stop = () => { if (!stopping) { stopping = true; void daemon.close().catch(e => { console.error(String(e)); process.exitCode = 1; }).finally(() => { process.off("SIGINT", stop); process.off("SIGTERM", stop); }); } };
    process.on("SIGINT", stop); process.on("SIGTERM", stop); return;
  }
  if (command === "peers") { await peersCommand(rest); return; }
  if (await fleetCommand(command, rest)) return;
  throw new Error(`Unknown command: ${command}. Use agtop --help.`);
}
if ((import.meta as ImportMeta & { main?: boolean }).main || (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)) {
  main().catch(e => { console.error(`agtop: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; });
}
