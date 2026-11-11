import { createServer, type IncomingMessage } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { listAgentTrees, killAgentTree, spawnContainedAgent } from "./manager.js";
import { getAcceleratorSnapshot } from "./accelerators.js";
import { probeLemonade } from "./backend.js";
import { handleFleetRoute } from "./daemon-routes.js";
import { FleetService } from "./fleet.js";
import { FleetError, FLEET_ERROR_STATUS } from "./fleet-errors.js";
import { harnessCatalog } from "./harnesses.js";
import { stateDir } from "./registry.js";
import type { ManagedAgent, SpawnAgentOptions } from "./types.js";

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new Error("Request body exceeds 64 KiB.");
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.trim() ? JSON.parse(text) : {};
}
/** Fleet routes report an oversized or malformed body as a FleetErrorBody (contracts 9, 9.4). */
async function fleetBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new FleetError("E_BODY_TOO_LARGE", "Request body exceeds 65536 bytes.");
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try { return JSON.parse(text); }
  catch { throw new FleetError("E_INVALID_REQUEST", "Request body must be valid JSON.", { field: "body" }); }
}
export async function startDaemon(options: {
  port?: number; token?: string;
  /** Federation listener settings (contracts 11.3); accepted and ignored until Unit 5.4. */
  federation?: { port: number; host?: string; certFile: string; keyFile: string };
} = {}) {
  const port = options.port ?? 13309;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port.");
  const token = options.token || randomBytes(32).toString("hex");
  if (token.length < 24) throw new Error("Daemon token must be at least 24 characters.");
  const agents = new Map<string, ManagedAgent>();
  // A failure after this point must not leave the fleet scheduler's timer running (contracts 8.7).
  const fleet = await FleetService.open({ surface: "daemon" });
  try {
    const server = createServer(async (req, res) => {
      res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store");
      const reply = (code: number, value: unknown) => { res.writeHead(code); res.end(JSON.stringify(value)); };
      const received = Buffer.from(req.headers.authorization || "");
      const expected = Buffer.from(`Bearer ${token}`);
      if (req.headers.origin || received.length !== expected.length || !timingSafeEqual(received, expected)) { reply(401, { error: "Bearer token required; browser origins are not accepted." }); return; }
      try {
        // A valid bearer token is Caller { kind: "admin" } (contracts 9). Fleet paths fall through
        // to the unchanged v0.1 routes when handleFleetRoute returns undefined.
        const url = req.url || "", queryAt = url.indexOf("?");
        const routed = await handleFleetRoute(fleet, {
          method: req.method ?? "", path: queryAt === -1 ? url : url.slice(0, queryAt),
          query: new URLSearchParams(queryAt === -1 ? "" : url.slice(queryAt + 1)),
          readBody: () => fleetBody(req),
        });
        if (routed !== undefined) { reply(routed.status, routed.body); return; }
        if (req.method === "GET" && req.url === "/v1/harnesses") { reply(200, harnessCatalog()); return; }
        if (req.method === "GET" && req.url === "/v1/agents") { reply(200, await listAgentTrees()); return; }
        if (req.method === "GET" && req.url === "/v1/accelerators") {
          let snapshot = getAcceleratorSnapshot();
          if (!snapshot) { await listAgentTrees(); snapshot = getAcceleratorSnapshot(); }
          reply(200, snapshot ?? { devices: [], status: [], sampledAt: performance.now() }); return;
        }
        if (req.method === "GET" && req.url === "/v1/lemonade") { reply(200, await probeLemonade()); return; }
        if (req.method === "POST" && req.url === "/v1/agents") {
          const data = await body(req);
          if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Expected spawn options.");
          const agent = await spawnContainedAgent({ ...data as SpawnAgentOptions, stdio: "ignore" });
          agents.set(agent.jobId, agent);
          void agent.exited.catch(e => console.error(`agtop job ${agent.jobId}: ${String(e)}`)).finally(() => agents.delete(agent.jobId));
          reply(201, { jobId: agent.jobId, pid: agent.pid, containmentMode: agent.containmentMode }); return;
        }
        const match = /^\/v1\/agents\/([^/]+)\/kill$/.exec(req.url || "");
        if (req.method === "POST" && match) {
          const data = await body(req) as { expectedStartTime?: unknown };
          if (!data || typeof data !== "object" || Array.isArray(data) || (data.expectedStartTime !== undefined && typeof data.expectedStartTime !== "string")) throw new Error("expectedStartTime must be a string.");
          const result = await killAgentTree(decodeURIComponent(match[1]), { expectedStartTime: data.expectedStartTime as string | undefined });
          reply(result.failedPids.length || result.errors.length ? 409 : 200, result); return;
        }
        reply(404, { error: "Route not found." });
      } catch (e) {
        if (e instanceof FleetError) { reply(FLEET_ERROR_STATUS[e.code], e.toBody()); return; }
        reply(400, { error: e instanceof Error ? e.message : String(e) });
      }
    });
    server.requestTimeout = 10000; server.headersTimeout = 10000;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No TCP address.");
    const tokenFile = path.join(stateDir(), `daemon-${address.port}.token`);
    try {
      fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tokenFile, token, { mode: 0o600 });
      if (process.platform !== "win32") fs.chmodSync(tokenFile, 0o600);
    } catch (e) { server.close(); throw e; }
    // Concurrent or repeated close() calls share one shutdown.
    let closing: Promise<void> | undefined;
    return { port: address.port, tokenFile, close: () => closing ??= (async () => {
      const stopped = new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
      server.closeIdleConnections();
      await stopped;
      try {
        const results = await Promise.allSettled([...agents.values()].map(a => a.terminate()));
        const failures = results.filter(r => r.status === "rejected" || r.value.failedPids.length || r.value.errors.length);
        if (failures.length) throw new Error(`Failed to clean up ${failures.length} daemon job(s).`);
      } finally {
        // Fleet shutdown is always awaited; the token file is removed even if it throws.
        try { await fleet.close(); } finally { fs.rmSync(tokenFile, { force: true }); }
      }
    })() };
  } catch (error) {
    await fleet.close().catch(() => undefined);
    throw error;
  }
}
