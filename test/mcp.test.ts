import { afterAll, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { killByMarker } from "../scripts/process-probe.js";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dir, "..");
const cli = path.join(root, "src/cli.ts");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-mcp-own-"));
const stateDir = path.join(scratch, "state");
const markerPrefix = "AGTOP_MCP_OWN_";
const sessions = new Set<Session>();

let counter = 0;
const jobId = (label: string) => {
  counter += 1;
  return `${label}-${counter}-${process.pid}`.slice(0, 80);
};
const marker = (label: string) => {
  counter += 1;
  return `${markerPrefix}${label}${counter}${process.pid}`;
};

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

interface Session {
  client: Client;
  transport: StdioClientTransport;
  logs: { text: string };
  close: () => Promise<void>;
}

interface RunBody {
  jobId: string;
  pid: number;
  peer: string;
  command?: string;
}
interface StatusBody {
  jobId: string;
  owned?: boolean;
  command?: string;
  peer?: string;
  note?: string;
  rootPid?: number;
  exited?: boolean;
  exitCode?: number;
  processes?: Array<{ pid: number; cmdline?: string }>;
}
interface ListBody { jobs: StatusBody[]; }
interface WaitBody { jobId: string; exited: boolean; exitCode?: number; timedOut?: boolean; }
interface KillBody {
  jobId: string;
  alreadyExited?: boolean;
  exitCode?: number;
  killedPids?: number[];
  failedPids?: number[];
  errors?: string[];
}
interface CleanupBody { jobs: Array<{ jobId: string }>; }
interface HarnessBody { harnesses: Array<{ id: string }>; }

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.AGTOP_STATE_DIR = stateDir;
  env.AGTOP_PEER = "mcp-ownership";
  return env;
}

function toolText(result: ToolResult): string {
  if (!Array.isArray(result.content)) return "";
  return result.content.map(item => item.type === "text" && "text" in item && typeof item.text === "string" ? item.text : "").join("\n");
}

function body<T>(result: ToolResult): T {
  const text = toolText(result);
  if (result.isError) throw new Error(text || "tool failed");
  return JSON.parse(text) as T;
}

function expectError(result: ToolResult, pattern: RegExp): string {
  const text = toolText(result);
  expect(result.isError, text).toBe(true);
  expect(text).toMatch(pattern);
  return text;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function openSession(): Promise<Session> {
  const logs = { text: "" };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp"],
    cwd: root,
    env: childEnv(),
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer | string) => { logs.text += String(chunk); });
  const client = new Client({ name: "agtop-mcp-ownership", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close().catch(() => {});
    throw error;
  }
  const session: Session = {
    client,
    transport,
    logs,
    close: async () => {
      sessions.delete(session);
      try { await client.close(); } catch { /* server already gone */ }
    },
  };
  sessions.add(session);
  return session;
}

async function stopSession(session: Session): Promise<void> {
  try { await session.client.callTool({ name: "cleanup", arguments: {} }); } catch { /* shutting down */ }
  await session.close();
}

async function withSession<T>(fn: (session: Session) => Promise<T>): Promise<T> {
  const session = await openSession();
  try { return await fn(session); }
  finally { await stopSession(session); }
}

async function withPair<T>(fn: (a: Session, b: Session) => Promise<T>): Promise<T> {
  const [a, b] = await Promise.all([openSession(), openSession()]);
  try { return await fn(a, b); }
  finally { await stopSession(a); await stopSession(b); }
}

async function invoke(session: Session, name: string, args: Record<string, unknown> = {}, meta?: Record<string, unknown>): Promise<ToolResult> {
  return session.client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) });
}

function sleeper(value: string, pidFile?: string): string {
  const write = pidFile ? `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` : "";
  return `${write}/*${value}*/setInterval(()=>{},1000)`;
}

