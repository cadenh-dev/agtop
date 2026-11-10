// THROWAWAY SPIKE (Fleet v0.2 Phase 0). Proves: non-blocking pipe capture -> boundary-safe redaction ->
// bounded ring -> framed JSONL spool -> HTTP tail -> crash recovery. Not production code; see docs/design/.
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";

export type Stream = "stdout" | "stderr";
export const CAP = 1 << 20, STDERR_RESERVE = 64 << 10, MAX_CHUNKS = 4096;
export const MAX_CHUNK = 64 << 10, MIN_CHUNK = 4 << 10, HOLDBACK = 1024, TICK_MS = 100;
const TERMINAL = new Set(["exited", "failed", "killed", "lost"]);

// ---- framing: "<len:8hex> <crc32:8hex> <json>\n" -------------------------------------------------------
const TABLE = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
export function crc32(b: Uint8Array): number { let c = ~0; for (let i = 0; i < b.length; i++) c = TABLE[(c ^ b[i]) & 255] ^ (c >>> 8); return ~c >>> 0; }
const hex = (n: number) => n.toString(16).padStart(8, "0");
export function frame(record: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(record));
  return Buffer.concat([Buffer.from(`${hex(json.length)} ${hex(crc32(json))} `), json, Buffer.from("\n")]);
}
/** Reads every valid record; the first invalid frame and everything after it is the corrupt tail. */
export function recover(file: string, repair: boolean): { records: any[]; corruptTailBytes: number } {
  let buf: Buffer;
  try { buf = fs.readFileSync(file); } catch { return { records: [], corruptTailBytes: 0 }; }
  const records: any[] = []; let off = 0;
  while (off + 18 <= buf.length) {
    const head = buf.toString("latin1", off, off + 18);
    if (!/^[0-9a-f]{8} [0-9a-f]{8} $/.test(head)) break;
    const end = off + 18 + parseInt(head.slice(0, 8), 16);
    if (end >= buf.length || buf[end] !== 10) break;
    const json = buf.subarray(off + 18, end);
    if (crc32(json) !== parseInt(head.slice(9, 17), 16)) break;
    try { records.push(JSON.parse(json.toString("utf8"))); } catch { break; }
    off = end + 1;
  }
  if (off < buf.length && repair) fs.truncateSync(file, off);
  return { records, corruptTailBytes: buf.length - off };
}

