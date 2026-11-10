# agtop Fleet v0.2: engineering contracts

Status: frozen for implementation (Waves 1–5). Companion documents: [architecture](fleet-v0.2.md), [ADRs](fleet-adrs.md), [threat model](fleet-threat-model.md), [acceptance](fleet-acceptance.md).

Rules for implementers:

- Everything in a `ts` block marked **types.ts** is pasted verbatim into `src/types.ts` by Unit 1.1. No other unit edits `src/types.ts`. If a type you need is missing, stop and report it; do not add it locally.
- Names, field names, defaults, limits, status codes and error codes in this document are normative. "Default" always means "the value used when the field is absent".
- All timestamps are ISO 8601 UTC strings produced by `new Date().toISOString()`, unless a field name ends in `Ms` (integer milliseconds).
- All byte counts are integers. `seq` values are positive safe integers.
- v0.1 behavior is unchanged unless a section says "v0.2 change". Section 13 lists every compatibility rule.

## 1. On-disk layout

`stateDir()` is the existing function in `src/registry.ts`. Fleet data lives in one new subdirectory so that v0.1 code, which only reads `<stateDir>/*.json`, never sees it.

```
<stateDir>/
  <jobId>.json                    v1 JobRecord. Unchanged. Still written for every managed launch.
  daemon-<port>.token             v0.1 daemon bearer token. Unchanged.
  fleet/                          mode 0700
    lock                          fleet lock (section 8.5)
    policy.json                   optional AdmissionPolicy override, mode 0600
    audit.jsonl                   framed security audit records, mode 0600 (threat model, section 6)
    jobs/<jobId>/                 mode 0700, one directory per fleet job
      events.jsonl                lifecycle events; fsync on every state event
      output.jsonl                current output segment; never fsynced
      output.prev.jsonl           previous output segment (tail spool) or absent
      kill.request                kill marker (section 8.6) or absent
    leases/<port>.json            one PortLease, mode 0600
    federation/                   mode 0700
      identity.json               { id, publicKey } of this daemon
      identity.key                Ed25519 private key, PKCS#8 PEM, mode 0600
      peers.json                  DaemonPeer[], mode 0600
```

All files are created with mode `0o600` and directories with `0o700`. On Windows the mode is ignored by the OS; see the threat model for the ACL rule.

### 1.1 Frame format

Every `*.jsonl` file under `fleet/` uses the same framing. One record is one line:

```
<len> <crc> <json>\n
```

- `<len>`: byte length of `<json>` in UTF-8, as exactly 8 lowercase hex digits.
- `<crc>`: CRC-32 (IEEE 802.3, polynomial `0xEDB88320`, the zlib/PNG variant) of the `<json>` bytes, as exactly 8 lowercase hex digits.
- Single ASCII spaces separate the fields. The frame header is therefore exactly 18 bytes.
- `<json>` is `JSON.stringify(record)` with no embedded newline (JSON.stringify never emits one).
- The terminator is a single `\n` (0x0A).

Check value: `crc32(Buffer.from("123456789")) === 0xcbf43926`.

Decoding stops at the first frame that fails any check (header does not match `/^[0-9a-f]{8} [0-9a-f]{8} $/`, the file ends before `len` bytes plus the terminator, the terminator is not `\n`, the CRC differs, or the JSON does not parse). Everything from that offset to the end of the file is the **corrupt tail**. Records before it are valid and are used.

A reader never modifies a file. Only `EventStore.repair()` truncates a corrupt tail, and only under the conditions in section 8.5.

## 2. Core types

### 2.1 Jobs — **types.ts**

```ts
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
```

Field rules:

| Field | Rule |
| --- | --- |
| `jobId` | Same validation as v0.1 `validateJobId`: `/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/`. |
| `state`, `stateReason` | Always the `state` and `reason` of the newest state event. |
| `supervisor` | Set at submission to the submitting process and never changed. |
| `containment` | Set by the patch on the `running` state event. |
| `exitCode` | The root's exit code. POSIX signal exits use `128 + signal number`, as v0.1. `null` when unknown (`failed` before spawn, `lost`). |
| `signal` | POSIX signal name when the root died from a signal; otherwise `null`. Always `null` on Windows. |
| `capture.kind` | `"pipe"` when captured, `"none"` when `capture: false`. `"pty"` is reserved for v0.3. |

### 2.2 v1 → v2 mapping

v1 records are **not rewritten**. `spawnContainedAgent` keeps writing the v1 file exactly as today, including for fleet jobs, so discovery, `agtop ps`, `agtop kill`, `isStaleJob` and every existing test keep working. A fleet job therefore has both a v1 file (while it is alive) and a `fleet/jobs/<jobId>/` directory (until retention removes it).

A managed job that has only a v1 record (launched by `agtop run`, by the legacy `POST /v1/agents`, by a v0.1 binary, or by a library caller using `spawnContainedAgent` directly) is shown in fleet listings through this pure function, exported from `src/job-index.ts`:

```ts
export function migrateV1Record(v1: JobRecord): JobRecordV2
```

| `JobRecordV2` field | Value derived from v1 `JobRecord` |
| --- | --- |
| `version` | `2` |
| `jobId`, `harness`, `peer`, `cwd`, `backend` | copied |
| `state` | `"running"` (a v1 record that `readJobs()` returns and `isStaleJob()` does not reject is live) |
| `stateReason` | `"spawned"` |
| `command` | `""` |
| `args` | `[]` |
| `owner` | `{ sessionId: "v1", tokenHash: "", surface: "library" }` |
| `visibility` | `"owner"` |
| `supervisor` | `{ pid: 0, startTime: "", surface: "library" }` |
| `containment` | `{ mode: v1.mode, rootPid: v1.rootPid, startTime: v1.startTime, jobName: v1.jobName, cgroupPath: v1.cgroupPath }` (omit absent optionals) |
| `capture` | `{ kind: "none", ringBytes: 0, spool: "off", spoolMaxBytes: 0, redact: true }` |
| `queue` | `{ admission: "immediate", priority: 0, dependsOn: [], resources: {}, leasePorts: [], leaseTtlMs: 0, timeoutMs: 0, maxQueueMs: 0 }` |
| `envKeys` | `[]` |
| `createdAt`, `startedAt` | `v1.createdAt` |
| `exitedAt`, `exitCode`, `signal`, `error` | `null` |
| `lastSeq` | `0` |
| `outputBytes` | `{ stdout: 0, stderr: 0 }` |

Migrated views are read-only: they are never written to disk, have no events, and `output`/`events` requests for them return `E_CAPTURE_DISABLED`. An empty `tokenHash` never matches any session, so a migrated job is owned by nobody. When both a fleet directory and a v1 file exist for a job ID, the fleet record wins and the v1 file is ignored by `JobIndex`.

### 2.3 Events — **types.ts**

```ts
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
```

Sequence rules:

1. `seq` is per job, starts at 1, and increases by exactly 1 for every event of every type. One counter covers both `events.jsonl` and the output segments.
2. `seq` 1 is always `{ type: "state", state: "queued", previous: null, reason: "submitted", record }`. This holds for immediate-admission jobs too; they pass through `queued` without waiting.
3. `state`, `spawn`, `exit`, `lease` and `policy` events are appended to `events.jsonl`. `stdout` and `stderr` events are appended to `output.jsonl`. Merging both files by `seq` gives the complete timeline.
4. Every state event is followed by `fsync` on `events.jsonl` before anything that depends on it happens: `queued` before `submit` returns, `starting` before the process is created, `exiting` (for a kill) before the tree is terminated, and the terminal state before the HTTP or MCP response that reports it. `running` is written immediately after `spawnContainedAgent` resolves, so the process may already be executing. No other event is fsynced.
5. `PolicyEvent` with `decision: "defer"` is written once per continuous block per rule, not on every scheduler tick. `"resume"` is written when that block clears.
6. `LeaseEvent` with `action: "renewed"` is **not** written (renewals only touch the lease file). The action value exists for the HTTP lease API response.

### 2.4 Output — **types.ts**

```ts
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
```

Output query semantics, applied in this order by `OutputRingBuffer.read`:

1. Select chunks of `stream` (default `"both"`), merged in `seq` order.
2. Keep chunks with `seq > since` (default `since = 0`).
3. If `tail` is present: keep only the last `tail` lines of the selected bytes. A line ends at `\n`; a final unterminated line counts as a line. If the cut falls inside a chunk, that chunk is returned with `data` starting at the cut, `offset` increased and `byteLength` reduced accordingly; its `seq` is unchanged. With `stream: "both"`, lines are counted over the seq-ordered concatenation.
4. If `tail` is absent: keep the oldest `limit` chunks (default 200, range 1–1000).
5. Enforce `maxBytes` (sum of `byteLength`; default 1 048 576, range 1–4 194 304). Without `tail`, stop before the first chunk that would exceed it (always return at least one chunk). With `tail`, drop chunks from the **front** until the total fits, then mark `hasMore: false`.
6. `hasMore` is true when step 4 or the non-tail branch of step 5 left newer chunks unreturned.
7. Encoding (default `"utf8"`): `data` is the chunk bytes decoded as UTF-8 with invalid sequences replaced by U+FFFD. Writers guarantee that an untrimmed chunk never ends inside a code point except at end of stream (section 6.2). `"base64"` returns the exact bytes.
8. `truncated`/`firstDroppedSeq`: set on a returned chunk when it is the oldest retained chunk of its stream, was not trimmed by `tail`, and `truncation(stream).lastDroppedSeq > since`.

Text rendering (CLI `agtop logs`, MCP `output` with `format: "text"`) inserts this exact line before a chunk with `truncated: true`, and nothing else:

```ts
export function truncationMarker(stream: OutputStream, t: TruncationInfo): string {
  return `[agtop: ${t.droppedBytes} bytes of ${stream} dropped (seq ${t.firstDroppedSeq}-${t.lastDroppedSeq})]\n`;
}
```

`truncationMarker` is exported from `src/capture.ts`.

### 2.5 Queue, leases, policy — **types.ts**

```ts
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
```

`DEFAULT_ADMISSION_POLICY`, exported from `src/policy.ts`:

| Field | Default | Valid range |
| --- | --- | --- |
| `maxRunning` | 8 | 1–256 |
| `maxRunningPerPeer` | 4 | 1–256 |
| `maxRunningPerHarness` | 4 | 1–256 |
| `harnessLimits` | `{}` | harness ID → 1–256; overrides `maxRunningPerHarness` for that harness |
| `maxQueued` | 200 | 1–10 000 |
| `gpuBusyPercent` / `gpuResumePercent` | 85 / 70 | 1–100; resume must be < busy |
| `npuBusyPercent` / `npuResumePercent` | 85 / 70 | 1–100; resume must be < busy |
| `minFreeMemoryMb` / `resumeFreeMemoryMb` | 1024 / 1536 | 0–1 048 576; resume must be ≥ min |
| `agingIntervalMs` | 30 000 | 1000–3 600 000 |
| `agingStep` | 1 | 0–100 |
| `agingMaxBoost` | 50 | 0–200 |
| `defaultLeaseTtlMs` | 600 000 | 10 000–86 400 000 |
| `pollMs` | 1000 | 250–60 000 |

"Running" for every cap means state `starting`, `running` or `exiting`, counted over all fleet jobs of all supervisors plus migrated v1 jobs.

### 2.6 Federation — **types.ts**

```ts
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
```

### 2.7 Errors — **types.ts**

```ts
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
```

`src/fleet-errors.ts` (Unit 1.1) exports:

```ts
export class FleetError extends Error {
  constructor(readonly code: FleetErrorCode, message: string, readonly details?: Record<string, unknown>);
  toBody(): FleetErrorBody;
}
export const FLEET_ERROR_STATUS: Record<FleetErrorCode, number>;
```