async function waitUntil(check: () => Promise<boolean> | boolean, label: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function visibleStatus(session: Session, id: string): Promise<StatusBody> {
  let latest = "";
  await waitUntil(async () => {
    const result = await invoke(session, "status", { jobId: id });
    latest = toolText(result);
    if (result.isError) return false;
    return typeof body<StatusBody>(result).rootPid === "number";
  }, `status for ${id} (${latest})`);
  return body<StatusBody>(await invoke(session, "status", { jobId: id, includeProcesses: true }));
}

async function terminatePid(pid: number): Promise<void> {
  if (process.platform === "win32") {
    const taskkill = process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "taskkill.exe") : "taskkill";
    await exec(taskkill, ["/F", "/PID", String(pid)], { windowsHide: true });
    return;
  }
  try { process.kill(pid, "SIGKILL"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

afterAll(async () => {
  for (const session of [...sessions]) await session.close().catch(() => {});
  killByMarker(markerPrefix);
  fs.rmSync(scratch, { recursive: true, force: true });
});

test("a second session cannot see, wait, or kill the first session's job", async () => {
  const value = marker("secret");
  const id = jobId("owned");
  const pidFile = path.join(scratch, `${id}.pid`);
  await withPair(async (a, b) => {
    const started = body<RunBody>(await invoke(a, "run", {
      command: process.execPath,
      args: ["-e", sleeper(value, pidFile)],
      jobId: id,
      peer: "session-a",
    }));
    expect(started.jobId).toBe(id);
    await waitUntil(() => fs.existsSync(pidFile) && alive(Number(fs.readFileSync(pidFile, "utf8"))), "owned process");

    const listed = body<ListBody>(await invoke(b, "list"));
    const row = listed.jobs.find(job => job.jobId === id);
    expect(row, JSON.stringify(listed)).toBeDefined();
    expect(row?.owned).toBe(false);
    expect(row?.command).toBeUndefined();
    expect(JSON.stringify(listed)).not.toContain(value);

    const foreign = await visibleStatus(b, id);
    expect(foreign.owned).toBe(false);
    expect(foreign.command).toBeUndefined();
    expect(foreign.processes).toBeUndefined();
    expect(foreign.note).toBe("Process details are only available for jobs created by this MCP session.");
    expect(JSON.stringify(foreign)).not.toContain(value);

    const owner = await visibleStatus(a, id);
    expect(owner.owned).toBe(true);
    expect(owner.command).toBe(process.execPath);
    expect(owner.processes?.some(process => process.cmdline?.includes(value))).toBe(true);

    expectError(await invoke(b, "kill", { jobId: id }), /only jobs created by this MCP session can be stopped/);
    expectError(await invoke(b, "wait", { jobId: id, timeoutMs: 0 }), /only jobs created by this MCP session can be awaited/);
    expect(alive(started.pid)).toBe(true);
  });
}, 45000);

test("duplicate job ids are rejected across sessions and the original job keeps running", async () => {
  const id = jobId("dup");
  await withPair(async (a, b) => {
    const started = body<RunBody>(await invoke(a, "run", {
      command: process.execPath,
      args: ["-e", sleeper(marker("dup"))],
      jobId: id,
      peer: "session-a",
    }));
    expectError(await invoke(b, "run", {
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      jobId: id,
      peer: "session-b",
    }), /EEXIST|already exists|file already/i);
    expect(alive(started.pid)).toBe(true);
    const owner = body<StatusBody>(await invoke(a, "status", { jobId: id }));
    expect(owner.owned).toBe(true);
    expect(owner.command).toBe(process.execPath);
  });
}, 30000);

test("cleanup stops only the jobs created by that session", async () => {
  const id = jobId("keep");
  await withPair(async (a, b) => {
    const started = body<RunBody>(await invoke(a, "run", {
      command: process.execPath,
      args: ["-e", sleeper(marker("keep"))],
      jobId: id,
    }));
    const cleaned = body<CleanupBody>(await invoke(b, "cleanup"));
    expect(cleaned.jobs).toEqual([]);
    expect(alive(started.pid)).toBe(true);
    const stopped = body<CleanupBody>(await invoke(a, "cleanup"));
    expect(stopped.jobs.some(job => job.jobId === id)).toBe(true);
    await waitUntil(() => !alive(started.pid), "owned process to exit after cleanup");
  });
}, 30000);

test("invalid job ids are rejected and cannot escape the state directory", async () => {
  await withSession(async session => {
    const traversal = ["../escape", "foo/bar", "..\\..\\Windows\\System32"];
    for (const id of traversal) {
      expectError(await invoke(session, "run", { command: process.execPath, args: ["-e", "process.exit(0)"], jobId: id }), /Job ID must contain/);
    }
    for (const id of ["", "a".repeat(81)]) {
      for (const name of ["run", "status", "wait", "kill"]) {
        const args = name === "run" ? { command: process.execPath, jobId: id } : { jobId: id };
        expectError(await invoke(session, name, args), /Input validation error/);
      }
    }
    for (const name of ["status", "wait", "kill"]) {
      expectError(await invoke(session, name, { jobId: "../escape" }), /no job named|only jobs created by this MCP session|Job ID must contain/);
    }
    const accepted = "a" + "b".repeat(79);
    const started = body<RunBody>(await invoke(session, "run", {
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      jobId: accepted,
    }));
    expect(started.jobId).toBe(accepted);
    expect(body<WaitBody>(await invoke(session, "wait", { jobId: accepted, timeoutMs: 15000 })).exitCode).toBe(0);

    expect(fs.existsSync(path.join(scratch, "escape.json"))).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(scratch), "escape.json"))).toBe(false);
    if (fs.existsSync(stateDir)) {
      expect(fs.readdirSync(stateDir).some(name => name.includes("..") || name.includes("foo"))).toBe(false);
    }
    expect(body<HarnessBody>(await invoke(session, "harnesses", { query: "custom" })).harnesses.some(item => item.id === "custom")).toBe(true);
  });
}, 30000);

