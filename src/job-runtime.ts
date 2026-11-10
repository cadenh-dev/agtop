// One supervisor's jobs: transition ordering, reader wiring, and kill markers (contracts 7.2, 8.6;
// fleet-v0.2.md section 3). Every state event is fsynced by JobEventWriter before its side effect.
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { OutputRingBuffer } from "./capture.js";
import { darwinIdentity } from "./darwin.js";
import { parseLinuxStat } from "./discovery.js";
import { jobDir, type EventStore, type JobEventWriter } from "./event-store.js";
import { isTerminal } from "./job-state.js";
import type { JobIndex } from "./job-index.js";
import { spawnContainedAgent } from "./manager.js";
import { SecretRedactor } from "./redact.js";
import { writePrivateFileAtomic } from "./secure-fs.js";
import { PipeStreamReader, pipeCaptureProvider } from "./streams.js";
import { windowsApi } from "./windows.js";
import type {
  CaptureProvider, CaptureSession, FleetSurface, JobContainment, JobEvent, JobEventBase, JobRecordPatch, JobRecordV2,
  KillResult, LeaseEvent, ManagedAgent, PolicyEvent, StateEvent, SupervisorIdentity,
} from "./types.js";

export interface SessionIdentity { sessionId: string; ownerToken: string; tokenHash: string }

const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;
const KILL_REASONS: ReadonlySet<KillRequest["reason"]> = new Set(["kill-requested", "cleanup", "cancelled"]);

/** Session identity from the environment, with a random fallback for each invalid part (contracts 7.2). */
export function newSessionIdentity(env: NodeJS.ProcessEnv = process.env): SessionIdentity {
  const sessionId = env.AGTOP_SESSION_ID !== undefined && SESSION_ID_RE.test(env.AGTOP_SESSION_ID) ? env.AGTOP_SESSION_ID : randomUUID();
  const ownerToken = env.AGTOP_OWNER_TOKEN !== undefined && env.AGTOP_OWNER_TOKEN.length >= 32 ? env.AGTOP_OWNER_TOKEN : randomBytes(32).toString("hex");
  return { sessionId, ownerToken, tokenHash: createHash("sha256").update(ownerToken).digest("hex") };
}

let selfStartTime: string | undefined;
/** This process's creation time in the v1/processSnapshot format, computed once. */
function ownStartTime(): string {
  if (selfStartTime !== undefined) return selfStartTime;
  try {
    if (process.platform === "win32") {
      const api = windowsApi();
      const handle = api.k.load("kernel32.dll").func("void * __stdcall GetCurrentProcess()")();
      selfStartTime = api.identity(handle);
    } else if (process.platform === "linux") {
      selfStartTime = parseLinuxStat(fs.readFileSync(`/proc/${process.pid}/stat`, "utf8"), 1, 1).startTime;
    } else {
      selfStartTime = darwinIdentity(process.pid) ?? "";
    }
  } catch { selfStartTime = ""; }
  return selfStartTime;
}

export function selfSupervisor(surface: FleetSurface): SupervisorIdentity {
  return { pid: process.pid, startTime: ownStartTime(), surface };
}

export interface KillRequest { by: string; reason: "kill-requested" | "cleanup" | "cancelled"; at: string; detail?: string }

/** <jobDir>/kill.request, written atomically (contracts 8.6). */
export function writeKillRequest(jobId: string, request: KillRequest): void {
  writePrivateFileAtomic(path.join(jobDir(jobId), "kill.request"), JSON.stringify(request));
}

/** The marker, or undefined when absent or unparseable. */
export function readKillRequest(jobId: string): KillRequest | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(jobDir(jobId), "kill.request"), "utf8")) as Partial<KillRequest>;
    if (typeof value.by !== "string" || typeof value.at !== "string" || !KILL_REASONS.has(value.reason as KillRequest["reason"])) return undefined;
    if (value.detail !== undefined && typeof value.detail !== "string") return undefined;
    const request: KillRequest = { by: value.by, reason: value.reason as KillRequest["reason"], at: value.at };
    if (value.detail !== undefined) request.detail = value.detail;
    return request;
  } catch { return undefined; }
}