| Code | HTTP | Meaning |
| --- | --- | --- |
| `E_UNAUTHORIZED` | 401 | Missing or wrong bearer token, browser `Origin` present, or missing federation headers |
| `E_SIGNATURE_INVALID` | 401 | Unknown or disabled peer, malformed header, or signature mismatch (deliberately indistinguishable) |
| `E_CLOCK_SKEW` | 401 | Timestamp outside ±60 000 ms. `details: { serverTimeMs }` |
| `E_REPLAY` | 401 | Nonce already seen for this peer |
| `E_REPLAY_CACHE_FULL` | 429 | Nonce cache for this peer is full |
| `E_FORBIDDEN_SCOPE` | 403 | Peer lacks the scope. `details: { scope }` |
| `E_NOT_OWNER` | 403 | Session or peer may not access this job or lease |
| `E_INVALID_REQUEST` | 400 | Validation failure. `details: { field }` when one field is at fault |
| `E_BODY_TOO_LARGE` | 413 | Request body over 65 536 bytes |
| `E_ROUTE_NOT_FOUND` | 404 | Unknown path or method |
| `E_JOB_NOT_FOUND` | 404 | No fleet job and no live v1 job with this ID |
| `E_JOB_EXISTS` | 409 | Job ID is in use by a non-terminal job |
| `E_DEPENDENCY_NOT_FOUND` | 422 | `dependsOn` names an unknown job. `details: { jobIds }` |
| `E_DEPENDENCY_CYCLE` | 422 | `dependsOn` contains the job itself or forms a cycle |
| `E_QUEUE_FULL` | 429 | `maxQueued` reached |
| `E_CAPTURE_DISABLED` | 409 | Job has `capture.kind === "none"` (including migrated v1 jobs) |
| `E_OUTPUT_UNAVAILABLE` | 410 | Captured job with `spool: "off"` whose supervisor is another process or gone |
| `E_KILL_INCOMPLETE` | 409 | Some PIDs survived. `details: { result: KillResult }` |
| `E_LEASE_CONFLICT` | 409 | Port is leased or has a listener. `details: { holder: LeaseHolder }` |
| `E_LEASE_NOT_FOUND` | 404 | No lease for this port |
| `E_PEER_NOT_FOUND` | 404 | Unknown peer ID in a `/v1/remote/` or `/v1/peers/` path |
| `E_PEER_UNREACHABLE` | 502 | Connection refused, reset, or DNS failure |
| `E_PEER_TIMEOUT` | 504 | No complete response within 10 000 ms |
| `E_PEER_TLS` | 502 | Certificate did not match `tlsCertPem` or failed CA verification |
| `E_PEER_PROTOCOL` | 502 | Response was not JSON or exceeded 8 MiB |
| `E_INTERNAL` | 500 | Unexpected exception; `error` is a generic message, the cause is logged to stderr |

## 3. Constants

Exported from the module that owns them; never duplicated.

| Constant | Value | Module |
| --- | --- | --- |
| `FRAME_HEADER_BYTES` | 18 | `event-store.ts` |
| `DEFAULT_RING_BYTES` | 1 048 576 | `capture.ts` |
| `MIN_RING_BYTES` / `MAX_RING_BYTES` | 65 536 / 16 777 216 | `capture.ts` |
| `STDERR_RESERVE_BYTES` | 65 536 (or `ringBytes / 4` when `ringBytes < 262 144`) | `capture.ts` |
| `MAX_RING_CHUNKS` | 4096 | `capture.ts` |
| `DEFAULT_SPOOL_MAX_BYTES` | 268 435 456 | `event-store.ts` |
| `MAX_CHUNK_BYTES` | 65 536 | `streams.ts` |
| `MIN_CHUNK_BYTES` | 4096 | `streams.ts` |
| `FLUSH_TICK_MS` | 100 | `streams.ts` |
| `MAX_HOLD_MS` | 2000 | `streams.ts` |
| `DRAIN_GRACE_MS` | 2000 | `streams.ts` |
| `REDACTION_HOLDBACK_BYTES` | 1024 | `redact.ts` |
| `REDACTION_MAX_MATCH_BYTES` | 600 | `redact.ts` |
| `SIGNATURE_VERSION` | `"AGTOP-ED25519-V1"` | `remote/auth.ts` |
| `MAX_SKEW_MS` | 60 000 | `remote/auth.ts` |
| `NONCE_TTL_MS` | 120 000 | `remote/auth.ts` |
| `NONCE_CACHE_MAX` | 4096 per peer | `remote/auth.ts` |
| `REMOTE_TIMEOUT_MS` | 10 000 | `remote/proxy.ts` |
| `REMOTE_MAX_RESPONSE_BYTES` | 8 388 608 | `remote/proxy.ts` |
| `RETENTION_HOURS` | 72 (env `AGTOP_FLEET_RETENTION_HOURS`, 0 disables) | `reconcile.ts` |
| `RETENTION_MAX_JOBS` | 200 terminal jobs | `reconcile.ts` |
| `HYDRATED_RING_CACHE` | 16 jobs (LRU) | `fleet.ts` |

## 4. `src/event-store.ts` (Unit 1.2)

Imports: `node:fs`, `node:path`, `./registry.js` (`stateDir`, `validateJobId`), `./fleet-errors.js`, types. No other internal imports.

```ts
export const FRAME_HEADER_BYTES = 18;
export const DEFAULT_SPOOL_MAX_BYTES = 268_435_456;
export function crc32(bytes: Uint8Array): number;
export function encodeFrame(record: unknown): Buffer;
export interface DecodeResult<T> { records: T[]; validBytes: number; corruptTailBytes: number }
export function decodeFrames<T = unknown>(buffer: Buffer): DecodeResult<T>;

export function fleetDir(): string;                 // path.join(stateDir(), "fleet")
export function jobDir(jobId: string): string;      // validateJobId, then path.join(fleetDir(), "jobs", jobId)

export interface StoredChunk { seq: number; stream: OutputStream; timestampMs: number; offset: number; data: Buffer }
export interface SpoolSegmentHeader {
  type: "segment"; jobId: string; createdAt: string;
  firstSeq: { stdout: number | null; stderr: number | null };
}
export interface StoredOutput {
  chunks: StoredChunk[];
  firstSeq: { stdout: number | null; stderr: number | null };
  corruptTailBytes: number;
}

export class JobEventWriter {
  readonly jobId: string;
  get lastSeq(): number;
  get outputBytes(): OutputCounters;
  /** Appends and fsyncs. Fills patch.lastSeq and patch.outputBytes with the values that include this event. */
  appendState(state: JobState, reason: JobStateReason, patch?: JobRecordPatch, detail?: string): StateEvent;
  appendSpawn(fields: Omit<SpawnEvent, keyof JobEventBase | "type">): SpawnEvent;
  appendExit(fields: Omit<ExitEvent, keyof JobEventBase | "type">): ExitEvent;
  appendLease(fields: Omit<LeaseEvent, keyof JobEventBase | "type">): LeaseEvent;
  appendPolicy(fields: Omit<PolicyEvent, keyof JobEventBase | "type">): PolicyEvent;
  /** Assigns seq and offset, writes one OutputEvent without fsync, rotates when needed. data.length must be 1..65536. */
  appendOutput(stream: OutputStream, data: Buffer, timestampMs: number): StoredChunk;
  close(): void;
}

export class EventStore {
  constructor(options?: { root?: string; now?: () => Date });
  /** Creates the job directory and writes seq 1. Throws FleetError("E_JOB_EXISTS") if a non-terminal job has this ID;
   *  removes the old directory first if the existing job is terminal. */
  create(record: JobRecordV2): JobEventWriter;
  /** For the reconciler only: append to a job whose supervisor is proven dead. */
  reopen(jobId: string): JobEventWriter;
  listJobIds(): string[];
  readAllEvents(jobId: string): { events: JobEvent[]; corruptTailBytes: number };   // events.jsonl only, never output
  readEvents(jobId: string, query?: EventsQuery): EventsPage;
  readOutput(jobId: string): StoredOutput;                                          // output.prev.jsonl then output.jsonl
  /** Truncates corrupt tails of all three files. Caller must hold the fleet lock and have proven the supervisor dead. */
  repair(jobId: string): { corruptTailBytes: number };
  remove(jobId: string): void;
}
```

Behavior:

- `crc32` is a local table-driven implementation. Do not use `zlib.crc32` (not available in every Node 22 release) or `Bun.hash` (unavailable under Node).
- `JobEventWriter` opens files with flag `"a"` and mode `0o600`, lazily on first write, and writes each frame with one `fs.writeSync` call. `appendState` calls `fs.fsyncSync` on the `events.jsonl` descriptor.
- Output segment lifecycle: the first record of every segment is a `SpoolSegmentHeader` frame. It is not a `JobEvent`, has no `seq`, and is skipped by readers after they copy `firstSeq`.
- Rotation with `spool: "tail"`: before writing an output record, if the raw (pre-base64) bytes written to the current segment are `>= ringBytes`, close it, delete `output.prev.jsonl`, rename `output.jsonl` to `output.prev.jsonl`, open a new `output.jsonl`, write its header. Disk therefore always holds the newest `ringBytes`–`2 × ringBytes` of output.
- With `spool: "full"`: never rotate; when the segment's raw bytes reach `spoolMaxBytes`, switch to the `"tail"` behavior from then on.
- With `spool: "off"`: `appendOutput` assigns `seq` and `offset` and returns the chunk but writes nothing.
- On Windows, close the descriptor before renaming.
- If a write to an output segment throws (for example `ENOSPC`), the writer stops spooling for that job (behaves as `spool: "off"` from then on), remembers the message, and adds `spool disabled: <message>` to the `detail` of the next state event. `appendOutput` never throws for I/O errors. A failed write to `events.jsonl` does throw; the runtime treats it as a spawn or containment error.
- `readEvents`: default `since` 0, `limit` 200 (range 1–1000), `types` = `["state", "spawn", "exit", "lease", "policy"]`. Output events are included only when `types` names `stdout` or `stderr`; they come from the retained segments in on-disk form (`encoding: "base64"`). Results are in `seq` order. `nextSince` is the last returned `seq` or `since`.
- Readers tolerate a concurrent writer: a partial trailing frame is simply the corrupt tail of that read and is ignored. Readers never truncate.

## 5. `src/job-index.ts` (Unit 1.3)

```ts
/** Folds lifecycle events into a record. Returns undefined when seq 1 is missing or carries no record. */
export function foldEvents(events: JobEvent[]): JobRecordV2 | undefined;
export function migrateV1Record(v1: JobRecord): JobRecordV2;
export function toSummary(record: JobRecordV2, caller: { owned: boolean; showCommand: boolean }): JobSummaryV2;
export interface JobFilter { states?: JobState[]; peer?: string; harness?: string; ownerSessionId?: string }
export interface IndexRebuildStats { jobs: number; events: number; corruptTailBytes: number; durationMs: number }

export class JobIndex {
  constructor(store: EventStore, options?: { readV1?: () => JobRecord[] });
  rebuild(): IndexRebuildStats;
  /** Re-reads events.jsonl of jobs whose file size changed, discovers new job directories, drops removed ones. */
  refresh(): void;
  /** Called by the local supervisor after each lifecycle append, so local state never waits for refresh(). */
  apply(event: JobEvent): void;
  get(jobId: string): JobRecordV2 | undefined;
  list(filter?: JobFilter): JobRecordV2[];                // createdAt descending, then jobId ascending
  queued(): JobRecordV2[];
  runningCounts(): { total: number; perPeer: Map<string, number>; perHarness: Map<string, number> };
}
```

Folding: start from `events[0].record`; for each later `StateEvent` set `state`, `stateReason = reason`, and shallow-assign `patch`; set `lastSeq` to the highest seq seen in `events.jsonl` unless a patch supplied a higher one. `spawn`, `exit`, `lease` and `policy` events do not change the record (their data reaches the record through the patch on the neighboring state event).

`RUNNING_STATES` and `TERMINAL_STATES` come from `src/job-state.ts` (section 14). `readV1` defaults to `readJobs` from `src/registry.ts`. v1 jobs whose ID has no fleet directory appear via `migrateV1Record`. `JobIndex` never scans the OS process table.

## 6. Capture modules

### 6.1 `src/redact.ts` (Unit 1.4)

```ts
export const REDACTION_HOLDBACK_BYTES = 1024;
export const REDACTION_MAX_MATCH_BYTES = 600;
export interface RedactionRule {
  id: string;
  /** Must have the g flag, must never match "\n", and no match may exceed REDACTION_MAX_MATCH_BYTES. */
  pattern: RegExp;
  /** When true, capture group 1 is a prefix that is kept; only the rest of the match is replaced. */
  keepPrefix?: boolean;
}
export const DEFAULT_REDACTION_RULES: readonly RedactionRule[];
export class SecretRedactor {
  constructor(rules?: readonly RedactionRule[]);
  /** Returns the bytes that are now safe to release. */
  push(chunk: Buffer, mode: "data" | "tick" | "eof"): Buffer;
  get heldBytes(): number;
  get redactionCount(): number;
}
/** One-shot helper for short strings. Equivalent to new SecretRedactor().push(Buffer.from(text), "eof"). */
export function redactText(text: string): string;
```