// ---- streaming redaction (latin1 view keeps arbitrary bytes intact) --------------------------------------
const RULES: Array<[string, RegExp]> = [
  ["openai-key", /sk-[A-Za-z0-9_-]{20,200}/g],
  ["github-token", /gh[pousr]_[A-Za-z0-9]{36,200}/g],
  ["env-secret", /([A-Z][A-Z0-9_]{0,60}(?:API_KEY|TOKEN|SECRET|PASSWORD)=)[^\s'"]{1,400}/g],
  ["auth-header", /(Authorization:[ \t]*)[^\r\n]{1,400}/gi],
];
export class Redactor {
  private carry = "";
  /** mode "data": hold back HOLDBACK bytes; "tick": release through the last newline; "eof": release all. */
  push(chunk: Buffer, mode: "data" | "tick" | "eof"): Buffer {
    const s = this.carry + chunk.toString("latin1");
    const spans: Array<[number, number, number, string]> = [];
    for (const [id, re] of RULES) {
      re.lastIndex = 0;
      for (let m: RegExpExecArray | null; (m = re.exec(s));) spans.push([m.index, m.index + (m[1]?.length ?? 0), m.index + m[0].length, id]);
    }
    spans.sort((a, b) => a[0] - b[0]);
    let cut = mode === "eof" ? s.length : Math.max(0, s.length - HOLDBACK);
    if (mode === "tick") cut = Math.max(cut, s.lastIndexOf("\n") + 1);
    for (const [start, , end] of spans) if (start < cut && end > cut) cut = end; // never cut inside a match
    let out = "", pos = 0;
    for (const [start, from, end, id] of spans) {
      if (start >= cut || end <= pos) continue;
      if (from < pos) { pos = end; continue; }
      out += s.slice(pos, from) + `[REDACTED:${id}]`; pos = end;
    }
    out += s.slice(pos, cut); this.carry = s.slice(cut);
    return Buffer.from(out, "latin1");
  }
}
/** Index at which to cut so the head ends on a UTF-8 code point boundary. */
export function utf8Cut(b: Buffer, limit = b.length): number {
  for (let i = limit - 1, n = 0; i >= 0 && n < 4; i--, n++) {
    const c = b[i];
    if ((c & 0xc0) === 0x80) continue;
    const need = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1;
    return need > limit - i ? i : limit;
  }
  return limit;
}

// ---- bounded ring --------------------------------------------------------------------------------------
export interface Chunk { seq: number; stream: Stream; ts: number; offset: number; data: Buffer }
export class Ring {
  private q: Record<Stream, Chunk[]> = { stdout: [], stderr: [] };
  private head: Record<Stream, number> = { stdout: 0, stderr: 0 };
  bytes: Record<Stream, number> = { stdout: 0, stderr: 0 };
  total: Record<Stream, number> = { stdout: 0, stderr: 0 };
  firstSeq: Record<Stream, number | null> = { stdout: null, stderr: null };
  lastSeq: Record<Stream, number> = { stdout: 0, stderr: 0 };
  private count(s: Stream) { return this.q[s].length - this.head[s]; }
  private oldest(s: Stream): Chunk | undefined { return this.q[s][this.head[s]]; }
  push(c: Chunk) {
    this.firstSeq[c.stream] ??= c.seq; this.lastSeq[c.stream] = c.seq;
    this.total[c.stream] = c.offset + c.data.length;
    this.q[c.stream].push(c); this.bytes[c.stream] += c.data.length;
    while (this.bytes.stdout + this.bytes.stderr > CAP || this.count("stdout") + this.count("stderr") > MAX_CHUNKS) this.evict();
  }
  private evict() {
    const o = this.oldest("stdout"), e = this.oldest("stderr");
    const s: Stream = !o ? "stderr" : !e ? "stdout" : this.bytes.stderr <= STDERR_RESERVE ? "stdout" : o.seq < e.seq ? "stdout" : "stderr";
    this.bytes[s] -= this.oldest(s)!.data.length;
    this.q[s][this.head[s]] = undefined as unknown as Chunk; // release the evicted buffer now, not at the next compaction
    if (++this.head[s] > 1024) { this.q[s] = this.q[s].slice(this.head[s]); this.head[s] = 0; }
  }
  truncation(s: Stream) {
    if (this.firstSeq[s] === null) return null;
    const o = this.oldest(s), droppedBytes = o ? o.offset : this.total[s];
    return droppedBytes === 0 ? null : { firstDroppedSeq: this.firstSeq[s]!, lastDroppedSeq: o ? o.seq - 1 : this.lastSeq[s], droppedBytes };
  }
  read(stream: Stream | "both", since: number, tail?: number) {
    const streams: Stream[] = stream === "both" ? ["stdout", "stderr"] : [stream];
    let chunks = streams.flatMap(s => this.q[s].slice(this.head[s])).filter(c => c.seq > since).sort((a, b) => a.seq - b.seq);
    const oldest = new Set(streams.map(s => this.oldest(s)));
    let trimmed: Chunk | undefined;
    if (tail !== undefined) {
      let lines = 0, i = chunks.length - 1, at = 0, found = false;
      for (; i >= 0 && !found; i--) {
        const d = chunks[i].data;
        for (let j = d.length - 1; j >= 0; j--) {
          if (d[j] !== 10 || (i === chunks.length - 1 && j === d.length - 1)) continue;
          if (++lines === tail) { at = j + 1; found = true; break; }
        }
        if (found) break;
      }
      if (found) {
        const c = chunks[i];
        trimmed = { ...c, offset: c.offset + at, data: c.data.subarray(at) };
        chunks = [trimmed, ...chunks.slice(i + 1)];
      }
    }
    return chunks.filter(c => c.data.length).map(c => {
      const t = c !== trimmed && oldest.has(c) ? this.truncation(c.stream) : null;
      return { seq: c.seq, stream: c.stream, timestamp: new Date(c.ts).toISOString(), offset: c.offset, encoding: "utf8" as const,
        data: c.data.toString("utf8"), byteLength: c.data.length, truncated: !!t && t.lastDroppedSeq > since,
        ...(t && t.lastDroppedSeq > since ? { firstDroppedSeq: t.firstDroppedSeq } : {}) };
    });
  }
}

// ---- capture provider seam (pipes now; a PTY provider slots in here in v0.3) ------------------------------
export interface Captured { pid: number; stdout: Readable; stderr: Readable; exited: Promise<number>; kill(): void }
export type CaptureProvider = (command: string, args: string[]) => Promise<Captured>;
export const nodePipes: CaptureProvider = async (command, args) => {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const exited = new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("exit", (code, sig) => resolve(code ?? (sig ? 137 : 1))); });
  if (child.pid === undefined) await exited;
  return { pid: child.pid!, stdout: child.stdout!, stderr: child.stderr!, exited, kill: () => { child.kill("SIGKILL"); } };
};

