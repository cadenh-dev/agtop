# agtop Fleet v0.2: threat model

Related: [architecture](fleet-v0.2.md), [contracts](fleet-contracts.md), [ADRs](fleet-adrs.md), [acceptance](fleet-acceptance.md). Every "must" in this document has a test in the acceptance matrix (security gates S1–S20).

## 1. Scope and honesty

agtop manages process lifetimes. It is not a sandbox, and v0.2 does not make it one. In particular:

- **The trust boundary on one machine is the OS user.** Every agtop process, every agent, and every job runs as the same user and can read the same state directory. Session ownership (section 3) is a policy enforced by agtop's own surfaces so that well-behaved agents do not read or stop each other's work by accident or by following an injected instruction. It does not stop a process that deliberately opens the files.
- **The local bearer token is full control**, as in v0.1: it can start and stop anything the user can, and from v0.2 it can read every job's captured output.
- **Federation is a real boundary.** A remote peer is a different machine and possibly a different person. Everything it can do is limited by cryptographic authentication and by scopes.

### Assets

| Asset | Why it matters |
| --- | --- |
| Captured output | May contain secrets, source code, customer data printed by a job |
| Command lines and working directories | Reveal projects, arguments, sometimes inline credentials |
| Control over processes | Starting commands is code execution; stopping them destroys work |
| Daemon bearer token | Full local control |
| Ed25519 identity key | Lets its holder act as this daemon toward every peer that trusts it |
| Event logs and audit log | Evidence; must not be forgeable by a remote party |

### Actors

| Actor | Capabilities assumed |
| --- | --- |
| A1 Cooperating agent session | Calls MCP tools; may be steered by prompt injection in files or web pages it reads |
| A2 Other local OS user | Can list processes and named pipes, connect to loopback ports, read world-readable files |
| A3 Web page in the user's browser | Can send HTTP requests to `127.0.0.1` with an `Origin` header; cannot read responses cross-origin or set `Authorization` without CORS |
| A4 Network attacker | Can observe, replay, modify, drop and redirect traffic between two daemons |
| A5 Malicious or compromised peer | Holds a valid peer key with some scopes |
| A6 A job's own process tree | Runs as the user; controls its own output bytes and timing |

Out of scope: a malicious process already running as the same user (it can read the token file and the state directory directly), kernel or hardware attacks, and denial of service by a local process with the user's privileges.

## 2. Summary of threats and controls

| # | Threat | Actor | Control | Residual risk |
| --- | --- | --- | --- | --- |
| T1 | Session B reads session A's output or events through MCP | A1 | Ownership check on `output`, `events`, resources (section 3) | Same-user file access; agents are told not to (skill) |
| T2 | Session B kills session A's job | A1 | Ownership check on `kill` (unchanged from v0.1) | Shell `kill` by the agent; covered by the skill and evals |
| T3 | Secret printed by a job is stored or returned | A6 | Streaming redaction before storage (section 5) | Unknown formats, encoded or newline-split secrets |
| T4 | Local user reads token, key, logs | A2 | 0600/0700 on POSIX, ACL hardening on Windows (section 4) | Administrator/root; backups |
| T5 | Web page drives the daemon | A3 | Bearer required, `Origin` rejected, no CORS (v0.1) | None new: fleet routes sit behind the same check |
| T6 | Eavesdropping or tampering between daemons | A4 | TLS 1.3 with pinned or CA-verified certificate (section 6) | Operator pins the wrong certificate |
| T7 | Replay of a captured request | A4 | Timestamp window, nonce cache, audience binding (section 6) | Replay cache lost on restart (window still bounds it) |
| T8 | Stolen peer key | A5 | Scopes, visibility prefixes, per-peer revocation, audit (section 6) | Whatever the scopes allowed until revoked |
| T9 | Peer runs code here | A5 | `jobs:submit` is off by default; submissions are labeled, capped, cannot set env or disable redaction | A peer with `jobs:submit` can run commands as the user; grant it deliberately |
| T10 | Output flood exhausts memory or disk | A6 | Ring cap, chunk cap, spool rotation, no backpressure | Transient RSS during bursts |
| T11 | Crafted output slows the redactor (ReDoS) | A6 | Linear-time rules, bounded quantifiers, per-chunk cost test | None known |
| T12 | Named-pipe squatting on Windows | A2 | Random single-use names, first-instance creation, fail closed (section 4.3) | Denial of that one launch |
| T13 | Forged or corrupted event log | A2/A6 | Files are user-private; frames are checksummed; single writer | Same-user tampering (out of scope) |
| T14 | Job ID as a path | A1/A5 | `validateJobId` before any path join; URL-decoding before validation | None known |
| T15 | Owner token leaks to a job | A6 | Token deleted from child and watchdog environments; only its hash is stored | — |

