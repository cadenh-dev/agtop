import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { killByMarker } from "../scripts/process-probe.js";

const root = path.resolve(import.meta.dir, "..");
const cli = path.join(root, "src/cli.ts");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-mcp-v2-"));
const stateDir = path.join(scratch, "state");
const markerPrefix = "AGTOP_MCP_V2_";
const sessions = new Set<Session>();

let counter = 0;
const jobId = (label: string) => {
  counter += 1;
  return `${label}-v2-${counter}-${process.pid}`.slice(0, 80);
};
const marker = (label: string) => {
  counter += 1;
  return `${markerPrefix}${label}${counter}${process.pid}`;
};

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

interface Session {
  client: Client;
  transport: StdioClientTransport;
  close: () => Promise<void>;
}

interface RunBody {
  jobId: string;
  pid?: number;
  state?: string;
  captured?: boolean;
  peer?: string;
  containmentMode?: string | null;
  queue?: { position: number; blockedBy: Array<Record<string, unknown>> };
}
interface WaitBody { jobId: string; exited: boolean; exitCode?: number | null; timedOut?: boolean; state?: string }
interface StatusBody {
  jobId: string; state?: string; captured?: boolean; outputBytes?: { stdout: number; stderr: number };
  lastSeq?: number; owned?: boolean; rootPid?: number | null; processCount?: number; queue?: { position: number };
}
interface ListBody { jobs: StatusBody[]; }
interface OutputBody {
  jobId: string; state: string; exitCode: number | null; stream: string; since: number; nextSince: number;
  lastSeq: number; hasMore: boolean; outputBytes: { stdout: number; stderr: number };
  truncation: { stdout: unknown; stderr: unknown }; text: string;
}
interface OutputPageBody extends Omit<OutputBody, "text"> { chunks: Array<{ seq: number; stream: string; data: string }> }
interface EventsBody {
  jobId: string; since: number; nextSince: number; hasMore: boolean;
  events: Array<{ type: string; seq: number; state?: string; record?: { owner: { tokenHash: string } } }>;
}

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.AGTOP_OWNER_TOKEN;
  delete env.AGTOP_SESSION_ID;
  env.AGTOP_STATE_DIR = stateDir;
  env.AGTOP_PEER = "mcp-v2";
  return { ...env, ...extra };
}

async function openSession(extraEnv: Record<string, string> = {}): Promise<Session> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp"],
    cwd: root,
    env: childEnv(extraEnv),
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => { /* drain the server's stderr */ });
  const client = new Client({ name: "agtop-mcp-v2", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close().catch(() => {});
    throw error;
  }
  const session: Session = { client, transport, close: async () => { sessions.delete(session); try { await client.close(); } catch { /* gone */ } } };
  sessions.add(session);
  return session;
}

async function withSession<T>(fn: (session: Session) => Promise<T>, extraEnv: Record<string, string> = {}): Promise<T> {
  const session = await openSession(extraEnv);
  try { return await fn(session); }
  finally {
    try { await session.client.callTool({ name: "cleanup", arguments: {} }); } catch { /* shutting down */ }
    await session.close();
  }
}

async function invoke(session: Session, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return session.client.callTool({ name, arguments: args });
}

function toolText(result: ToolResult): string {
  if (!Array.isArray(result.content)) return "";
  return result.content.map(item => item.type === "text" && "text" in item && typeof item.text === "string" ? item.text : "").join("\n");
}

function body<T>(result: ToolResult): T {
  const value = toolText(result);
  if (result.isError) throw new Error(value || "tool failed");
  return JSON.parse(value) as T;
}

function expectError(result: ToolResult, pattern: RegExp): string {
  const value = toolText(result);
  expect(result.isError, value).toBe(true);
  expect(value).toMatch(pattern);
  return value;
}