`DEFAULT_REDACTION_RULES`, in this order (replacement is always `[REDACTED:<id>]`):

| `id` | `pattern` | `keepPrefix` |
| --- | --- | --- |
| `openai-key` | `/sk-[A-Za-z0-9_-]{20,200}/g` | no |
| `github-token` | `/gh[pousr]_[A-Za-z0-9]{36,200}/g` | no |
| `github-pat` | `/github_pat_[A-Za-z0-9_]{22,200}/g` | no |
| `aws-access-key` | `/\b(?:AKIA\|ASIA)[0-9A-Z]{16}\b/g` | no |
| `google-api-key` | `/AIza[0-9A-Za-z_-]{35}/g` | no |
| `slack-token` | `/xox[abprs]-[A-Za-z0-9-]{10,200}/g` | no |
| `jwt` | `/eyJ[A-Za-z0-9_-]{10,180}\.[A-Za-z0-9_-]{10,180}\.[A-Za-z0-9_-]{10,180}/g` | no |
| `auth-header` | `/(Authorization:[ \t]*)[^\r\n]{1,400}/gi` | yes |
| `bearer-token` | `/(Bearer[ \t]+)[A-Za-z0-9._~+\/=-]{16,400}/g` | yes |
| `env-secret` | `/([A-Z][A-Z0-9_]{0,60}(?:API_KEY\|TOKEN\|SECRET\|PASSWORD\|PASSWD)=)[^\s'"]{1,400}/g` | yes |

(The `\|` above is a literal `|` in the regular expression; it is escaped only for the table.) `sk-` covers OpenAI, Anthropic (`sk-ant-`) and DeepSeek keys. `env-secret` covers `DEEPSEEK_API_KEY=...`, `OPENAI_API_KEY=...`, `GITHUB_TOKEN=...` and similar.

