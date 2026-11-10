import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path";
import { crc32, decodeFrames, DEFAULT_SPOOL_MAX_BYTES, encodeFrame, EventStore, FRAME_HEADER_BYTES } from "../src/event-store.js";
import { FleetError } from "../src/fleet-errors.js";
import type { CaptureSpec, JobRecordV2 } from "../src/types.js";
let root: string, store: EventStore;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-event-store-")); store = new EventStore({ root }); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
function makeRecord(jobId: string, capture: Partial<CaptureSpec> = {}): JobRecordV2 {
  return {
    version: 2, jobId, state: "queued", stateReason: "submitted", harness: "custom", command: "echo", args: [], cwd: root, peer: "tester", backend: "unknown", owner: { sessionId: "s", tokenHash: "", surface: "daemon" }, visibility: "owner", supervisor: { pid: 1, startTime: "1", surface: "daemon" }, containment: null,
    capture: { kind: "pipe", ringBytes: 4096, spool: "tail", spoolMaxBytes: DEFAULT_SPOOL_MAX_BYTES, redact: false, ...capture },
    queue: { admission: "immediate", priority: 0, dependsOn: [], resources: {}, leasePorts: [], leaseTtlMs: 0, timeoutMs: 0, maxQueueMs: 0 }, envKeys: [], createdAt: "2026-01-01T00:00:00.000Z", startedAt: null, exitedAt: null, exitCode: null, signal: null, lastSeq: 0, outputBytes: { stdout: 0, stderr: 0 }, error: null,
  };
}
const jobPath = (jobId: string) => path.join(root, "fleet", "jobs", jobId);
function expectCorruptTail(tail: Buffer): void {
  const good = encodeFrame({ seq: 1, text: "ok" }), result = decodeFrames(Buffer.concat([good, tail]));
  expect(result.records).toEqual([{ seq: 1, text: "ok" }]); expect(result.validBytes).toBe(good.length); expect(result.corruptTailBytes).toBe(tail.length); }
