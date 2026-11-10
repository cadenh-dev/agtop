export type HarnessType =
  | "claude-code" | "codex" | "opencode" | "aider" | "goose" | "deepseek-harness"
  | "gemini-cli" | "qwen-code" | "cursor-agent" | "amp" | "crush" | "cline"
  | "roo-code" | "kilo-code" | "continue-cli" | "openhands" | "swe-agent" | "plandex"
  | "mentat" | "gpt-engineer" | "open-interpreter" | "cody" | "copilot-cli"
  | "amazon-q" | "kiro" | "antigravity" | "aichat" | "shell-gpt" | "fabric"
  | "mods" | "llm" | "smolagents" | "junie" | "droid" | "kimi" | "codebuff" | "ra-aid"
  | "lemonade-server" | "ollama" | "llama-cpp" | "lm-studio" | "vllm" | "sglang"
  | "localai" | "koboldcpp" | "text-generation-webui" | "jan" | "tabby" | "tabby-agent" | "open-webui"
  | "aphrodite" | "exllamav2" | "mlc-llm" | "llama-cpp-python" | "tgi" | "triton"
  | "mistralrs" | "xinference" | "llamafile" | "mlx-lm" | "openllm"
  | "custom";
export type Backend = "amd-lemonade-local" | "cloud-api" | "local-engine" | "unknown";
export type ProcessRole =
  | "agent" | "subagent" | "mcp-server" | "inference-server" | "dev-server" | "language-server"
  | "test-runner" | "build" | "package-manager" | "git" | "browser" | "shell" | "tool";
/** Which signal produced a role. */
export type RoleSource = "job" | "harness" | "catalog" | "socket" | "inherited" | "fallback";
export interface ListeningSocket { address: string; port: number }
export interface AgentProcess extends RawOsProcess {
  role: ProcessRole;
  roleSource: RoleSource;
  /** Built only from catalog literals, PIDs, harness/job IDs and socket endpoints. Never raw argv or cwd. */
  roleEvidence: string;
}
export type ContainmentMode = "linux-cgroup" | "linux-env-pgid" | "darwin-env-pgid" | "win32-job-object" | "passive-ppid";
export interface RawOsProcess {
  pid: number; ppid: number; name: string; cmdline: string; argv?: string[];
  startTime: string; cpuSeconds: number; cpuPercent: number; memoryMb: number;
  cwd?: string; pgid?: number; envTags?: Record<string, string>; cgroup?: string; state?: string;
  accelerators?: AcceleratorUsage[];
  /** Local inference endpoint connections observed in this snapshot. */
  socketConnections?: SocketConnection[];
  /** TCP sockets this process is listening on, from the same socket snapshot as socketConnections. */
  listeningSockets?: ListeningSocket[];
}
export interface SocketConnection { address: string; port: number; serverPid?: number; serverHarness?: HarnessType }
export interface GitWorktreeInfo { repoRoot: string; branch: string; isWorktree: boolean; gitDir: string; commonDir: string }
export interface AgentProcessTree {
  jobId: string; harness: HarnessType; backend: Backend; backendEvidence: string;
  userOrPeer: string; rootPid: number; git?: GitWorktreeInfo; containmentMode: ContainmentMode;
  totalCpuPercent: number; totalMemoryMb: number; processes: AgentProcess[];
  gpuPercent?: number;
  npuPercent?: number;
  gpuMemoryMb?: number;
  /** Count of processes per role in this tree; roles with zero processes are omitted. */
  roleCounts: Partial<Record<ProcessRole, number>>;
}
export type AcceleratorKind = "gpu" | "npu";
/** One accelerator device as seen by agtop. `id` is stable for the life of the device. */
export interface AcceleratorDevice {
  id: string;
  kind: AcceleratorKind;
  name?: string;
  vendor?: string;
  utilizationPercent?: number;
}
/** Usage of one device by one process over the last sampling interval. */
export interface AcceleratorUsage {
  deviceId: string;
  kind: AcceleratorKind;
  utilizationPercent?: number;
  engine?: string;
  memoryBytes?: number;
}
export type AcceleratorSource = "windows-pdh" | "linux-drm-fdinfo" | "nvml" | "darwin-iokit" | "none";
export interface AcceleratorStatus {
  source: AcceleratorSource;
  kind: AcceleratorKind | "any";
  available: boolean;
  reason?: string;
  message?: string;
}
export interface AcceleratorSnapshot {
  devices: AcceleratorDevice[];
  status: AcceleratorStatus[];
  sampledAt: number;
}
export interface SpawnAgentOptions {
  jobId?: string; harness: HarnessType; command: string; args?: string[]; cwd?: string;
  userOrPeer?: string; useLemonadeLocal?: boolean; lemonadeUrl?: string;
  extraEnv?: Record<string, string>; stdio?: "inherit" | "ignore" | "capture";
  /** A writable, delegated cgroup v2 directory. Failure is fatal when supplied. */
  cgroupRoot?: string;
  /** Required when stdio is "capture". Opened by the caller; the manager attaches and releases it. */
  captureSession?: CaptureSession;
}
export interface ManagedAgent {
  jobId: string; pid: number; containmentMode: ContainmentMode;
  exited: Promise<number>;
  terminate(): Promise<KillResult>;
  /** Present when stdio was "capture". */
  output?: { stdout: import("node:stream").Readable; stderr: import("node:stream").Readable | null };
  /** Root creation time, as stored in the v1 record. Always set from Unit 2.4 on. */
  startTime?: string;
  /** v1 record fields the fleet layer copies into JobContainment. */
  jobName?: string; cgroupPath?: string;
}
export interface KillResult { killedPids: number[]; failedPids: number[]; errors: string[] }
export interface JobRecord {
  version: 1; jobId: string; rootPid: number; startTime: string; harness: HarnessType;
  peer: string; cwd: string; backend: Backend; mode: ContainmentMode;
  jobName?: string; cgroupPath?: string; createdAt: string;
}

