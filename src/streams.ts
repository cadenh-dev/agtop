// Pipe capture reader and capture provider seam (contracts 6.2). One reader per stream: the data
// handler is synchronous, never pauses and never awaits. Redaction runs first, then bytes are
// emitted in 4-64 KiB chunks on UTF-8 boundaries, plus an unconditional 100 ms tick.
import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import type { SecretRedactor } from "./redact.js";
import type { CaptureProvider, CaptureSession, OutputStream } from "./types.js";

export type { CaptureProvider, CaptureSession } from "./types.js";

export const MAX_CHUNK_BYTES = 65_536, MIN_CHUNK_BYTES = 4_096, FLUSH_TICK_MS = 100, MAX_HOLD_MS = 2_000, DRAIN_GRACE_MS = 2_000;

const EMPTY = Buffer.alloc(0);

/** Largest index <= limit at which bytes[0..index) ends on a UTF-8 boundary; at most 3 bytes are held. */
export function utf8Boundary(bytes: Buffer, limit: number = bytes.length): number {
  const end = Math.min(Math.max(limit, 0), bytes.length);
  for (let i = end - 1, seen = 0; i >= 0 && seen < 4; i--, seen++) {
    const c = bytes[i];
    if ((c & 0xc0) === 0x80) continue;
    const need = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1;
    return need > end - i ? i : end;
  }
  return end;
}

export interface PipeReaderOptions {
  stream: OutputStream;
  /** null when the job has redact: false. */
  redactor: SecretRedactor | null;
  onChunk(data: Buffer, timestampMs: number): void;
  now?: () => number;
}

export class PipeStreamReader {
  /** Resolves after the final chunk was delivered: on end/close/error of the source, or DRAIN_GRACE_MS after notifyExit(). */
  readonly done: Promise<void>;

  private readonly source: Readable;
  private readonly options: PipeReaderOptions;
  private readonly now: () => number;
  private resolveDone: () => void = () => {};
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private inBytes = 0;
  private outBytes = 0;
  private heldSince: number | null = null;
  private finished = false;
  private drainedFlag = true;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(source: Readable, options: PipeReaderOptions) {
    this.source = source;
    this.options = options;
    this.now = options.now ?? Date.now;
    this.done = new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });

    // Attach synchronously and immediately start flowing. Never pause.
    source.on("data", this.onData);
    source.once("end", this.onSourceEnd);
    source.once("close", this.onSourceEnd);
    source.once("error", this.onSourceEnd);

    this.tickTimer = setInterval(this.onTick, FLUSH_TICK_MS);
    this.tickTimer.unref();
  }

  /** The root process exited. Starts the drain grace timer. */
  notifyExit(): void {
    if (this.finished || this.graceTimer) return;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (this.finished) return;
      this.finish(false);
      this.source.destroy();
    }, DRAIN_GRACE_MS);
  }

  /** false if the grace timer ended the read while the pipe was still open. */
  get drained(): boolean {
    return this.drainedFlag;
  }

  get bytesIn(): number {
    return this.inBytes;
  }

  get bytesOut(): number {
    return this.outBytes;
  }

  private readonly onData = (data: Buffer): void => {
    if (this.finished) return;
    this.inBytes += data.length;
    this.feed(data, "data");
    if (this.pendingBytes >= MIN_CHUNK_BYTES) this.emit(false, false);
  };

  private readonly onSourceEnd = (): void => {
    this.finish(true);
  };

  private readonly onTick = (): void => {
    if (this.finished) return;
    const redactor = this.options.redactor;
    // An unterminated line (a prompt) would be held forever by the redactor;
    // release it through EOF once it has been held longer than MAX_HOLD_MS.
    const mode = redactor && this.heldSince !== null && this.now() - this.heldSince > MAX_HOLD_MS ? "eof" : "tick";
    this.feed(EMPTY, mode);
    this.emit(true, false);
  };

  private feed(bytes: Buffer, mode: "data" | "tick" | "eof"): void {
    const redactor = this.options.redactor;
    const safe = redactor ? redactor.push(bytes, mode) : bytes;
    if (safe.length > 0) {
      this.pending.push(safe);
      this.pendingBytes += safe.length;
    }
    if (redactor) {
      // The hold clock measures a stall: it restarts whenever the redactor releases bytes.
      // Under continuous output the carry is never empty, so restarting only on empty would
      // switch every tick to "eof" after MAX_HOLD_MS and release half-arrived secrets.
      if (redactor.heldBytes === 0) this.heldSince = null;
      else if (this.heldSince === null || safe.length > 0) this.heldSince = this.now();
    }
  }

  private emit(force: boolean, eof: boolean): void {
    let buffer = Buffer.concat(this.pending);
    this.pending = [];
    this.pendingBytes = 0;
    while (buffer.length > 0) {
      const cut = eof && buffer.length <= MAX_CHUNK_BYTES
        ? buffer.length
        : utf8Boundary(buffer, Math.min(buffer.length, MAX_CHUNK_BYTES));
      if (cut === 0) break;
      // A data-triggered emit keeps a short tail pending; a tick-triggered one sends it.
      if (!force && cut === buffer.length && cut < MIN_CHUNK_BYTES) break;
      // Own the memory: never hand out a slice of a pooled buffer.
      const piece = Buffer.allocUnsafeSlow(cut);
      buffer.copy(piece, 0, 0, cut);
      this.outBytes += cut;
      this.options.onChunk(piece, this.now());
      buffer = buffer.subarray(cut);
    }
    if (buffer.length > 0) {
      this.pending = [buffer];
      this.pendingBytes = buffer.length;
    }
  }

  private finish(drained: boolean): void {
    if (this.finished) return;
    this.finished = true;
    this.drainedFlag = drained;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    this.feed(EMPTY, "eof");
    // The final chunk may end mid code point: bytes are never transcoded.
    this.emit(true, true);
    this.resolveDone();
  }
}

