import { expect, test } from "bun:test";
import {
  DEFAULT_RING_BYTES, MAX_RING_BYTES, MAX_RING_CHUNKS, MIN_RING_BYTES, OutputRingBuffer,
  STDERR_RESERVE_BYTES, renderOutputText, truncationMarker,
} from "../src/capture.js";
import type { StoredChunk } from "../src/event-store.js";
import { FleetError } from "../src/fleet-errors.js";
import type { OutputChunk, OutputPage, OutputQuery, OutputStream, TruncationInfo } from "../src/types.js";

const EPOCH = 1_700_000_000_000;
const mk = (seq: number, stream: OutputStream, offset: number, data: string | Buffer): StoredChunk =>
  ({ seq, stream, timestampMs: EPOCH + seq, data: Buffer.isBuffer(data) ? data : Buffer.from(data), offset });
const seqs = (page: { chunks: OutputChunk[] }): number[] => page.chunks.map((chunk) => chunk.seq);
function expectInvalid(ring: OutputRingBuffer, query: OutputQuery, field: string): void {
  let error: unknown;
  try { ring.read(query); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(FleetError);
  expect((error as FleetError).code).toBe("E_INVALID_REQUEST");
  expect((error as FleetError).details).toEqual({ field });
}

test("constants and byte cap", () => {
  expect([DEFAULT_RING_BYTES, MIN_RING_BYTES, MAX_RING_BYTES, MAX_RING_CHUNKS, STDERR_RESERVE_BYTES]).toEqual([1_048_576, 65_536, 16_777_216, 4096, 65_536]);
  const ring = new OutputRingBuffer({ capBytes: 1024 });
  for (let seq = 1; seq <= 20; seq += 1) ring.push(mk(seq, "stdout", (seq - 1) * 100, Buffer.alloc(100, seq)));
  expect(ring.retainedBytes).toEqual({ stdout: 1000, stderr: 0 }); expect(ring.totalBytes).toEqual({ stdout: 2000, stderr: 0 }); expect(ring.lastSeq).toBe(20);
  const page = ring.read({ limit: 1000 });
  expect(seqs(page)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]); expect(page.chunks[0]!.offset).toBe(1000);
  expect(ring.truncation("stdout")).toEqual({ firstDroppedSeq: 1, lastDroppedSeq: 10, droppedBytes: 1000 });
});

test("chunk cap bounds a trickle of tiny chunks", () => {
  const ring = new OutputRingBuffer({ maxChunks: 10 });
  for (let seq = 1; seq <= 50; seq += 1) ring.push(mk(seq, "stdout", seq - 1, "x"));
  expect(ring.retainedBytes.stdout).toBe(10); expect(ring.totalBytes.stdout).toBe(50);
  expect(seqs(ring.read({ limit: 1000 }))).toEqual([41, 42, 43, 44, 45, 46, 47, 48, 49, 50]);
  expect(ring.truncation("stdout")).toEqual({ firstDroppedSeq: 1, lastDroppedSeq: 40, droppedBytes: 40 });
});

test("evicted buffers are released immediately", () => {
  const ring = new OutputRingBuffer({ capBytes: 65_536 });
  const push = (seq: number, offset: number): WeakRef<Buffer> => { const data = Buffer.alloc(32_768, seq); ring.push(mk(seq, "stdout", offset, data)); return new WeakRef(data); };
  const first = push(1, 0); push(2, 32_768); Bun.gc(true); push(3, 65_536); Bun.gc(true);
  expect(first.deref()).toBeUndefined(); expect(ring.retainedBytes.stdout).toBe(65_536);
});

test("the stderr reserve keeps stderr under a stdout flood", () => {
  const ring = new OutputRingBuffer({ capBytes: 1_048_576 });
  for (let seq = 1; seq <= 8; seq += 1) ring.push(mk(seq, "stderr", (seq - 1) * 8192, Buffer.alloc(8192, seq)));
  const kept = ring.read({ stream: "stderr", limit: 1000 }).chunks;
  for (let seq = 9; seq <= 48; seq += 1) ring.push(mk(seq, "stdout", (seq - 9) * 65_536, Buffer.alloc(65_536, seq)));
  expect(ring.retainedBytes.stderr).toBe(65_536); expect(ring.truncation("stderr")).toBeNull();
  expect(ring.read({ stream: "stderr", limit: 1000 }).chunks).toEqual(kept); expect(ring.retainedBytes.stdout).toBe(1_048_576 - 65_536);
  const small = new OutputRingBuffer({ capBytes: 65_536 });
  small.push(mk(1, "stderr", 0, Buffer.alloc(16_384, 1))); small.push(mk(2, "stderr", 16_384, Buffer.alloc(16_384, 2)));
  for (let seq = 3; seq <= 42; seq += 1) small.push(mk(seq, "stdout", (seq - 3) * 4096, Buffer.alloc(4096, seq)));
  expect(small.retainedBytes.stderr).toBe(16_384); expect(small.truncation("stderr")).toEqual({ firstDroppedSeq: 1, lastDroppedSeq: 1, droppedBytes: 16_384 });
});