// ---- job: events.jsonl (fsync on state) + rotating output spool (no fsync) -------------------------------
export class Job {
  ring = new Ring(); seq = 0; state = "queued"; pid = 0; exitCode: number | null = null; corruptTailBytes = 0;
  private events = -1; private spool = -1; private spoolRaw = 0; private kill?: () => void; private killed = false;
  constructor(readonly id: string, readonly dir: string) { fs.mkdirSync(dir, { recursive: true }); }
  private file(name: string) { return path.join(this.dir, name); }
  private event(record: Record<string, unknown>, sync: boolean) {
    if (this.events < 0) this.events = fs.openSync(this.file("events.jsonl"), "a");
    fs.writeSync(this.events, frame({ seq: ++this.seq, timestamp: new Date().toISOString(), jobId: this.id, ...record }));
    if (sync) fs.fsyncSync(this.events);
  }
  private setState(state: string, extra: Record<string, unknown> = {}) { this.state = state; this.event({ type: "state", state, ...extra }, true); }
  private openSpool() {
    this.spool = fs.openSync(this.file("output.jsonl"), "a"); this.spoolRaw = 0;
    fs.writeSync(this.spool, frame({ type: "segment", firstSeq: this.ring.firstSeq }));
  }
  private append(c: Chunk) {
    if (this.spool < 0) this.openSpool();
    if (this.spoolRaw >= CAP) { // rotate: disk always holds between CAP and 2*CAP of the newest output
      fs.closeSync(this.spool); fs.rmSync(this.file("output.prev.jsonl"), { force: true });
      fs.renameSync(this.file("output.jsonl"), this.file("output.prev.jsonl")); this.openSpool();
    }
    fs.writeSync(this.spool, frame({ type: c.stream, seq: c.seq, ts: c.ts, offset: c.offset, data: c.data.toString("base64") }));
    this.spoolRaw += c.data.length; this.ring.push(c);
  }
  async run(provider: CaptureProvider, command: string, args: string[]) {
    this.setState("starting");
    let proc: Captured;
    try { proc = await provider(command, args); } catch (e) { this.setState("failed", { reason: String(e) }); return; }
    this.pid = proc.pid; this.kill = proc.kill;
    this.event({ type: "spawn", pid: proc.pid, command, args }, false); this.setState("running");
    const drained = (["stdout", "stderr"] as const).map(stream => new Promise<void>(resolve => {
      const redactor = new Redactor(); let pending: Buffer[] = [], size = 0, offset = 0, done = false;
      const emit = (eof: boolean, force = eof) => {
        let buf = Buffer.concat(pending); pending = []; size = 0;
        while (buf.length) {
          const cut = eof && buf.length <= MAX_CHUNK ? buf.length : utf8Cut(buf, Math.min(buf.length, MAX_CHUNK));
          if (cut === 0 || (!force && cut === buf.length && cut < MIN_CHUNK)) break;
          this.append({ seq: ++this.seq, stream, ts: Date.now(), offset, data: buf.subarray(0, cut) });
          offset += cut; buf = buf.subarray(cut);
        }
        if (buf.length) { pending = [buf]; size = buf.length; }
      };
      const feed = (data: Buffer, mode: "data" | "tick" | "eof") => { const out = redactor.push(data, mode); if (out.length) { pending.push(out); size += out.length; } };
      // Latency bound: every TICK_MS release through the last newline, even while data keeps flowing.
      const timer = setInterval(() => { feed(Buffer.alloc(0), "tick"); emit(false, true); }, TICK_MS);
      const finish = () => { if (done) return; done = true; clearInterval(timer); feed(Buffer.alloc(0), "eof"); emit(true); resolve(); };
      const source = proc[stream];
      // The handler never awaits and never pauses the stream: the child can only block if this event loop stalls.
      source.on("data", (data: Buffer) => { feed(data, "data"); if (size >= MIN_CHUNK) emit(false); });
      source.once("end", finish); source.once("close", finish); source.once("error", finish);
      // A grandchild holding the pipe open must not delay exit forever: drain for a bounded grace period.
      void proc.exited.then(() => setTimeout(() => { finish(); source.destroy(); }, 2000).unref(), finish);
    }));
    const code = await proc.exited.catch(() => 1);
    await Promise.all(drained);
    this.exitCode = code; this.event({ type: "exit", exitCode: code }, false);
    this.setState(this.killed ? "killed" : "exited", { exitCode: code });
  }
  terminate() { if (!TERMINAL.has(this.state)) { this.killed = true; this.kill?.(); } }
  /** Rebuild from disk after a daemon crash. */
  static recover(id: string, dir: string): Job {
    const job = new Job(id, dir);
    const events = recover(job.file("events.jsonl"), true); job.corruptTailBytes += events.corruptTailBytes;
    for (const e of events.records) {
      job.seq = Math.max(job.seq, e.seq);
      if (e.type === "state") job.state = e.state;
      if (e.type === "spawn") job.pid = e.pid;
      if (e.type === "exit") job.exitCode = e.exitCode;
    }
    for (const name of ["output.prev.jsonl", "output.jsonl"]) {
      const out = recover(job.file(name), true); job.corruptTailBytes += out.corruptTailBytes;
      for (const r of out.records) {
        if (r.type === "segment") { for (const s of ["stdout", "stderr"] as const) job.ring.firstSeq[s] ??= r.firstSeq[s]; continue; }
        job.seq = Math.max(job.seq, r.seq);
        job.ring.push({ seq: r.seq, stream: r.type, ts: r.ts, offset: r.offset, data: Buffer.from(r.data, "base64") });
      }
    }
    if (!TERMINAL.has(job.state)) {
      let alive = false;
      try { if (job.pid) { process.kill(job.pid, 0); alive = true; } } catch { /* gone */ }
      if (alive) try { process.kill(job.pid, "SIGKILL"); } catch { /* raced */ }
      job.setState("lost", { reason: "supervisor-crash", previousState: job.state, rootWasAlive: alive });
    }
    return job;
  }
}