class PosixCaptureSession implements CaptureSession {
  posixStdio(): ["ignore", "pipe", "pipe"] {
    return ["ignore", "pipe", "pipe"];
  }

  windowsHandles(): { stdin: unknown; stdout: unknown; stderr: unknown } {
    throw new Error("windowsHandles() is only available from the win32 capture provider");
  }

  attach(child?: ChildProcess): { stdout: Readable; stderr: Readable | null } {
    if (!child) throw new Error("attach() requires the spawned child process");
    if (!child.stdout || !child.stderr) {
      throw new Error("child process has no stdout/stderr pipes; spawn it with posixStdio()");
    }
    return { stdout: child.stdout, stderr: child.stderr };
  }

  releaseChildEnds(): void {} // Node closes the child-side ends itself.

  dispose(): void {} // Nothing to release: the pipes belong to the ChildProcess.
}

const posixCapture: CaptureProvider = {
  kind: "pipe",
  async open(_jobId: string): Promise<CaptureSession> {
    return new PosixCaptureSession();
  },
};

let windowsProvider: CaptureProvider | null = null;

async function openWindowsCapture(jobId: string): Promise<CaptureSession> {
  if (!windowsProvider) {
    // Built from a variable so type-checking does not require ./windows-pipes.js
    // (Unit 2.3) to exist before that unit lands.
    const specifier = "./windows-pipes.js";
    const module = (await import(specifier)) as { windowsPipeCaptureProvider?: () => CaptureProvider };
    const factory = module.windowsPipeCaptureProvider;
    if (typeof factory !== "function") {
      throw new Error("windows-pipes.js does not export windowsPipeCaptureProvider()");
    }
    windowsProvider = factory();
  }
  return windowsProvider.open(jobId);
}

const windowsCapture: CaptureProvider = { kind: "pipe", open: openWindowsCapture };

export function pipeCaptureProvider(platform: NodeJS.Platform = process.platform): CaptureProvider {
  return platform === "win32" ? windowsCapture : posixCapture;
}