// ===== Fleet v0.2 (additive) =====
export type JobState = "queued" | "starting" | "running" | "exiting" | "exited" | "failed" | "killed" | "lost";
export type TerminalJobState = "exited" | "failed" | "killed" | "lost";
export type JobStateReason =
  | "submitted" | "admitted" | "spawned" | "root-exited" | "kill-requested" | "timeout" | "queue-timeout"
  | "cleanup" | "supervisor-shutdown" | "cancelled" | "spawn-error" | "capture-error" | "dependency-failed"
  | "policy-rejected" | "containment-error" | "supervisor-lost";
export type OutputStream = "stdout" | "stderr";
export type FleetSurface = "mcp" | "daemon" | "cli" | "library" | "remote";
export type OutputVisibility = "owner" | "peer" | "all";
export type SpoolMode = "tail" | "full" | "off";
export type CaptureKind = "pipe" | "pty" | "none";

/** The process that holds a job's pipes and is the only writer of its event log. */
export interface SupervisorIdentity { pid: number; startTime: string; surface: FleetSurface }
/** tokenHash is lowercase hex SHA-256 of the session's owner token. The token itself is never persisted. */
export interface JobOwner { sessionId: string; tokenHash: string; surface: FleetSurface; remotePeerId?: string }
export interface CaptureSpec { kind: CaptureKind; ringBytes: number; spool: SpoolMode; spoolMaxBytes: number; redact: boolean }
export interface ResourceRequest { gpu?: boolean; npu?: boolean; memoryMb?: number }
export interface QueueSpec {
  admission: "immediate" | "queued";
  priority: number; dependsOn: string[]; resources: ResourceRequest;
  leasePorts: number[]; leaseTtlMs: number; timeoutMs: number; maxQueueMs: number;
}
export interface JobContainment { mode: ContainmentMode; rootPid: number; startTime: string; jobName?: string; cgroupPath?: string }
export interface OutputCounters { stdout: number; stderr: number }
export interface JobRecordV2 {
  version: 2;
  jobId: string;
  state: JobState;
  stateReason: JobStateReason;
  harness: HarnessType;
  command: string;
  args: string[];
  cwd: string;
  peer: string;
  backend: Backend;
  owner: JobOwner;
  visibility: OutputVisibility;
  supervisor: SupervisorIdentity;
  /** null until the process exists. */
  containment: JobContainment | null;
  capture: CaptureSpec;
  queue: QueueSpec;
  /** Names of extraEnv keys only. Environment values are never persisted. */
  envKeys: string[];
  createdAt: string;
  startedAt: string | null;
  exitedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  /** Highest seq written for this job, as of the last lifecycle event (live readers may know a newer value). */
  lastSeq: number;
  /** Redacted bytes captured per stream, as of the last lifecycle event. */
  outputBytes: OutputCounters;
  /** Human-readable failure text for state "failed" or "lost"; otherwise null. */
  error: string | null;
}
/** Fields a state event may change. */
export type JobRecordPatch = Partial<Pick<JobRecordV2,
  "containment" | "startedAt" | "exitedAt" | "exitCode" | "signal" | "lastSeq" | "outputBytes" | "error">>;
