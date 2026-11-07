import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { darwinIdentity, darwinTcpRows, readDarwinProcesses } from "../src/darwin.js";
import { scanDarwinProcesses } from "../src/discovery.js";

const children: ReturnType<typeof Bun.spawn>[] = [];
function spawnBun(code: string, env: Record<string, string> = {}, stdout: "ignore" | "pipe" = "ignore") {
  const child = Bun.spawn([process.execPath, "-e", code], {
    env: { ...process.env, ...env }, stdin: "ignore", stdout, stderr: "ignore",
  });
  children.push(child);
  return child;
}
async function stop(child: ReturnType<typeof Bun.spawn> | undefined): Promise<void> {
  if (!child) return;
  try { child.kill("SIGKILL"); } catch { /* already exited */ }
  await child.exited.catch(() => undefined);
}
async function readLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const next = await reader.read();
    if (next.done) break;
    text += new TextDecoder().decode(next.value);
  }
  void reader.cancel();
  return text.trim();
}
async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, timeout = 4_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== undefined) return result;
    await delay(40);
  }
  throw new Error("Timed out waiting for the Darwin process/socket snapshot.");
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(stop));
});

describe("live Darwin process discovery", () => {
  test.skipIf(process.platform !== "darwin")("matches this process argv, cwd, and identity, and records scan timing", () => {
    const started = performance.now();
    const processes = readDarwinProcesses();
    const elapsedMs = performance.now() - started;
    const current = processes.find(record => record.pid === process.pid);
    expect(current).toBeDefined();
    expect(current!.argv).toEqual(process.argv);
    expect(current!.cwd).toBe(fs.realpathSync(process.cwd()));
    expect(current!.startTime).toBe(darwinIdentity(process.pid)!);
    console.info(`Darwin libproc scan: ${processes.length} readable processes in ${elapsedMs.toFixed(1)} ms`);
  }, 20_000);

  test.skipIf(process.platform !== "darwin")("reads inherited AGTOP tags from a child process", async () => {
    const child = spawnBun("setInterval(() => {}, 1000)", { AGTOP_JOB_ID: "live-x" });
    const rows = await waitFor(() => {
      return scanDarwinProcesses().then(processes => processes.find(record => record.pid === child.pid));
    });
    expect(rows.envTags?.AGTOP_JOB_ID).toBe("live-x");
  }, 20_000);

  test.skipIf(process.platform !== "darwin")("converts Mach ticks to CPU seconds and reports resident memory", async () => {
    const child = spawnBun("const end = Date.now() + 5000; while (Date.now() < end) {} setInterval(() => {}, 1000)");
    const first = readDarwinProcesses().find(record => record.pid === child.pid);
    expect(first).toBeDefined();
    await delay(1_000);
    const second = readDarwinProcesses().find(record => record.pid === child.pid);
    expect(second).toBeDefined();
    expect(second!.cpuSeconds - first!.cpuSeconds).toBeGreaterThanOrEqual(0.2);
    expect(second!.residentBytes).toBeGreaterThan(1_048_576);
  }, 15_000);

  test.skipIf(process.platform !== "darwin")("attributes listener and established client TCP rows to their PIDs", async () => {
    const server = spawnBun("const net = require('node:net'); const server = net.createServer(() => {}); server.listen(0, '127.0.0.1', () => console.log(server.address().port)); setInterval(() => {}, 1000)", {}, "pipe");
    const port = Number(await readLine(server.stdout!));
    expect(port).toBeGreaterThan(0);
    const client = spawnBun(`const net = require('node:net'); net.connect(${port}, '127.0.0.1'); setInterval(() => {}, 1000)`);
    const rows = await waitFor(() => {
      const current = darwinTcpRows([server.pid, client.pid]);
      return current.some(row => row.pid === server.pid && row.state === 2 && row.localPort === port) &&
        current.some(row => row.pid === client.pid && row.state === 5 && row.remotePort === port) ? current : undefined;
    });
    expect(rows).toContainEqual(expect.objectContaining({ pid: server.pid, state: 2, localAddress: "127.0.0.1", localPort: port }));
    expect(rows).toContainEqual(expect.objectContaining({ pid: client.pid, state: 5, remoteAddress: "127.0.0.1", remotePort: port }));
  }, 20_000);

  test.skipIf(process.platform !== "darwin")("keeps launchd as a reduced record for non-root scans and agrees with ps process groups", () => {
    const child = spawnBun("setInterval(() => {}, 1000)");
    const processRecord = readDarwinProcesses().find(record => record.pid === child.pid);
    expect(processRecord).toBeDefined();
    const ps = execFileSync("/bin/ps", ["-o", "ppid=,pgid=", "-p", String(child.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim().split(/\s+/).map(Number);
    expect([processRecord!.ppid, processRecord!.pgid]).toEqual(ps);
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      const launchd = readDarwinProcesses().find(record => record.pid === 1);
      expect(launchd).toMatchObject({ restricted: true });
      expect(launchd!.startTime).not.toBe("0");
    }
  }, 20_000);
});
