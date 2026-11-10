# agtop Fleet v0.2: architecture decision records

Status of every record: **accepted** for v0.2. Related: [architecture](fleet-v0.2.md), [contracts](fleet-contracts.md), [threat model](fleet-threat-model.md), [acceptance](fleet-acceptance.md).

Measurements quoted here come from the Phase 0 spike (`spike/fleet-v0.2-capture`, Windows 11, Bun 1.4.4); the full table is in [fleet-v0.2.md, section 8](fleet-v0.2.md#8-spike-results).

| ADR | Decision in one line |
| --- | --- |
| [001](#adr-001-pipe-capture-in-v02-pty-behind-agtop_pty1-in-v03) | Capture through non-blocking OS pipes now; PTY later behind a provider seam |
| [002](#adr-002-event-store-framed-jsonl-plus-an-in-memory-index) | Per-job framed, checksummed JSONL plus an in-memory index; fsync on state changes only |
| [003](#adr-003-ring-buffer-size-byte-safety-and-truncation) | 1 MiB binary-safe ring per job, oldest-first eviction with a stderr reserve, prefix truncation metadata |
| [004](#adr-004-cooperative-admission-not-preemption) | Cooperative admission queue; never suspend or throttle a running job |
| [005](#adr-005-per-peer-ed25519-request-signing-over-tls) | Per-peer Ed25519 request signatures over TLS with scopes; no shared bearer token across machines |
| [006](#adr-006-mcp-tools-for-actions-and-bounded-queries-resources-for-streams) | MCP tools for actions and bounded queries, MCP resources for cursor-paged streams |
| [007](#adr-007-v1-records-coexist-with-jobrecordv2) | v1 job records are kept and coexist; nothing is migrated in place |
| [008](#adr-008-redaction-is-on-by-default-and-runs-before-storage) | Redaction is default-on and runs before any storage; opt-out is per job and audited |

---

## ADR-001: Pipe capture in v0.2, PTY behind `AGTOP_PTY=1` in v0.3

### Context

v0.1 launches background jobs with ignored stdio. Agents cannot see why a dev server or build failed, so they rerun it in a shell, outside containment. Capture must work with the existing launch paths without weakening them: Windows uses `CreateProcessW` with `PROC_THREAD_ATTRIBUTE_JOB_LIST` and a suspended first thread; POSIX uses a `/bin/sh` launcher gated on fd 3, a process group, and a watchdog or cgroup. A capture mechanism must never block the child, even when the daemon is slow.

### Decision

Capture stdout and stderr through ordinary OS pipes, drained by an always-flowing reader with no backpressure.

- POSIX: Node's own `child_process` pipes on fds 1 and 2 of the existing launcher.
- Windows: one libuv named-pipe server per stream in the supervisor; the child receives synchronous client handles opened with `CreateFileW` and passed through `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` in the same `CreateProcessW` call that assigns the Job Object.
- The child's stdin is the null device.
- A `CaptureProvider` / `CaptureSession` seam isolates the mechanism. `CaptureSpec.kind` already admits `"pty"`, and `OutputChunk.stream` stays `"stdout" | "stderr"` (a PTY provider reports everything as `stdout` and returns `stderr: null`). v0.3 adds a second provider selected by `AGTOP_PTY=1`; no record, event or route changes.

### Consequences

- Programs see a pipe, not a terminal: no colors by default, block buffering in some runtimes (output arrives in bursts), no interactive prompts. This is acceptable for dev servers, builds, tests and non-interactive agents; `agtop run` remains the path for interactive sessions.
- stdout and stderr stay separate streams with one shared sequence, so relative order across streams is the order the supervisor read them, not necessarily the order the child wrote them.
- The Windows provider adds two Koffi calls (`CreateFileW`) and a named-pipe name per stream. Pipe names are unguessable and single-use.
- Verified by the spike: 10 MiB through both providers in about 150 ms with a child that uses blocking writes, correct EOF, correct exit codes, child killed with the supervisor.

### Rejected alternatives

- **PTY now (ConPTY on Windows, `forkpty`/`node-pty` on POSIX).** Needs a native dependency or substantial Koffi work on three platforms, ConPTY rewrites output (cursor movement, line wrapping) so byte-exact capture and redaction boundaries get harder, and ConPTY interacts with Job Objects through an extra `conhost` process. Too much risk for the release that introduces capture.
- **Redirect to a file and tail it.** The child can never block, but output is unbounded on disk before redaction, redaction would have to run after secrets are already stored, and tailing needs polling or platform watchers.
- **Anonymous pipes read with blocking `ReadFile` on a worker thread or Koffi async calls.** Works, but needs a thread per stream and a CRT file descriptor or async FFI, both fragile across Node and Bun. Named pipes reuse the event loop.
- **Replace the Windows launcher with `child_process.spawn` and assign the Job Object afterwards.** Reopens the race the v0.1 design closed: a child can spawn descendants before it is in the job.
- **Apply backpressure (pause the stream when the ring is full).** That is exactly the deadlock this ADR exists to prevent.

---

## ADR-002: Event store: framed JSONL plus an in-memory index

### Context

Job history must survive a supervisor crash, be readable by other processes of the same user without a server, tolerate a torn final write, and add no runtime dependency (the compiled binary embeds Bun and Koffi only). Several supervisor processes write concurrently, but each job has exactly one writer. Output can arrive at tens of MiB per second.

### Decision

- One directory per job. Lifecycle events go to `events.jsonl`; output chunks go to `output.jsonl` with a previous segment `output.prev.jsonl`.
- Every record is one line: 8 hex digits of length, 8 hex digits of CRC-32, the JSON, a newline. A reader stops at the first frame that fails a check; the rest is a corrupt tail.
- `fsync` after every state event (`queued`, `starting`, `running`, `exiting`, `exited`, `failed`, `killed`, `lost`). Never `fsync` for output.
- The first event carries the whole `JobRecordV2`; later state events carry patches. `JobIndex` folds events into records in memory and is rebuilt at every process start.
- A corrupt tail is truncated only by the reconciler, only after the job's supervisor is proven dead, under the fleet lock. Live readers ignore a partial last frame.
- The output spool rotates when a segment holds `ringBytes` of raw output, so disk holds between one and two ring sizes of the newest output per job (`spool: "tail"`, the default). `spool: "full"` keeps everything up to `spoolMaxBytes`; `spool: "off"` keeps output in memory only.

### Consequences

- A process crash loses no completed write (the page cache survives). An operating-system crash or power loss can lose recent output and at most the lifecycle event being written; every earlier state is durable.
- Recovery cost is linear in retained bytes: about 20 ms to rebuild two jobs with 2.8 MiB of spool in the spike. Rings for jobs supervised elsewhere are hydrated lazily and cached (16 jobs).
- Files are greppable and can be inspected with a text editor; the frame header is fixed-width.
- Base64 inflates output on disk by one third. The bound is still explicit: about 2.8 MiB per job at the default ring size.
- There are no transactions across jobs. Cross-job invariants (caps, leases) are enforced by the fleet lock and exclusive file creation, not by the store.
- Single-writer discipline is a rule, not a mechanism: a second writer would corrupt `seq` ordering. Only `JobEventWriter` assigns `seq`.

### Rejected alternatives

- **SQLite (`bun:sqlite` / `node:sqlite`).** Two different built-in drivers for the two supported runtimes, `node:sqlite` is not stable in Node 22, and WAL files shared by several processes on Windows add lock-contention failure modes. Transactions are not needed: each job has one writer and events are append-only.
- **One global log for all jobs.** Needs cross-process write locking for every output chunk and makes retention a compaction problem.
- **`fsync` per output chunk.** At 4–64 KiB chunks this is hundreds of syncs per second per job; on Windows each costs milliseconds. It would turn the daemon into the bottleneck and risk blocking children.
- **Plain JSONL without length or checksum.** Cannot distinguish a torn line from valid JSON that happens to parse, and a flipped bit inside base64 would go unnoticed.
- **A `record.json` snapshot next to the log.** Two sources of truth; the fold is cheap, so the log alone is authoritative.

---

## ADR-003: Ring buffer size, byte safety and truncation

### Context

Most questions about a job are about its recent output: the last error, the "listening on" line. Memory must be bounded per job regardless of how much a job prints, binary and partial UTF-8 output must not corrupt anything, and a reader must be able to tell that output was dropped and how much.

### Decision

- One ring per job, **1 MiB by default** (`ringBytes`, 64 KiB–16 MiB), holding redacted bytes of both streams as chunks of at most 64 KiB, plus a cap of 4096 chunks.
- Chunks are byte buffers. The reader cuts chunks on UTF-8 code point boundaries where it can (holding back at most 3 bytes); bytes are never transcoded. API responses decode to UTF-8 with U+FFFD for invalid sequences, or return base64 on request.
- Eviction is oldest-first per stream. stdout is evicted before stderr while stderr holds 64 KiB or less, so a flood on stdout cannot erase the last errors.
- Every chunk has a job-wide `seq` and a per-stream byte `offset`. Dropped output is therefore always a prefix of a stream and is described by `TruncationInfo { firstDroppedSeq, lastDroppedSeq, droppedBytes }`. A returned chunk that borders the gap carries `truncated: true` and `firstDroppedSeq`; text renderers insert one marker line: `[agtop: N bytes of stdout dropped (seq A-B)]`.
- `tail=N` counts lines at read time over raw bytes; storage is not line-oriented.

### Consequences

- 20 jobs cost about 30 MiB of steady-state RSS above an idle daemon in the spike (20 MiB of data plus overhead), within the 50 MB budget. Transient RSS during bursts is higher.
- A client that polls with `since` can compute exactly how many bytes it missed from `offset` values, even across a supervisor restart.
- Very long lines are split across chunks; consumers must concatenate before splitting lines.
- The reserve means the two streams are not evicted in strict global order; `seq` still orders what remains.

### Rejected alternatives

- **Line-based ring (keep the last N lines).** Unbounded memory for long lines, and binary output has no lines.
- **Separate fixed rings per stream.** Wastes half the budget for the common stdout-only job; the reserve gives the same protection for stderr.
- **Head-and-tail retention (keep the first and last 512 KiB).** Useful for build logs, but truncation would be a hole instead of a prefix, which complicates cursors and the restart story. The optional full spool covers this need.
- **Unbounded memory with a disk cap only.** A single noisy job could exhaust daemon memory before the cap helps.
- **Storing decoded strings.** Corrupts binary output and makes byte accounting inexact.

---

## ADR-004: Cooperative admission, not preemption

### Context

Several agents on one workstation start builds, test suites and local model runs at the same time. The visible failures are `EADDRINUSE`, thrashing memory, and GPU jobs that slow each other to a crawl. agtop can see ports, memory and accelerator use. It cannot know what a suspended agent would do to its own state: an agent harness that is stopped mid-request times out its API calls, loses its MCP connections, and may corrupt a half-written file when resumed or killed.

### Decision

Control **when jobs start**, never whether a running job keeps running.

- A queue ordered by numeric priority with aging (one point per 30 s waited, capped), then FIFO.
- `dependsOn`: a job starts after its dependencies exit with code 0 and fails if one cannot.
- Concurrency caps: global, per peer, per harness.
- Advisory port leases with a TTL and conflict detection against real listeners.
- GPU, NPU and memory guards with separate busy and resume thresholds (hysteresis). An unmeasurable value never blocks.
- A job blocked by a guard holds back lower-ranked jobs that want the same resource kind, so small jobs cannot starve a large one.
- Admission is decided under a cross-process lock; every supervisor runs the same deterministic planner over the same on-disk state and admits only its own jobs.
- agtop never sends `SIGSTOP`, never freezes a cgroup, never lowers priority, and never kills a job to make room. The v0.1 immediate launch stays available and is the default when no queue option is given.

### Consequences

- Admission is advisory: a process started outside agtop is not queued, and guards react to measured load, not reservations. Two jobs admitted in the same second can still overload a GPU; the guard closes for the next one.
- Queue state is spread across supervisors. If a supervisor dies, its queued jobs become `lost`; they are not handed to another supervisor.
- Decisions are explainable: every deferral is a `PolicyEvent` or a `blockedBy` entry naming the rule, the measured value and the threshold.
- Port leases prevent collisions only among cooperating agents; the listener check catches the rest at admission time.

### Rejected alternatives

- **Preemption with `SIGSTOP`/`SIGCONT` or cgroup freeze.** Breaks agent sessions as described above, has no Windows equivalent that is safe for arbitrary trees, and turns a scheduling tool into a source of data loss. Explicitly ruled out.
- **Kill-and-requeue the lowest-priority job.** Destroys work and violates the v0.1 rule that an agent never kills another agent's job.
- **Hard reservations (GPU memory accounting).** agtop cannot enforce them and per-process GPU memory is not measurable on every platform; a reservation that is not enforced is worse than an honest threshold.
- **A single scheduler daemon that owns every job.** Would force MCP sessions to route launches through a daemon, changing v0.1 lifetimes (jobs die with their session today) and adding a single point of failure.
- **Nice/priority-class adjustments.** No effect on GPU contention or port collisions, and surprising for the user.

---

## ADR-005: Per-peer Ed25519 request signing over TLS

### Context

A developer wants to see and stop jobs on a second machine (a build box, a GPU workstation) from the first. The v0.1 daemon is loopback-only with one bearer token that grants full local control: spawn anything, kill anything. Sending that token to another machine would hand over the whole account. Requests cross a LAN or VPN where they can be observed, replayed or redirected.

### Decision

- Federation is a **separate TLS 1.3 listener** with its own route prefix (`/fed/v1`). It is off unless `--federation-port` is given. The loopback listener and its bearer token are unchanged and never accept federation traffic; the federation listener never accepts the bearer token.
- Each daemon has an Ed25519 identity. A peer entry holds the other side's public key, URL, optional pinned certificate, and the **scopes** that peer is granted here.
- Every request is signed: the signature covers a version tag, method, path and query, timestamp, nonce, sender ID, **audience ID** and the SHA-256 of the body. The receiver rejects timestamps more than 60 s off and nonces seen in the last 120 s.
- Scopes are least-privilege and default to nothing: `jobs:list`, `jobs:read`, `jobs:output`, `jobs:events`, `jobs:submit`, `jobs:kill`, `jobs:kill-any`, `telemetry:read`. Visibility of local jobs is further limited to the peer's own submissions plus configured peer-label prefixes.
- Server authentication uses TLS: a pinned certificate per peer, or the system CA store with hostname verification. Responses are not signed separately.
- Operators supply the TLS certificate and key files. agtop generates only the Ed25519 identity.

### Consequences

- Compromise of one peer's key exposes only what that peer's scopes allow on each machine that trusts it, and is revoked by removing or disabling one entry.
- A captured request cannot be replayed (nonce), delayed (timestamp), sent to a different daemon (audience), or modified (body hash and path are signed).
- Machines need clocks within a minute of each other; the error says so and reports the server time.
- Setup takes an explicit key exchange (`agtop peers init`, `agtop peers add`) and a certificate. There is no discovery and no trust-on-first-use.
- Uses only `node:crypto`, `node:https` and `node:tls`; no new dependency.

### Rejected alternatives

- **Shared static bearer token across machines.** One secret, full control, no attribution, no scoping, replayable if ever observed. Ruled out.
- **Mutual TLS as the only authentication.** Sound cryptographically, but it requires a private CA or per-peer client certificates, which Node cannot mint without extra dependencies, and authorization would hang off certificate fields. Ed25519 keys are 32 bytes that can be pasted into a command; scopes live next to them.
- **OAuth/OIDC or JWT bearer tokens.** Needs an issuer; bearer tokens are replayable within their lifetime without proof of possession.
- **SSH tunnel to the remote loopback daemon.** Works today without code, but grants the remote bearer token's full control and puts no scopes or audit trail on remote actions. It remains possible for users who want it; it is not the product answer.
- **HMAC with a per-peer shared secret.** Each side could impersonate the other, and a leak on either machine compromises both directions.

---

## ADR-006: MCP tools for actions and bounded queries, resources for streams

### Context

Agents use agtop through MCP. Client support differs: every client calls tools; resource support (listing, reading, subscriptions) varies and some agents never read resources on their own initiative. Log reading has two shapes: "show me the last 100 lines now" and "follow this job".

### Decision

- **Tools** for everything an agent must be able to do in any client: `run` (extended), `status` (additive fields), and the new bounded queries `output` (tail or `since` cursor, byte budget, text or JSON) and `events`.
- **Resources** for read-only streams with cursor pagination: `agtop://jobs/{jobId}/output/{stream}[/{since}]` and `agtop://jobs/{jobId}/events[/{since}]`, with `nextUri` in each page and change notifications for subscribed clients. Cursors are path segments; no query strings.
- Both go through the same `FleetService` calls and the same ownership checks. A session reads only jobs it created, unless the job's `visibility` is `peer` or `all`.
- Tool results are bounded by default (100 lines, 64 KiB) so that a log read cannot flood an agent's context.

### Consequences

- An agent on a tools-only client loses nothing; resources are an optimization for clients that can subscribe.
- Two entry points to the same data must stay consistent; they share one implementation and the tests assert equal pages.
- `run` now captures by default. The skill and the server instructions must say when to read output and must keep telling agents to use the shell for short commands.
- The capability declaration grows to include `resources`; clients that ignore it are unaffected.

### Rejected alternatives

- **Resources only.** Clients without resource support, or agents that do not think to read them, could not see logs at all.
- **Tools only.** Works, but polling `output` in a loop wastes turns where a subscription would do, and resources are the protocol's intended shape for readable, addressable data.
- **Streaming output through MCP progress or logging notifications.** Not addressable, not replayable, tied to one request, and uneven across clients.
- **Query strings in resource URIs.** URI-template query expansion is inconsistently implemented by clients; path segments work everywhere.
- **Unbounded `output` by default.** One call could return 1 MiB into the model's context.

---

## ADR-007: v1 records coexist with `JobRecordV2`

### Context

v0.1 writes `<stateDir>/<jobId>.json` (`version: 1`) before a process runs and removes it when the job ends. Discovery, `agtop ps`, `agtop kill`, stale-record cleanup, the desktop and 500+ tests depend on that file and on `readJobs()` returning only version 1 records. A v0.1 binary may run next to a v0.2 binary on the same state directory.

### Decision

Keep writing v1 records unchanged for every managed launch. Put all v0.2 state in `<stateDir>/fleet/`, which v0.1 never reads. A fleet job has both. Jobs that have only a v1 record appear in fleet listings through a pure, read-only mapping (`migrateV1Record`); nothing on disk is rewritten.

### Consequences

- No migration step, no downgrade problem, and mixed-version operation is safe.
- Two representations exist while a job is alive. The fleet record wins for fleet fields; the v1 record remains authoritative for containment and discovery.
- Migrated views have no owner, no output and no events, and say so with `E_CAPTURE_DISABLED`.

### Rejected alternatives

- **Bump the v1 file to `version: 2` in place.** `readJobs()` filters on `version === 1`; every v0.1 reader and many tests would stop seeing jobs.
- **One-time migration at startup.** v1 records describe live processes only and disappear on exit; there is nothing durable to migrate.
- **Dropping v1.** Would require rewriting discovery and containment in the same release as capture and scheduling.

---

## ADR-008: Redaction is on by default and runs before storage

### Context

Captured output is new attack surface: before v0.2, a secret printed by a job vanished; now it would sit in a ring, a spool file, HTTP responses, MCP tool results in a model's context, and possibly another machine. Agents routinely print environment dumps, curl commands with headers, and `.env` contents.

### Decision

Redact inside the pipe reader, before bytes reach the ring or the spool. Rules are a short list of high-confidence token shapes with literal prefixes and bounded lengths. The redactor holds back the last 1 KiB of each stream so a secret split across reads is still matched, and never splits a match. Opt-out is per job (`redact: false`), is recorded in the job record and in the audit log, and is refused for jobs submitted by remote peers.

### Consequences

- Nothing downstream needs to redact again, and nothing unredacted is ever written to disk.
- Live output lags by at most one tick (100 ms) for complete lines and up to 2 s for an unterminated line.
- Redaction is a mitigation, not a guarantee: secrets in unknown formats, split by a newline, or encoded pass through. The threat model lists the residual risks.
- Byte counts refer to redacted output, so they can differ from what the child wrote.

### Rejected alternatives

- **Redact at read time.** Leaves secrets on disk and requires every reader, including future ones, to remember.
- **Entropy-based detection.** High false-positive rate on hashes, IDs and base64 assets; unpredictable cost.
- **Opt-in redaction.** The dangerous case is the one nobody anticipated.
- **A global off switch (environment variable).** Too easy to leave on; the per-job flag makes the choice visible in the record.
