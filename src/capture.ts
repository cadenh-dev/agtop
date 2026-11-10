import type { StoredChunk, StoredOutput } from "./event-store.js";
import { FleetError } from "./fleet-errors.js";
import type { OutputChunk, OutputCounters, OutputPage, OutputQuery, OutputStream, TruncationInfo } from "./types.js";

export const DEFAULT_RING_BYTES = 1_048_576, MIN_RING_BYTES = 65_536, MAX_RING_BYTES = 16_777_216, MAX_RING_CHUNKS = 4096;
/** Base stderr reservation; a ring smaller than 256 KiB reserves a quarter of its bytes instead. */
export const STDERR_RESERVE_BYTES = 65_536;

export interface RingOptions { capBytes?: number; stderrReserveBytes?: number; maxChunks?: number }
interface Queue { chunks: (StoredChunk | undefined)[]; head: number }
interface TailCut { index: number; bytes: number }
const STREAMS: readonly OutputStream[] = ["stdout", "stderr"];
const defaultStderrReserve = (capBytes: number): number => (capBytes < 262_144 ? Math.floor(capBytes / 4) : STDERR_RESERVE_BYTES);
const queryError = (field: string, message: string): FleetError => new FleetError("E_INVALID_REQUEST", message, { field });

function integerInRange(value: number | undefined, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw queryError(field, `${field} must be an integer between ${min} and ${max}.`);
  return value;
}

/** One job's bounded ring of redacted stdout and stderr chunks (contracts 6.3). Never touches disk. */
export class OutputRingBuffer {
  private readonly capBytes: number;
  private readonly stderrReserveBytes: number;
  private readonly maxChunks: number;
  private readonly queues: Record<OutputStream, Queue> = { stdout: { chunks: [], head: 0 }, stderr: { chunks: [], head: 0 } };
  private readonly retained: OutputCounters = { stdout: 0, stderr: 0 };
  private readonly total: OutputCounters = { stdout: 0, stderr: 0 };
  private readonly firstSeqOf: Record<OutputStream, number | null> = { stdout: null, stderr: null };
  private readonly lastSeqOf: Record<OutputStream, number> = { stdout: 0, stderr: 0 };
  private lastSeqValue = 0;

  constructor(options: RingOptions = {}) {
    this.capBytes = options.capBytes ?? DEFAULT_RING_BYTES;
    this.stderrReserveBytes = options.stderrReserveBytes ?? defaultStderrReserve(this.capBytes);
    this.maxChunks = options.maxChunks ?? MAX_RING_CHUNKS;
  }

  push(chunk: StoredChunk): void {
    const stream = chunk.stream;
    if (this.firstSeqOf[stream] === null) this.firstSeqOf[stream] = chunk.seq;
    this.lastSeqOf[stream] = chunk.seq; this.lastSeqValue = Math.max(this.lastSeqValue, chunk.seq);
    this.total[stream] = chunk.offset + chunk.data.length;
    this.queues[stream].chunks.push(chunk); this.retained[stream] += chunk.data.length;
    while (this.retained.stdout + this.retained.stderr > this.capBytes || this.counted("stdout") + this.counted("stderr") > this.maxChunks) {
      if (!this.evictOne()) break;
    }
  }

  /** Rebuild from disk. Sets firstSeq from the segment headers, then pushes the chunks in order. */
  hydrate(stored: StoredOutput): void {
    this.firstSeqOf.stdout = stored.firstSeq.stdout;
    this.firstSeqOf.stderr = stored.firstSeq.stderr;
    for (const chunk of stored.chunks) this.push(chunk);
  }

  read(query: OutputQuery): { chunks: OutputChunk[]; nextSince: number; hasMore: boolean } {
    const stream = query.stream ?? "both";
    if (stream !== "stdout" && stream !== "stderr" && stream !== "both") throw queryError("stream", 'stream must be "stdout", "stderr" or "both".');
    const since = query.since ?? 0;
    if (!Number.isInteger(since) || since < 0) throw queryError("since", "since must be a non-negative integer.");
    const tail = query.tail;
    if (tail !== undefined && (!Number.isInteger(tail) || tail < 1 || tail > 10_000)) throw queryError("tail", "tail must be an integer between 1 and 10000.");
    const limit = tail === undefined ? integerInRange(query.limit, "limit", 1, 1000, 200) : 0;
    const maxBytes = integerInRange(query.maxBytes, "maxBytes", 1, 4_194_304, 1_048_576);
    const encoding = query.encoding ?? "utf8";
    if (encoding !== "utf8" && encoding !== "base64") throw queryError("encoding", 'encoding must be "utf8" or "base64".');

    const selected = this.select(stream, since);
    let kept: StoredChunk[]; let hasMore = false;
    if (tail === undefined) {
      kept = selected.slice(0, limit);
      hasMore = kept.length < selected.length;
      const withinBudget: StoredChunk[] = []; let totalBytes = 0;
      for (const chunk of kept) {
        if (withinBudget.length > 0 && totalBytes + chunk.data.length > maxBytes) { hasMore = true; break; }
        withinBudget.push(chunk); totalBytes += chunk.data.length;
      }
      kept = withinBudget;
    } else {
      const cut = this.tailCut(selected, tail);
      kept = selected.slice(cut.index);
      if (cut.bytes > 0 && kept.length > 0) {
        const first = kept[0]!;
        kept = [{ seq: first.seq, stream: first.stream, timestampMs: first.timestampMs, offset: first.offset + cut.bytes, data: first.data.subarray(cut.bytes) }, ...kept.slice(1)];
      }
      let totalBytes = kept.reduce((sum, chunk) => sum + chunk.data.length, 0);
      while (kept.length > 0 && totalBytes > maxBytes) { totalBytes -= kept[0]!.data.length; kept = kept.slice(1); }
    }

    const oldest: Record<OutputStream, StoredChunk | undefined> = { stdout: this.oldest("stdout"), stderr: this.oldest("stderr") };
    const chunks: OutputChunk[] = kept.map((chunk) => {
      const info = chunk === oldest[chunk.stream] ? this.truncation(chunk.stream) : null;
      const truncated = info !== null && info.lastDroppedSeq > since;
      const out: OutputChunk = {
        seq: chunk.seq, stream: chunk.stream, timestamp: new Date(chunk.timestampMs).toISOString(), offset: chunk.offset,
        byteLength: chunk.data.length, encoding, data: encoding === "base64" ? chunk.data.toString("base64") : chunk.data.toString("utf8"), truncated,
      };
      if (truncated) out.firstDroppedSeq = info.firstDroppedSeq;
      return out;
    });
    return { chunks, nextSince: chunks.length > 0 ? chunks[chunks.length - 1]!.seq : since, hasMore };
  }