test("tool schemas reject the wrong argument types and the server keeps running", async () => {
  await withSession(async session => {
    const cases: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: "run", args: { command: 1 } },
      { name: "run", args: { command: "" } },
      { name: "run", args: { command: process.execPath, args: "nope" } },
      { name: "run", args: { command: process.execPath, args: [1] } },
      { name: "run", args: { command: process.execPath, harness: 1 } },
      { name: "wait", args: { jobId: "job-a", timeoutMs: "10" } },
      { name: "wait", args: { jobId: "job-a", timeoutMs: 1.5 } },
      { name: "wait", args: { jobId: "job-a", timeoutMs: -1 } },
      { name: "wait", args: { jobId: "job-a", timeoutMs: 3_600_001 } },
      { name: "status", args: { jobId: "job-a", includeProcesses: "yes" } },
      { name: "kill", args: { jobId: 1 } },
      { name: "list", args: { query: 1 } },
      { name: "harnesses", args: { query: { id: "claude" } } },
    ];
    for (const item of cases) expectError(await invoke(session, item.name, item.args), /Input validation error/);
    const listed = body<HarnessBody>(await invoke(session, "harnesses"));
    expect(listed.harnesses.length).toBeGreaterThan(0);
  });
}, 30000);

test("run reports a missing executable as a tool error and releases the job id", async () => {
  const id = jobId("missing");
  await withSession(async session => {
    expectError(await invoke(session, "run", { command: "agtop-this-command-does-not-exist", jobId: id }), /Executable not found/);
    const started = body<RunBody>(await invoke(session, "run", {
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      jobId: id,
    }));
    expect(started.jobId).toBe(id);
    expect(body<WaitBody>(await invoke(session, "wait", { jobId: id, timeoutMs: 15000 })).exitCode).toBe(0);
    const names = (await session.client.listTools()).tools.map(tool => tool.name);
    expect(names).toContain("run");
  });
}, 30000);

test("wait timeout reports the job is still running and leaves it alive", async () => {
  const id = jobId("timeout");
  await withSession(async session => {
    const started = body<RunBody>(await invoke(session, "run", {
      command: process.execPath,
      args: ["-e", sleeper(marker("timeout"))],
      jobId: id,
    }));
    expect(alive(started.pid)).toBe(true);
    const waited = body<WaitBody>(await invoke(session, "wait", { jobId: id, timeoutMs: 0 }));
    expect(waited).toMatchObject({ jobId: id, exited: false, timedOut: true });
    expect(alive(started.pid)).toBe(true);
    const status = body<StatusBody>(await invoke(session, "status", { jobId: id }));
    expect(status.exited).toBe(false);
  });
}, 30000);

test("wait on an already exited job returns the same exit code", async () => {
  const id = jobId("exited");
  await withSession(async session => {
    await invoke(session, "run", { command: process.execPath, args: ["-e", "process.exit(3)"], jobId: id });
    const first = body<WaitBody>(await invoke(session, "wait", { jobId: id, timeoutMs: 15000 }));
    expect(first).toMatchObject({ jobId: id, exited: true, exitCode: 3 });
    const second = body<WaitBody>(await invoke(session, "wait", { jobId: id, timeoutMs: 1000 }));
    expect(second).toEqual(first);
  });
}, 30000);

test("killing an owned job twice is a clear no-op after it exits", async () => {
  const id = jobId("twice");
  await withSession(async session => {
    await invoke(session, "run", { command: process.execPath, args: ["-e", sleeper(marker("twice"))], jobId: id });
    const first = body<KillBody>(await invoke(session, "kill", { jobId: id }));
    expect(first.failedPids).toEqual([]);
    expect(first.errors).toEqual([]);
    expect(first.killedPids?.length).toBeGreaterThan(0);
    const waited = body<WaitBody>(await invoke(session, "wait", { jobId: id, timeoutMs: 15000 }));
    expect(waited.exited).toBe(true);
    expect(typeof waited.exitCode).toBe("number");
    const second = body<KillBody>(await invoke(session, "kill", { jobId: id }));
    expect(second.alreadyExited).toBe(true);
    expect(second.exitCode).toBe(waited.exitCode);
  });
}, 30000);