## 3. Session isolation

### 3.1 How ownership is established

- An MCP server process creates a `SessionIdentity` at startup: a `sessionId` and a 256-bit random `ownerToken`. The token never leaves the process: it is not written to disk, not logged, not returned by any tool, and removed from the environment of every child and watchdog.
- An orchestrator that wants a session to keep its identity across restarts supplies `AGTOP_SESSION_ID` and `AGTOP_OWNER_TOKEN` in the MCP server's environment. That is the only way to "explicitly scope" a second process into the same session.
- When a job is submitted, the record stores `owner = { sessionId, tokenHash: sha256(ownerToken), surface }`. The record is the first event of the job's log and is fsynced before the job can run.
- Jobs submitted through the daemon are owned by the daemon's session; jobs submitted by a remote peer are owned by that peer (`remotePeerId`) with an empty `tokenHash`.

### 3.2 How it is checked

All surfaces call `FleetService`, which calls `ownership.ts`. There is no other path to output.

| Action | Session caller (MCP) | Peer caller (federation) | Admin caller (bearer token, CLI) |
| --- | --- | --- | --- |
| List jobs | All jobs; command, args and cwd only for own jobs | Own submissions plus jobs under granted peer-label prefixes; never command lines of others | Everything |
| Read output or events | Own jobs; others only if the job's `visibility` is `all`, or `peer` with an identical peer label | Own submissions; others only if visible **and** `visibility` is `all` | Everything |
| Kill | Own jobs only | Own submissions with `jobs:kill`; visible others only with `jobs:kill-any` | Everything |

Rules that must hold:

1. A session is the owner only if both `sessionId` and the token hash match; the hash comparison is constant-time and an empty stored hash never matches.
2. `visibility` is chosen by the job's creator at submission and cannot be changed later.
3. The MCP error for a denied read is `E_NOT_OWNER` and reveals nothing about the job beyond what `list` already shows. The federation listener reports a job the peer cannot see as `E_JOB_NOT_FOUND`.
4. `StateEvent.record.owner.tokenHash` is blanked in every MCP and federation response.
5. Denials are decided before any output is read from memory or disk.

### 3.3 What it does not do

A session that runs `cat` on another job's spool file through its shell tool succeeds: same user, same files. The controls for that are behavioral (the skill tells agents to use `output` and never to read the state directory; an eval scenario checks it) and architectural (redaction means the file holds no known-format secrets). Users who need hard isolation between agents must run them as different OS users or in containers; each then has its own state directory.

## 4. Local storage

### 4.1 POSIX

- `<stateDir>` and every directory under `fleet/` are created with mode `0700`; every file with mode `0600`, set at creation (`open` with mode) so there is no window with wider permissions. `ensurePrivateDir` also `chmod`s an existing directory to `0700`.
- The daemon token file keeps its v0.1 behavior (`0600`, re-`chmod`ed).
- The Ed25519 key is loaded only if `assertPrivateFile` passes: owned by the current uid and no group or other permission bits. Otherwise the federation listener refuses to start and says why.
- Files are created with exclusive or atomic operations (`wx`, or temp file plus rename in the same directory); temp names include the PID.

### 4.2 Windows

v0.1 relies on the profile directory's inherited ACL. v0.2 hardens the fleet directory explicitly:

- When `ensurePrivateDir` creates `fleet/` (and `fleet/federation/`), it runs `icacls <dir> /inheritance:r /grant:r "<user>:(OI)(CI)F"`: inheritance from the parent is removed and only the current user has access, inherited by everything created inside.
- `identity.key` additionally gets `icacls <file> /inheritance:r /grant:r "<user>:F"`.
- If `icacls` fails or is missing, agtop records `acl-hardening-failed` in the audit log, prints one warning to stderr, and continues with inherited ACLs for job data. The federation listener, however, refuses to start when the key file could not be hardened.
- The v0.1 token file location and ACL behavior are unchanged, so `test/daemon-security.test.ts` keeps passing as written. New tests extend it: on POSIX, mode checks for `fleet/`, a job directory, `events.jsonl`, `output.jsonl`, a lease file and `identity.key`; on Windows, an `icacls` query asserting that the fleet directory has no inherited entries and no entry for `Everyone`, `Users` or `Authenticated Users`.