export interface RuntimeDeps {
  store: EventStore; index: JobIndex;
  spawn?: typeof spawnContainedAgent; capture?: CaptureProvider; now?: () => number;
  hooks?: {
    /** Called after the exit event and before the terminal state event (the scheduler releases leases here). */
    beforeTerminal?(jobId: string): void;
    /** Called after the terminal state event is durable (the scheduler triggers a tick here). */
    afterTerminal?(record: JobRecordV2): void;
  };
}

type KillReason = "kill-requested" | "timeout" | "cleanup" | "supervisor-shutdown" | "cancelled";
type EnqueueEnv = { extraEnv?: Record<string, string>; useLemonadeLocal?: boolean; lemonadeUrl?: string; cgroupRoot?: string };
interface JobRun {
  jobId: string; record: JobRecordV2; writer: JobEventWriter; env: EnqueueEnv;
  agent?: ManagedAgent; readers: PipeStreamReader[]; ring?: OutputRingBuffer;
  timeout?: ReturnType<typeof setTimeout>; startPromise?: Promise<JobRecordV2>; killPromise?: Promise<KillResult | null>;
  killReason?: KillReason; killDetail?: string;
  exit?: Promise<void>; exitSettled: boolean; exitCode: number | null; startedAtMs: number;
  containmentErrors: string[]; finalizePromise?: Promise<JobRecordV2>; finalized: boolean;
  waiters: Array<(record: JobRecordV2) => void>;
}

/** One supervisor's jobs (contracts 7.2). It never touches leases; the scheduler owns them. */
export class JobRuntime {
  private readonly deps: RuntimeDeps;
  private readonly runs = new Map<string, JobRun>();
  private readonly spawnAgent: typeof spawnContainedAgent;
  private readonly capture: CaptureProvider;
  private readonly now: () => number;

  constructor(deps: RuntimeDeps) {
    this.deps = deps;
    this.spawnAgent = deps.spawn ?? spawnContainedAgent;
    this.capture = deps.capture ?? pipeCaptureProvider();
    this.now = deps.now ?? Date.now;
  }

  /** Writes seq 1 and returns. The job stays queued until start() is called. */
  enqueue(record: JobRecordV2, env: EnqueueEnv = {}): void {
    const writer = this.deps.store.create(record);
    const first = this.deps.store.readAllEvents(record.jobId).events[0];
    if (first !== undefined) this.deps.index.apply(first);
    this.runs.set(record.jobId, {
      jobId: record.jobId, record: this.deps.index.get(record.jobId) ?? { ...record }, writer, env, readers: [],
      exitSettled: false, exitCode: null, startedAtMs: this.now(), containmentErrors: [], finalized: false, waiters: [],
    });
  }

  /** queued → starting → running. Rejects, after recording "failed", when the job cannot start. */
  start(jobId: string): Promise<JobRecordV2> {
    const run = this.runs.get(jobId);
    if (run === undefined) return Promise.reject(new Error(`Unknown job ${jobId}.`));
    return run.startPromise ??= this.launch(run);
  }

  /** Cancels a queued job or terminates a live one (rows 7, 9 and 11). */
  kill(jobId: string, reason: KillReason, detail?: string): Promise<KillResult | null> {
    const run = this.runs.get(jobId);
    if (run === undefined) return Promise.resolve(null);
    return run.killPromise ??= this.doKill(run, reason, detail);
  }

  /** Fails a queued job without spawning it (row 12). */
  fail(jobId: string, reason: "dependency-failed" | "queue-timeout" | "policy-rejected", detail: string): void {
    const run = this.runs.get(jobId);
    if (run === undefined || run.record.state !== "queued") throw new Error(`Job ${jobId} is not queued.`);
    this.terminal(run, run.writer.appendState("failed", reason, { error: detail, exitedAt: this.timestamp() }, detail.slice(0, 500)));
  }

  appendLease(jobId: string, fields: Omit<LeaseEvent, keyof JobEventBase | "type">): void {
    const run = this.runs.get(jobId);
    if (run === undefined) throw new Error(`Unknown job ${jobId}.`);
    this.apply(run, run.writer.appendLease(fields));
  }

  appendPolicy(jobId: string, fields: Omit<PolicyEvent, keyof JobEventBase | "type">): void {
    const run = this.runs.get(jobId);
    if (run === undefined) throw new Error(`Unknown job ${jobId}.`);
    this.apply(run, run.writer.appendPolicy(fields));
  }

