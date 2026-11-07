import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { spawnContainedAgent, listAgentTrees } from "../src/manager.js";
import { startDaemon } from "../src/daemon.js";
import { probeLemonade } from "../src/backend.js";
import { createServer } from "node:http";

const exec = promisify(execFile);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-integration-"));
const previousStateDir = process.env.AGTOP_STATE_DIR;
process.env.AGTOP_STATE_DIR = path.join(temporary, "state");
const cli = path.resolve("src/cli.ts");
afterAll(() => {
  if (previousStateDir === undefined) delete process.env.AGTOP_STATE_DIR; else process.env.AGTOP_STATE_DIR = previousStateDir;
  fs.rmSync(temporary, { recursive: true, force: true });
});
async function waitFile(file: string) {
  for (let i = 0; i < 100; i++) { if (fs.existsSync(file)) return; await delay(50); }
  throw new Error(`Fixture did not start: ${file}`);
}
test("launch preserves argv/environment and cleans records after normal exit", async () => {
  const file = path.join(temporary, "arguments.json");
  const args = ["", "two words", 'a"b', "C:\\space here\\", "$literal; & ()"];
  const script = `require('fs').writeFileSync(process.argv[1], JSON.stringify({args:process.argv.slice(2),job:process.env.AGTOP_JOB_ID,key:process.env.AGTOP_TEST_VALUE}));`;
  const agent = await spawnContainedAgent({ jobId: "argument-test", harness: "custom", command: process.execPath, args: ["-e", script, file, ...args], extraEnv: { AGTOP_TEST_VALUE: "hello = world" } });
  expect(await agent.exited).toBe(0);
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ args, job: "argument-test", key: "hello = world" });
  expect(fs.existsSync(path.join(process.env.AGTOP_STATE_DIR!, "argument-test.json"))).toBe(false);
});
test("cross-process ps and kill find descendants after their intermediate parent exits", async () => {
  const file = path.join(temporary, "descendant.pid");
  const grandchild = `require('fs').writeFileSync(${JSON.stringify(file)},String(process.pid));setInterval(()=>{},1000);`;
  const intermediate = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore',detached:true}).unref();`;
  const root = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(intermediate)}],{stdio:'ignore'});setInterval(()=>{},1000);`;
  const agent = await spawnContainedAgent({ jobId: "tree-test", harness: "custom", command: process.execPath, args: ["-e", root] });
  try {
    await waitFile(file); const descendant = Number(fs.readFileSync(file, "utf8"));
    await delay(100);
    const { stdout } = await exec(process.execPath, [cli, "ps", "--json"], { windowsHide: true, timeout: 20000 });
    const tree = JSON.parse(stdout).find((t: any) => t.jobId === agent.jobId);
    expect(tree).toBeDefined();
    expect(tree.processes.map((p: any) => p.pid)).toContain(descendant);
    expect(tree.processes.map((p: any) => p.pid)).toContain(agent.pid);
    expect(tree.containmentMode).toBe(process.platform === "win32" ? "win32-job-object" : "linux-env-pgid");
    const killed = await exec(process.execPath, [cli, "kill", agent.jobId], { windowsHide: true, timeout: 20000 });
    const result = JSON.parse(killed.stdout);
    expect(result.failedPids).toEqual([]); expect(result.errors).toEqual([]);
    expect(result.killedPids).toContain(agent.pid); expect(result.killedPids).toContain(descendant);
    await agent.exited;
  } finally { await agent.terminate().catch(() => {}); await agent.exited; }
}, 45000);
test("managed process socket evidence identifies its local inference server", async () => {
  const ready = path.join(temporary, "socket-server.json");
  const serverScript = path.join(temporary, "ollama.js");
  fs.writeFileSync(serverScript, `const http=require('http');const fs=require('fs');const server=http.createServer((req,res)=>{res.writeHead(200);res.write('connected');});server.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.argv[2],JSON.stringify({port:server.address().port,pid:process.pid})));setInterval(()=>{},1000);`);
  const server = spawn(process.execPath, ["run", serverScript, ready], { stdio: "ignore", windowsHide: true });
  const clientScript = `require('http').get('http://127.0.0.1:'+process.argv[1],res=>{});setInterval(()=>{},1000);`;
  let agent: Awaited<ReturnType<typeof spawnContainedAgent>> | undefined;
  try {
    await waitFile(ready);
    const endpoint = JSON.parse(fs.readFileSync(ready, "utf8")) as { port: number; pid: number };
    agent = await spawnContainedAgent({ jobId: "socket-attribution", harness: "custom", command: process.execPath, args: ["-e", clientScript, String(endpoint.port)] });
    let tree: Awaited<ReturnType<typeof listAgentTrees>>[number] | undefined;
    for (let i = 0; i < 3; i++) {
      tree = (await listAgentTrees()).find(t => t.jobId === agent!.jobId);
      if (tree?.backendEvidence.includes(`ollama, pid ${endpoint.pid}`)) break;
      await delay(100);
    }
    expect(tree?.backend).toBe("local-engine");
    expect(tree?.backendEvidence).toContain(`socket: pid ${agent.pid} -> 127.0.0.1:${endpoint.port} (ollama, pid ${endpoint.pid})`);
  } finally {
    if (agent) { await agent.terminate().catch(() => {}); await agent.exited; }
    server.kill();
  }
}, 30000);
test("failed spawn and duplicate job IDs do not leak or overwrite ownership", async () => {
  await expect(spawnContainedAgent({ jobId: "missing", harness: "custom", command: "agtop-this-command-does-not-exist" })).rejects.toThrow("Executable not found");
  await expect(spawnContainedAgent({ jobId: "../escape", harness: "custom", command: process.execPath })).rejects.toThrow("Job ID");
  const agent = await spawnContainedAgent({ jobId: "duplicate", harness: "custom", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] });
  try {
    await expect(spawnContainedAgent({ jobId: "duplicate", harness: "custom", command: process.execPath })).rejects.toThrow();
    expect((await listAgentTrees()).find(t => t.jobId === "duplicate")?.rootPid).toBe(agent.pid);
  } finally { await agent.terminate(); await agent.exited; }
}, 20000);
test.skipIf(process.platform !== "win32")("invalid native executable fails launch and releases the job reservation", async () => {
  const invalid = path.join(temporary, "invalid.exe"); fs.writeFileSync(invalid, "not an executable");
  await expect(spawnContainedAgent({ jobId: "bad-native", harness: "custom", command: invalid })).rejects.toThrow("CreateProcessW");
  expect(fs.existsSync(path.join(process.env.AGTOP_STATE_DIR!, "bad-native.json"))).toBe(false);
});
test.skipIf(process.platform !== "win32")("Job Object kills descendants if the owning manager crashes", async () => {
  const file = path.join(temporary, "crash-child.pid");
  const managerModule = new URL("../src/manager.ts", import.meta.url).href;
  const childScript = `require('fs').writeFileSync(${JSON.stringify(file)}, String(process.pid));setInterval(()=>{},1000);`;
  const ownerScript = `const {spawnContainedAgent}=await import(${JSON.stringify(managerModule)});await spawnContainedAgent({jobId:'crash-test',harness:'custom',command:process.execPath,args:['-e',${JSON.stringify(childScript)}]});`;
  const owner = spawn(process.execPath, ["-e", ownerScript], { stdio: "ignore", windowsHide: true });
  const exited = new Promise<void>(resolve => owner.once("exit", () => resolve()));
  try {
    await waitFile(file); const pid = Number(fs.readFileSync(file, "utf8"));
    owner.kill("SIGKILL"); await exited;
    let alive = true;
    for (let i = 0; i < 50; i++) {
      try { process.kill(pid, 0); } catch { alive = false; break; }
      await delay(50);
    }
    expect(alive).toBe(false);
    expect((await listAgentTrees()).some(t => t.jobId === "crash-test")).toBe(false);
  } finally { owner.kill("SIGKILL"); await exited; }
}, 15000);
test.skipIf(process.platform !== "linux" || !process.env.AGTOP_TEST_CGROUP_ROOT)("delegated cgroup contains and terminates a detached descendant", async () => {
  const file = path.join(temporary, "cgroup-child.pid");
  const leaf = `require('fs').writeFileSync(${JSON.stringify(file)},String(process.pid));setInterval(()=>{},1000);`;
  const script = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:'ignore',detached:true}).unref();setInterval(()=>{},1000);`;
  const agent = await spawnContainedAgent({ jobId: "cgroup-test", harness: "custom", command: process.execPath, args: ["-e", script], cgroupRoot: process.env.AGTOP_TEST_CGROUP_ROOT });
  try {
    await waitFile(file);
    expect(agent.containmentMode).toBe("linux-cgroup");
    const tree = (await listAgentTrees()).find(t => t.jobId === agent.jobId)!;
    expect(tree.processes.map(p => p.pid)).toContain(Number(fs.readFileSync(file, "utf8")));
    const result = await agent.terminate(); expect(result.failedPids).toEqual([]); expect(result.errors).toEqual([]);
    await agent.exited;
  } finally { await agent.terminate().catch(() => {}); await agent.exited; }
}, 15000);
test("daemon authenticates reads and mutations, rejects origins, and cleans up owned jobs", async () => {
  const daemon = await startDaemon({ port: 0 });
  const base = `http://127.0.0.1:${daemon.port}`;
  const authorization = `Bearer ${fs.readFileSync(daemon.tokenFile, "utf8")}`;
  let jobId: string | undefined;
  try {
    expect((await fetch(`${base}/v1/agents`)).status).toBe(401);
    expect((await fetch(`${base}/v1/agents`, { headers: { authorization, origin: "https://example.com" } })).status).toBe(401);
    expect((await fetch(`${base}/v1/agents`, { headers: { authorization } })).status).toBe(200);
    expect((await fetch(`${base}/v1/harnesses`)).status).toBe(401);
    const catalog = await (await fetch(`${base}/v1/harnesses`, { headers: { authorization } })).json() as Array<{ id: string; kind: string }>;
    expect(catalog.some(h => h.id === "claude-code" && h.kind === "agent")).toBe(true);
    const response = await fetch(`${base}/v1/agents`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ harness: "custom", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] }) });
    expect(response.status).toBe(201); jobId = (await response.json() as { jobId: string }).jobId;
    expect((await listAgentTrees()).some(t => t.jobId === jobId)).toBe(true);
    const staleStop = await fetch(`${base}/v1/agents/${jobId}/kill`, {
      method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ expectedStartTime: "stale-selection" }),
    });
    expect(staleStop.status).toBe(400);
    expect((await listAgentTrees()).some(t => t.jobId === jobId)).toBe(true);
  } finally { await daemon.close(); }
  expect((await listAgentTrees()).some(t => t.jobId === jobId)).toBe(false);
  expect(fs.existsSync(daemon.tokenFile)).toBe(false);
}, 30000);
test("Lemonade probe separates available and loaded model lists", async () => {
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/health") res.end(JSON.stringify({ status: "ok", all_models_loaded: [{ model_name: "loaded" }] }));
    else if (req.url === "/v1/models") res.end(JSON.stringify({ data: [{ id: "available" }, { id: "loaded" }] }));
    else { res.writeHead(404); res.end("{}"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    const status = await probeLemonade(`http://127.0.0.1:${address.port}`);
    expect(status).toMatchObject({ reachable: true, loadedModels: ["loaded"], availableModels: ["available", "loaded"] });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