/** What list endpoints return. command, args and cwd are present only when the caller may see them (section 9.2). */
export interface JobSummaryV2 {
  jobId: string; state: JobState; stateReason: JobStateReason; harness: HarnessType; peer: string;
  owned: boolean; ownerSessionId: string; surface: FleetSurface; visibility: OutputVisibility;
  rootPid: number | null; containmentMode: ContainmentMode | null;
  createdAt: string; startedAt: string | null; exitedAt: string | null; exitCode: number | null;
  captured: boolean; lastSeq: number; outputBytes: OutputCounters;
  priority: number; leasePorts: number[];
  command?: string; args?: string[]; cwd?: string;
}

export type JobEventType = "state" | "spawn" | "stdout" | "stderr" | "exit" | "lease" | "policy";
export interface JobEventBase { seq: number; timestamp: string; jobId: string }
export interface StateEvent extends JobEventBase {
  type: "state"; state: JobState; previous: JobState | null; reason: JobStateReason;
  /** Present on seq 1 only: the complete record at submission. */
  record?: JobRecordV2;
  /** Present when the transition changes record fields. */
  patch?: JobRecordPatch;
  /** Free text, at most 500 characters, for failed/lost/killed. */
  detail?: string;
}
export interface SpawnEvent extends JobEventBase {
  type: "spawn"; pid: number; startTime: string; containmentMode: ContainmentMode; capture: CaptureKind;
}
export interface OutputEvent extends JobEventBase {
  type: OutputStream;
  /** Byte offset of this chunk within its stream (bytes of this stream before it, after redaction). */
  offset: number; byteLength: number; encoding: "base64"; data: string;
}
export interface ExitEvent extends JobEventBase {
  type: "exit"; exitCode: number | null; signal: string | null; durationMs: number;
  outputBytes: OutputCounters;
  /** false when the drain grace period expired while a descendant still held a pipe open. */
  drained: boolean;
}
export interface LeaseEvent extends JobEventBase {
  type: "lease"; action: "acquired" | "renewed" | "released" | "expired" | "conflict"; port: number;
  expiresAt?: string; holder?: LeaseHolder;
}
export type PolicyRule = "gpu-busy" | "npu-busy" | "memory-low";
export interface PolicyEvent extends JobEventBase {
  type: "policy"; decision: "defer" | "resume" | "admit" | "reject"; rule: PolicyRule | "cap" | "dependency" | "queue";
  /** Measured value (percent or MiB) or null when the platform could not measure it. */
  measured: number | null; threshold: number | null; detail: string;
}
export type JobEvent = StateEvent | SpawnEvent | OutputEvent | ExitEvent | LeaseEvent | PolicyEvent;