### 4.3 Capture pipes

- POSIX pipes are anonymous and inherited; no other process can open them.
- Windows named pipes have names of the form `\\.\pipe\agtop-<jobId>-<stream>-<random UUID>`. The supervisor creates the server (libuv creates the first instance exclusively), opens the single client end itself, and stops listening on the first connection. If another process connected first, the supervisor's own `CreateFileW` fails with `ERROR_PIPE_BUSY` and the launch fails closed with `capture-error`. The default pipe ACL gives other users no write access. A squatter can therefore deny one launch but cannot read output (the server never writes) or inject output into a running job (the only write handle belongs to the job).

## 5. Redaction

### 5.1 Guarantees

1. Redaction runs in the pipe reader, before a byte reaches the ring, the spool, HTTP, MCP or a peer. There is no code path that stores unredacted output when `redact` is true.
2. A secret that matches a rule is replaced even when it is split across any number of pipe reads, provided the pieces arrive within the hold window (rule 4) and the secret is at most 600 bytes.
3. A match is never cut: the redactor moves its release point to the end of any match that straddles it.
4. Hold window: the last 1024 bytes of each stream are held until more data arrives; complete lines are released every 100 ms; an unterminated line is released after 2 s or at end of stream.
5. Replacements have the form `[REDACTED:<rule id>]`. For `auth-header`, `bearer-token` and `env-secret` the name is kept and only the value is replaced, so logs stay readable.
6. Command lines are not captured output and are not redacted in `JobRecordV2`; they are visible only to the owner and to admin callers, as in v0.1. Environment values are never stored (only key names).

### 5.2 Performance and ReDoS

- Every rule starts with a literal or a bounded character class and uses only bounded quantifiers (`{m,n}`) over simple character classes. There are no nested quantifiers, no alternation inside a repetition, no backreferences and no lookbehind. Worst-case work per input byte is bounded by a constant (the largest bound, 400), so total work is linear in input size.
- No rule can match `\n`, which is what makes the line-based release safe and bounds every match to one line.
- The redactor works on a latin1 view of the bytes: one byte is one character, so offsets are exact and binary data passes through unchanged.
- Required tests: 1 MiB of each adversarial input (`"A".repeat(n)`, `"sk-".repeat(n)`, `"AAAA_".repeat(n)`, `"Authorization:" + " ".repeat(n)`, `"eyJ" + "a.".repeat(n)`) must be processed in under 250 ms; throughput on ordinary log text must exceed 20 MiB/s on CI hardware. The spike's end-to-end path (redaction included) ran at about 65 MiB/s.
- Adding a rule requires: a literal prefix, a maximum match length under 600 bytes, no newline match, and a new adversarial test.

### 5.3 Residual risks (documented, not fixed)

- Secrets in formats without a rule (for example a bare 32-character hex password), secrets wrapped across lines, base64- or URL-encoded secrets, and secrets written one character at a time more than 2 s apart.
- A secret longer than the rule's upper bound is redacted up to the bound; the remainder is released.
- Multi-line private keys (`-----BEGIN … PRIVATE KEY-----`) are not redacted in v0.2.
- False positives replace harmless text that looks like a token; `redact: false` exists for jobs where that matters.

### 5.4 Opting out

`redact: false` is per job, never global, and:

- is stored in `capture.redact` in the job's first event, so every later reader can see that the output is raw;
- writes an audit record `{ event: "redact-disabled", actor, jobId }` before the job is queued;
- is rejected with `E_INVALID_REQUEST` for jobs submitted by a remote peer;
- does not change who may read the output.

## 6. Federation

### 6.1 Man in the middle

