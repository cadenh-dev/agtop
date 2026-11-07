import { afterAll, afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isStaleJob, processSnapshot, pruneStaleJobs, reserveJob, writeJob } from "../src/registry.js";
import type { JobRecord } from "../src/types.js";

const oldState = process.env.AGTOP_STATE_DIR;
const state = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-stale-"));
process.env.AGTOP_STATE_DIR = state;
afterEach(() => { for (const name of fs.readdirSync(state)) fs.rmSync(path.join(state, name), { recursive: true, force: true }); });
afterAll(() => { if (oldState === undefined) delete process.env.AGTOP_STATE_DIR; else process.env.AGTOP_STATE_DIR = oldState; fs.rmSync(state, { recursive: true, force: true }); });

function record(jobId: string, rootPid = 900_001): JobRecord {
  return { version: 1, jobId, rootPid, startTime: "100", harness: "custom", peer: "test", cwd: os.tmpdir(), backend: "unknown", mode: process.platform === "win32" ? "win32-job-object" : process.platform === "darwin" ? "darwin-env-pgid" : "linux-env-pgid", ...(process.platform === "win32" ? { jobName: `missing-${jobId}` } : {}), createdAt: new Date().toISOString() };
}
function stale(job: JobRecord, processes: Parameters<typeof isStaleJob>[1], members: number[] = []) { return isStaleJob(job, processes, members); }

describe("stale job records", () => {
  test("dead supervisor with no live members is stale and can be pruned", () => {
    const job = record("dead-job"); writeJob(job);
    expect(stale(job, [])).toBe(true);
    expect(pruneStaleJobs(false, candidate => stale(candidate, []))).toEqual(["dead-job"]);
    expect(fs.existsSync(path.join(state, "dead-job.json"))).toBe(false);
  });

  test("live supervisor is never stale", () => {
    const job = record("live-root", process.pid);
    expect(stale(job, [{ pid: process.pid, startTime: "100" }])).toBe(false);
  });

  test("a tagged live member prevents pruning", () => {
    const job = record("member-job");
    if (process.platform === "win32") expect(stale(job, [{ pid: 42, startTime: "member" }], [42])).toBe(false);
    else expect(stale(job, [{ pid: 42, startTime: "member", tag: job.jobId }])).toBe(false);
  });

  test("PID reuse with a different creation time counts as a dead supervisor", () => {
    const job = record("reused-pid", 42);
    expect(stale(job, [{ pid: 42, startTime: "200" }])).toBe(true);
  });

  test("dry-run retains stale record and reservation reclaims stale ID", () => {
    const job = record("reclaim-me"); writeJob(job);
    expect(pruneStaleJobs(true, candidate => stale(candidate, []))).toEqual(["reclaim-me"]);
    expect(fs.existsSync(path.join(state, "reclaim-me.json"))).toBe(true);
    const release = reserveJob("reclaim-me", candidate => stale(candidate, []));
    expect(fs.existsSync(path.join(state, "reclaim-me.json"))).toBe(true);
    release();
    expect(fs.existsSync(path.join(state, "reclaim-me.json"))).toBe(false);
  });

  test("macOS ps scanner mode keeps records because it cannot provide stale-check tags", () => {
    const previous = process.env.AGTOP_DARWIN_SCANNER;
    process.env.AGTOP_DARWIN_SCANNER = "ps";
    const job = { ...record("ps-mode-live"), mode: "darwin-env-pgid" as const };
    try {
      writeJob(job);
      expect(() => processSnapshot("darwin")).toThrow("native macOS process snapshot");
      expect(isStaleJob(job, undefined, undefined, "darwin")).toBe(false);
      expect(pruneStaleJobs(false, candidate => isStaleJob(candidate, undefined, undefined, "darwin"))).toEqual([]);
      expect(fs.existsSync(path.join(state, "ps-mode-live.json"))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.AGTOP_DARWIN_SCANNER;
      else process.env.AGTOP_DARWIN_SCANNER = previous;
    }
  });
});