export interface OutputChunk {
  seq: number; stream: OutputStream; timestamp: string;
  /** Byte offset within the stream of the first byte of data. */
  offset: number;
  /** Number of captured bytes this chunk represents (not the length of the JSON string). */
  byteLength: number;
  encoding: "utf8" | "base64"; data: string;
  /** true when this is the oldest retained chunk of its stream and older bytes after `since` were dropped. */
  truncated: boolean;
  /** Present exactly when truncated is true. */
  firstDroppedSeq?: number;
}
/** Dropped output is always a prefix of a stream, so three numbers describe it completely. */
export interface TruncationInfo {
  /** seq of the first chunk ever written to this stream. */
  firstDroppedSeq: number;
  /** No chunk of this stream with seq <= lastDroppedSeq is retained. Equals (oldest retained seq - 1). */
  lastDroppedSeq: number;
  /** Offset of the oldest retained byte, i.e. the number of bytes dropped. */
  droppedBytes: number;
}
export interface OutputQuery {
  stream?: OutputStream | "both"; since?: number; tail?: number; limit?: number; maxBytes?: number;
  encoding?: "utf8" | "base64";
}
export interface OutputPage {
  jobId: string; state: JobState; exitCode: number | null;
  stream: OutputStream | "both"; since: number;
  /** Pass as `since` to continue. Equals the seq of the last returned chunk, or `since` when chunks is empty. */
  nextSince: number;
  lastSeq: number; hasMore: boolean;
  /** "memory": served from the supervisor's ring. "spool": rebuilt from disk by a process that is not the supervisor. */
  source: "memory" | "spool";
  outputBytes: OutputCounters;
  truncation: { stdout: TruncationInfo | null; stderr: TruncationInfo | null };
  chunks: OutputChunk[];
}
export interface EventsQuery { since?: number; limit?: number; types?: JobEventType[] }
export interface EventsPage { jobId: string; since: number; nextSince: number; lastSeq: number; hasMore: boolean; events: JobEvent[] }

export interface QueueEntry {
  jobId: string; peer: string; harness: HarnessType; priority: number; dependsOn: string[];
  resources: ResourceRequest; leasePorts: number[]; redact: boolean;
  enqueuedAt: string; maxQueueMs: number; sessionId: string; supervisorPid: number;
}
export interface ListenerInfo { pid: number; address: string; port: number; jobId?: string; peer?: string }
export type LeaseHolder =
  | { kind: "lease"; port: number; jobId: string | null; peer: string; expiresAt: string }
  | { kind: "listener"; port: number; pid: number; address: string; jobId?: string; peer?: string };
export type BlockReason =
  | { kind: "dependency"; jobIds: string[] }
  | { kind: "cap"; cap: "global" | "peer" | "harness"; limit: number; running: number }
  | { kind: "lease"; port: number; holder: LeaseHolder }
  | { kind: "policy"; rule: PolicyRule; measured: number | null; threshold: number }
  | { kind: "outranked"; byJobId: string };
export interface QueueEntryView extends QueueEntry { position: number; effectivePriority: number; blockedBy: BlockReason[] }
export interface PortLease {
  /** Capability for renew/release. Random UUID. Omitted from non-admin views. */
  leaseId: string;
  port: number; jobId: string | null; peer: string; sessionId: string; holder: SupervisorIdentity;
  acquiredAt: string; renewedAt: string; expiresAt: string; ttlMs: number;
}
export interface AdmissionPolicy {
  maxRunning: number; maxRunningPerPeer: number; maxRunningPerHarness: number;
  harnessLimits: Record<string, number>;
  maxQueued: number;
  gpuBusyPercent: number; gpuResumePercent: number;
  npuBusyPercent: number; npuResumePercent: number;
  minFreeMemoryMb: number; resumeFreeMemoryMb: number;
  agingIntervalMs: number; agingStep: number; agingMaxBoost: number;
  defaultLeaseTtlMs: number; pollMs: number;
}
export interface GuardState { rule: PolicyRule; closed: boolean; measured: number | null; changedAt: string }