  truncation(stream: OutputStream): TruncationInfo | null {
    const firstDroppedSeq = this.firstSeqOf[stream];
    if (firstDroppedSeq === null) return null;
    const oldest = this.oldest(stream); const droppedBytes = oldest ? oldest.offset : this.total[stream];
    if (droppedBytes === 0) return null;
    return { firstDroppedSeq, lastDroppedSeq: oldest ? oldest.seq - 1 : this.lastSeqOf[stream], droppedBytes };
  }

  get retainedBytes(): OutputCounters { return { ...this.retained }; }
  get totalBytes(): OutputCounters { return { ...this.total }; }
  get lastSeq(): number { return this.lastSeqValue; }

  private counted(stream: OutputStream): number { return this.queues[stream].chunks.length - this.queues[stream].head; }
  private oldest(stream: OutputStream): StoredChunk | undefined { return this.queues[stream].chunks[this.queues[stream].head]; }

  private evictOne(): boolean {
    const stdout = this.oldest("stdout"), stderr = this.oldest("stderr");
    if (!stdout && !stderr) return false;
    let stream: OutputStream;
    if (!stdout) stream = "stderr"; else if (!stderr) stream = "stdout";
    else if (this.retained.stderr <= this.stderrReserveBytes) stream = "stdout";
    else stream = stdout.seq < stderr.seq ? "stdout" : "stderr";
    this.dropOldest(stream);
    return true;
  }

  private dropOldest(stream: OutputStream): void {
    const queue = this.queues[stream]; const chunk = queue.chunks[queue.head];
    if (chunk === undefined) return;
    queue.chunks[queue.head] = undefined; // release the evicted buffer now, not at compaction (landmine 3)
    queue.head += 1; this.retained[stream] -= chunk.data.length;
    if (queue.head > 1024 && queue.head * 2 >= queue.chunks.length) { queue.chunks = queue.chunks.slice(queue.head); queue.head = 0; }
  }

  private select(stream: OutputStream | "both", since: number): StoredChunk[] {
    const streams = stream === "both" ? STREAMS : [stream]; const selected: StoredChunk[] = [];
    for (const name of streams) {
      const queue = this.queues[name];
      for (let index = queue.head; index < queue.chunks.length; index += 1) {
        const chunk = queue.chunks[index];
        if (chunk !== undefined && chunk.seq > since) selected.push(chunk);
      }
    }
    if (streams.length > 1) selected.sort((a, b) => a.seq - b.seq);
    return selected;
  }

  /** Locate the start of the last `tail` lines in the seq-ordered bytes. */
  private tailCut(chunks: StoredChunk[], tail: number): TailCut {
    if (chunks.length === 0) return { index: 0, bytes: 0 };
    const lastData = chunks[chunks.length - 1]!.data;
    // A trailing newline terminates the last line instead of starting an empty one.
    let remaining = lastData.length > 0 && lastData[lastData.length - 1] === 10 ? tail + 1 : tail;
    for (let index = chunks.length - 1; index >= 0; index -= 1) {
      const data = chunks[index]!.data;
      for (let position = data.length - 1; position >= 0;) {
        const newline = data.lastIndexOf(10, position);
        if (newline < 0) break;
        remaining -= 1;
        if (remaining === 0) return newline + 1 === data.length ? { index: index + 1, bytes: 0 } : { index, bytes: newline + 1 };
        position = newline - 1;
      }
    }
    return { index: 0, bytes: 0 };
  }
}

export function truncationMarker(stream: OutputStream, t: TruncationInfo): string {
  return `[agtop: ${t.droppedBytes} bytes of ${stream} dropped (seq ${t.firstDroppedSeq}-${t.lastDroppedSeq})]\n`;
}

/** Renders chunks as text with truncation markers, for the CLI and MCP text format. */
export function renderOutputText(page: Pick<OutputPage, "chunks" | "truncation">): string {
  let text = "";
  for (const chunk of page.chunks) {
    if (chunk.truncated && page.truncation[chunk.stream]) text += truncationMarker(chunk.stream, page.truncation[chunk.stream]!);
    text += chunk.data;
  }
  return text;
}