test("truncation before, during and after drops", () => {
  const fresh = new OutputRingBuffer(); fresh.push(mk(1, "stdout", 0, "hello\n")); fresh.push(mk(2, "stderr", 0, "oops\n"));
  expect([fresh.truncation("stdout"), fresh.truncation("stderr")]).toEqual([null, null]); expect(fresh.totalBytes).toEqual({ stdout: 6, stderr: 5 });
  expect(fresh.read({}).chunks.every((chunk) => !chunk.truncated)).toBe(true);
  const ring = new OutputRingBuffer({ capBytes: 250 });
  for (let seq = 1; seq <= 6; seq += 1) ring.push(mk(seq, "stdout", (seq - 1) * 100, Buffer.alloc(100, seq)));
  expect(ring.truncation("stdout")).toEqual({ firstDroppedSeq: 1, lastDroppedSeq: 4, droppedBytes: 400 });
  const page = ring.read({}); expect(page.chunks[0]).toMatchObject({ seq: 5, truncated: true, firstDroppedSeq: 1 }); expect(page.chunks.slice(1).every((chunk) => !chunk.truncated)).toBe(true);
  const gone = new OutputRingBuffer({ capBytes: 10 }); gone.push(mk(1, "stdout", 0, Buffer.alloc(100, 1)));
  expect(gone.truncation("stdout")).toEqual({ firstDroppedSeq: 1, lastDroppedSeq: 1, droppedBytes: 100 }); expect(gone.read({})).toEqual({ chunks: [], nextSince: 0, hasMore: false });
});

test("hydrate equals a live ring and takes firstSeq from headers", () => {
  const chunks: StoredChunk[] = []; let stdoutOffset = 0, stderrOffset = 0;
  for (let seq = 1; seq <= 40; seq += 1) {
    const isError = seq % 5 === 0, data = Buffer.from(`${isError ? "err" : "out"} ${seq}\n`);
    chunks.push(mk(seq, isError ? "stderr" : "stdout", isError ? stderrOffset : stdoutOffset, data));
    if (isError) stderrOffset += data.length; else stdoutOffset += data.length;
  }
  const live = new OutputRingBuffer({ capBytes: 200 }); for (const entry of chunks) live.push(entry);
  const hydrated = new OutputRingBuffer({ capBytes: 200 }); hydrated.hydrate({ chunks, firstSeq: { stdout: 1, stderr: 5 }, corruptTailBytes: 0 });
  const queries: OutputQuery[] = [
    {}, { stream: "stdout" }, { stream: "stderr" }, { since: 10 }, { tail: 3 },
    { tail: 2, stream: "stdout" }, { encoding: "base64" }, { limit: 2, maxBytes: 20 }, { since: 20, maxBytes: 15 },
  ];
  for (const query of queries) expect(hydrated.read(query)).toEqual(live.read(query));
  expect([hydrated.truncation("stdout"), hydrated.truncation("stderr"), hydrated.retainedBytes, hydrated.totalBytes, hydrated.lastSeq])
    .toEqual([live.truncation("stdout"), live.truncation("stderr"), live.retainedBytes, live.totalBytes, live.lastSeq]);
  const headers = new OutputRingBuffer(); headers.hydrate({ chunks: [mk(5, "stdout", 10, "abc")], firstSeq: { stdout: 3, stderr: null }, corruptTailBytes: 0 });
  expect(headers.truncation("stdout")).toEqual({ firstDroppedSeq: 3, lastDroppedSeq: 4, droppedBytes: 10 }); expect(headers.truncation("stderr")).toBeNull();
});