test("crc32 check value and Unicode round trip", () => {
  expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  const record = { message: "héllo 🚀 世界", seq: 7 }, json = Buffer.from(JSON.stringify(record), "utf8"), frame = encodeFrame(record);
  expect(frame.length).toBe(FRAME_HEADER_BYTES + json.length + 1); expect(frame.subarray(0, 18).toString("latin1")).toMatch(/^[0-9a-f]{8} [0-9a-f]{8} $/);
  expect(parseInt(frame.subarray(0, 8).toString(), 16)).toBe(json.length); expect(parseInt(frame.subarray(9, 17).toString(), 16)).toBe(crc32(json));
  expect(decodeFrames(frame)).toEqual({ records: [record], validBytes: frame.length, corruptTailBytes: 0 });
  expect(decodeFrames(Buffer.alloc(0))).toEqual({ records: [], validBytes: 0, corruptTailBytes: 0 });
});
test("six corruption cases recover the valid prefix", () => {
  const frame = encodeFrame({ seq: 2, text: "x".repeat(20) });
  expectCorruptTail(frame.subarray(0, 10)); expectCorruptTail(frame.subarray(0, frame.length - 5));
  const badCrc = Buffer.from(frame); badCrc[9] = badCrc[9] === 0x30 ? 0x31 : 0x30; expectCorruptTail(badCrc);
  expectCorruptTail(frame.subarray(0, frame.length - 1));
  const json = Buffer.from("not json"), header = Buffer.from(`${json.length.toString(16).padStart(8, "0")} ${crc32(json).toString(16).padStart(8, "0")} `);
  expectCorruptTail(Buffer.concat([header, json, Buffer.from("\n")])); expectCorruptTail(Buffer.from("garbage-appended\n"));
});
test("a reader never truncates; repair removes exactly the corrupt tail", () => {
  const writer = store.create(makeRecord("events-corrupt")); writer.appendState("starting", "admitted"); writer.close();
  const file = path.join(jobPath("events-corrupt"), "events.jsonl"), valid = fs.readFileSync(file);
  fs.appendFileSync(file, Buffer.from("garbage"));
  const size = fs.statSync(file).size, first = store.readAllEvents("events-corrupt");
  expect(first.events.map((event) => event.seq)).toEqual([1, 2]); expect(first.corruptTailBytes).toBe(7);
  store.readAllEvents("events-corrupt"); expect(fs.statSync(file).size).toBe(size);
  expect(store.repair("events-corrupt")).toEqual({ corruptTailBytes: 7 }); expect(fs.readFileSync(file)).toEqual(valid); expect(store.repair("events-corrupt")).toEqual({ corruptTailBytes: 0 });
});
test("repair also truncates output segment tails", () => {
  const writer = store.create(makeRecord("output-corrupt")); writer.appendOutput("stdout", Buffer.from("hello"), 0); writer.close();
  const file = path.join(jobPath("output-corrupt"), "output.jsonl"), valid = fs.readFileSync(file);
  fs.appendFileSync(file, Buffer.from("xx"));
  expect(store.readOutput("output-corrupt").chunks.map((chunk) => chunk.seq)).toEqual([2]); expect(store.readOutput("output-corrupt").corruptTailBytes).toBe(2);
  expect(store.repair("output-corrupt")).toEqual({ corruptTailBytes: 2 }); expect(fs.readFileSync(file)).toEqual(valid);
});
test("seq is monotonic across events.jsonl and output segments", () => {
  const writer = store.create(makeRecord("mono"));
  writer.appendState("starting", "admitted"); writer.appendSpawn({ pid: 1, startTime: "1", containmentMode: "passive-ppid", capture: "pipe" });
  writer.appendOutput("stdout", Buffer.from("a"), 0); writer.appendOutput("stderr", Buffer.from("bb"), 0);
  writer.appendState("running", "spawned", { startedAt: "2026-01-01T00:00:01.000Z" }); writer.appendState("exiting", "root-exited");
  writer.appendExit({ exitCode: 0, signal: null, durationMs: 1, outputBytes: writer.outputBytes, drained: true });
  const patch: { [key: string]: unknown } = {}, last = writer.appendState("exited", "root-exited", patch as never); writer.close();
  const events = store.readAllEvents("mono").events, chunks = store.readOutput("mono").chunks, seqs = [...events.map((event) => event.seq), ...chunks.map((chunk) => chunk.seq)].sort((a, b) => a - b);
  expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]); expect(last.seq).toBe(9); expect(patch.lastSeq).toBe(9);
  expect(patch.outputBytes).toEqual({ stdout: 1, stderr: 2 });
  const outputOnly = store.readEvents("mono", { types: ["stdout", "stderr"] });
  expect(outputOnly.events.map((event) => event.seq)).toEqual([4, 5]); expect(outputOnly.lastSeq).toBe(9);
});
test("appendState rejects illegal transitions and fills the patch", () => {
  const writer = store.create(makeRecord("patch")); writer.appendOutput("stdout", Buffer.from("abc"), 0);
  const patch: { [key: string]: unknown } = {}, event = writer.appendState("starting", "admitted", patch as never);
  expect(event.patch?.lastSeq).toBe(3); expect(patch.outputBytes).toEqual({ stdout: 3, stderr: 0 });
  writer.appendState("running", "spawned");
  expect(() => writer.appendState("queued", "submitted")).toThrow("Illegal job transition running -> queued"); writer.close();
});
test("reopen continues the sequence of a dead supervisor's job", () => {
  const writer = store.create(makeRecord("reopen")); writer.appendState("starting", "admitted"); writer.appendOutput("stdout", Buffer.from("abc"), 0); writer.close();
  const reopened = store.reopen("reopen");
  expect(reopened.lastSeq).toBe(3); expect(reopened.outputBytes).toEqual({ stdout: 3, stderr: 0 });
  expect(reopened.appendState("running", "spawned").seq).toBe(4); reopened.close();
});
test("readEvents pages and filters by type", () => {
  const writer = store.create(makeRecord("pages"));
  writer.appendState("starting", "admitted"); writer.appendSpawn({ pid: 1, startTime: "1", containmentMode: "passive-ppid", capture: "pipe" });
  writer.appendOutput("stdout", Buffer.from("hi"), 0); writer.appendState("running", "spawned"); writer.appendState("exiting", "root-exited");
  writer.appendExit({ exitCode: 0, signal: null, durationMs: 1, outputBytes: writer.outputBytes, drained: true }); writer.appendState("exited", "root-exited"); writer.close();
  const first = store.readEvents("pages", { limit: 2 }); expect(first.events.map((event) => event.seq)).toEqual([1, 2]); expect(first.hasMore).toBe(true); expect(first.nextSince).toBe(2); expect(first.lastSeq).toBe(8);
  const second = store.readEvents("pages", { since: first.nextSince, limit: 2 });
  expect(second.events.map((event) => event.seq)).toEqual([3, 5]); expect(second.nextSince).toBe(5);
  expect(store.readEvents("pages", { types: ["state"] }).events.map((event) => event.seq)).toEqual([1, 2, 5, 6, 8]);
  const stdout = store.readEvents("pages", { types: ["stdout"] }).events;
  expect(stdout.length).toBe(1); const outputEvent = stdout[0]; if (outputEvent.type !== "stdout") throw new Error("expected stdout event");
  expect(outputEvent.seq).toBe(4); expect(outputEvent.encoding).toBe("base64"); expect(Buffer.from(outputEvent.data, "base64").toString()).toBe("hi");
});
test("tail rotation keeps between 1x and 2x ringBytes", () => {
  const writer = store.create(makeRecord("rot", { ringBytes: 1024, spool: "tail" }));
  for (let i = 0; i < 20; i++) writer.appendOutput("stdout", Buffer.alloc(256, i + 1), i);
  writer.close();
  const output = store.readOutput("rot"), total = output.chunks.reduce((sum, chunk) => sum + chunk.data.length, 0);
  expect(total).toBeGreaterThanOrEqual(1024); expect(total).toBeLessThanOrEqual(2048); expect(output.chunks[output.chunks.length - 1].seq).toBe(21);
  expect(output.firstSeq.stdout).toBe(2); expect(fs.existsSync(path.join(jobPath("rot"), "output.prev.jsonl"))).toBe(true);
});
test("full mode keeps everything until spoolMaxBytes then switches to tail", () => {
  const writer = store.create(makeRecord("full", { ringBytes: 512, spool: "full", spoolMaxBytes: 1024 }));
  for (let i = 0; i < 6; i++) writer.appendOutput("stdout", Buffer.alloc(200, i + 1), i);
  expect(store.readOutput("full").chunks.length).toBe(6); expect(fs.existsSync(path.join(jobPath("full"), "output.prev.jsonl"))).toBe(false);
  writer.appendOutput("stdout", Buffer.alloc(200, 7), 7); expect(fs.existsSync(path.join(jobPath("full"), "output.prev.jsonl"))).toBe(true);
  const output = store.readOutput("full"); expect(output.chunks.length).toBe(7); expect(output.chunks.reduce((sum, chunk) => sum + chunk.data.length, 0)).toBe(1400); writer.close();
});
test("off mode assigns seq and offset but writes nothing", () => {
  const writer = store.create(makeRecord("off", { spool: "off" }));
  const first = writer.appendOutput("stdout", Buffer.from("abc"), 0), second = writer.appendOutput("stdout", Buffer.from("def"), 1);
  expect(first.seq).toBe(2); expect(second.seq).toBe(3); expect(second.offset).toBe(3); expect(writer.outputBytes).toEqual({ stdout: 6, stderr: 0 }); writer.close();
  expect(store.readOutput("off").chunks).toEqual([]); expect(store.readOutput("off").firstSeq).toEqual({ stdout: null, stderr: null });
  expect(store.readEvents("off", { types: ["stdout"] }).events).toEqual([]); expect(fs.existsSync(path.join(jobPath("off"), "output.jsonl"))).toBe(false);
});
test("an output write error disables spooling and reports it on the next state", () => {
  const writer = store.create(makeRecord("spool-error")); fs.mkdirSync(path.join(jobPath("spool-error"), "output.jsonl"));
  expect(writer.appendOutput("stdout", Buffer.from("x"), 0).seq).toBe(2);
  const event = writer.appendState("starting", "admitted", undefined, "hello");
  expect(event.detail).toContain("hello"); expect(event.detail).toContain("spool disabled: ");
  expect(writer.appendState("running", "spawned").detail).toBeUndefined(); writer.close();
  expect(fs.statSync(path.join(jobPath("spool-error"), "output.jsonl")).isDirectory()).toBe(true);
});
test("create rejects a non-terminal job and replaces a terminal one", () => {
  const writer = store.create(makeRecord("dup")); let caught: unknown;
  try { store.create(makeRecord("dup")); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(FleetError); expect((caught as FleetError).code).toBe("E_JOB_EXISTS");
  writer.appendState("failed", "spawn-error", { error: "nope" }); writer.close();
  const replaced = store.create(makeRecord("dup"));
  expect(store.readAllEvents("dup").events.map((event) => event.seq)).toEqual([1]); expect(replaced.lastSeq).toBe(1); replaced.close();
  expect(store.listJobIds()).toEqual(["dup"]);
});
test("100 fsynced state appends stay under 50 ms p95", () => { const samples: number[] = [];
  for (let i = 0; i < 34; i++) {
    const writer = store.create(makeRecord(`perf-${i}`));
    for (const [state, reason] of [["starting", "admitted"], ["running", "spawned"], ["exiting", "root-exited"]] as const) {
      const started = performance.now(); writer.appendState(state, reason); samples.push(performance.now() - started);
    }
    writer.close();
  }
  samples.sort((a, b) => a - b); expect(samples.length).toBe(102); expect(samples[Math.ceil(samples.length * 0.95) - 1]).toBeLessThan(50);
});