test("cleanup with no owned jobs returns an empty list", async () => {
  await withSession(async session => {
    expect(body<CleanupBody>(await invoke(session, "cleanup"))).toEqual({ jobs: [] });
    expect(body<CleanupBody>(await invoke(session, "cleanup"))).toEqual({ jobs: [] });
  });
}, 20000);

test("harness search returns the full catalog for an empty query and nothing for an unknown query", async () => {
  await withSession(async session => {
    const all = body<HarnessBody>(await invoke(session, "harnesses"));
    const blank = body<HarnessBody>(await invoke(session, "harnesses", { query: "" }));
    const unknown = body<HarnessBody>(await invoke(session, "harnesses", { query: "not-a-real-harness-zzzz" }));
    expect(all.harnesses.length).toBeGreaterThan(0);
    expect(blank.harnesses.map(item => item.id)).toEqual(all.harnesses.map(item => item.id));
    expect(unknown.harnesses).toEqual([]);
  });
}, 20000);

test("OpenCode session metadata is appended to AGTOP_PEER when no peer is requested", async () => {
  await withSession(async session => {
    const cases = [
      { file: "peer-opencode.json", meta: { "ai.opencode/sessionID": "ses_opencode_1" }, peer: "mcp-ownership:ses_opencode_1" },
      { file: "peer-session.json", meta: { sessionId: "ses_meta_2" }, peer: "mcp-ownership:ses_meta_2" },
      { file: "peer-explicit.json", meta: { "ai.opencode/sessionID": "ses_ignored" }, peer: "task-peer", requested: "task-peer" },
    ];
    for (const item of cases) {
      const file = path.join(scratch, item.file);
      const id = jobId("peer");
      const args: Record<string, unknown> = {
        command: process.execPath,
        args: ["-e", `require('fs').writeFileSync(${JSON.stringify(file)}, JSON.stringify({peer:process.env.AGTOP_PEER||''}))`],
        jobId: id,
      };
      if (item.requested) args.peer = item.requested;
      const started = body<RunBody>(await invoke(session, "run", args, item.meta));
      expect(started.peer).toBe(item.peer);
      const waited = body<WaitBody>(await invoke(session, "wait", { jobId: id, timeoutMs: 15000 }));
      expect(waited.exitCode).toBe(0);
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ peer: item.peer });
      expect(body<StatusBody>(await invoke(session, "status", { jobId: id })).peer).toBe(item.peer);
    }
  });
}, 30000);

// TerminateProcess does not run the stdio end/SIGINT/SIGTERM handler. Windows
// uses Job Object kill-on-close; POSIX platforms use the detached crash-cleanup watchdog.
test.skipIf(!["win32", "linux", "darwin"].includes(process.platform))("killing the MCP server process reaps owned jobs", async () => {
  const value = marker("crash");
  const pidFile = path.join(scratch, "crash-pids.json");
  const script = `const fs=require('fs');const cp=require('child_process');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)',${JSON.stringify(value)}],{detached:true,stdio:'ignore'});child.unref();fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({root:process.pid,child:child.pid}));setInterval(()=>{},1000);`;
  const session = await openSession();
  const id = jobId("crash");
  let serverPid = 0;
  try {
    const started = body<RunBody>(await invoke(session, "run", {
      command: process.execPath,
      args: ["-e", script],
      jobId: id,
    }));
    serverPid = session.transport.pid ?? 0;
    expect(serverPid).toBeGreaterThan(0);
    expect(serverPid).not.toBe(process.pid);
    let tree = { root: 0, child: 0 };
    await waitUntil(() => {
      if (!fs.existsSync(pidFile)) return false;
      tree = JSON.parse(fs.readFileSync(pidFile, "utf8")) as { root: number; child: number };
      return tree.root > 0 && tree.child > 0 && alive(tree.root) && alive(tree.child);
    }, "contained tree");
    expect(session.logs.text).not.toContain("stopping");
    await terminatePid(serverPid);
    await waitUntil(() => !alive(serverPid) && !alive(tree.root) && !alive(tree.child), "job object kill-on-close");
    expect(alive(started.pid)).toBe(false);
    expect(session.logs.text).not.toContain("stopping");
  } finally {
    if (serverPid && alive(serverPid)) await terminatePid(serverPid).catch(() => {});
    killByMarker(value);
    await session.close();
  }
}, 30000);