Algorithm of `push` (the spike's `Redactor` is the reference implementation):

1. `s = carry + chunk.toString("latin1")`. The latin1 view maps every byte to one character, so arbitrary binary data survives and all patterns, which are ASCII, still match.
2. Collect all matches of all rules as `[matchStart, redactStart, end, id]` and sort by `matchStart`.
3. Choose `cut`: `"eof"` → `s.length`; `"data"` → `max(0, s.length - REDACTION_HOLDBACK_BYTES)`; `"tick"` → the larger of the `"data"` cut and `s.lastIndexOf("\n") + 1`.
4. For each match in order: if `matchStart < cut && end > cut`, set `cut = end`. A match is never split.
5. Emit `s[0..cut)` with every match that starts before `cut` replaced; where matches overlap, the earlier one wins and a later match that starts inside it only extends the redacted range. `carry = s[cut..)`, unredacted, to be rescanned next time.
6. Return `Buffer.from(output, "latin1")`.

Why it is safe: a match that begins before the holdback zone is at most 600 bytes long and therefore ends inside the buffer, so it is complete; a secret that begins inside the holdback zone is not released until more data, a newline-bounded tick, or EOF arrives. Rules never match across `\n`, so releasing through the last newline cannot split a secret.

### 6.2 `src/streams.ts` (Unit 2.2)

```ts
export const MAX_CHUNK_BYTES = 65_536, MIN_CHUNK_BYTES = 4096, FLUSH_TICK_MS = 100, MAX_HOLD_MS = 2000, DRAIN_GRACE_MS = 2000;
/** Largest index <= limit at which bytes[0..index) ends on a UTF-8 code point boundary. */
export function utf8Boundary(bytes: Buffer, limit?: number): number;

export interface PipeReaderOptions {
  stream: OutputStream;
  /** null when the job has redact: false. */
  redactor: SecretRedactor | null;
  onChunk(data: Buffer, timestampMs: number): void;
  now?: () => number;
}
export class PipeStreamReader {
  constructor(source: import("node:stream").Readable, options: PipeReaderOptions);
  /** Resolves after the final chunk was delivered: on end/close/error of the source, or DRAIN_GRACE_MS after notifyExit(). */
  readonly done: Promise<void>;
  /** The root process exited. Starts the drain grace timer. */
  notifyExit(): void;
  /** false if the grace timer ended the read while the pipe was still open. */
  get drained(): boolean;
  get bytesIn(): number;
  get bytesOut(): number;
}

export function pipeCaptureProvider(platform?: NodeJS.Platform): CaptureProvider;   // win32 → windows-pipes.ts, else POSIX
```

The capture seam is declared in `src/types.ts` (Unit 1.1 pastes it; `src/streams.ts` re-exports both names) — **types.ts**:

```ts
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
```

The POSIX session is trivial: `posixStdio()` returns `["ignore", "pipe", "pipe"]`, `attach(child)` returns `{ stdout: child.stdout, stderr: child.stderr }`, `windowsHandles()` throws, and `releaseChildEnds()` and `dispose()` do nothing (Node closes the child ends itself).

`PipeStreamReader` behavior (the spike's `Job.run` inner loop is the reference):

- Attach `data`, `end`, `close` and `error` listeners synchronously in the constructor. Never call `pause()`, never `await` inside the `data` handler, never apply backpressure. Output that the ring cannot hold is dropped by the ring, not by slowing the child.
- On `data`: pass the bytes through `redactor.push(bytes, "data")` (or use them as-is when `redactor` is null), append the result to `pending`. If `pending` holds at least `MIN_CHUNK_BYTES`, emit.
- A `setInterval(FLUSH_TICK_MS)` timer, `unref()`ed: call `redactor.push(empty, "tick")`, append, and emit everything pending. If any redactor carry has been held longer than `MAX_HOLD_MS`, call `redactor.push(empty, "eof")` instead (this releases an unterminated line such as a prompt).
- Emit: concatenate `pending`; repeatedly cut at `utf8Boundary(buffer, min(buffer.length, MAX_CHUNK_BYTES))` and call `onChunk(piece, now())`. Bytes after the last boundary (at most 3) stay pending. A data-triggered emit keeps a final piece smaller than `MIN_CHUNK_BYTES` pending; a tick-triggered emit sends it.
- Finish (once): clear the timer, `redactor.push(empty, "eof")`, emit everything including an incomplete trailing code point, resolve `done`.
- `notifyExit()` starts a `DRAIN_GRACE_MS` timer; when it fires, finish with `drained = false` and `destroy()` the source.
- Each `onChunk` buffer must own its memory (`Buffer.concat` result or an explicit copy), never a slice of a pooled buffer.

### 6.3 `src/capture.ts` (Unit 2.1)

```ts
export const DEFAULT_RING_BYTES = 1_048_576, MIN_RING_BYTES = 65_536, MAX_RING_BYTES = 16_777_216, MAX_RING_CHUNKS = 4096;
export interface RingOptions { capBytes?: number; stderrReserveBytes?: number; maxChunks?: number }
export class OutputRingBuffer {
  constructor(options?: RingOptions);
  push(chunk: StoredChunk): void;
  /** Rebuild from disk. Sets firstSeq from the segment headers, then pushes the chunks in order. */
  hydrate(stored: StoredOutput): void;
  read(query: OutputQuery): { chunks: OutputChunk[]; nextSince: number; hasMore: boolean };
  truncation(stream: OutputStream): TruncationInfo | null;
  get retainedBytes(): OutputCounters;
  get totalBytes(): OutputCounters;
  get lastSeq(): number;
}
export function truncationMarker(stream: OutputStream, t: TruncationInfo): string;
/** Renders chunks as text with truncation markers, for the CLI and MCP text format. */
export function renderOutputText(page: Pick<OutputPage, "chunks" | "truncation">): string;
```

Rules:

- One ring per job holding both streams. `capBytes` bounds `retainedBytes.stdout + retainedBytes.stderr`. `maxChunks` bounds the total chunk count.
- After every `push`, while over either bound, evict one chunk: if only one stream has chunks, evict its oldest; else if `retainedBytes.stderr <= stderrReserveBytes`, evict the oldest stdout chunk; else evict whichever stream's oldest chunk has the smaller `seq`. This keeps the last 64 KiB of stderr even under a stdout flood.
- Eviction must release the buffer immediately. If the queue is an array with a head index, set the evicted slot to `undefined` before advancing; the spike leaked 1 MiB per job until this was fixed.
- `truncation(stream)`: `null` if the stream never produced a chunk or its oldest retained chunk has `offset === 0`. Otherwise `{ firstDroppedSeq: firstSeq[stream], lastDroppedSeq: oldestRetained ? oldestRetained.seq - 1 : lastSeqOfStream, droppedBytes: oldestRetained ? oldestRetained.offset : totalBytes[stream] }`.
- `read` implements section 2.4 exactly.

### 6.4 `src/windows-pipes.ts` (Unit 2.3)

```ts
export function windowsPipeCaptureProvider(): CaptureProvider;
```

The exact working pattern is in [fleet-v0.2.md, section 7](fleet-v0.2.md#7-reference-capture-patterns-from-the-spike). Unit 2.3 also changes one signature in `src/windows.ts`:

```ts
// before: launch(name, command, args, cwd, env, inherit: boolean)
launch(name: string, command: string, args: string[], cwd: string, env: Record<string, string>,
  stdio: boolean | { stdin: unknown; stdout: unknown; stderr: unknown })
```

`true` and `false` keep their v0.1 meaning. An object means: `STARTF_USESTDHANDLES`, the three handles in `STARTUPINFO` and in `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`, `bInheritHandles = TRUE`, and creation flags `0x80000 | 0x400 | 0x4 | 0x08000000` (the non-inherit flags, including `CREATE_NO_WINDOW`). `launch` does not close the supplied handles; the caller does, via `CaptureSession.releaseChildEnds()`.

## 7. Supervisor modules

### 7.1 `src/manager.ts` changes (Unit 2.4)

**types.ts** (Unit 1.1 replaces the two existing declarations with these; every new field is optional, so v0.1 code compiles unchanged until Unit 2.4 uses them):

```ts
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
```

The existing validation message for `stdio` becomes `"stdio must be inherit, ignore, or capture."`.

Manager behavior with `stdio: "capture"`:

- Windows: `windowsApi().launch(..., captureSession.windowsHandles())`; after `launch` returns (the process exists, suspended) call `captureSession.attach()` and `captureSession.releaseChildEnds()`, then `writeJob`, then `resume()`. On any failure call `captureSession.dispose()`.
- POSIX: the existing `spawn("/bin/sh", ...)` call uses `stdio: [...captureSession.posixStdio(), "pipe"]` (fd 3 stays the launch gate). Call `captureSession.attach(child)` right after `spawn` returns and before the gate is released, so no output can precede the listeners.
- Delete `AGTOP_SESSION_ID` and `AGTOP_OWNER_TOKEN` from the child environment, next to the existing `AGTOP_DAEMON_TOKEN` deletion, and add both names to the `watchdogCommand` deletion list in `src/watchdog.ts`.
- Nothing else changes. `"inherit"` and `"ignore"` take the v0.1 code paths byte for byte.

### 7.2 `src/job-runtime.ts` (Unit 2.4)

```ts
export interface SessionIdentity { sessionId: string; ownerToken: string; tokenHash: string }
export function newSessionIdentity(env?: NodeJS.ProcessEnv): SessionIdentity;
export function selfSupervisor(surface: FleetSurface): SupervisorIdentity;

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
export class JobRuntime {
  constructor(deps: RuntimeDeps);
  /** Writes seq 1 and returns. The job stays queued until start() is called. */
  enqueue(record: JobRecordV2, env: { extraEnv?: Record<string, string>; useLemonadeLocal?: boolean; lemonadeUrl?: string; cgroupRoot?: string }): void;
  /** queued → starting → running. Resolves when running, rejects (after recording "failed") on spawn errors. */
  start(jobId: string): Promise<JobRecordV2>;
  /** Cancels a queued job or terminates a live one. */
  kill(jobId: string, reason: "kill-requested" | "timeout" | "cleanup" | "supervisor-shutdown" | "cancelled", detail?: string): Promise<KillResult | null>;
  /** Fails a queued job without spawning it. */
  fail(jobId: string, reason: "dependency-failed" | "queue-timeout" | "policy-rejected", detail: string): void;
  /** Append to a supervised, non-terminal job's log. Used by the scheduler. */
  appendLease(jobId: string, fields: Omit<LeaseEvent, keyof JobEventBase | "type">): void;
  appendPolicy(jobId: string, fields: Omit<PolicyEvent, keyof JobEventBase | "type">): void;
  ring(jobId: string): OutputRingBuffer | undefined;       // only for jobs this process supervises
  supervises(jobId: string): boolean;
  wait(jobId: string): Promise<JobRecordV2>;               // resolves at a terminal state
  /** Terminates every non-terminal job this process supervises. */
  shutdown(): Promise<void>;
}
```

`newSessionIdentity`: `sessionId` is `env.AGTOP_SESSION_ID` if it matches `/^[A-Za-z0-9_-]{8,80}$/`, else `randomUUID()`. `ownerToken` is `env.AGTOP_OWNER_TOKEN` if it is at least 32 characters, else `randomBytes(32).toString("hex")`. `tokenHash` is `createHash("sha256").update(ownerToken).digest("hex")`.

`selfSupervisor`: `{ pid: process.pid, startTime, surface }` where `startTime` is this process's creation time in the same format v1 records use (`windowsApi().identity` of the current process handle on Windows, `posixOps().identity(process.pid)` elsewhere), computed once.

The runtime never touches leases itself: the scheduler acquires them before `start` and releases them in `hooks.beforeTerminal`. The exact order of operations for `start`, exit handling and `kill` is the transition table in [fleet-v0.2.md, section 3](fleet-v0.2.md#3-job-state-machine).

### 7.3 `src/reconcile.ts` (Unit 2.5)

```ts
export interface ReconcileStats extends IndexRebuildStats { lost: string[]; repaired: string[]; pruned: string[]; killedPids: number[] }
export function withFleetLock<T>(fn: () => T | Promise<T>, options?: { timeoutMs?: number }): Promise<T>;
export function supervisorAlive(id: SupervisorIdentity, snapshot?: ProcessIdentity[]): boolean;
export async function reconcileFleet(store: EventStore, index: JobIndex, options?: {
  snapshot?: () => ProcessIdentity[]; kill?: typeof killAgentTree; now?: () => Date;
}): Promise<ReconcileStats>;
```

Specified in section 8.5 and in [fleet-v0.2.md, section 4](fleet-v0.2.md#4-restart-reconciliation).

## 8. Scheduler modules

### 8.1 `src/leases.ts` (Unit 3.1)

```ts
export class LeaseManager {
  constructor(options?: {
    dir?: string; now?: () => number;
    listeners?: () => ListenerInfo[];
    alive?: (holder: SupervisorIdentity) => boolean;
  });
  /** Throws FleetError("E_LEASE_CONFLICT", …, { holder }). */
  acquire(request: { port: number; jobId: string | null; peer: string; sessionId: string; holder: SupervisorIdentity; ttlMs?: number }): PortLease;
  /** Throws E_LEASE_NOT_FOUND, or E_NOT_OWNER when leaseId does not match. */
  renew(port: number, leaseId: string): PortLease;
  release(port: number, leaseId: string): void;
  /** Releases every lease of a job. Returns the ports. */
  releaseJob(jobId: string): number[];
  get(port: number): PortLease | null;
  list(): PortLease[];
  /** Why this port cannot be leased to forJobId right now, or null. Does not modify anything. */
  check(port: number, forJobId?: string): LeaseHolder | null;
  /** Deletes expired and dead-holder leases. Returns the ports. */
  sweep(): number[];
}
```

- Port range 1–65535. `ttlMs` default `policy.defaultLeaseTtlMs`, range 10 000–86 400 000.
- A lease file is created with `fs.openSync(path, "wx", 0o600)` then written and closed; `EEXIST` means the port is leased. This is the only mutual exclusion and it is atomic on all three platforms.
- A lease is **dead** when `now > expiresAt` or `alive(holder)` is false. `acquire` and `check` treat a dead lease as absent; `acquire` deletes it first.
- `check` order: (1) live lease held by another job → `{ kind: "lease", … }`; (2) any listener on that port, on any address, whose `jobId` is not `forJobId` → `{ kind: "listener", … }`; else `null`. `acquire` runs `check` then creates the file.
- `listeners` defaults to the listening sockets of the most recent `listAgentTrees()` result held by the caller; it must not trigger a scan. `alive` defaults to `supervisorAlive`.
- Leases are advisory. agtop never binds, proxies or blocks a port.

### 8.2 `src/policy.ts` (Unit 3.2)

```ts
export const DEFAULT_ADMISSION_POLICY: AdmissionPolicy;
/** Returns a complete, validated policy or throws FleetError("E_INVALID_REQUEST", …, { field }). */
export function parseAdmissionPolicy(value: unknown): AdmissionPolicy;
export function loadAdmissionPolicy(): AdmissionPolicy;                 // fleet/policy.json merged over defaults; defaults if absent
export function saveAdmissionPolicy(policy: AdmissionPolicy): void;     // atomic temp + rename, mode 0600

export interface PolicyBlock { rule: PolicyRule; measured: number | null; threshold: number }
export interface PolicyTransition { rule: PolicyRule; decision: "defer" | "resume"; measured: number; threshold: number }
export class ResourcePolicyGuard {
  constructor(policy: AdmissionPolicy, probes?: {
    accelerators?: () => AcceleratorSnapshot | undefined; freeMemoryMb?: () => number; now?: () => number;
  });
  setPolicy(policy: AdmissionPolicy): void;
  /** Samples once and updates hysteresis state. Call once per scheduler tick. */
  sample(): PolicyTransition[];
  /** Pure with respect to the last sample. */
  evaluate(resources: ResourceRequest): PolicyBlock[];
  state(): GuardState[];
}
```

- GPU measure: the maximum `utilizationPercent` over devices of kind `"gpu"` in `getAcceleratorSnapshot()`; NPU likewise. If no device of that kind reports a number, the measure is `null`.
- Hysteresis per rule: a guard **closes** when `measured >= busyPercent` and **opens** when `measured <= resumePercent`. Between the two it keeps its state. A `null` measure opens the guard: agtop never blocks on a value it cannot measure.
- Memory: `freeMemoryMb` defaults to `os.freemem() / 1048576`. `memory-low` closes when `free < minFreeMemoryMb` and opens when `free >= resumeFreeMemoryMb`.
- `evaluate`: `resources.gpu` and a closed `gpu-busy` guard → block; `resources.npu` and closed `npu-busy` → block; closed `memory-low` → block for every request; additionally `resources.memoryMb` set and `free - memoryMb < minFreeMemoryMb` → `memory-low` block with `threshold = minFreeMemoryMb + memoryMb`.
- The guard only defers admission. It never suspends, throttles or signals a running job.

### 8.3 `src/queue.ts` (Unit 3.3)

Pure logic: no file, process or clock access except the injected `nowMs`.

```ts
export function effectivePriority(entry: QueueEntry, policy: AdmissionPolicy, nowMs: number): number;
export function orderQueue(entries: QueueEntry[], policy: AdmissionPolicy, nowMs: number): QueueEntry[];
/** Throws FleetError E_DEPENDENCY_NOT_FOUND or E_DEPENDENCY_CYCLE. */
export function validateDependencies(jobId: string, dependsOn: string[], known: (jobId: string) => { dependsOn: string[] } | undefined): void;

export interface AdmissionInput {
  nowMs: number; policy: AdmissionPolicy;
  /** PID of the calling supervisor; only its entries can be admitted or failed. */
  ownSupervisorPid: number;
  /** Every queued entry of every supervisor. */
  queued: QueueEntry[];
  job(jobId: string): Pick<JobRecordV2, "state" | "exitCode"> | undefined;
  running: { total: number; perPeer: Map<string, number>; perHarness: Map<string, number> };
  leaseCheck(port: number, jobId: string): LeaseHolder | null;
  policyBlocks(resources: ResourceRequest): PolicyBlock[];
}
export interface AdmissionPlan {
  /** Own entries to start now, in order. */
  admit: string[];
  /** Own entries to fail now. */
  fail: Array<{ jobId: string; reason: "dependency-failed" | "queue-timeout"; detail: string }>;
  /** Every queued entry in global order with its position (1-based) and block reasons (empty for admitted entries). */
  views: QueueEntryView[];
}
export function planAdmission(input: AdmissionInput): AdmissionPlan;
```

- `effectivePriority = priority + min(agingMaxBoost, floor((nowMs - Date.parse(enqueuedAt)) / agingIntervalMs) * agingStep)`.
- `orderQueue`: `effectivePriority` descending, then `enqueuedAt` ascending, then `jobId` ascending (plain string comparison).
- `planAdmission` walks the global order once, keeping mutable copies of `running`, a set of ports claimed in this pass, and a set `starvedKinds` of resource kinds (`"gpu"`, `"npu"`, `"memory"`). For each entry:
  1. Dependencies: a dependency in `failed`, `killed`, `lost`, or `exited` with nonzero `exitCode`, or one that no longer exists → own entries go to `fail` with `dependency-failed`; foreign entries are skipped. A dependency not yet `exited` → block `{ kind: "dependency", jobIds }`.
  2. `maxQueueMs > 0` and waited longer → own entries go to `fail` with `queue-timeout`.
  3. Caps, in the order global, peer, harness → block `{ kind: "cap", … }`.
  4. Leases: for each port, `leaseCheck`, or a claim earlier in this pass → block `{ kind: "lease", … }`.
  5. Policy: `policyBlocks(resources)` → blocks `{ kind: "policy", … }`; add the entry's requested kinds to `starvedKinds` (`gpu` if `resources.gpu`, `npu` if `resources.npu`, `memory` if `resources.memoryMb`).
  6. Anti-starvation: if the entry has no blocks so far but requests a kind already in `starvedKinds` (set by a higher-ranked entry), block `{ kind: "outranked", byJobId }` naming that entry.
  7. No blocks: increment the running copies and claim its ports whether the entry is own or foreign (a foreign supervisor will admit it). Own entries are appended to `admit`.
- Entries blocked by dependencies, caps or leases do not hold back lower-ranked entries. Only policy blocks do, and only for the same resource kind.

### 8.4 `src/scheduler.ts` (Unit 3.4)

```ts
export class Scheduler {
  constructor(deps: { runtime: JobRuntime; index: JobIndex; leases: LeaseManager; guard: ResourcePolicyGuard;
    policy: () => AdmissionPolicy; listeners: () => ListenerInfo[]; now?: () => number });
  start(): void;                       // setInterval(policy().pollMs), unref()ed
  stop(): void;
  /** Runs one admission pass now. Passes never overlap; a call during a pass schedules exactly one follow-up. */
  tick(): Promise<AdmissionPlan>;
  view(): QueueEntryView[];            // from the last plan
}
```

One tick, entirely inside `withFleetLock`:

1. `index.refresh()`; `leases.sweep()`; `guard.sample()` (write a `PolicyEvent` to each own queued job affected by a transition).
2. Process `kill.request` markers of own queued jobs → `runtime.kill(jobId, "cancelled")`.
3. `planAdmission(...)`.
4. For each `fail`: `runtime.fail(...)`.
5. For each `admit`, in order: acquire its leases (`LeaseEvent acquired` each); on `E_LEASE_CONFLICT` write `LeaseEvent conflict`, release what was acquired, leave it queued. Otherwise append the `starting` state event (this is what makes the admission visible to other supervisors) and release the lock **before** spawning; `runtime.start(jobId)` continues outside the lock.

Ticks are triggered by the timer, by every submission, and by every terminal transition of an own job.

### 8.5 Fleet lock, liveness and repair

`withFleetLock` serializes admission and reconciliation across processes:

- Acquire: `fs.openSync(<fleetDir>/lock, "wx", 0o600)` and write `{ pid, startTime }` (a `SupervisorIdentity` without `surface`). On `EEXIST`, read the holder; if `supervisorAlive` is false, delete the file and retry; otherwise wait 10 ms and retry. Default `timeoutMs` 5000, then throw `FleetError("E_INTERNAL", "Fleet lock timeout")`.
- Release: delete the file in a `finally` block.
- Never hold the lock across a process spawn, a process scan, or any network call.

`supervisorAlive(id, snapshot)`: `id.pid > 0` and the snapshot (default `processSnapshot()` from `src/registry.ts`) contains a process with that `pid` and the same `startTime`. `{ pid: 0 }` (migrated v1 jobs) is never alive for this purpose. If the snapshot cannot be taken (it throws), treat every supervisor as alive: unknown is never treated as dead.

`EventStore.repair(jobId)` may be called only by `reconcileFleet`, inside the lock, for a job whose supervisor is not alive.

### 8.6 Kill requests

Any process may ask for a job to stop, but only the supervisor writes the outcome. `src/job-runtime.ts` exports:

```ts
export interface KillRequest { by: string; reason: "kill-requested" | "cleanup" | "cancelled"; at: string; detail?: string }
export function writeKillRequest(jobId: string, request: KillRequest): void;    // <jobDir>/kill.request, atomic temp + rename
export function readKillRequest(jobId: string): KillRequest | undefined;
```

To stop a job supervised by another process: write the marker, then, if the job is `starting`, `running` or `exiting`, call `killAgentTree(jobId)` (the v1 record makes this work). The supervisor, when its root exits or on its next scheduler tick for a queued job, reads the marker and records `killed` with the marker's `reason` instead of `exited`. `by` is `"session:<sessionId>"`, `"admin"`, or `"peer:<peerId>"`.

### 8.7 `src/fleet.ts` and `src/ownership.ts` (Unit 3.5)

`FleetService` is the only object the daemon, MCP server and CLI call. They never import `job-runtime`, `scheduler`, `queue`, `leases`, `policy`, `event-store` or `job-index` directly.

```ts
// src/ownership.ts
export type Caller =
  | { kind: "admin" }
  | { kind: "session"; session: SessionIdentity; peer: string }
  | { kind: "peer"; peer: DaemonPeer };
export function isOwner(record: JobRecordV2, caller: Caller): boolean;
export function canSee(record: JobRecordV2, caller: Caller): boolean;          // may appear in lists
export function canSeeCommand(record: JobRecordV2, caller: Caller): boolean;   // command, args, cwd
export function canReadOutput(record: JobRecordV2, caller: Caller): boolean;   // output and events
export function canKill(record: JobRecordV2, caller: Caller): boolean;
/** Throws FleetError("E_NOT_OWNER") with a fixed message per action. */
export function assertAllowed(action: "output" | "events" | "kill" | "read", record: JobRecordV2, caller: Caller): void;

// src/fleet.ts
export interface SubmitJobRequest {
  jobId?: string; harness?: HarnessType; command: string; args?: string[]; cwd?: string; peer?: string;
  extraEnv?: Record<string, string>; useLemonadeLocal?: boolean; lemonadeUrl?: string; cgroupRoot?: string;
  capture?: boolean; redact?: boolean; ringBytes?: number; spool?: SpoolMode; visibility?: OutputVisibility;
  admission?: "immediate" | "queued"; priority?: number; dependsOn?: string[]; resources?: ResourceRequest;
  leasePorts?: number[]; leaseTtlMs?: number; timeoutMs?: number; maxQueueMs?: number;
}
export interface JobView { job: JobSummaryV2; record?: JobRecordV2; queue?: QueueEntryView; leases: Array<Omit<PortLease, "leaseId" | "sessionId">>;
  truncation: { stdout: TruncationInfo | null; stderr: TruncationInfo | null } }
export class FleetService {
  static open(options: { surface: FleetSurface; session?: SessionIdentity; trees?: () => AgentProcessTree[] }): Promise<FleetService>;
  readonly session: SessionIdentity;
  submit(request: SubmitJobRequest, caller: Caller): Promise<JobSummaryV2>;
  list(filter: JobFilter & { limit?: number; after?: string }, caller: Caller): { jobs: JobSummaryV2[]; nextAfter: string | null };
  get(jobId: string, caller: Caller): JobView;
  output(jobId: string, query: OutputQuery, caller: Caller): OutputPage;
  events(jobId: string, query: EventsQuery, caller: Caller): EventsPage;
  kill(jobId: string, caller: Caller, detail?: string): Promise<{ job: JobSummaryV2; result: KillResult | null }>;
  wait(jobId: string, timeoutMs: number): Promise<{ exited: boolean; timedOut?: true; state: JobState; exitCode: number | null }>;
  queue(): { entries: QueueEntryView[]; guards: GuardState[]; policy: AdmissionPolicy };
  readonly leases: LeaseManager;
  setPolicy(policy: AdmissionPolicy): void;
  close(): Promise<void>;       // scheduler.stop(), runtime.shutdown()
}
```

Access rules (`ownership.ts`):

| Function | `admin` | `session` | `peer` |
| --- | --- | --- | --- |
| `isOwner` | false | `owner.sessionId === session.sessionId` and `timingSafeEqual(owner.tokenHash, session.tokenHash)` | `owner.remotePeerId === peer.id` |
| `canSee` | true | true (lists are shared, as v0.1) | `isOwner`, or `record.peer` starts with one of `peer.jobPeerPrefixes` |
| `canSeeCommand` | true | `isOwner` | `isOwner` |
| `canReadOutput` | true | `isOwner`, or `visibility === "all"`, or `visibility === "peer"` and `record.peer === caller.peer` | `canSee` and (`isOwner` or `visibility === "all"`) |
| `canKill` | true | `isOwner` | `isOwner`, or `canSee` and peer has scope `jobs:kill-any` |

Scope checks for peers (`jobs:output` and so on) happen before these, in the federation listener (section 11.3). `tokenHash` comparison must use `crypto.timingSafeEqual` on equal-length buffers and return false for an empty stored hash.

`submit` defaults and validation (all failures are `E_INVALID_REQUEST` with `details.field` unless stated):

| Field | Default | Validation |
| --- | --- | --- |
| `jobId` | `randomUUID()` | `validateJobId`; `E_JOB_EXISTS` if non-terminal |
| `harness` | `"custom"` | member of `harnesses` |
| `command` | required | non-empty string, ≤ 4096 chars, no NUL |
| `args` | `[]` | string array, ≤ 256 items, each ≤ 32 768 chars |
| `cwd` | `process.cwd()` | existing directory |
| `peer` | session caller: `caller.peer`; admin: OS user name; peer caller: `"peer:" + peer.id` | ≤ 200 chars; a peer caller's value is always forced to start with `"peer:<id>"` |
| `capture` | `true` | boolean |
| `redact` | `true` | boolean; `false` writes an audit record (threat model, section 5.4) |
| `ringBytes` | 1 048 576 | integer 65 536–16 777 216 |
| `spool` | `"tail"` | `"tail"`, `"full"`, `"off"` |
| `visibility` | `"owner"` | `"owner"`, `"peer"`, `"all"` |
| `admission` | `"queued"` if any of `priority`, `dependsOn`, `leasePorts`, `resources`, `maxQueueMs` is present, else `"immediate"` | |
| `priority` | 0 | integer −100…100 |
| `dependsOn` | `[]` | ≤ 16 valid job IDs; `validateDependencies` |
| `resources` | `{}` | `gpu`, `npu` boolean; `memoryMb` integer 1–1 048 576 |
| `leasePorts` | `[]` | ≤ 8 distinct integers 1–65535 |
| `leaseTtlMs` | policy default | integer 10 000–86 400 000 |
| `timeoutMs` | 0 (none) | integer 0–604 800 000; measured from `running` |
| `maxQueueMs` | 0 (none) | integer 0–604 800 000 |

`admission: "immediate"` skips caps, policy and ordering and starts the job at once; it still counts toward other jobs' caps. If the caller passes `admission: "immediate"` together with `leasePorts`, `submit` runs `leases.check` for each port inside the fleet lock **before** creating the job and throws `E_LEASE_CONFLICT` without creating anything when a port is unavailable. `submit` resolves when the job is `running` (immediate) or as soon as it is durably `queued` (queued).

`output` routing: if this process supervises the job, read its ring (`source: "memory"`). Otherwise hydrate a ring from `store.readOutput(jobId)` (`source: "spool"`), cached per job in an LRU of 16 and re-hydrated when either segment's size or mtime changes. `capture.kind === "none"` → `E_CAPTURE_DISABLED`; `spool === "off"` and not supervised here → `E_OUTPUT_UNAVAILABLE`.

`list` never scans processes. `limit` default 100 (1–500); `after` is a job ID cursor in the list order.

`trees` (default: a function returning the last `listAgentTrees()` result the host process obtained, or `[]`) supplies listeners for lease conflict detection.

## 9. HTTP daemon API (Unit 4.1)

All routes are served by the existing loopback listener. Authentication is unchanged: `Authorization: Bearer <token>`, no `Origin` header. A valid bearer token is `Caller { kind: "admin" }`. Responses are `application/json` with `Cache-Control: no-store`. Request bodies are JSON, at most 65 536 bytes.

v0.1 routes (`/v1/harnesses`, `/v1/agents`, `/v1/accelerators`, `/v1/lemonade`, `POST /v1/agents`, `POST /v1/agents/:id/kill`) keep their exact behavior, including the `{ "error": string }` body with status 400 and the 401 body text. Every route below uses `FleetErrorBody` and the status table in section 2.7. `:id` is a URL-encoded job ID.

Unit 4.1 adds `src/daemon-routes.ts`:

```ts
export interface RouteContext { method: string; path: string; query: URLSearchParams; readBody(): Promise<unknown> }
/** Returns undefined when the path is not a fleet route, so daemon.ts falls through to its v0.1 routes. */
export function handleFleetRoute(fleet: FleetService, ctx: RouteContext): Promise<{ status: number; body: unknown } | undefined>;
```

and changes `src/daemon.ts` only to: construct `FleetService.open({ surface: "daemon" })`, call `handleFleetRoute` after authentication and before the v0.1 routes, map a thrown `FleetError` to its status and body, and call `fleet.close()` in `close()`. `startDaemon` options gain `federation?: { port: number; host?: string; certFile: string; keyFile: string }`, ignored until Unit 5.4. Unit 4.1 implements sections 9.1 and 9.2 only.

Query parameter parsing: integers must match `/^\d+$/`; anything else, or a value out of range, is `E_INVALID_REQUEST` with `details.field`. Unknown query parameters are ignored.

### 9.1 Jobs

| Method and path | Request | Success |
| --- | --- | --- |
| `GET /v1/jobs` | Query: `state` (comma-separated `JobState` values), `peer`, `harness`, `owner` (session ID), `limit` (1–500, default 100), `after` (job ID) | 200 `{ "jobs": JobSummaryV2[], "nextAfter": string \| null }` |
| `POST /v1/jobs` | Body: `SubmitJobRequest` | 201 `{ "job": JobSummaryV2 }` when the job is `running`; 202 with the same body when it is `queued` |
| `GET /v1/jobs/:id` | — | 200 `JobView` (with `record`) |
| `GET /v1/jobs/:id/output` | Query: `stream` (`stdout`, `stderr`, `both`; default `both`), `tail` (1–10 000 lines), `since` (default 0), `limit` (1–1000, default 200), `maxBytes` (1–4 194 304, default 1 048 576), `encoding` (`utf8`, `base64`; default `utf8`) | 200 `OutputPage` |
| `GET /v1/jobs/:id/events` | Query: `since` (default 0), `limit` (1–1000, default 200), `types` (comma-separated `JobEventType` values; default `state,spawn,exit,lease,policy`) | 200 `EventsPage` |
| `POST /v1/jobs/:id/kill` | Body: `{ "detail"?: string }` (≤ 500 chars) or empty | 200 `{ "job": JobSummaryV2, "result": KillResult \| null }` |

Errors: `GET` routes on an unknown job → 404 `E_JOB_NOT_FOUND`. `output`/`events` → 409 `E_CAPTURE_DISABLED` or 410 `E_OUTPUT_UNAVAILABLE`. `POST /v1/jobs` → 400, 409 `E_JOB_EXISTS`, 409 `E_LEASE_CONFLICT` (immediate admission only), 422, 429. Kill of a terminal job → 200 with `result: null` (idempotent). Kill with surviving PIDs → 409 `E_KILL_INCOMPLETE`.

Example:

```http
GET /v1/jobs/build-42/output?stream=stdout&tail=2&since=0 HTTP/1.1
Authorization: Bearer 5f0c…
```

```json
{
  "jobId": "build-42", "state": "running", "exitCode": null,
  "stream": "stdout", "since": 0, "nextSince": 918, "lastSeq": 921, "hasMore": false, "source": "memory",
  "outputBytes": { "stdout": 10485790, "stderr": 512 },
  "truncation": { "stdout": { "firstDroppedSeq": 4, "lastDroppedSeq": 901, "droppedBytes": 9437214 }, "stderr": null },
  "chunks": [
    { "seq": 918, "stream": "stdout", "timestamp": "2026-11-10T18:04:11.213Z", "offset": 10485711, "byteLength": 79,
      "encoding": "utf8", "data": "[412/412] linking\nkey=[REDACTED:openai-key] done\n", "truncated": false }
  ]
}
```

### 9.2 Queue, policy and leases

| Method and path | Request | Success |
| --- | --- | --- |
| `GET /v1/queue` | — | 200 `{ "entries": QueueEntryView[], "guards": GuardState[], "policy": AdmissionPolicy }` |
| `GET /v1/policy` | — | 200 `{ "policy": AdmissionPolicy }` |
| `PUT /v1/policy` | Body: a complete `AdmissionPolicy` | 200 `{ "policy": AdmissionPolicy }`; writes `fleet/policy.json` |
| `GET /v1/leases` | — | 200 `{ "leases": PortLease[] }` (admin sees `leaseId`) |
| `POST /v1/leases` | Body: `{ "port": number, "ttlMs"?: number, "peer"?: string, "jobId"?: string }` | 201 `{ "lease": PortLease }` |
| `POST /v1/leases/:port/renew` | Body: `{ "leaseId": string }` | 200 `{ "lease": PortLease }` |
| `DELETE /v1/leases/:port` | Query: `leaseId` (optional for admin) | 200 `{ "released": true }` |

A lease created through `POST /v1/leases` has `sessionId: "daemon"`, `holder` = the daemon, `peer` default = OS user name, `jobId` default `null`. Errors: 409 `E_LEASE_CONFLICT` with `details.holder`, 404 `E_LEASE_NOT_FOUND`, 403 `E_NOT_OWNER` when a supplied `leaseId` does not match.

### 9.3 Peers and remote proxy (Unit 5.3)

These routes live in `src/remote/routes.ts`, which exports

```ts
export function handleRemoteRoute(deps: { registry: PeerRegistry; proxy: RemoteProxy }, ctx: RouteContext): Promise<{ status: number; body: unknown } | undefined>;
```

Unit 5.4 adds the call to `src/daemon.ts`, after `handleFleetRoute` and before the v0.1 routes.

| Method and path | Request | Success |
| --- | --- | --- |
| `GET /v1/peers` | — | 200 `{ "self": LocalIdentity \| null, "peers": DaemonPeer[] }` |
| `POST /v1/peers` | Body: `{ id, url, publicKey, scopes, label?, tlsCertPem?, jobPeerPrefixes?, enabled? }` | 201 `{ "peer": DaemonPeer }` (upsert; `enabled` default true, `jobPeerPrefixes` default `[]`) |
| `DELETE /v1/peers/:peerId` | — | 200 `{ "removed": true }` |
| `GET /v1/remote/:peerId/jobs` | Same query as `GET /v1/jobs` | The peer's status and body |
| `GET /v1/remote/:peerId/jobs/:id` | — | The peer's status and body |
| `GET /v1/remote/:peerId/jobs/:id/output` | Same query as local | The peer's status and body |
| `GET /v1/remote/:peerId/jobs/:id/events` | Same query as local | The peer's status and body |
| `POST /v1/remote/:peerId/jobs/:id/kill` | Same body as local | The peer's status and body |
| `POST /v1/remote/:peerId/jobs` | `SubmitJobRequest` | The peer's status and body |
| `GET /v1/remote/:peerId/telemetry` | — | The peer's status and body |

`/v1/remote/:peerId/<rest>` is forwarded to `<peer.url>/fed/v1/<rest>` with the same method, query and body, signed as in section 11. A peer response with a JSON body is passed through with its status. Transport failures map to `E_PEER_UNREACHABLE`, `E_PEER_TIMEOUT`, `E_PEER_TLS`, `E_PEER_PROTOCOL`; an unknown or disabled `peerId` is `E_PEER_NOT_FOUND`.

### 9.4 JSON Schema for `SubmitJobRequest`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agtop.dev/schema/fleet/submit-job-request.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["command"],
  "properties": {
    "jobId": { "type": "string", "pattern": "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$" },
    "harness": { "type": "string", "maxLength": 80 },
    "command": { "type": "string", "minLength": 1, "maxLength": 4096 },
    "args": { "type": "array", "maxItems": 256, "items": { "type": "string", "maxLength": 32768 } },
    "cwd": { "type": "string", "maxLength": 4096 },
    "peer": { "type": "string", "maxLength": 200 },
    "extraEnv": { "type": "object", "additionalProperties": { "type": "string" } },
    "useLemonadeLocal": { "type": "boolean" },
    "lemonadeUrl": { "type": "string", "maxLength": 2048 },
    "cgroupRoot": { "type": "string", "maxLength": 4096 },
    "capture": { "type": "boolean", "default": true },
    "redact": { "type": "boolean", "default": true },
    "ringBytes": { "type": "integer", "minimum": 65536, "maximum": 16777216, "default": 1048576 },
    "spool": { "enum": ["tail", "full", "off"], "default": "tail" },
    "visibility": { "enum": ["owner", "peer", "all"], "default": "owner" },
    "admission": { "enum": ["immediate", "queued"] },
    "priority": { "type": "integer", "minimum": -100, "maximum": 100, "default": 0 },
    "dependsOn": { "type": "array", "maxItems": 16, "uniqueItems": true, "items": { "type": "string", "pattern": "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$" } },
    "resources": {
      "type": "object", "additionalProperties": false,
      "properties": { "gpu": { "type": "boolean" }, "npu": { "type": "boolean" }, "memoryMb": { "type": "integer", "minimum": 1, "maximum": 1048576 } }
    },
    "leasePorts": { "type": "array", "maxItems": 8, "uniqueItems": true, "items": { "type": "integer", "minimum": 1, "maximum": 65535 } },
    "leaseTtlMs": { "type": "integer", "minimum": 10000, "maximum": 86400000 },
    "timeoutMs": { "type": "integer", "minimum": 0, "maximum": 604800000, "default": 0 },
    "maxQueueMs": { "type": "integer", "minimum": 0, "maximum": 604800000, "default": 0 }
  }
}
```

Unknown top-level properties are rejected with `E_INVALID_REQUEST` and `details.field` naming the first one. The same rule applies to `PUT /v1/policy`, `POST /v1/leases` and `POST /v1/peers` bodies. Validation is hand-written (the daemon does not import zod).

`FleetErrorBody` schema:

```json
{
  "type": "object", "required": ["error", "code"], "additionalProperties": false,
  "properties": { "error": { "type": "string" }, "code": { "type": "string", "pattern": "^E_[A-Z_]+$" }, "details": { "type": "object" } }
}
```

## 10. MCP v2 surface (Unit 4.2)

Unit 4.2 adds `src/mcp-v2.ts`, which exports `registerFleetTools(server: McpServer, fleet: FleetService, helpers)` and `registerFleetResources(server, fleet)`, and edits `src/mcp.ts` to call them, to route `run`/`status`/`wait`/`kill`/`cleanup` through `FleetService`, and to update `VERSION` to `"0.2.0"`, `capabilities` to `{ tools: {}, resources: { subscribe: true, listChanged: true } }`, and `instructions`.

The MCP server process opens `FleetService.open({ surface: "mcp" })`. Every tool call uses `Caller { kind: "session", session: fleet.session, peer: <the v0.1 peerFor() label> }`. The v0.1 `owned` map is replaced by `isOwner`; a job is owned exactly when this process's session created it.

### 10.1 Tool changes

Existing tools keep their names, required inputs, and every v0.1 output field. Additions only:

`run` — new optional inputs (zod):

```ts
capture: z.boolean().optional().describe("Capture stdout and stderr into a bounded buffer readable with the output tool. Default true."),
redact: z.boolean().optional().describe("Redact secrets from captured output. Default true; false is audited."),
priority: z.number().int().min(-100).max(100).optional().describe("Queue priority; higher runs first. Passing it queues the job."),
dependsOn: z.array(z.string().min(1).max(80)).max(16).optional().describe("Job IDs that must exit with code 0 first."),
leasePorts: z.array(z.number().int().min(1).max(65535)).max(8).optional().describe("TCP ports this job will bind; the job waits until each is free."),
resources: z.object({ gpu: z.boolean().optional(), npu: z.boolean().optional(), memoryMb: z.number().int().min(1).max(1048576).optional() }).optional()
  .describe("Resources the job needs; the job waits while they are busy."),
timeoutMs: z.number().int().min(0).max(604800000).optional().describe("Kill the job this long after it starts. 0 or absent: no limit."),
visibility: z.enum(["owner", "peer", "all"]).optional().describe("Who may read this job's output. Default owner."),
```

`run` result: when the job is `running`, the v0.1 object plus `state: "running"` and `captured: boolean`. When it is `queued`: `{ jobId, state: "queued", harness, label, peer, cwd, captured, queue: { position, blockedBy } }` with no `pid` and no `containmentMode`. A v0.1-style call (none of `priority`, `dependsOn`, `leasePorts`, `resources`) is never queued.

`status` result — added fields: `state`, `stateReason`, `captured`, `outputBytes` (`{ stdout, stderr }`), `lastSeq`, and, when applicable, `queue` (`QueueEntryView`), `leases`, `truncation`. For a job that is known to the fleet store but has no live tree (queued or terminal), `status` returns the fleet fields plus the v0.1 `ownedSummary` fields for owned jobs. `outputBytes` and `lastSeq` are returned for every job; all other added fields only for jobs the session may read.

`wait` result — added field `state`. A timeout on a queued job returns `{ jobId, exited: false, timedOut: true, state: "queued" }`.

`kill` and `cleanup` — unchanged shapes. `kill` on an owned queued job cancels it and returns `{ jobId, cancelled: true, state: "killed" }`. Messages for non-owned jobs are unchanged from v0.1.

`list` — each job gains `state`, `captured`, `outputBytes`, `lastSeq`. Queued and recently finished fleet jobs are appended after live trees with `rootPid: null`, `processCount: 0`, and zero CPU and memory.

### 10.2 New tools

`output`:

```ts
server.registerTool("output", {
  title: "Read job output",
  description: "Read captured stdout/stderr of a job created by this MCP session. Returns the last lines by default; pass since to page forward. Output is bounded: older bytes are dropped and reported in truncation.",
  inputSchema: {
    jobId: z.string().min(1).max(80).describe("Job ID returned by run."),
    stream: z.enum(["stdout", "stderr", "both"]).optional().describe("Default both."),
    tail: z.number().int().min(1).max(2000).optional().describe("Return only the last N lines. Default 100 when since is absent."),
    since: z.number().int().min(0).optional().describe("Return chunks after this sequence number (nextSince of a previous call)."),
    maxBytes: z.number().int().min(1024).max(262144).optional().describe("Byte budget for this call. Default 65536."),
    format: z.enum(["text", "json"]).optional().describe("text (default) joins the output; json returns chunks."),
  },
  annotations: { readOnlyHint: true },
}, handler);
```

Result (a JSON text content block). `format: "text"`:

```json
{ "jobId": "task-dev", "state": "running", "exitCode": null, "stream": "both", "since": 0, "nextSince": 918,
  "lastSeq": 921, "hasMore": false, "outputBytes": { "stdout": 20480, "stderr": 0 },
  "truncation": { "stdout": null, "stderr": null }, "text": "ready on http://localhost:5173\n" }
```

`text` is `renderOutputText(page)`. `format: "json"` returns the `OutputPage` unchanged (`chunks` instead of `text`). Defaults: neither `tail` nor `since` → `tail: 100`; `maxBytes: 65536`; `limit` is not exposed (uses 200).

`events`:

```ts
server.registerTool("events", {
  title: "Read job events",
  description: "Read the lifecycle timeline of a job created by this MCP session: queue, start, exit, port leases, and admission decisions.",
  inputSchema: {
    jobId: z.string().min(1).max(80).describe("Job ID returned by run."),
    since: z.number().int().min(0).optional().describe("Return events after this sequence number."),
    limit: z.number().int().min(1).max(500).optional().describe("Default 100."),
    types: z.array(z.enum(["state", "spawn", "exit", "lease", "policy"])).optional().describe("Default: all lifecycle types."),
  },
  annotations: { readOnlyHint: true },
}, handler);
```

Result: `EventsPage`. Output events are not available through this tool; use `output`. In `StateEvent.record`, `owner.tokenHash` is replaced by `""`.

Failures use the existing `failure()` helper with text `agtop: <CODE>: <message>`. Fixed messages:

| Situation | Text |
| --- | --- |
| `output`/`events` on a job the session may not read | `agtop: E_NOT_OWNER: only jobs created by this MCP session can be read.` |
| Unknown job | `agtop: E_JOB_NOT_FOUND: no job named <jobId>.` |
| Capture off | `agtop: E_CAPTURE_DISABLED: this job was started without output capture.` |

### 10.3 Resources

Resource templates (registered with the SDK's `ResourceTemplate`; path segments only, no query strings):

| URI template | Content |
| --- | --- |
| `agtop://jobs/{jobId}/output/{stream}` | `OutputPage` for `{ stream, tail: 200, maxBytes: 262144 }`; `stream` is `stdout`, `stderr` or `both` |
| `agtop://jobs/{jobId}/output/{stream}/{since}` | `OutputPage` for `{ stream, since, maxBytes: 262144 }` |
| `agtop://jobs/{jobId}/events` | `EventsPage` for `{ limit: 200 }`, newest 200 lifecycle events |
| `agtop://jobs/{jobId}/events/{since}` | `EventsPage` for `{ since, limit: 200 }` |

- `contents` is one item: `{ uri, mimeType: "application/json", text: JSON.stringify(page) }`. Each page object carries an extra field `nextUri`: the cursor URI for the next page (`…/output/{stream}/{nextSince}` or `…/events/{nextSince}`), present also when `hasMore` is false so a client can poll it.
- `list` callback of the two cursor-less templates returns one resource per job the session may read (`name`: `"<jobId> output"` / `"<jobId> events"`); the cursor templates list nothing.
- Access checks are identical to the tools. A denied read throws an MCP error with the same text as the tool failure.
- Subscriptions: for the cursor-less URIs of jobs this process supervises, send `notifications/resources/updated` at most once every 500 ms per URI while new output or events arrive, and once at the terminal state. Send `notifications/resources/list_changed` when an owned job is created or pruned.

### 10.4 Instructions and skill

The `instructions` string in `src/mcp.ts` and `skills/agtop/SKILL.md` must continue to satisfy `test/docs.test.ts` as it stands today: both contain a phrase matching `/discards (stdout|output)/`, both contain `cleanup`, both match `/times out/`, both contain `only accepts jobs created by this MCP session`, and the skill description still starts with `Use when` and contains `Not for short commands whose output you need`. Use this sentence in both: `"run" captures stdout and stderr into a bounded buffer that "output" reads; with capture set to false it discards output.` Short commands whose output the agent needs still belong in the normal shell; `output` is for long-lived jobs.

## 11. Federation (Wave 5)

### 11.1 Identity and peer store — `src/remote/registry.ts` (Unit 5.1)

```ts
export class PeerRegistry {
  constructor(options?: { dir?: string });
  /** Creates identity.json and identity.key if absent. id default: os.hostname() lowercased, non [a-z0-9-] replaced by "-", trimmed to 63. */
  ensureIdentity(id?: string): LocalIdentity;
  self(): LocalIdentity | null;
  privateKey(): import("node:crypto").KeyObject;      // throws FleetError("E_INTERNAL") when no identity exists
  list(): DaemonPeer[];
  get(id: string): DaemonPeer | undefined;
  /** Validates and writes peers.json atomically (temp + rename, 0600). Throws E_INVALID_REQUEST. */
  upsert(input: Pick<DaemonPeer, "id" | "url" | "publicKey" | "scopes"> & Partial<Pick<DaemonPeer, "label" | "tlsCertPem" | "jobPeerPrefixes" | "enabled">>): DaemonPeer;
  remove(id: string): boolean;
  touch(id: string, at: Date): void;                  // lastSeenAt; in memory, flushed at most once per minute
}
```

Keys: `crypto.generateKeyPairSync("ed25519")`. `identity.key` is the private key exported as PKCS#8 PEM. `publicKey` strings are the raw 32 bytes (the last 32 bytes of the SPKI DER export) in standard base64; import with `createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" })`.

`list()` and `get()` re-read `peers.json` when its mtime or size differs from the last read, so edits made by `agtop peers` reach a running daemon without a restart.

Validation: `id` pattern; `url` parses, protocol `https:`, no path other than `/`, no query, no credentials; `publicKey` decodes to exactly 32 bytes; `scopes` are distinct `PeerScope` values; `jobPeerPrefixes` ≤ 16 strings of 1–200 chars; `tlsCertPem` ≤ 16 384 chars and parses with `new crypto.X509Certificate`.

### 11.2 Request signing — `src/remote/auth.ts` (Unit 5.2)

```ts
export const SIGNATURE_VERSION = "AGTOP-ED25519-V1";
export const MAX_SKEW_MS = 60_000, NONCE_TTL_MS = 120_000, NONCE_CACHE_MAX = 4096;
export interface SignedRequestInput {
  method: string;            // uppercase
  pathWithQuery: string;     // exactly as sent on the request line, e.g. "/fed/v1/jobs/a/output?tail=100"
  timestampMs: number; nonce: string;
  senderId: string;          // X-Agtop-Peer
  audienceId: string;        // the receiving daemon's LocalIdentity.id
  body: Buffer;              // empty buffer when there is no body
}
export function canonicalRequest(input: SignedRequestInput): string;
export function signRequest(privateKey: import("node:crypto").KeyObject, input: Omit<SignedRequestInput, "timestampMs" | "nonce"> & { timestampMs?: number; nonce?: string }): PeerAuthHeaders;
export class PeerAuth {
  constructor(registry: PeerRegistry, options?: { now?: () => number });
  /** Returns the authenticated peer or throws FleetError. */
  verify(request: { method: string; pathWithQuery: string; headers: Record<string, string | string[] | undefined>; body: Buffer }): DaemonPeer;
  /** Throws FleetError("E_FORBIDDEN_SCOPE", …, { scope }). */
  requireScope(peer: DaemonPeer, scope: PeerScope): void;
}
```

Headers:

| Header | Value |
| --- | --- |
| `X-Agtop-Peer` | Sender's peer ID |
| `X-Agtop-Timestamp` | Sender's clock, integer milliseconds since the Unix epoch, decimal |
| `X-Agtop-Nonce` | 16 random bytes, base64url without padding (22 characters) |
| `X-Agtop-Signature` | Ed25519 signature of the canonical request, base64url without padding (86 characters) |

Canonical request: these eight lines joined with `\n`, no trailing newline, encoded as UTF-8:

```
AGTOP-ED25519-V1
<METHOD>
<pathWithQuery>
<timestampMs>
<nonce>
<senderId>
<audienceId>
<lowercase hex SHA-256 of the body bytes>
```

Sign with `crypto.sign(null, Buffer.from(canonical), privateKey)`; verify with `crypto.verify(null, …)`. The SHA-256 of an empty body is `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

`verify` steps, in this order; the first failure throws:

1. All four headers present, single-valued, and well-formed (`Peer` matches the ID pattern, `Timestamp` matches `/^\d{13}$/`, `Nonce` matches `/^[A-Za-z0-9_-]{22}$/`, `Signature` matches `/^[A-Za-z0-9_-]{86}$/`) → else `E_UNAUTHORIZED` (headers missing) or `E_SIGNATURE_INVALID` (malformed).
2. Peer exists and `enabled` → else `E_SIGNATURE_INVALID`.
3. `|now - timestamp| <= MAX_SKEW_MS` → else `E_CLOCK_SKEW` with `details.serverTimeMs`.
4. Signature verifies over the canonical request built with `audienceId = registry.self().id` → else `E_SIGNATURE_INVALID`.
5. Nonce not in this peer's cache → else `E_REPLAY`. Evict entries older than `NONCE_TTL_MS`; if the cache still holds `NONCE_CACHE_MAX` entries → `E_REPLAY_CACHE_FULL`. Insert the nonce.

The nonce is checked after the signature so that unauthenticated traffic cannot fill a peer's cache. Every failure appends an audit record.

### 11.3 Federation listener — `src/remote/server.ts` (Unit 5.4)

```ts
export async function startFederationListener(options: {
  fleet: FleetService; registry: PeerRegistry; auth: PeerAuth;
  port: number; host?: string;          // host default "0.0.0.0"
  certFile: string; keyFile: string;
}): Promise<{ port: number; close(): Promise<void> }>;
```

An `https.createServer` with `minVersion: "TLSv1.3"`. It refuses to start (throws `FleetError("E_INTERNAL")` with a clear message) when no identity exists, when `assertPrivateFile(identity.key)` fails, or, on Windows, when `hardenWindowsAcl(identity.key)` fails. It serves only `/fed/v1/*`; the loopback listener never serves `/fed/*` and this listener never serves `/v1/*`. The bearer token is not accepted here. Body limit 65 536 bytes (`E_BODY_TOO_LARGE`), `requestTimeout` and `headersTimeout` 10 000 ms. Each request: read the body, `auth.verify`, `requireScope`, then call `FleetService` with `Caller { kind: "peer", peer }`.

| Route | Scope | Behavior |
| --- | --- | --- |
| `GET /fed/v1/hello` | none (authenticated) | 200 `{ "id": string, "version": "0.2.0", "scopes": PeerScope[] }` — the caller's granted scopes |
| `GET /fed/v1/jobs` | `jobs:list` | As `GET /v1/jobs`, filtered by `canSee` |
| `GET /fed/v1/jobs/:id` | `jobs:read` | `JobView` without `record` unless `isOwner` |
| `GET /fed/v1/jobs/:id/output` | `jobs:output` | As local; `E_NOT_OWNER` unless `canReadOutput` |
| `GET /fed/v1/jobs/:id/events` | `jobs:events` | As local; `E_NOT_OWNER` unless `canReadOutput`; `owner.tokenHash` blanked |
| `POST /fed/v1/jobs` | `jobs:submit` | As `POST /v1/jobs`; `owner = { sessionId: "peer:<id>", tokenHash: "", surface: "remote", remotePeerId: <id> }`; `extraEnv`, `cgroupRoot` and `redact: false` are rejected with `E_INVALID_REQUEST` |
| `POST /fed/v1/jobs/:id/kill` | `jobs:kill` (own jobs) or `jobs:kill-any` | `E_NOT_OWNER` unless `canKill` |
| `GET /fed/v1/telemetry` | `telemetry:read` | 200 `{ "accelerators": AcceleratorSnapshot \| null, "running": number, "queued": number, "guards": GuardState[] }` |

A job the peer cannot see is reported as `E_JOB_NOT_FOUND`, not `E_NOT_OWNER`, so job IDs do not leak.

### 11.4 Outbound client — `src/remote/proxy.ts` (Unit 5.3)

```ts
export const REMOTE_TIMEOUT_MS = 10_000, REMOTE_MAX_RESPONSE_BYTES = 8_388_608;
export class RemoteProxy {
  constructor(registry: PeerRegistry, options?: { timeoutMs?: number; request?: typeof import("node:https").request });
  /** path starts with "/fed/v1/". Resolves with the peer's status and parsed JSON body; rejects with FleetError E_PEER_*. */
  forward(peerId: string, method: "GET" | "POST", path: string, query: URLSearchParams, body?: unknown): Promise<{ status: number; body: unknown }>;
}
```

- `audienceId` is `peer.id`; `senderId` is `registry.self().id`.
- TLS: when `peer.tlsCertPem` is set, pass `ca: [peer.tlsCertPem]` and `checkServerIdentity: (_host, cert) => cert.fingerprint256 === new X509Certificate(peer.tlsCertPem).fingerprint256 ? undefined : new Error("certificate mismatch")`. Otherwise use Node defaults. Never set `rejectUnauthorized: false`.
- No redirects, no proxy (`agent: false`), `Content-Type: application/json`, request body at most 65 536 bytes.

## 12. Desktop (Unit 4.4)

`desktop/src/model.rs` — add (all `#[derive(Clone, Debug, Default, Deserialize)]` with `#[serde(rename_all = "camelCase")]` unless noted):

```rust
pub struct OutputCounters { pub stdout: u64, pub stderr: u64 }

pub struct TruncationInfo { pub first_dropped_seq: u64, pub last_dropped_seq: u64, pub dropped_bytes: u64 }

pub struct Truncation {
    #[serde(default)] pub stdout: Option<TruncationInfo>,
    #[serde(default)] pub stderr: Option<TruncationInfo>,
}

pub struct OutputChunk {
    pub seq: u64,
    pub stream: String,            // "stdout" | "stderr"
    pub timestamp: String,
    pub offset: u64,
    pub byte_length: u64,
    pub encoding: String,          // the desktop always requests utf8
    pub data: String,
    #[serde(default)] pub truncated: bool,
    #[serde(default)] pub first_dropped_seq: Option<u64>,
}

pub struct OutputPage {
    pub job_id: String,
    pub state: String,
    #[serde(default)] pub exit_code: Option<i64>,
    pub next_since: u64,
    pub last_seq: u64,
    #[serde(default)] pub has_more: bool,
    #[serde(default)] pub source: String,
    #[serde(default)] pub output_bytes: OutputCounters,
    #[serde(default)] pub truncation: Truncation,
    #[serde(default)] pub chunks: Vec<OutputChunk>,
}

pub struct JobEvent {
    pub seq: u64,
    pub timestamp: String,
    #[serde(rename = "type")] pub kind: String,
    #[serde(default)] pub state: Option<String>,
    #[serde(default)] pub reason: Option<String>,
    #[serde(default)] pub detail: Option<String>,
    #[serde(default)] pub exit_code: Option<i64>,
    #[serde(default)] pub port: Option<u16>,
    #[serde(default)] pub action: Option<String>,
    #[serde(default)] pub decision: Option<String>,
    #[serde(default)] pub rule: Option<String>,
    #[serde(default)] pub pid: Option<u32>,
}

pub struct EventsPage {
    pub next_since: u64,
    pub last_seq: u64,
    #[serde(default)] pub has_more: bool,
    #[serde(default)] pub events: Vec<JobEvent>,
}
```

Unknown JSON fields are ignored (serde default), so the desktop tolerates additive daemon changes.

`desktop/src/client.rs` — add:

```rust
pub enum Command {
    Refresh,
    Stop { id: String, start_time: String },
    Launch(Launch),
    /** Some(id): start polling this job's output and events. None: stop. */
    WatchJob(Option<String>),
}
pub enum Event {
    // existing variants unchanged
    JobOutput { id: String, page: OutputPage },
    JobEvents { id: String, page: EventsPage },
    JobDetailUnavailable { id: String, message: String },
}
```

Worker loop changes: keep `watched: Option<(String, u64, u64)>` (job ID, output cursor, events cursor). `WatchJob(Some(id))` resets it to `(id, 0, 0)`; the first output request is `/v1/jobs/{id}/output?stream=both&tail=500&since=0`, later ones `/v1/jobs/{id}/output?stream=both&since={cursor}&maxBytes=262144`; events use `/v1/jobs/{id}/events?since={cursor}&limit=200`. After each response set the cursor to `next_since` and repeat immediately while `has_more`. While a job is watched the `recv_timeout` is 1 second instead of 2. The existing `get` helper must surface the daemon's `error` text for non-success statuses on these routes; map 404, 409 and 410 to `JobDetailUnavailable` (not `Event::Error`) and stop watching that job. Job IDs go through the existing `encode_segment`.

`desktop/src/job_detail.rs` (new) owns the view state: `pub struct JobDetail { pub job_id: String, pub lines: VecDeque<(String, String)>, pub events: Vec<JobEvent>, pub truncation: Truncation, pub state: String, pub exit_code: Option<i64>, pub unavailable: Option<String> }` with `pub fn apply_output(&mut self, page: OutputPage)` (splits chunk data into lines per stream, keeps the newest 5000 lines, inserts one marker line for a chunk with `truncated`), `pub fn apply_events(&mut self, page: EventsPage)`, and a `render` function used by `ui.rs` in a detail pane below the process tree. `ui.rs` sends `WatchJob` when the selection changes. `main.rs` gains `mod job_detail;`.

## 13. Compatibility rules

1. `src/types.ts` changes are additive, except the widening of `SpawnAgentOptions.stdio` and the new optional fields in section 7.1.
2. `JobRecord` (v1), `readJobs`, `writeJob`, `reserveJob`, `isStaleJob`, `pruneStaleJobs` keep their signatures and behavior. `readJobs` still returns only `version === 1` records from `<stateDir>/*.json`.
3. `spawnContainedAgent` with `stdio` absent, `"ignore"` or `"inherit"` behaves exactly as v0.1.
4. `agtop run` (CLI) stays a foreground supervisor with inherited stdio and does not create a fleet record.
5. `POST /v1/agents` stays an immediate launch with ignored stdio and no fleet record. `POST /v1/agents/:id/kill` is unchanged and works on fleet jobs too (it does not write a kill marker, so such a job ends as `exited`).
6. Every v0.1 MCP tool accepts every v0.1 input and returns every v0.1 output field with the same meaning. The one behavioral v0.2 change: `run` captures output by default (`capture: true`) instead of discarding it. Pass `capture: false` for the exact v0.1 behavior.
7. MCP shutdown and `cleanup` still terminate the session's jobs; fleet jobs are recorded as `killed` with reason `supervisor-shutdown` or `cleanup`.
8. `agtop cleanup --stale` additionally prunes terminal fleet jobs past retention and reports them in the same `stale` array.
9. No new runtime dependency. CRC-32, framing, Ed25519 and TLS use Node built-ins; Koffi is used only where it already is, plus `CreateFileW` in `src/windows-pipes.ts`.
10. Existing test files are not edited, with one exception: Unit 4.2 may add assertions to `test/docs.test.ts` and must keep the existing ones passing unmodified. New MCP cases go in `test/mcp-v2.test.ts`.

## 14. `src/job-state.ts` (Unit 1.1)

```ts
export const TERMINAL_STATES: ReadonlySet<JobState>;     // exited, failed, killed, lost
export const RUNNING_STATES: ReadonlySet<JobState>;      // starting, running, exiting
export const LEGAL_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>>;
export function isLegalTransition(from: JobState | null, to: JobState): boolean;   // from null: only "queued" is legal
export function isTerminal(state: JobState): state is TerminalJobState;
```

`LEGAL_TRANSITIONS` is exactly:

```ts
{
  queued:   ["starting", "killed", "failed", "lost"],
  starting: ["running", "failed", "lost"],
  running:  ["exiting", "lost"],
  exiting:  ["exited", "killed", "failed", "lost"],
  exited: [], failed: [], killed: [], lost: [],
}
```

`JobEventWriter.appendState` throws `Error("Illegal job transition <from> -> <to>")` for anything else. This is a programming error, not a `FleetError`.

## 15. `src/secure-fs.ts` and `src/audit.ts` (Unit 1.5)

```ts
// src/secure-fs.ts
/** mkdir -p with mode 0700; chmod 0700 on POSIX; hardenWindowsAcl once per directory per process on Windows. */
export function ensurePrivateDir(dir: string): void;
/** Write to "<file>.<pid>.tmp" with mode 0600, then rename over file. */
export function writePrivateFileAtomic(file: string, data: string | Buffer): void;
/** open(file, "wx", 0600), write, close. Returns false on EEXIST; rethrows anything else. */
export function createPrivateFileExclusive(file: string, data: string | Buffer): boolean;
/** POSIX: throws if (mode & 0o077) !== 0 or the owner is not the current uid. Windows: no-op. */
export function assertPrivateFile(file: string): void;
/** Windows only; returns { ok: true } elsewhere. Never throws. */
export function hardenWindowsAcl(target: string): { ok: boolean; message?: string };

// src/audit.ts
export type AuditEvent =
  | "redact-disabled" | "peer-auth-failed" | "peer-submit" | "peer-kill" | "peer-added" | "peer-removed"
  | "policy-changed" | "admin-kill" | "acl-hardening-failed";
export interface AuditRecord { timestamp: string; event: AuditEvent; actor: string; jobId?: string; peerId?: string; code?: FleetErrorCode; detail?: string }
/** Appends one frame to <fleetDir>/audit.jsonl. Rotates to audit.prev.jsonl at 4 MiB. Never throws. */
export function audit(record: Omit<AuditRecord, "timestamp">): void;
export function readAudit(limit?: number): AuditRecord[];       // newest last; default 200
```

`hardenWindowsAcl` runs `icacls.exe <target> /inheritance:r /grant:r <user>:<rights>` through `execFileSync` with `windowsHide: true`, a 5000 ms timeout and no shell. `<rights>` is `(OI)(CI)F` for a directory and `F` for a file. `<user>` is `USERDOMAIN\USERNAME` when both environment variables are set, otherwise `os.userInfo().username`. A failure is returned, not thrown, and the caller records an `acl-hardening-failed` audit event and continues.

`actor` uses the same vocabulary as `KillRequest.by`. `detail` is passed through `redactText` and cut to 500 characters.

`FleetService.open` calls `ensurePrivateDir(fleetDir())` before anything else touches the directory. Lease, policy, peer, identity and kill-marker files are written only through `writePrivateFileAtomic` or `createPrivateFileExclusive`. `PeerRegistry.privateKey()` calls `assertPrivateFile` on `identity.key` and refuses to load a key that others can read.

## 16. CLI (Units 4.3 and 5.1)

`src/cli-fleet.ts` exports `fleetCommand(command: string, args: string[]): Promise<boolean>`; it returns false when `command` is not one of its commands. `src/cli.ts` calls it before the final "Unknown command" error and adds one help line per command. Read-only commands open `FleetService.open({ surface: "cli" })` with `Caller { kind: "admin" }` (the CLI runs as the OS user who owns the state directory) and read from disk; they do not need a daemon.

| Command | Behavior |
| --- | --- |
| `agtop jobs [--state S[,S…]] [--json]` | `fleet.list`. Text: one line per job: `jobId  state  harness  peer  exitCode  outputBytes`. |
| `agtop logs JOB_ID [--stream stdout/stderr/both] [--tail N] [--since SEQ] [--follow] [--json]` | `fleet.output`. Default `--tail 100`. Text mode writes `renderOutputText`. `--follow` polls every 500 ms with the returned `nextSince` until the job is terminal. `--json` prints each `OutputPage`. |
| `agtop events JOB_ID [--since SEQ] [--json]` | `fleet.events`. Text: `seq  timestamp  type  summary`. |
| `agtop queue [--json]` | `fleet.queue()`. |
| `agtop leases [--json]` | `fleet.leases.list()` without `leaseId`. |
| `agtop submit [--port 13309] [run options] [--priority N] [--depends-on ID]… [--lease-port P]… [--gpu] [--npu] [--memory-mb N] [--timeout MS] [--no-capture] [--no-redact] -- COMMAND [ARGS…]` | Sends `POST /v1/jobs` to the local daemon using the token file `daemon-<port>.token`; prints the response JSON. Exits 1 with the daemon's `error` text on failure. The CLI itself never supervises a fleet job. |
| `agtop daemon [--port N] [--federation-port N --tls-cert FILE --tls-key FILE [--federation-host HOST]]` | Options may appear in any order. `--federation-port` requires both TLS files. Passed to `startDaemon` as `federation`. |
| `agtop peers init [--id ID]` | Unit 5.1, `src/cli-peers.ts`: `PeerRegistry.ensureIdentity`; prints `{ id, publicKey }`. |
| `agtop peers list [--json]`, `agtop peers add --id ID --url URL --public-key KEY [--scope S]… [--prefix P]… [--tls-cert FILE]`, `agtop peers remove ID` | Unit 5.1: edit `peers.json` through `PeerRegistry`. A running daemon re-reads `peers.json` when its mtime changes. |

`src/cli-peers.ts` exports `peersCommand(args: string[]): Promise<void>`; Unit 5.1 adds the `peers` dispatch line and help line to `src/cli.ts`.

Exit codes: 0 on success, 1 on any error (message on stderr as `agtop: <text>`), matching v0.1.