export type PeerScope =
  | "jobs:list" | "jobs:read" | "jobs:output" | "jobs:events" | "jobs:submit" | "jobs:kill" | "jobs:kill-any" | "telemetry:read";
export interface DaemonPeer {
  /** /^[a-z0-9][a-z0-9-]{2,62}$/ */
  id: string;
  label?: string;
  /** Base URL of the peer's federation listener, e.g. "https://build-box.lan:13310". No path, no trailing slash. */
  url: string;
  /** Raw 32-byte Ed25519 public key, standard base64 (44 characters). */
  publicKey: string;
  /** PEM certificate that is the only trust anchor for this peer's TLS. Absent: system CAs and hostname verification. */
  tlsCertPem?: string;
  /** What this peer may do on THIS daemon (inbound grants). Empty: the peer is known but can do nothing. */
  scopes: PeerScope[];
  /** Local jobs the peer may see besides the ones it submitted: jobs whose `peer` label starts with one of these. */
  jobPeerPrefixes: string[];
  enabled: boolean;
  addedAt: string;
  lastSeenAt: string | null;
}
export interface LocalIdentity { id: string; publicKey: string }
export interface PeerAuthHeaders {
  "X-Agtop-Peer": string; "X-Agtop-Timestamp": string; "X-Agtop-Nonce": string; "X-Agtop-Signature": string;
}

export type FleetErrorCode =
  | "E_UNAUTHORIZED" | "E_SIGNATURE_INVALID" | "E_CLOCK_SKEW" | "E_REPLAY" | "E_REPLAY_CACHE_FULL"
  | "E_FORBIDDEN_SCOPE" | "E_NOT_OWNER"
  | "E_INVALID_REQUEST" | "E_BODY_TOO_LARGE" | "E_ROUTE_NOT_FOUND"
  | "E_JOB_NOT_FOUND" | "E_JOB_EXISTS" | "E_DEPENDENCY_NOT_FOUND" | "E_DEPENDENCY_CYCLE" | "E_QUEUE_FULL"
  | "E_CAPTURE_DISABLED" | "E_OUTPUT_UNAVAILABLE" | "E_KILL_INCOMPLETE"
  | "E_LEASE_CONFLICT" | "E_LEASE_NOT_FOUND"
  | "E_PEER_NOT_FOUND" | "E_PEER_UNREACHABLE" | "E_PEER_TIMEOUT" | "E_PEER_TLS" | "E_PEER_PROTOCOL"
  | "E_INTERNAL";
export interface FleetErrorBody { error: string; code: FleetErrorCode; details?: Record<string, unknown> }

/** Seam for v0.3 PTY support. v0.2 ships only the "pipe" provider. */
export interface CaptureSession {
  /** POSIX: stdio[0..2] values for child_process.spawn. */
  posixStdio(): ["ignore", "pipe", "pipe"];
  /** Windows: inheritable handles for STARTUPINFO.hStdInput/hStdOutput/hStdError. */
  windowsHandles(): { stdin: unknown; stdout: unknown; stderr: unknown };
  /** After the process exists: the parent-side readable ends. stderr is null when the provider merges streams (PTY). */
  attach(child?: import("node:child_process").ChildProcess): { stdout: import("node:stream").Readable; stderr: import("node:stream").Readable | null };
  /** Close the parent's copies of the child-side ends. Mandatory immediately after process creation on Windows. */
  releaseChildEnds(): void;
  dispose(): void;
}
export interface CaptureProvider { readonly kind: "pipe" | "pty"; open(jobId: string): Promise<CaptureSession> }