- The federation listener requires TLS 1.3. The client verifies the server with the peer's pinned certificate (`tlsCertPem`: the only accepted trust anchor for that peer, compared by SHA-256 fingerprint) or, when no certificate is pinned, with the system CA store and hostname verification. Verification is never disabled.
- The request signature authenticates the client to the server independently of TLS, and covers the method, full path and query, and body hash, so a TLS-terminating intermediary cannot alter a request without invalidating it.
- The signature includes the audience (the receiver's peer ID). A request captured on its way to daemon B cannot be presented to daemon C, even if C trusts the same sender.
- Responses are authenticated by TLS only. A client must therefore not use a peer without a pinned certificate on a network where it would not trust the CA system.

### 6.2 Replay and clock skew

- Requests more than 60 s from the receiver's clock are rejected with `E_CLOCK_SKEW`; the response includes the server time so the operator can see the offset. agtop does not adjust clocks or widen the window automatically.
- Each accepted nonce is remembered per peer for 120 s (twice the window). A repeated nonce is `E_REPLAY`.
- The nonce is recorded only after the signature verifies, so an unauthenticated sender cannot fill the cache. An authenticated peer that sends more than 4096 requests in 120 s gets `E_REPLAY_CACHE_FULL` (429) until entries expire; this is also the per-peer rate limit.
- The cache is in memory. After a daemon restart, a request captured in the previous 60 s could be replayed once. The affected operations are reads and `kill`, which is idempotent; `POST /fed/v1/jobs` with a caller-chosen `jobId` is rejected as `E_JOB_EXISTS` while that job is still active, and peers should always send a `jobId` for that reason; a replayed submission of a job that already finished would run it again. This residual risk is accepted for v0.2.

### 6.3 Key compromise

- Private keys never leave the machine and are never sent over the wire. `identity.key` is user-private (section 4).
- Each peer has its own entry; there is no shared secret. Revocation is `agtop peers remove <id>` or `enabled: false`, effective on the next request because a running daemon reloads `peers.json` when it changes.
- A stolen key is useful only from a network position that can reach the federation port, and only within that peer's scopes.
- Rotation: generate a new identity (delete `identity.key` and run `agtop peers init`), then update the public key at each peer. There is no automatic rotation in v0.2.

### 6.4 Blast radius through `PeerScope`

A new peer has no scopes. Each scope unlocks exactly one capability:

| Scope | Allows | Does not allow |
| --- | --- | --- |
| `jobs:list` | Summaries of visible jobs | Command lines of jobs the peer did not submit |
| `jobs:read` | One visible job's summary, queue position and lease ports | The full record of others' jobs |
| `jobs:output` | Output of the peer's own submissions, and of visible jobs marked `visibility: "all"` | Any other output |
| `jobs:events` | Same rule as output | — |
| `jobs:submit` | Queue a job here, labeled `peer:<id>`, subject to local caps and policy | `extraEnv`, `cgroupRoot`, `redact: false`, choosing another peer label |
| `jobs:kill` | Stop the peer's own submissions | Stopping local or other peers' jobs |
| `jobs:kill-any` | Stop any visible job | Stopping jobs outside the granted prefixes |
| `telemetry:read` | Accelerator devices, guard states, running and queued counts | Per-process data |

"Visible" means: submitted by this peer, or its peer label starts with one of the `jobPeerPrefixes` granted to this peer. With no prefixes, a peer sees only its own submissions.

`jobs:submit` is remote code execution as the local user by design. It should be granted only to machines the same person controls. Every remote submission and every remote kill writes an audit record with the peer ID.

### 6.5 Listener hardening

- Off by default; binds only when `--federation-port` and both TLS files are given.
- Separate route prefix and separate listener: a bug in federation auth cannot expose `/v1/*`, and the bearer token is meaningless on the federation port.
- Request body limit 64 KiB, header and request timeouts 10 s, no redirects followed by the client, response size limit 8 MiB.
- All authentication failures look the same to the sender (`E_SIGNATURE_INVALID`) except clock skew and replay, which a legitimate peer needs to diagnose.
- Remote callers never receive `owner.tokenHash`, lease IDs, session IDs of other sessions, or file paths outside the job's own `cwd`.

## 7. Resource exhaustion

- Per job: at most `ringBytes` (default 1 MiB) plus 4096 chunk headers in memory; at most two segments of `ringBytes` raw output on disk in the default spool mode; `spoolMaxBytes` (256 MiB) in full mode.
- The reader never queues: a chunk is redacted, framed, written and pushed in the `data` handler. If the disk write throws (disk full), the writer disables the spool for that job, records the error once in the next lifecycle event's `detail`, and capture continues in memory.
- Fleet-wide: `maxQueued` (200) bounds queued jobs; retention bounds finished jobs (72 h, 200 jobs); the audit log rotates at 4 MiB.
- HTTP responses are bounded by `maxBytes` (4 MiB hard maximum) and `limit`.

## 8. Audit trail

`fleet/audit.jsonl` (framed, user-private, rotated) records, with timestamp and actor: every `redact: false` submission, every failed federation authentication (with the error code, never the signature), every remote submission and remote kill, peer additions and removals, policy changes, admin kills of jobs owned by another session, and ACL-hardening failures. Job-level history (state changes, leases, admission decisions) is in each job's own event log. Audit records pass through the redactor before they are written.
