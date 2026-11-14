import * as fs from "node:fs";
import * as path from "node:path";
import { stateDir, validateJobId } from "./registry.js";
import { FleetError } from "./fleet-errors.js";
import { isLegalTransition, isTerminal } from "./job-state.js";
import type { EventsPage, EventsQuery, ExitEvent, JobEvent, JobEventBase, JobEventType, JobRecordPatch, JobRecordV2, JobState, JobStateReason, LeaseEvent, OutputCounters, OutputStream, PolicyEvent, SpawnEvent, StateEvent } from "./types.js";
export const FRAME_HEADER_BYTES = 18;
export const DEFAULT_SPOOL_MAX_BYTES = 268_435_456;
const MAX_CHUNK_BYTES = 65_536;
const JOB_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const DEFAULT_EVENT_TYPES: readonly JobEventType[] = ["state", "spawn", "exit", "lease", "policy"];
const FRAME_HEADER_RE = /^[0-9a-f]{8} [0-9a-f]{8} $/;
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
})();
/** CRC-32/IEEE 802.3 (the zlib/PNG variant), computed locally (contracts 1.1). */
export function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
const hex8 = (value: number): string => (value >>> 0).toString(16).padStart(8, "0");
/** One framed record: "<len> <crc> " + JSON + "\n" (contracts 1.1). */
export function encodeFrame(record: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(record), "utf8");
  return Buffer.concat([Buffer.from(`${hex8(json.length)} ${hex8(crc32(json))} `, "latin1"), json, Buffer.from("\n")]);
}
export interface DecodeResult<T> { records: T[]; validBytes: number; corruptTailBytes: number }
/** Reads valid frames from the front; the first failure marks the start of the corrupt tail. */
export function decodeFrames<T = unknown>(buffer: Buffer): DecodeResult<T> {
  const records: T[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (buffer.length - offset < FRAME_HEADER_BYTES) break;
    const header = buffer.toString("latin1", offset, offset + FRAME_HEADER_BYTES); if (!FRAME_HEADER_RE.test(header)) break;
    const length = parseInt(header.slice(0, 8), 16), expectedCrc = parseInt(header.slice(9, 17), 16), jsonStart = offset + FRAME_HEADER_BYTES, jsonEnd = jsonStart + length;
    if (jsonEnd >= buffer.length || buffer[jsonEnd] !== 0x0a) break;
    const json = buffer.subarray(jsonStart, jsonEnd);
    if (crc32(json) !== expectedCrc) break;
    let parsed: T; try { parsed = JSON.parse(json.toString("utf8")) as T; } catch { break; }
    records.push(parsed); offset = jsonEnd + 1;
  }
  return { records, validBytes: offset, corruptTailBytes: buffer.length - offset };
}
export function fleetDir(): string { return path.join(stateDir(), "fleet"); }
export function jobDir(jobId: string): string { validateJobId(jobId); return path.join(fleetDir(), "jobs", jobId); }
export interface StoredChunk { seq: number; stream: OutputStream; timestampMs: number; offset: number; data: Buffer }
export interface SpoolSegmentHeader { type: "segment"; jobId: string; createdAt: string; firstSeq: { stdout: number | null; stderr: number | null } }
export interface StoredOutput { chunks: StoredChunk[]; firstSeq: { stdout: number | null; stderr: number | null }; corruptTailBytes: number }
interface WriterOptions {
  now: () => Date; record?: JobRecordV2; state?: JobState | null; seq?: number; firstSeq?: { stdout: number | null; stderr: number | null };
  offsets?: OutputCounters; outputBytes?: OutputCounters; spoolRaw?: number; needsHeader?: boolean;
}
const emptyCounters = (): OutputCounters => ({ stdout: 0, stderr: 0 });
/** The single writer of one job's event log and output segments (contracts 2.3, 4). */
export class JobEventWriter {
  readonly jobId: string; private readonly dir: string; private readonly now: () => Date; private readonly initialRecord?: JobRecordV2;
  private readonly ringBytes: number; private readonly spoolMaxBytes: number; private stateValue: JobState | null; private seqValue: number;
  private readonly counters: OutputCounters; private readonly offsets: OutputCounters; private readonly firstSeqs: { stdout: number | null; stderr: number | null };
  private eventsFd = -1; private spoolFd = -1; private spoolRaw: number; private spoolMode: "tail" | "full" | "off";
  private needsHeader: boolean; private spoolDisabledMessage?: string; private closed = false;
  constructor(jobId: string, dir: string, options: WriterOptions) {
    this.jobId = jobId; this.dir = dir; this.now = options.now; this.initialRecord = options.record;
    this.stateValue = options.state ?? null; this.seqValue = options.seq ?? 0;
    this.counters = { ...(options.outputBytes ?? emptyCounters()) }; this.offsets = { ...(options.offsets ?? emptyCounters()) };
    this.firstSeqs = { ...(options.firstSeq ?? { stdout: null, stderr: null }) }; this.spoolRaw = options.spoolRaw ?? 0; this.needsHeader = options.needsHeader ?? true;
    const capture = options.record?.capture;
    this.spoolMode = capture?.spool ?? "off"; this.ringBytes = capture?.ringBytes ?? 0; this.spoolMaxBytes = capture?.spoolMaxBytes ?? DEFAULT_SPOOL_MAX_BYTES;
  }
  get lastSeq(): number { return this.seqValue; } get outputBytes(): OutputCounters { return { ...this.counters }; }
  /** Appends and fsyncs. Fills patch.lastSeq and patch.outputBytes with the values that include this event. */
  appendState(state: JobState, reason: JobStateReason, patch?: JobRecordPatch, detail?: string): StateEvent {
    if (!isLegalTransition(this.stateValue, state)) throw new Error(`Illegal job transition ${this.stateValue} -> ${state}`);
    const seq = this.seqValue + 1;
    let finalDetail = detail;
    if (this.spoolDisabledMessage !== undefined) {
      const message = `spool disabled: ${this.spoolDisabledMessage}`;
      finalDetail = finalDetail === undefined || finalDetail === "" ? message : `${finalDetail}; ${message}`;
      this.spoolDisabledMessage = undefined; this.spoolMode = "off";
    }
    if (patch !== undefined) { patch.lastSeq = seq; patch.outputBytes = { ...this.counters }; }
    const event: StateEvent = { seq, timestamp: this.now().toISOString(), jobId: this.jobId, type: "state", state, previous: this.stateValue, reason };
    if (seq === 1 && this.initialRecord !== undefined) event.record = this.initialRecord;
    if (patch !== undefined) event.patch = patch;
    if (finalDetail !== undefined) event.detail = finalDetail;
    this.writeLifecycle(event); fs.fsyncSync(this.eventsFd); this.seqValue = seq; this.stateValue = state; return event;
  }
  appendSpawn(fields: Omit<SpawnEvent, keyof JobEventBase | "type">): SpawnEvent {
    return this.appendLifecycle((seq, timestamp) => ({ seq, timestamp, jobId: this.jobId, type: "spawn", ...fields })); }
  appendExit(fields: Omit<ExitEvent, keyof JobEventBase | "type">): ExitEvent {
    return this.appendLifecycle((seq, timestamp) => ({ seq, timestamp, jobId: this.jobId, type: "exit", ...fields })); }
  appendLease(fields: Omit<LeaseEvent, keyof JobEventBase | "type">): LeaseEvent {
    return this.appendLifecycle((seq, timestamp) => ({ seq, timestamp, jobId: this.jobId, type: "lease", ...fields })); }
  appendPolicy(fields: Omit<PolicyEvent, keyof JobEventBase | "type">): PolicyEvent {
    return this.appendLifecycle((seq, timestamp) => ({ seq, timestamp, jobId: this.jobId, type: "policy", ...fields })); }
  /** Assigns seq and offset, writes one OutputEvent without fsync, rotates when needed. data.length must be 1..65536. */
  appendOutput(stream: OutputStream, data: Buffer, timestampMs: number): StoredChunk {
    if (data.length < 1 || data.length > MAX_CHUNK_BYTES) throw new Error(`Output chunk must be 1..${MAX_CHUNK_BYTES} bytes.`);
    const seq = this.seqValue + 1, offset = this.offsets[stream], chunk: StoredChunk = { seq, stream, timestampMs, offset, data };
    this.seqValue = seq; this.offsets[stream] = offset + data.length; this.counters[stream] += data.length;
    if (this.firstSeqs[stream] === null) this.firstSeqs[stream] = seq;
    if (this.spoolMode !== "off" && !this.closed) { try { this.writeOutput(chunk); } catch (error) { this.disableSpooling(error); } }
    return chunk;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.eventsFd >= 0) { try { fs.closeSync(this.eventsFd); } catch { /* already closed */ } this.eventsFd = -1; }
    if (this.spoolFd >= 0) { try { fs.closeSync(this.spoolFd); } catch { /* already closed */ } this.spoolFd = -1; }
  }
  private appendLifecycle<T extends JobEvent>(build: (seq: number, timestamp: string) => T): T {
    const seq = this.seqValue + 1, event = build(seq, this.now().toISOString());
    this.writeLifecycle(event); this.seqValue = seq; return event;
  }
  private writeLifecycle(event: JobEvent): void {
    if (this.eventsFd < 0) this.eventsFd = fs.openSync(path.join(this.dir, "events.jsonl"), "a", 0o600);
    fs.writeSync(this.eventsFd, encodeFrame(event));
  }
  private writeOutput(chunk: StoredChunk): void {
    if (this.spoolMode === "full" && this.spoolRaw >= this.spoolMaxBytes) this.spoolMode = "tail";
    if (this.spoolMode === "tail" && this.spoolFd >= 0 && this.spoolRaw >= this.ringBytes) this.rotate();
    if (this.spoolFd < 0) this.openSegment();
    const event = { seq: chunk.seq, timestamp: new Date(chunk.timestampMs).toISOString(), jobId: this.jobId, type: chunk.stream,
      offset: chunk.offset, byteLength: chunk.data.length, encoding: "base64", data: chunk.data.toString("base64") };
    fs.writeSync(this.spoolFd, encodeFrame(event)); this.spoolRaw += chunk.data.length;
  }
  private rotate(): void {
    // Windows cannot rename an open file; close before renaming on every platform.
    const current = path.join(this.dir, "output.jsonl"), previous = path.join(this.dir, "output.prev.jsonl");
    if (this.spoolFd >= 0) { fs.closeSync(this.spoolFd); this.spoolFd = -1; }
    fs.rmSync(previous, { force: true }); fs.renameSync(current, previous);
    this.spoolRaw = 0; this.needsHeader = true; this.openSegment();
  }
  private openSegment(): void {
    this.spoolFd = fs.openSync(path.join(this.dir, "output.jsonl"), "a", 0o600);
    if (!this.needsHeader) return;
    const header: SpoolSegmentHeader = { type: "segment", jobId: this.jobId, createdAt: this.now().toISOString(), firstSeq: { ...this.firstSeqs } }; fs.writeSync(this.spoolFd, encodeFrame(header)); this.needsHeader = false;
  }
  private disableSpooling(error: unknown): void {
    if (this.spoolDisabledMessage === undefined) this.spoolDisabledMessage = error instanceof Error ? error.message : String(error);
    this.spoolMode = "off"; if (this.spoolFd >= 0) { try { fs.closeSync(this.spoolFd); } catch { /* already closed */ } this.spoolFd = -1; }
  }
}
interface SegmentRead { chunks: StoredChunk[]; firstSeq: { stdout: number | null; stderr: number | null }; corruptTailBytes: number }
export class EventStore {
  private readonly root?: string; private readonly now: () => Date;
  constructor(options?: { root?: string; now?: () => Date }) { this.root = options?.root; this.now = options?.now ?? (() => new Date()); }
  /** State directory used by this store, including a caller supplied root. */
  get stateRoot(): string { return this.root ?? stateDir(); }
  /** Creates the job directory and writes seq 1; throws E_JOB_EXISTS for a non-terminal job, replaces a terminal one. */
  create(record: JobRecordV2): JobEventWriter {
    validateJobId(record.jobId);
    const dir = this.jobPath(record.jobId);
    if (fs.existsSync(dir)) {
      const state = lastState(this.readAllEvents(record.jobId).events);
      if (state === null || !isTerminal(state)) throw new FleetError("E_JOB_EXISTS", `Job ${record.jobId} already exists.`);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const writer = new JobEventWriter(record.jobId, dir, { now: this.now, record, needsHeader: true });
    try { writer.appendState("queued", "submitted"); } catch (error) { writer.close(); throw error; }
    return writer;
  }
  /** For the reconciler only: append to a job whose supervisor is proven dead. */
  reopen(jobId: string): JobEventWriter {
    const dir = this.jobPath(jobId), events = this.readAllEvents(jobId);
    let state: JobState | null = null, record: JobRecordV2 | undefined, seq = 0;
    for (const event of events.events) {
      seq = Math.max(seq, event.seq);
      if (event.type !== "state") continue;
      state = event.state;
      if (event.record !== undefined) record = event.record;
      if (record !== undefined && event.patch !== undefined) Object.assign(record, event.patch);
    }
    const stored = this.readOutput(jobId), offsets = emptyCounters();
    for (const chunk of stored.chunks) { seq = Math.max(seq, chunk.seq); offsets[chunk.stream] = Math.max(offsets[chunk.stream], chunk.offset + chunk.data.length); }
    const current = this.readSegment(jobId, "output.jsonl");
    let spoolRaw = 0; for (const chunk of current.chunks) spoolRaw += chunk.data.length;
    const outputBytes: OutputCounters = { stdout: Math.max(record?.outputBytes.stdout ?? 0, offsets.stdout), stderr: Math.max(record?.outputBytes.stderr ?? 0, offsets.stderr) };
    return new JobEventWriter(jobId, dir, { now: this.now, record, state, seq, firstSeq: stored.firstSeq, offsets, outputBytes, spoolRaw,
      needsHeader: current.chunks.length === 0 && current.firstSeq.stdout === null && current.firstSeq.stderr === null });
  }
  listJobIds(): string[] {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(this.jobsRoot(), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return entries.filter((entry) => entry.isDirectory() && JOB_ID_RE.test(entry.name)).map((entry) => entry.name).sort();
  }
  readAllEvents(jobId: string): { events: JobEvent[]; corruptTailBytes: number } {
    const buffer = this.readFile(path.join(this.jobPath(jobId), "events.jsonl"));
    if (buffer === undefined) return { events: [], corruptTailBytes: 0 };
    const decoded = decodeFrames<JobEvent>(buffer);
    return { events: decoded.records.filter((event) => typeof event === "object" && event !== null), corruptTailBytes: decoded.corruptTailBytes };
  }
  readEvents(jobId: string, query?: EventsQuery): EventsPage {
    const since = query?.since ?? 0, limit = Math.min(1000, Math.max(1, Math.floor(query?.limit ?? 200)));
    const wanted = new Set<JobEventType>(query?.types ?? DEFAULT_EVENT_TYPES), all = this.readAllEvents(jobId), stored = this.readOutput(jobId);
    let lastSeq = 0;
    for (const event of all.events) lastSeq = Math.max(lastSeq, event.seq);
    for (const chunk of stored.chunks) lastSeq = Math.max(lastSeq, chunk.seq);
    const merged: JobEvent[] = all.events.filter((event) => wanted.has(event.type));
    if (wanted.has("stdout") || wanted.has("stderr")) for (const chunk of stored.chunks) {
      if (!wanted.has(chunk.stream)) continue;
      merged.push({ seq: chunk.seq, timestamp: new Date(chunk.timestampMs).toISOString(), jobId, type: chunk.stream,
        offset: chunk.offset, byteLength: chunk.data.length, encoding: "base64", data: chunk.data.toString("base64") });
    }
    merged.sort((a, b) => a.seq - b.seq);
    const selected = merged.filter((event) => event.seq > since), events = selected.slice(0, limit);
    return { jobId, since, nextSince: events.length > 0 ? events[events.length - 1].seq : since, lastSeq, hasMore: selected.length > limit, events };
  }
  readOutput(jobId: string): StoredOutput {
    const previous = this.readSegment(jobId, "output.prev.jsonl"), current = this.readSegment(jobId, "output.jsonl");
    return { chunks: [...previous.chunks, ...current.chunks],
      firstSeq: { stdout: previous.firstSeq.stdout ?? current.firstSeq.stdout, stderr: previous.firstSeq.stderr ?? current.firstSeq.stderr },
      corruptTailBytes: previous.corruptTailBytes + current.corruptTailBytes };
  }
  /** Truncates corrupt tails of all three files. Caller must hold the fleet lock and have proven the supervisor dead. */
  repair(jobId: string): { corruptTailBytes: number } {
    const dir = this.jobPath(jobId);
    let corruptTailBytes = 0;
    for (const name of ["events.jsonl", "output.prev.jsonl", "output.jsonl"]) {
      const file = path.join(dir, name), buffer = this.readFile(file);
      if (buffer === undefined) continue;
      const decoded = decodeFrames(buffer);
      if (decoded.corruptTailBytes > 0) { fs.truncateSync(file, decoded.validBytes); corruptTailBytes += decoded.corruptTailBytes; }
    }
    return { corruptTailBytes };
  }
  remove(jobId: string): void { fs.rmSync(this.jobPath(jobId), { recursive: true, force: true }); }
  private fleetRoot(): string { return this.root === undefined ? fleetDir() : path.join(this.root, "fleet"); }
  private jobsRoot(): string { return path.join(this.fleetRoot(), "jobs"); }
  private jobPath(jobId: string): string { validateJobId(jobId); return path.join(this.jobsRoot(), jobId); }
  private readFile(file: string): Buffer | undefined {
    try { return fs.readFileSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  private readSegment(jobId: string, name: string): SegmentRead {
    const result: SegmentRead = { chunks: [], firstSeq: { stdout: null, stderr: null }, corruptTailBytes: 0 };
    const buffer = this.readFile(path.join(this.jobPath(jobId), name)); if (buffer === undefined) return result;
    const decoded = decodeFrames<Record<string, unknown>>(buffer); result.corruptTailBytes = decoded.corruptTailBytes;
    for (const record of decoded.records) {
      if (record === null || typeof record !== "object") continue;
      if (record.type === "segment") {
        const first = record.firstSeq as { stdout?: unknown; stderr?: unknown } | undefined;
        if (first !== undefined && first !== null) {
          if (result.firstSeq.stdout === null && typeof first.stdout === "number") result.firstSeq.stdout = first.stdout;
          if (result.firstSeq.stderr === null && typeof first.stderr === "number") result.firstSeq.stderr = first.stderr;
        }
        continue;
      }
      if ((record.type !== "stdout" && record.type !== "stderr") || typeof record.seq !== "number" || typeof record.offset !== "number" || typeof record.data !== "string") continue;
      const stream = record.type, data = Buffer.from(record.data, "base64");
      const parsedTime = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
      result.chunks.push({ seq: record.seq, stream, timestampMs: Number.isFinite(parsedTime) ? parsedTime : 0, offset: record.offset, data });
      if (result.firstSeq[stream] === null) result.firstSeq[stream] = record.seq;
    }
    return result;
  }
}
function lastState(events: JobEvent[]): JobState | null {
  let state: JobState | null = null; for (const event of events) if (event.type === "state") state = event.state; return state;
}