  ring(jobId: string): OutputRingBuffer | undefined {
    return this.runs.get(jobId)?.ring;
  }

  supervises(jobId: string): boolean {
    return this.runs.has(jobId);
  }

  wait(jobId: string): Promise<JobRecordV2> {
    const run = this.runs.get(jobId);
    if (run === undefined) return Promise.reject(new Error(`Unknown job ${jobId}.`));
    if (isTerminal(run.record.state)) return Promise.resolve(run.record);
    return new Promise((resolve) => run.waiters.push(resolve));
  }

  /** Terminates every non-terminal job this process supervises and waits for them. */
  async shutdown(): Promise<void> {
    const live = [...this.runs.values()].filter((run) => !isTerminal(run.record.state));
    await Promise.allSettled(live.map((run) => this.kill(run.jobId, "supervisor-shutdown")));
    await Promise.allSettled(live.map((run) => this.wait(run.jobId)));
  }

  private timestamp(): string { return new Date(this.now()).toISOString(); }

  /** Applies an event to the index and keeps the run's copied record current. */
  private apply(run: JobRun, event: JobEvent): void {
    this.deps.index.apply(event);
    run.record = this.deps.index.get(run.jobId) ?? run.record;
  }

  /** Row 8–12 tail: terminal state is durable, then the writer closes, then afterTerminal fires. */
  private terminal(run: JobRun, event: StateEvent): JobRecordV2 {
    this.apply(run, event);
    run.finalized = true;
    if (run.timeout !== undefined) { clearTimeout(run.timeout); run.timeout = undefined; }
    run.writer.close();
    for (const resolve of run.waiters.splice(0)) resolve(run.record);
    this.deps.hooks?.afterTerminal?.(run.record);
    return run.record;
  }

  private async launch(run: JobRun): Promise<JobRecordV2> {
    this.apply(run, run.writer.appendState("starting", "admitted"));
    const capture = run.record.capture.kind !== "none";
    let session: CaptureSession | undefined;
    let agent: ManagedAgent | undefined;
    try {
      if (capture) session = await this.capture.open(run.jobId);
      agent = await this.spawnAgent({
        jobId: run.jobId, harness: run.record.harness, command: run.record.command, args: run.record.args, cwd: run.record.cwd,
        userOrPeer: run.record.peer, extraEnv: run.env.extraEnv, useLemonadeLocal: run.env.useLemonadeLocal,
        lemonadeUrl: run.env.lemonadeUrl, cgroupRoot: run.env.cgroupRoot,
        ...(capture ? { stdio: "capture" as const, captureSession: session } : { stdio: "ignore" as const }),
      });
      run.agent = agent;
      const output = agent.output;
      if (capture && output === undefined) throw new Error("capture session did not provide output streams.");
      if (output !== undefined) {
        // Row 3: one reader per stream, attached before the spawn and running state events. The
        // handler is synchronous: appendOutput assigns seq, then the ring stores the same chunk.
        const ring = run.ring = new OutputRingBuffer({ capBytes: run.record.capture.ringBytes });
        for (const stream of ["stdout", "stderr"] as const) {
          const source = output[stream];
          if (source === null) continue;
          run.readers.push(new PipeStreamReader(source, {
            stream, redactor: run.record.capture.redact ? new SecretRedactor() : null,
            onChunk: (data, timestampMs) => ring.push(run.writer.appendOutput(stream, data, timestampMs)),
          }));
        }
      }
      this.apply(run, run.writer.appendSpawn({
        pid: agent.pid, startTime: agent.startTime ?? "", containmentMode: agent.containmentMode, capture: run.record.capture.kind,
      }));
      const containment: JobContainment = { mode: agent.containmentMode, rootPid: agent.pid, startTime: agent.startTime ?? "" };
      if (agent.jobName !== undefined) containment.jobName = agent.jobName;
      if (agent.cgroupPath !== undefined) containment.cgroupPath = agent.cgroupPath;
      run.startedAtMs = this.now();
      this.apply(run, run.writer.appendState("running", "spawned", { containment, startedAt: this.timestamp() }));
      run.exit = agent.exited.then(
        (code) => this.onRootExit(run, code),
        () => this.onRootExit(run, null),
      );
      const timeoutMs = run.record.queue.timeoutMs;
      if (timeoutMs > 0) run.timeout = setTimeout(() => {
        void this.kill(run.jobId, "timeout", `timed out after ${timeoutMs} ms`).catch(() => undefined);
      }, timeoutMs);
      return run.record;
    } catch (error) {
      if (session !== undefined) session.dispose();
      if (agent !== undefined) { try { await agent.terminate(); } catch { /* the spawn failure is the recorded cause */ } }
      const row = capture && session === undefined ? "capture-error" : "spawn-error";
      const message = error instanceof Error ? error.message : String(error);
      this.deps.hooks?.beforeTerminal?.(run.jobId);
      this.terminal(run, run.writer.appendState("failed", row, { error: message, exitedAt: this.timestamp() }, message.slice(0, 500)));
      throw error instanceof Error ? error : new Error(message);
    }
  }

