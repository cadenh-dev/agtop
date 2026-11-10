// THROWAWAY SPIKE acceptance test. Run: bun test spike/fleet-spike.test.ts
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CAP, frame } from "./fleet-spike.ts";
import { lineFor } from "./emitter.ts";

const MB10 = 10 * 1024 * 1024;
const emitter = path.resolve(import.meta.dir, "emitter.ts"), daemonScript = path.resolve(import.meta.dir, "fleet-spike.ts");
const providers = process.platform === "win32" ? ["node", "winjob"] : ["node"];
const results: Record<string, unknown> = { platform: process.platform, arch: process.arch, bun: Bun.version, cpus: os.cpus().length, cpu: os.cpus()[0]?.model };
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-spike-"));
afterAll(() => {
  console.log("SPIKE_RESULTS " + JSON.stringify(results));
  fs.writeFileSync(path.resolve(import.meta.dir, `results-${process.platform}.json`), JSON.stringify(results, null, 2) + "\n");
  fs.rmSync(temp, { recursive: true, force: true });
});

/** What the emitter writes for `total` bytes, after redaction, split by stream. */
function expected(total: number) {
  const lines = { stdout: [] as string[], stderr: [] as string[] }, bytes = { stdout: 0, stderr: 0 };
  for (let i = 0, sent = 0; sent < total; i++) {
    const line = lineFor(i);
    sent += Buffer.byteLength(line.raw) + 1; lines[line.stream].push(line.redacted); bytes[line.stream] += Buffer.byteLength(line.redacted) + 1;
  }
  return { lines, bytes };
}
async function startDaemon(dataDir: string, provider: string) {
  const proc = Bun.spawn([process.execPath, daemonScript, "--data", dataDir], { stdout: "pipe", stderr: "inherit", env: { ...process.env, SPIKE_PROVIDER: provider } });
  const reader = proc.stdout.getReader(); let text = "";
  while (!text.includes("\n")) { const { value, done } = await reader.read(); if (done) throw new Error("daemon exited before ready"); text += new TextDecoder().decode(value); }
  reader.releaseLock();
  const base = `http://127.0.0.1:${JSON.parse(text).port}`;
  const get = async (p: string) => (await fetch(base + p)).json() as Promise<any>;
  const post = async (p: string, body: unknown = {}) => (await fetch(base + p, { method: "POST", body: JSON.stringify(body) })).json() as Promise<any>;
  const run = (jobId: string, ...args: string[]) => post("/v1/jobs", { jobId, command: process.execPath, args: [emitter, ...args] });
  const until = async (jobId: string, done: (job: any) => boolean, timeoutMs = 60_000) => {
    for (const deadline = Date.now() + timeoutMs; ;) {
      const job = await get(`/v1/jobs/${jobId}`);
      if (done(job)) return job;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${jobId} in state ${job.state}`);
      await Bun.sleep(20);
    }
  };
  return { proc, get, post, run, until };
}
const text = (chunks: any[]) => chunks.map(c => c.data).join("");
const tailLines = (chunks: any[]) => text(chunks).replace(/\n$/, "").split("\n");
const terminal = (job: any) => ["exited", "failed", "killed", "lost"].includes(job.state);
function percentile(values: number[], p: number) { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; }
async function latency(get: (p: string) => Promise<any>, route: string, n: number) {
  const times: number[] = [];
  for (let i = 0; i < n; i++) { const t = performance.now(); await get(route); times.push(performance.now() - t); }
  return { n, p50: +percentile(times, 0.5).toFixed(2), p95: +percentile(times, 0.95).toFixed(2), max: +Math.max(...times).toFixed(2) };
}
function spoolText(dataDir: string, jobId: string) {
  return ["output.prev.jsonl", "output.jsonl"].map(name => {
    try { return fs.readFileSync(path.join(dataDir, "jobs", jobId, name), "utf8"); } catch { return ""; }
  }).join("").split("\n").filter(Boolean).map(line => JSON.parse(line.slice(18))).filter(r => r.data).map(r => Buffer.from(r.data, "base64").toString("latin1")).join("");
}

for (const provider of providers) describe(`capture provider: ${provider}`, () => {
  const dataDir = path.join(temp, provider), metrics: Record<string, unknown> = {};
  results[provider] = metrics;

  test("10 MB burst: no deadlock, bounded ring, redaction, fast tail", async () => {
    const d = await startDaemon(dataDir, provider), want = expected(MB10);
    const idleRss = (await d.get("/v1/stats")).rss, started = performance.now();
    await d.run("burst", String(MB10));
    const live: number[] = [];
    for (let job = await d.get("/v1/jobs/burst"); !terminal(job); job = await d.get("/v1/jobs/burst")) {
      const t = performance.now(); await d.get("/v1/jobs/burst/output?stream=stdout&tail=100&since=0"); live.push(performance.now() - t);
    }
    const job = await d.until("burst", terminal);
    metrics.captureMs = +(performance.now() - started).toFixed(0);
    metrics.throughputMiBps = +(MB10 / 1048576 / ((performance.now() - started) / 1000)).toFixed(1);
    expect(job.state).toBe("exited"); expect(job.exitCode).toBe(0);
    expect(job.outputBytes).toEqual(want.bytes);                                  // every byte accounted for
    expect(job.retainedBytes.stdout + job.retainedBytes.stderr).toBeLessThanOrEqual(CAP);
    expect(job.truncation.stdout.droppedBytes).toBe(want.bytes.stdout - job.retainedBytes.stdout);
    expect(job.truncation.stdout.firstDroppedSeq).toBeGreaterThan(0);
    const all = await d.get("/v1/jobs/burst/output?stream=stdout&since=0");
    expect(all.chunks[0].truncated).toBe(true);                                   // explicit truncation marker
    expect(all.chunks[0].firstDroppedSeq).toBe(job.truncation.stdout.firstDroppedSeq);
    expect(all.chunks[0].seq).toBe(job.truncation.stdout.lastDroppedSeq + 1);
    expect(all.chunks[0].offset).toBe(job.truncation.stdout.droppedBytes);
    expect(text(all.chunks)).not.toContain("�");                             // chunk boundaries never split a code point
    for (const stream of ["stdout", "stderr"] as const) {
      const out = await d.get(`/v1/jobs/burst/output?stream=${stream}&tail=100&since=0`);
      expect(tailLines(out.chunks)).toEqual(want.lines[stream].slice(-100));
    }
    expect(spoolText(dataDir, "burst")).not.toMatch(/sk-[a-z0-9]{20}|ghp_[a-z0-9]{20}|API_KEY=[a-z0-9]/);  // nothing raw on disk
    const idle = await latency(d.get, "/v1/jobs/burst/output?stream=stdout&tail=100&since=0", 300);
    metrics.tailLatencyIdleMs = idle;
    metrics.tailLatencyDuringBurstMs = { n: live.length, p50: +percentile(live, 0.5).toFixed(2), p95: +percentile(live, 0.95).toFixed(2), max: +Math.max(...live).toFixed(2) };
    metrics.rssMiB = { idle: +(idleRss / 1048576).toFixed(1), afterBurst: +((await d.get("/v1/stats")).rss / 1048576).toFixed(1) };
    metrics.ringChunks = all.chunks.length;
    expect(idle.p95).toBeLessThan(100);
    expect(percentile(live, 0.95)).toBeLessThan(100);
    d.proc.kill(); await d.proc.exited;
  }, 120_000);

  test("child exits mid-write and child killed mid-stream", async () => {
    const d = await startDaemon(path.join(temp, `${provider}-edge`), provider);
    await d.run("die", "200000", "die");
    const died = await d.until("die", terminal);
    expect(died.state).toBe("exited"); expect(died.exitCode).toBe(7);
    const out = await d.get("/v1/jobs/die/output?stream=stdout&tail=1&since=0");
    expect(text(out.chunks)).toBe("partial line without newline �");        // incomplete code point flushed at EOF
    await d.run("forever", "0", "forever");
    await d.until("forever", job => job.outputBytes.stdout > 2 * CAP);
    await d.post("/v1/jobs/forever/kill");
    const killed = await d.until("forever", terminal, 15_000);
    expect(killed.state).toBe("killed");
    d.proc.kill(); await d.proc.exited;
  }, 60_000);

  test("20 concurrent jobs x 2 MiB: bounded memory, no deadlock", async () => {
    const d = await startDaemon(path.join(temp, `${provider}-fleet`), provider);
    const before = (await d.get("/v1/stats")).rss;
    const ids = Array.from({ length: 20 }, (_, i) => `fleet-${i}`);
    await Promise.all(ids.map(id => d.run(id, String(2 * CAP))));
    const done = await Promise.all(ids.map(id => d.until(id, terminal, 90_000)));
    expect(done.every(job => job.state === "exited" && job.exitCode === 0)).toBe(true);
    const peak = (await d.get("/v1/stats")).rss;
    expect(done.reduce((sum, job) => sum + job.retainedBytes.stdout + job.retainedBytes.stderr, 0)).toBeLessThanOrEqual(20 * CAP);
    await d.get("/v1/stats?gc=1"); await Bun.sleep(5000);                         // let the allocator return freed pages
    const settled = await d.get("/v1/stats?gc=1"), mib = (n: number) => +(n / 1048576).toFixed(1);
    metrics.fleet20 = { rssBeforeMiB: mib(before), rssAtCompletionMiB: mib(peak), transientOverheadMiB: mib(peak - before),
      rssSettledMiB: mib(settled.rss), settledOverheadMiB: mib(settled.rss - before), heapUsedSettledMiB: mib(settled.heapUsed),
      list: await latency(async () => Promise.all(ids.map(id => d.get(`/v1/jobs/${id}`))), "", 20) };
    expect(settled.rss - before).toBeLessThan(50 * 1024 * 1024);                  // budget: 20 x 1 MiB rings < 50 MB steady-state overhead
    d.proc.kill(); await d.proc.exited;
  }, 180_000);

  test("daemon SIGKILL -> corrupt tail -> restart replays the exact pre-crash tail", async () => {
    const first = await startDaemon(dataDir, provider);                           // same data dir as the burst test
    await first.run("live", "0", "slow");
    await first.until("live", job => job.outputBytes.stdout > 1200);
    const before = await first.get("/v1/jobs/burst/output?stream=stdout&tail=100&since=0");
    const liveBefore = tailLines((await first.get("/v1/jobs/live/output?stream=stdout&tail=100&since=0")).chunks);
    first.proc.kill(9); await first.proc.exited;                                  // hard crash: no handlers run
    const torn = frame({ type: "stdout", seq: 999999, ts: 0, offset: 0, data: "A".repeat(4000) });
    for (const id of ["burst", "live"]) {                                         // torn write: valid header, half a body
      fs.appendFileSync(path.join(dataDir, "jobs", id, "output.jsonl"), torn.subarray(0, torn.length - 1500));
    }
    const started = performance.now(), second = await startDaemon(dataDir, provider);
    metrics.restartMs = +(performance.now() - started).toFixed(0);
    metrics.recoveryMs = +(await second.get("/v1/stats")).recoveryMs.toFixed(1);
    const after = await second.get("/v1/jobs/burst/output?stream=stdout&tail=100&since=0");
    expect(after.chunks.map((c: any) => c.data).join("")).toBe(text(before.chunks));
    expect(tailLines(after.chunks)).toEqual(expected(MB10).lines.stdout.slice(-100));
    expect(after.state).toBe("exited"); expect(after.corruptTailBytes).toBe(torn.length - 1500);
    expect(after.truncation.stdout.firstDroppedSeq).toBe(before.truncation.stdout.firstDroppedSeq);
    const live = await second.get("/v1/jobs/live/output?stream=stdout&since=0");
    expect(live.state).toBe("lost"); expect(live.corruptTailBytes).toBe(torn.length - 1500);
    const numbers = text(live.chunks).split("\n").slice(0, -1).map(line => Number(line.split("|")[0]));   // drop a trailing partial line
    expect(numbers.every((n, i) => i === 0 || n === numbers[i - 1] + 1)).toBe(true);   // contiguous, nothing reordered
    // The spool is not fsynced per chunk, but a process crash (not an OS crash) loses at most the unflushed redactor carry.
    expect(numbers.at(-1)).toBeGreaterThanOrEqual(Number(liveBefore.at(-2)!.split("|")[0]));
    second.proc.kill(); await second.proc.exited;
  }, 120_000);
});