// ---- daemon ----------------------------------------------------------------------------------------------
export async function startSpikeDaemon(dataDir: string, provider: CaptureProvider, port = 0) {
  const jobs = new Map<string, Job>(), started = performance.now();
  const root = path.join(dataDir, "jobs"); fs.mkdirSync(root, { recursive: true });
  for (const id of fs.readdirSync(root)) jobs.set(id, Job.recover(id, path.join(root, id)));
  const recoveryMs = performance.now() - started;
  const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  const summary = (j: Job) => ({ jobId: j.id, state: j.state, pid: j.pid, exitCode: j.exitCode, lastSeq: j.seq, corruptTailBytes: j.corruptTailBytes,
    outputBytes: j.ring.total, retainedBytes: j.ring.bytes, truncation: { stdout: j.ring.truncation("stdout"), stderr: j.ring.truncation("stderr") } });
  const server = Bun.serve({ port, hostname: "127.0.0.1", async fetch(req) {
    const url = new URL(req.url), parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/v1/stats") { if (url.searchParams.has("gc")) Bun.gc(true); return json(200, { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed, jobs: jobs.size, recoveryMs }); }
    if (req.method === "POST" && url.pathname === "/v1/jobs") {
      const body = await req.json() as { command: string; args: string[]; jobId?: string };
      const id = body.jobId ?? randomUUID(), job = new Job(id, path.join(root, id));
      jobs.set(id, job); void job.run(provider, body.command, body.args);
      return json(202, summary(job));
    }
    const job = parts[0] === "v1" && parts[1] === "jobs" ? jobs.get(parts[2]) : undefined;
    if (!job) return json(404, { error: "Job not found.", code: "E_JOB_NOT_FOUND" });
    if (req.method === "POST" && parts[3] === "kill") { job.terminate(); return json(200, summary(job)); }
    if (req.method === "GET" && parts.length === 3) return json(200, summary(job));
    if (req.method === "GET" && parts[3] === "output") {
      const stream = (url.searchParams.get("stream") ?? "both") as Stream | "both", since = Number(url.searchParams.get("since") ?? 0);
      const tail = url.searchParams.has("tail") ? Number(url.searchParams.get("tail")) : undefined;
      const chunks = job.ring.read(stream, since, tail);
      return json(200, { ...summary(job), stream, since, nextSince: chunks.at(-1)?.seq ?? since, chunks });
    }
    return json(404, { error: "Route not found.", code: "E_ROUTE_NOT_FOUND" });
  } });
  return { port: server.port, jobs, stop: () => server.stop(true) };
}

if (import.meta.main) {
  const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1];
  const provider = process.env.SPIKE_PROVIDER === "winjob" ? (await import("./win-job.ts")).winJobPipes : nodePipes;
  const daemon = await startSpikeDaemon(arg("--data"), provider);
  console.log(JSON.stringify({ port: daemon.port, pid: process.pid }));
}
