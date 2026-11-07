import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const posix = process.platform === "linux" || process.platform === "darwin";
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-posix-crash-"));
const previousStateDir = process.env.AGTOP_STATE_DIR;
process.env.AGTOP_STATE_DIR = path.join(temporary, "state");
afterAll(() => {
  if (previousStateDir === undefined) delete process.env.AGTOP_STATE_DIR; else process.env.AGTOP_STATE_DIR = previousStateDir;
  fs.rmSync(temporary, { recursive: true, force: true });
});

async function waitFile(file: string): Promise<void> {
  for (let i = 0; i < 100; i++) { if (fs.existsSync(file)) return; await delay(50); }
  throw new Error(`Fixture did not start: ${file}`);
}

function running(pid: number): boolean {
  try {
    const stat = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 }).trim();
    return Boolean(stat) && !stat.startsWith("Z");
  } catch { return false; }
}

async function waitDead(pids: number[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && pids.some(running)) await delay(50);
  expect(pids.map(running)).toEqual([false, false]);
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once("exit", () => resolve()));
}

function containedFixture(file: string): string {
  const grandchild = "setInterval(()=>{},1000);";
  return `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore',detached:true});require('fs').writeFileSync(${JSON.stringify(file)},JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000);`;
}

async function crashOwner(owner: ChildProcess, file: string): Promise<number[]> {
  const exited = waitForExit(owner);
  try {
    await waitFile(file);
    const pids = JSON.parse(fs.readFileSync(file, "utf8")) as number[];
    owner.kill("SIGKILL");
    await exited;
    await waitDead(pids);
    return pids;
  } finally {
    owner.kill("SIGKILL");
    await exited;
  }
}

test.skipIf(!posix)("manager SIGKILL cleans the source-mode fallback tree, including detached grandchildren", async () => {
  const file = path.join(temporary, "source-pids.json");
  const managerModule = new URL("../src/manager.ts", import.meta.url).href;
  const root = containedFixture(file);
  const ownerScript = `const {spawnContainedAgent}=await import(${JSON.stringify(managerModule)});await spawnContainedAgent({jobId:'posix-crash-source',harness:'custom',command:process.execPath,args:['-e',${JSON.stringify(root)}]});setInterval(()=>{},1000);`;
  const owner = spawn(process.execPath, ["-e", ownerScript], {
    stdio: "ignore", windowsHide: true, env: { ...process.env, AGTOP_STATE_DIR: process.env.AGTOP_STATE_DIR },
  });
  await crashOwner(owner, file);
}, 15_000);

const distCli = path.resolve("dist/cli.js");
test.skipIf(!posix || !fs.existsSync(distCli))("node dist/cli.js run crash cleanup survives manager SIGKILL", async () => {
  const file = path.join(temporary, "node-dist-pids.json");
  const root = containedFixture(file);
  const owner = spawn("node", [distCli, "run", "--id", "posix-crash-node-dist", "--", process.execPath, "-e", root], {
    stdio: "ignore", windowsHide: true, env: { ...process.env, AGTOP_STATE_DIR: process.env.AGTOP_STATE_DIR },
  });
  await crashOwner(owner, file);
}, 15_000);

const compiledBinary = process.env.AGTOP_TEST_BIN;
test.skipIf(!posix || !compiledBinary)("compiled binary crash cleanup survives manager SIGKILL", async () => {
  const file = path.join(temporary, "compiled-pids.json");
  const root = containedFixture(file);
  const owner = spawn(compiledBinary!, ["run", "--id", "posix-crash-compiled", "--", process.execPath, "-e", root], {
    stdio: "ignore", windowsHide: true, env: { ...process.env, AGTOP_STATE_DIR: process.env.AGTOP_STATE_DIR },
  });
  await crashOwner(owner, file);
}, 15_000);