  /** Row 6: the root exited on its own. */
  private onRootExit(run: JobRun, code: number | null): void {
    run.exitSettled = true; run.exitCode = code;
    if (run.timeout !== undefined) { clearTimeout(run.timeout); run.timeout = undefined; }
    if (run.record.state === "running" && run.killReason === undefined) {
      this.apply(run, run.writer.appendState("exiting", "root-exited"));
      for (const reader of run.readers) reader.notifyExit();
    }
    void this.finalize(run).catch(() => undefined);
  }

  private finalize(run: JobRun): Promise<JobRecordV2> {
    return run.finalizePromise ??= this.doFinalize(run);
  }

  /** Rows 8–10: ExitEvent, beforeTerminal, terminal state, close, afterTerminal. */
  private async doFinalize(run: JobRun): Promise<JobRecordV2> {
    if (run.finalized) return run.record;
    // A containment failure is terminal even when the root survived; otherwise wait for the root.
    if (run.exit !== undefined && run.containmentErrors.length === 0) await run.exit;
    if (run.readers.length > 0) await Promise.all(run.readers.map((reader) => reader.done));
    if (run.finalized) return run.record;
    const marker = readKillRequest(run.jobId);
    const reason = run.killReason ?? marker?.reason;
    const errors = run.containmentErrors.length > 0 ? run.containmentErrors.join("; ") : undefined;
    this.apply(run, run.writer.appendExit({
      exitCode: run.exitCode, signal: null, durationMs: Math.max(0, this.now() - run.startedAtMs),
      outputBytes: run.writer.outputBytes, drained: run.readers.every((reader) => reader.drained),
    }));
    this.deps.hooks?.beforeTerminal?.(run.jobId);
    const patch: JobRecordPatch = { exitCode: run.exitCode, signal: null, exitedAt: this.timestamp() };
    if (errors !== undefined) patch.error = errors;
    const event = run.writer.appendState(errors === undefined ? (reason === undefined ? "exited" : "killed") : "failed",
      errors === undefined ? reason ?? "root-exited" : "containment-error", patch, (errors ?? run.killDetail ?? marker?.detail)?.slice(0, 500));
    return this.terminal(run, event);
  }

  /** Row 7: state exiting first, then terminate, then notifyExit. A starting job waits for start. */
  private async doKill(run: JobRun, reason: KillReason, detail?: string): Promise<KillResult | null> {
    if (isTerminal(run.record.state)) return null;
    if (run.record.state === "queued") {
      this.terminal(run, run.writer.appendState("killed", reason, { exitedAt: this.timestamp() }, detail?.slice(0, 500)));
      return null;
    }
    if (run.record.state === "starting") {
      await run.startPromise?.catch(() => undefined);
      if (isTerminal(run.record.state)) return null;
    }
    run.killReason ??= reason;
    if (detail !== undefined) run.killDetail = detail;
    const terminating = run.record.state === "running";
    if (terminating) this.apply(run, run.writer.appendState("exiting", reason, undefined, detail?.slice(0, 500)));
    let result: KillResult | null = null;
    if (terminating && run.agent !== undefined) {
      try {
        result = await run.agent.terminate();
        if (result.failedPids.length > 0 || result.errors.length > 0) {
          run.containmentErrors.push(...(result.errors.length > 0 ? result.errors : [`failed PIDs: ${result.failedPids.join(", ")}`]));
        }
      } catch (error) {
        run.containmentErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    for (const reader of run.readers) reader.notifyExit();
    await this.finalize(run);
    return result;
  }
}
