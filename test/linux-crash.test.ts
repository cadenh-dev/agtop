import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-linux-crash-"));
const previousStateDir = process.env.AGTOP_STATE_DIR;
process.env.AGTOP_STATE_DIR = path.join(temporary, "state");
afterAll(() => {
  if (previousStateDir === undefined) delete process.env.AGTOP_STATE_DIR; else process.env.AGTOP_STATE_DIR = previousStateDir;
  fs.rmSync(temporary, { recursive: true, force: true });
});

async function waitFile(file: string) {
  for (let i = 0; i < 100; i++) { if (fs.existsSync(file)) return; await delay(50); }
  throw new Error(`Fixture did not start: ${file}`);
}
function running(pid: number): boolean {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch { return false; }
}

test.skipIf(process.platform !== "linux")("manager SIGKILL cleans fallback tree including detached grandchildren", async () => {
  const file = path.join(temporary, "pids.json");
  const module = new URL("../src/manager.ts", import.meta.url).href;
  const grandchild = `setInterval(()=>{},1000);`;
  const root = `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore',detached:true});require('fs').writeFileSync(${JSON.stringify(file)},JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000);`;
  const ownerScript = `const {spawnContainedAgent}=await import(${JSON.stringify(module)});await spawnContainedAgent({jobId:'linux-crash-test',harness:'custom',command:process.execPath,args:['-e',${JSON.stringify(root)}]});setInterval(()=>{},1000);`;
  const owner = spawn(process.execPath, ["-e", ownerScript], { stdio: "ignore", windowsHide: true, env: { ...process.env, AGTOP_STATE_DIR: process.env.AGTOP_STATE_DIR } });
  const exited = new Promise<void>(resolve => owner.once("exit", () => resolve()));
  try {
    await waitFile(file);
    const pids = JSON.parse(fs.readFileSync(file, "utf8")) as number[];
    owner.kill("SIGKILL"); await exited;
    for (let i = 0; i < 100 && pids.some(running); i++) await delay(50);
    expect(pids.map(running)).toEqual([false, false]);
  } finally { owner.kill("SIGKILL"); await exited; }
}, 15000);