test("read selects streams, applies since and limit, and pages", () => {
  const ring = new OutputRingBuffer(); ring.push(mk(1, "stdout", 0, "a")); ring.push(mk(2, "stderr", 0, "b")); ring.push(mk(3, "stdout", 1, "c"));
  const both = ring.read({});
  expect(both.chunks.map((chunk) => [chunk.seq, chunk.stream, chunk.data])).toEqual([[1, "stdout", "a"], [2, "stderr", "b"], [3, "stdout", "c"]]); expect(both.nextSince).toBe(3);
  expect(seqs(ring.read({ stream: "stdout" }))).toEqual([1, 3]); expect(seqs(ring.read({ stream: "stderr" }))).toEqual([2]);
  expect(ring.read({ since: 3 })).toEqual({ chunks: [], nextSince: 3, hasMore: false }); expect(ring.read({ since: 99 })).toEqual({ chunks: [], nextSince: 99, hasMore: false });
  const many = new OutputRingBuffer(); for (let seq = 1; seq <= 250; seq += 1) many.push(mk(seq, "stdout", seq - 1, "x"));
  const first = many.read({}); expect([first.chunks.length, first.chunks[0]!.seq, first.nextSince, first.hasMore]).toEqual([200, 1, 200, true]);
  const second = many.read({ since: first.nextSince }); expect([second.chunks.length, second.chunks[0]!.seq, second.nextSince, second.hasMore]).toEqual([50, 201, 250, false]);
  expect(seqs(many.read({ limit: 3 }))).toEqual([1, 2, 3]);
});

test("maxBytes without tail stops before the first chunk that would exceed it", () => {
  const ring = new OutputRingBuffer(); for (let seq = 1; seq <= 5; seq += 1) ring.push(mk(seq, "stdout", (seq - 1) * 100, Buffer.alloc(100, seq)));
  const page = ring.read({ maxBytes: 250 }); expect(seqs(page)).toEqual([1, 2]); expect(page.hasMore).toBe(true);
  const single = ring.read({ maxBytes: 50 }); expect(seqs(single)).toEqual([1]); expect(single.chunks[0]!.byteLength).toBe(100); expect(single.hasMore).toBe(true);
  const only = new OutputRingBuffer(); only.push(mk(1, "stdout", 0, Buffer.alloc(100, 1)));
  expect(seqs(only.read({ maxBytes: 50 }))).toEqual([1]); expect(only.read({ maxBytes: 50 }).hasMore).toBe(false);
});

test("tail counts lines across chunks and both streams", () => {
  const ring = new OutputRingBuffer(); ring.push(mk(1, "stdout", 0, "one\ntwo\n")); ring.push(mk(2, "stdout", 8, "three\nfour"));
  const two = ring.read({ tail: 2 }); expect(two.chunks).toHaveLength(1); expect(two.chunks[0]).toMatchObject({ seq: 2, offset: 8, byteLength: 10, data: "three\nfour" }); expect([two.hasMore, two.nextSince]).toEqual([false, 2]);
  const three = ring.read({ tail: 3 }); expect(three.chunks.map((chunk) => [chunk.seq, chunk.offset, chunk.byteLength, chunk.data])).toEqual([[1, 4, 4, "two\n"], [2, 8, 10, "three\nfour"]]);
  const single = new OutputRingBuffer(); single.push(mk(1, "stdout", 0, "a\nb\nc\nd")); expect(single.read({ tail: 2 }).chunks[0]).toMatchObject({ offset: 4, byteLength: 3, data: "c\nd" });
  const trailing = new OutputRingBuffer(); trailing.push(mk(1, "stdout", 0, "a\nb\n")); expect(trailing.read({ tail: 1 }).chunks[0]).toMatchObject({ offset: 2, byteLength: 2, data: "b\n" });
  const mixed = new OutputRingBuffer(); mixed.push(mk(1, "stdout", 0, "out1\n")); mixed.push(mk(2, "stderr", 0, "err1\n")); mixed.push(mk(3, "stdout", 5, "out2\n")); mixed.push(mk(4, "stderr", 5, "err2"));
  expect(mixed.read({ tail: 2 }).chunks.map((chunk) => [chunk.seq, chunk.data])).toEqual([[3, "out2\n"], [4, "err2"]]); expect(seqs(mixed.read({ tail: 3 }))).toEqual([2, 3, 4]); expect(seqs(mixed.read({ tail: 10 }))).toEqual([1, 2, 3, 4]);
});

