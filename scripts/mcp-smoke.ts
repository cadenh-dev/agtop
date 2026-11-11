import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { findByMarker, killByMarker } from "./process-probe.js";

const root = path.resolve(import.meta.dir, "..");
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-mcp-"));
const markers = new Set<string>();
let counter = 0;

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const unique = (label: string) => `${label}-${Date.now()}-${counter++}`;

async function waitFor(check: () => boolean, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await delay(100);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for a process to appear.`);
}

function marker(label: string): string {
  const value = `AGTOP_MCP_${unique(label)}`;
  markers.add(value);
  return value;
}

const parentScript = "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)',process.argv[1]],{detached:true,stdio:'ignore'}).unref();";
const longScript = `${parentScript}setInterval(()=>{},1000)`;

const env = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
Object.assign(env, { AGTOP_STATE_DIR: stateDir, AGTOP_PEER: "mcp-smoke" });

const binary = process.env.AGTOP_MCP_BIN ? path.resolve(process.env.AGTOP_MCP_BIN) : undefined;
function newTransport(extraEnv: Record<string, string> = {}) {
  return new StdioClientTransport({
    command: binary ?? process.execPath,
    args: binary ? ["mcp"] : [path.join(root, "src/cli.ts"), "mcp"],
    cwd: root,
    env: { ...env, ...extraEnv },
    stderr: "inherit",
  });
}
const transport = newTransport();
const client = new Client({ name: "agtop-mcp-smoke", version: "1.0.0" }, { capabilities: {} });

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  const content = response.content as Array<{ type: string; text?: string }>;
  const body = content.find(item => item.type === "text")?.text;
  if (response.isError) throw new Error(`${name}: ${body ?? "tool failed"}`);
  return body ? JSON.parse(body) : undefined;
}

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`PASS  ${name}`);
}

try {
  await client.connect(transport);

  await check("tools/list exposes the task-containment surface", async () => {
    const tools = (await client.listTools()).tools.map(tool => tool.name).sort();
    assert.deepEqual(tools, ["accelerators", "cleanup", "events", "harnesses", "kill", "lemonade", "list", "output", "run", "status", "wait"]);
  });

  await check("harness search returns the expanded catalog", async () => {
    const result = await call("harnesses", { query: "claude" });
    assert.equal(result.harnesses.some((item: any) => item.id === "claude-code"), true);
  });

  await check("normal task cleanup reaps a detached grandchild", async () => {
    const value = marker("normal");
    const jobId = unique("smoke-normal");
    const job = await call("run", {
      command: process.execPath,
      args: ["-e", parentScript, value],
      harness: "custom",
      jobId,
      peer: "smoke",
    });
    assert.equal(job.jobId, jobId);
    const waited = await call("wait", { jobId, timeoutMs: 15000 });
    assert.equal(waited.exitCode, 0);
    await delay(1000);
    assert.deepEqual(findByMarker(value), []);
  });

  await check("kill terminates an owned process tree", async () => {
    const value = marker("kill");
    const jobId = unique("smoke-kill");
    await call("run", {
      command: process.execPath,
      args: ["-e", longScript, value],
      harness: "custom",
      jobId,
      peer: "smoke",
    });
    await waitFor(() => findByMarker(value).length >= 2);
    const status = await call("status", { jobId, includeProcesses: true });
    assert.equal(status.owned, true);
    assert.equal(typeof status.rootStartTime, "string");
    assert.ok(Array.isArray(status.processes));
    const killed = await call("kill", { jobId, expectedStartTime: status.rootStartTime });
    assert.deepEqual(killed.failedPids, []);
    assert.deepEqual(killed.errors, []);
    await call("wait", { jobId, timeoutMs: 15000 });
    await delay(500);
    assert.deepEqual(findByMarker(value), []);
  });

  await check("kill rejects jobs from outside this session", async () => {
    const denied = await client.callTool({ name: "kill", arguments: { jobId: "not-owned" } });
    assert.equal(denied.isError, true);
  });

  await check("output returns captured stdout for an owned job", async () => {
    const jobId = unique("smoke-output");
    const line = unique("captured-line");
    await call("run", {
      command: process.execPath,
      args: ["-e", `console.log(${JSON.stringify(line)})`],
      harness: "custom",
      jobId,
      peer: "smoke",
    });
    const waited = await call("wait", { jobId, timeoutMs: 15000 });
    assert.equal(waited.exitCode, 0);
    const start = Date.now();
    let page = await call("output", { jobId });
    while (!(typeof page.text === "string" && page.text.includes(line)) && Date.now() - start < 5000) {
      await delay(100);
      page = await call("output", { jobId });
    }
    assert.equal(typeof page.text, "string");
    assert.equal(page.text.includes(line), true);
  });

  await check("output is denied across MCP sessions", async () => {
    const jobId = unique("smoke-foreign");
    await call("run", {
      command: process.execPath,
      args: ["-e", "console.log('owner-only')"],
      harness: "custom",
      jobId,
      peer: "smoke",
    });
    await call("wait", { jobId, timeoutMs: 15000 });
    const foreign = new Client({ name: "agtop-mcp-smoke-foreign", version: "1.0.0" }, { capabilities: {} });
    const foreignTransport = newTransport({
      AGTOP_SESSION_ID: `smoke-foreign-${Date.now()}`,
      AGTOP_OWNER_TOKEN: "f".repeat(64),
    });
    try {
      await foreign.connect(foreignTransport);
      const denied = await foreign.callTool({ name: "output", arguments: { jobId } });
      const body = (denied.content as Array<{ type: string; text?: string }>)
        .find(item => item.type === "text")?.text;
      assert.equal(denied.isError, true);
      assert.equal(body, "agtop: E_NOT_OWNER: only jobs created by this MCP session can be read.");
    } finally {
      try { await foreign.close(); } catch {}
      try { await foreignTransport.close(); } catch {}
    }
  });

  await check("cleanup stops every task job", async () => {
    const value = marker("cleanup");
    const jobId = unique("smoke-cleanup");
    await call("run", {
      command: process.execPath,
      args: ["-e", longScript, value],
      harness: "custom",
      jobId,
      peer: "smoke",
    });
    await waitFor(() => findByMarker(value).length >= 2);
    const result = await call("cleanup");
    assert.equal(result.jobs.some((job: any) => job.jobId === jobId), true);
    await delay(500);
    assert.deepEqual(findByMarker(value), []);
  });

  await check("closing the MCP session reaps its jobs", async () => {
    const value = marker("shutdown");
    const jobId = unique("smoke-shutdown");
    await call("run", {
      command: process.execPath,
      args: ["-e", longScript, value],
      harness: "custom",
      jobId,
      peer: "smoke",
    });
    await waitFor(() => findByMarker(value).length >= 2);
    await client.close();
    await delay(1500);
    assert.deepEqual(findByMarker(value), []);
  });

  console.log(`\nPASS ${passed} MCP task-containment checks.`);
} catch (error) {
  console.error(`\nFAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  for (const value of markers) {
    const leftover = findByMarker(value);
    if (leftover.length) console.error(`leftover for ${value}: ${leftover.map(p => `${p.pid}(${p.state ?? "?"}, ppid ${p.ppid}, ${p.name})`).join(", ")}`);
    killByMarker(value);
  }
  try { await client.close(); } catch {}
  fs.rmSync(stateDir, { recursive: true, force: true });
}