async function waitUntil(check: () => Promise<boolean> | boolean, label: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function contentText(contents: Array<{ uri: string; text?: string; blob?: string }>): string {
  const item = contents[0];
  if (item === undefined || item.text === undefined) throw new Error("Resource had no text content.");
  return item.text;
}

async function rejectionOf(promise: Promise<unknown>): Promise<string> {
  try { await promise; return ""; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
}

const sleeper = (value: string) => `/*${value}*/setInterval(()=>{},1000)`;
const printer = (out: string, err?: string) => `console.log(${JSON.stringify(out)});${err === undefined ? "" : `console.error(${JSON.stringify(err)});`}`;

afterAll(async () => {
  for (const session of [...sessions]) await session.close().catch(() => {});
  killByMarker(markerPrefix);
  fs.rmSync(scratch, { recursive: true, force: true });
});

test("run captures output and output pages text, json, and a single stream", async () => {
  await withSession(async session => {
    const id = jobId("capture");
    const started = body<RunBody>(await invoke(session, "run", {
      command: process.execPath, args: ["-e", printer("alpha-line", "beta-line")], jobId: id,
    }));
    expect(started).toMatchObject({ jobId: id, state: "running", captured: true });
    expect(typeof started.pid).toBe("number");

    const waited = body<WaitBody>(await invoke(session, "wait", { jobId: id, timeoutMs: 15000 }));
    expect(waited).toMatchObject({ jobId: id, exited: true, exitCode: 0, state: "exited" });

    const all = body<OutputBody>(await invoke(session, "output", { jobId: id }));
    expect(all).toMatchObject({ jobId: id, state: "exited", exitCode: 0, stream: "both", since: 0, hasMore: false });
    expect(all.text).toContain("alpha-line");
    expect(all.text).toContain("beta-line");
    expect(all.outputBytes.stdout).toBeGreaterThan(0);
    expect(all.outputBytes.stderr).toBeGreaterThan(0);
    expect(all.truncation).toEqual({ stdout: null, stderr: null });
    expect(all.nextSince).toBeLessThanOrEqual(all.lastSeq);

    const paged = body<OutputBody>(await invoke(session, "output", { jobId: id, since: all.nextSince }));
    expect(paged.text).toBe("");
    expect(paged.nextSince).toBe(all.nextSince);

    const json = body<OutputPageBody>(await invoke(session, "output", { jobId: id, format: "json" }));
    expect(json.chunks.length).toBeGreaterThan(0);
    expect(json.chunks.map(chunk => chunk.data).join("")).toContain("alpha-line");
    expect(json.nextSince).toBe(all.nextSince);

    const stdout = body<OutputBody>(await invoke(session, "output", { jobId: id, stream: "stdout" }));
    expect(stdout.text).toContain("alpha-line");
    expect(stdout.text).not.toContain("beta-line");
  });
}, 30000);

test("capture false discards output and output reports the fixed failure", async () => {
  await withSession(async session => {
    const id = jobId("nocapture");
    const started = body<RunBody>(await invoke(session, "run", {
      command: process.execPath, args: ["-e", "console.log('gone')"], jobId: id, capture: false,
    }));
    expect(started.captured).toBe(false);
    body<WaitBody>(await invoke(session, "wait", { jobId: id, timeoutMs: 15000 }));
    expectError(await invoke(session, "output", { jobId: id }), /^agtop: E_CAPTURE_DISABLED: this job was started without output capture\.$/);
    expectError(await invoke(session, "events", { jobId: id }), /^agtop: E_CAPTURE_DISABLED: this job was started without output capture\.$/);
  });
}, 30000);

test("events returns the lifecycle timeline with owner.tokenHash blanked", async () => {
  const token = "c".repeat(64);
  const hash = createHash("sha256").update(token).digest("hex");
  await withSession(async session => {
    const id = jobId("events");
    body<RunBody>(await invoke(session, "run", {
      command: process.execPath, args: ["-e", printer("event-line")], jobId: id,
    }));
    body<WaitBody>(await invoke(session, "wait", { jobId: id, timeoutMs: 15000 }));
    const page = body<EventsBody>(await invoke(session, "events", { jobId: id }));
    const types = new Set(page.events.map(event => event.type));
    expect(types).toContain("state");
    expect(types).toContain("spawn");
    expect(types).toContain("exit");
    expect(types).not.toContain("stdout");
    const first = page.events[0]!;
    expect(first.type).toBe("state");
    expect(first.record?.owner.tokenHash).toBe("");
    const raw = toolText(await invoke(session, "events", { jobId: id }));
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(hash);

    const states = body<EventsBody>(await invoke(session, "events", { jobId: id, types: ["state"] }));
    expect(states.events.every(event => event.type === "state")).toBe(true);
    expect(states.events.map(event => event.state)).toContain("running");
    expectError(await invoke(session, "events", { jobId: "no-such-job-v2" }), /^agtop: E_JOB_NOT_FOUND: no job named no-such-job-v2\.$/);
  }, { AGTOP_OWNER_TOKEN: token, AGTOP_SESSION_ID: "ses_mcp_v2_events" });
}, 30000);

test("a queued run reports its queue shape and kill cancels it", async () => {
  await withSession(async session => {
    const blocker = jobId("blocker");
    body<RunBody>(await invoke(session, "run", {
      command: process.execPath, args: ["-e", sleeper(marker("blocker"))], jobId: blocker,
    }));
    const id = jobId("queued");
    const queued = body<RunBody>(await invoke(session, "run", {
      command: process.execPath, args: ["-e", printer("never")], jobId: id, priority: 5, dependsOn: [blocker],
    }));
    expect(queued.state).toBe("queued");
    expect(queued).not.toHaveProperty("pid");
    expect(queued).not.toHaveProperty("containmentMode");
    expect(queued.captured).toBe(true);
    expect(queued.queue?.position).toBeGreaterThanOrEqual(1);
    expect(queued.queue?.blockedBy).toEqual([{ kind: "dependency", jobIds: [blocker] }]);

    const status = body<StatusBody>(await invoke(session, "status", { jobId: id }));
    expect(status).toMatchObject({ jobId: id, state: "queued", captured: true, rootPid: null });
    expect(status.queue?.position).toBeGreaterThanOrEqual(1);

    const waited = body<WaitBody>(await invoke(session, "wait", { jobId: id, timeoutMs: 0 }));
    expect(waited).toEqual({ jobId: id, exited: false, timedOut: true, state: "queued" });

    expect(body<Record<string, unknown>>(await invoke(session, "kill", { jobId: id })))
      .toEqual({ jobId: id, cancelled: true, state: "killed" });
    const final = body<WaitBody>(await invoke(session, "wait", { jobId: id, timeoutMs: 5000 }));
    expect(final).toMatchObject({ jobId: id, exited: true, state: "killed" });
    body(await invoke(session, "kill", { jobId: blocker }));
  });
}, 30000);

test("status, list, and wait expose the v0.2 fields", async () => {
  await withSession(async session => {
    const id = jobId("fields");
    body<RunBody>(await invoke(session, "run", {
      command: process.execPath, args: ["-e", printer("fields-line")], jobId: id,
    }));
    const waited = body<WaitBody>(await invoke(session, "wait", { jobId: id, timeoutMs: 15000 }));
    expect(waited.state).toBe("exited");

    const status = body<StatusBody>(await invoke(session, "status", { jobId: id }));
    expect(status.state).toBe("exited");
    expect(status.captured).toBe(true);
    expect(status.outputBytes?.stdout).toBeGreaterThan(0);
    expect(status.lastSeq).toBeGreaterThan(0);

    await waitUntil(async () => {
      const listed = body<ListBody>(await invoke(session, "list", { query: id }));
      const row = listed.jobs.find(job => job.jobId === id);
      if (row === undefined || row.rootPid !== null) return false;
      expect(row).toMatchObject({ state: "exited", captured: true, processCount: 0, rootPid: null });
      expect(row.outputBytes?.stdout).toBeGreaterThan(0);
      expect(row.lastSeq).toBeGreaterThan(0);
      return true;
    }, "list row for a finished fleet job");

    expectError(await invoke(session, "status", { jobId: "no-such-job-v2" }), /^agtop: no job named no-such-job-v2\.$/);
  });
}, 30000);

test("output, events, and resources deny another session's job", async () => {
  const identity = { AGTOP_OWNER_TOKEN: "d".repeat(64), AGTOP_SESSION_ID: "ses_mcp_v2_pair" };
  const a = await openSession(identity), b = await openSession(), same = await openSession(identity);
  try {
    const id = jobId("foreign");
    body<RunBody>(await invoke(a, "run", { command: process.execPath, args: ["-e", printer("private-line")], jobId: id }));
    body<WaitBody>(await invoke(a, "wait", { jobId: id, timeoutMs: 15000 }));

    const denied = "agtop: E_NOT_OWNER: only jobs created by this MCP session can be read.";
    expectError(await invoke(b, "output", { jobId: id }), /^agtop: E_NOT_OWNER: only jobs created by this MCP session can be read\.$/);
    expectError(await invoke(b, "events", { jobId: id }), /^agtop: E_NOT_OWNER: only jobs created by this MCP session can be read\.$/);
    expect(await rejectionOf(b.client.readResource({ uri: `agtop://jobs/${id}/output/both` }, { timeout: 5000 }))).toContain(denied);
    expect(await rejectionOf(b.client.readResource({ uri: `agtop://jobs/${id}/events` }, { timeout: 5000 }))).toContain(denied);

    const own = body<OutputBody>(await invoke(same, "output", { jobId: id }));
    expect(own.text).toContain("private-line");
  } finally {
    for (const session of [a, b, same]) {
      try { await session.client.callTool({ name: "cleanup", arguments: {} }); } catch { /* shutting down */ }
      await session.close();
    }
  }
}, 45000);

test("resources list readable jobs and every page carries nextUri", async () => {
  await withSession(async session => {
    const id = jobId("resources");
    body<RunBody>(await invoke(session, "run", { command: process.execPath, args: ["-e", printer("resource-line")], jobId: id }));
    body<WaitBody>(await invoke(session, "wait", { jobId: id, timeoutMs: 15000 }));

    const listed = await session.client.listResources();
    const byUri = new Map(listed.resources.map(resource => [resource.uri, resource]));
    const output = byUri.get(`agtop://jobs/${id}/output/both`);
    const events = byUri.get(`agtop://jobs/${id}/events`);
    expect(output?.name).toBe(`${id} output`);
    expect(events?.name).toBe(`${id} events`);

    const templates = await session.client.listResourceTemplates();
    const patterns = templates.resourceTemplates.map(template => template.uriTemplate).sort();
    expect(patterns).toEqual([
      "agtop://jobs/{jobId}/events",
      "agtop://jobs/{jobId}/events/{since}",
      "agtop://jobs/{jobId}/output/{stream}",
      "agtop://jobs/{jobId}/output/{stream}/{since}",
    ]);

    const page = JSON.parse(contentText((await session.client.readResource({ uri: `agtop://jobs/${id}/output/both` })).contents)) as OutputPageBody & { nextUri: string };
    expect(page.jobId).toBe(id);
    expect(page.chunks.map(chunk => chunk.data).join("")).toContain("resource-line");
    expect(page.nextUri).toBe(`agtop://jobs/${id}/output/both/${page.nextSince}`);
    const cursor = JSON.parse(contentText((await session.client.readResource({ uri: page.nextUri })).contents)) as OutputPageBody;
    expect(cursor.since).toBe(page.nextSince);

    const timeline = JSON.parse(contentText((await session.client.readResource({ uri: `agtop://jobs/${id}/events` })).contents)) as EventsBody & { nextUri: string };
    expect(timeline.events.some(event => event.type === "exit")).toBe(true);
    expect(timeline.nextUri).toBe(`agtop://jobs/${id}/events/${timeline.nextSince}`);
  });
}, 30000);

test("a subscription receives resource updates while output arrives", async () => {
  await withSession(async session => {
    const id = jobId("subscribe");
    const uri = `agtop://jobs/${id}/output/both`;
    const updates: string[] = [];
    session.client.setNotificationHandler(ResourceUpdatedNotificationSchema, notification => { updates.push(notification.params.uri); });
    await session.client.subscribeResource({ uri });
    body<RunBody>(await invoke(session, "run", {
      command: process.execPath, args: ["-e", "console.log('subscription-line'); setTimeout(()=>{},800)"], jobId: id,
    }));
    await waitUntil(() => updates.includes(uri), `resource update for ${uri}`, 6000);
    body<WaitBody>(await invoke(session, "wait", { jobId: id, timeoutMs: 15000 }));
    await session.client.unsubscribeResource({ uri });
  });
}, 30000);

test("a v0.1-style run is never queued", async () => {
  await withSession(async session => {
    const id = jobId("legacy");
    const started = body<RunBody>(await invoke(session, "run", {
      command: process.execPath, args: ["-e", sleeper(marker("legacy"))], jobId: id,
    }));
    expect(started).toMatchObject({ jobId: id, state: "running", captured: true });
    expect(started).not.toHaveProperty("queue");
    expect(typeof started.pid).toBe("number");
    expect(typeof started.containmentMode).toBe("string");
    body(await invoke(session, "kill", { jobId: id }));
  });
}, 30000);