test("maxBytes with tail drops from the front; trimmed chunks are not flagged", () => {
  const ring = new OutputRingBuffer(); for (let seq = 1; seq <= 10; seq += 1) ring.push(mk(seq, "stdout", (seq - 1) * 6, `line${seq}\n`));
  const page = ring.read({ tail: 5, maxBytes: 12 }); expect(seqs(page)).toEqual([10]); expect([page.hasMore, page.nextSince]).toEqual([false, 10]);
  const trimmed = new OutputRingBuffer({ capBytes: 100 }); trimmed.push(mk(1, "stdout", 0, "old\n".repeat(25))); trimmed.push(mk(2, "stdout", 100, "x\n".repeat(50)));
  expect(trimmed.truncation("stdout")).not.toBeNull(); expect(trimmed.read({ tail: 2 }).chunks[0]).toMatchObject({ seq: 2, offset: 196, byteLength: 4, data: "x\nx\n", truncated: false });
});

test("truncated is set only while the dropped prefix lies after since", () => {
  const ring = new OutputRingBuffer({ capBytes: 1024 }); for (let seq = 1; seq <= 20; seq += 1) ring.push(mk(seq, "stdout", (seq - 1) * 100, Buffer.alloc(100, seq)));
  expect(ring.read({ since: 9, limit: 1 }).chunks[0]).toMatchObject({ seq: 11, truncated: true, firstDroppedSeq: 1 });
  const at = ring.read({ since: 10, limit: 1 }).chunks[0]!; expect(at.truncated).toBe(false); expect("firstDroppedSeq" in at).toBe(false);
});

test("base64 is byte-exact and utf8 replaces invalid sequences", () => {
  const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x41, 0xf0, 0x9f, 0x9a, 0x80]); const ring = new OutputRingBuffer(); ring.push(mk(1, "stdout", 0, bytes));
  const base64 = ring.read({ encoding: "base64" }).chunks[0]!; expect([base64.data, base64.byteLength, base64.encoding]).toEqual([bytes.toString("base64"), bytes.length, "base64"]);
  const utf8 = ring.read({}).chunks[0]!; expect([utf8.data, utf8.byteLength, utf8.encoding]).toEqual([bytes.toString("utf8"), bytes.length, "utf8"]);
  expect(utf8.data).toContain("\uFFFD"); expect(utf8.data).toContain("\u{1F680}");
});

test("out-of-range query values throw E_INVALID_REQUEST with the field", () => {
  const ring = new OutputRingBuffer(); ring.push(mk(1, "stdout", 0, "x\n"));
  expectInvalid(ring, { since: -1 }, "since"); expectInvalid(ring, { since: 1.5 }, "since");
  expectInvalid(ring, { limit: 0 }, "limit"); expectInvalid(ring, { limit: 1001 }, "limit");
  expectInvalid(ring, { maxBytes: 0 }, "maxBytes"); expectInvalid(ring, { maxBytes: 4_194_305 }, "maxBytes");
  expectInvalid(ring, { tail: 0 }, "tail"); expectInvalid(ring, { tail: 10_001 }, "tail");
  expectInvalid(ring, { encoding: "hex" as unknown as "utf8" }, "encoding"); expectInvalid(ring, { stream: "pty" as unknown as OutputStream }, "stream");
  expect(ring.read({ tail: 1, limit: 9_999 }).chunks).toHaveLength(1);
});

test("truncationMarker and renderOutputText", () => {
  expect(truncationMarker("stdout", { firstDroppedSeq: 3, lastDroppedSeq: 7, droppedBytes: 1234 })).toBe("[agtop: 1234 bytes of stdout dropped (seq 3-7)]\n");
  const truncation: { stdout: TruncationInfo | null; stderr: TruncationInfo | null } = { stdout: { firstDroppedSeq: 2, lastDroppedSeq: 9, droppedBytes: 10 }, stderr: { firstDroppedSeq: 1, lastDroppedSeq: 1, droppedBytes: 5 } };
  const built = (seq: number, stream: OutputStream, data: string, truncated: boolean, firstDroppedSeq?: number): OutputChunk =>
    ({ seq, stream, timestamp: "t", offset: 0, byteLength: data.length, encoding: "utf8", data, truncated, ...(firstDroppedSeq ? { firstDroppedSeq } : {}) });
  const page: Pick<OutputPage, "chunks" | "truncation"> = { truncation, chunks: [built(10, "stdout", "abc", true, 2), built(11, "stdout", "def", false), built(12, "stderr", "err", true, 1)] };
  expect(renderOutputText(page)).toBe("[agtop: 10 bytes of stdout dropped (seq 2-9)]\nabcdef[agtop: 5 bytes of stderr dropped (seq 1-1)]\nerr"); expect(renderOutputText({ chunks: [], truncation })).toBe("");
});
