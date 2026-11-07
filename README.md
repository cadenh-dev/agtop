<img src="assets/icon.svg" width="64" height="64" alt="">

# agtop

Agent-aware process discovery and containment for Windows, Linux, and macOS. Use it as a terminal monitor, a TypeScript library, or a local HTTP service for an Electron application.

Recognizes coding agents such as Claude Code, Codex, OpenCode, aider, Goose, Gemini CLI, Qwen Code, Cursor Agent, Antigravity, OpenHands, and Plandex, plus local inference servers such as Lemonade, Ollama, llama.cpp, LM Studio, vLLM, SGLang, LocalAI, KoboldCpp, Tabby, and TGI. Run `agtop harnesses` to list or search the full catalog. Managed jobs can use any executable.

## Native desktop UI

The desktop is built in Rust with [GPUI](https://gpui.rs/). It has live agent lists, full-text filtering across harnesses, commands, branches, peers, and PIDs, repository and branch details, CPU/RSS totals, a process tree, Lemonade status, and launch/stop controls. It uses the same containment engine as the CLI through an authenticated loopback connection. HTTP requests run on a worker thread so scans do not block the window.

```sh
bun install
bun run desktop:build
bun run desktop
```

Or, after building the CLI, use `agtop ui`. This starts a private daemon on an available port and opens the GPUI window. Closing the window stops jobs launched by that session and removes its token file. Independently discovered agents are left running. Launching background jobs discards stdout/stderr; use `agtop run` in a terminal for interactive harness sessions.

The launch form has a searchable harness picker (backed by the daemon's harness catalog), an executable, an exact JSON argument array, and an optional working directory. On Windows, a Codex npm shim can be launched as `cmd.exe` with `["/c", "codex.cmd"]`. Stopping a tree requires confirmation in the UI; the API verifies the selected root's creation time before acting. Keyboard shortcuts: Ctrl+N to launch, Ctrl+R to refresh, Tab to move focus, Escape to cancel, and Ctrl+Q to quit.

Building the desktop requires a current Rust MSVC toolchain plus Visual Studio C++ Build Tools and the Windows SDK on Windows. On Linux it requires Rust, a C/C++ toolchain, pkg-config, fontconfig, Wayland/X11 and xkbcommon development libraries, and a Vulkan-capable graphics driver. See [Zed's Linux dependency guide](https://github.com/zed-industries/zed/blob/main/docs/src/development/linux.md) for platform package names. GPUI is pinned to 0.2.2 and the dependency graph is locked in `desktop/Cargo.lock`.

`bun run desktop:build` copies the native executable to `dist/agtop-desktop.exe` (Windows) or `dist/agtop-desktop` (Linux). Distribute it next to the compiled `agtop` executable and start with `agtop ui`. The UI executable can also attach to an existing `agtop daemon` on port 13309, or accept `--port PORT --token-file PATH`. In that attached mode, closing the window leaves the independently owned daemon and its jobs running. Keep the API on loopback; this version of the UI monitors the machine on which it runs.

Desktop checks:

```sh
bun scripts/build-desktop.ts check
bun scripts/build-desktop.ts test
bun scripts/build-desktop.ts fmt -- --check
```

## Run

Requires Bun for development, or Node.js 22+ for the built JavaScript. Windows containment requires Windows 10 / Server 2016 or newer and Koffi (included in dependencies). Linux requires `/proc`, `getconf`, and `/bin/sh`.

```sh
bun install
bun agtop.ts --help
bun agtop.ts ps --json
bun agtop.ts harnesses claude
bun agtop.ts mcp
bun agtop.ts cleanup
bun agtop.ts cleanup --stale --dry-run --json
bun agtop.ts top
bun agtop.ts run --harness codex -- codex
bun agtop.ts kill JOB_ID
bun agtop.ts lemonade --json
```

On Windows, pass `.cmd`, `.bat`, and `.ps1` shims through an explicit interpreter:

```powershell
bun agtop.ts run --harness codex -- cmd.exe /c codex.cmd
```

Build JavaScript and TypeScript declarations with `bun run build`, then run `node dist/cli.js`. To register `agtop` on your PATH for development, run `bun link` after building. Bare `agtop` opens the live view on a terminal and prints a snapshot when redirected. Press `q` or Ctrl+C to exit the live view. CPU values use 100% for one core; the first library snapshot has no prior sample and reports zero. `ps` takes two samples.

`run` inherits terminal input and output, stays alive until the root command exits, and cleans up remaining descendants on normal exit. Ctrl+C requests tree termination. Nonzero child exits propagate to the CLI. It is a foreground supervisor, not a detached service launcher; use daemon mode for managed background jobs.

## Library

```ts
import { spawnContainedAgent, listAgentTrees, killAgentTree } from './dist/index.js';

const agent = await spawnContainedAgent({
  harness: 'codex',
  command: process.platform === 'win32' ? 'cmd.exe' : 'codex',
  args: process.platform === 'win32' ? ['/c', 'codex.cmd'] : [],
  cwd: process.cwd(),
  userOrPeer: 'local',
  stdio: 'inherit',
});

console.log(agent.jobId, agent.pid, agent.containmentMode);
console.log(await listAgentTrees());
const result = await killAgentTree(agent.jobId);
console.log(result.killedPids, result.failedPids, result.errors);
await agent.exited;
```

`spawnContainedAgent()` is asynchronous and returns `ManagedAgent`, rather than a Node `ChildProcess`. `stdio` supports `inherit` and `ignore` (the library default). Attach a rejection handler to `exited` when you do not await it immediately. `listAgentTrees()`, `resolveGitWorktree()`, and `probeLemonade()` are also exported. Importing the library does not start the CLI, launch processes, or scan the OS.

In Electron, use the library from the main process and expose a narrow application IPC interface. An app using the HTTP daemon reads its token from the local token file; it should not expose the token to web content.

## Containment and discovery

| Mode | Membership and termination |
| --- | --- |
| `win32-job-object` | The process is created inside a named Job Object using `PROC_THREAD_ATTRIBUTE_JOB_LIST`. The manager persists metadata before resuming its initial thread. Descendants remain members even after an intermediate process exits. `TerminateJobObject` terminates the job; closing the last handle also terminates it. Setup failures abort launch. |
| `linux-cgroup` | A launcher waits on a dedicated pipe while agtop moves it into a new delegated cgroup v2 directory. Only then does it execute the harness. Membership includes nested cgroups; termination writes to `cgroup.kill`. |
| `linux-env-pgid` | Default Linux fallback: a detached process group plus inherited `AGTOP_*` tags. A pipe-watched helper cleans up tagged processes and process-group members if the manager exits unexpectedly. Termination uses pidfds where supported. |
| `darwin-env-pgid` | macOS process group plus inherited `AGTOP_*` tags. A pipe-watched helper in its own session cleans up after manager failure. Termination re-checks creation time before each SIGKILL; there is no pidfd, so a microsecond PID-reuse race remains. Not atomic. |
| `passive-ppid` | Discovery of independently started processes. Termination uses pidfds where supported and creation-time checks before signaling. It cannot provide atomic containment or recover arbitrary descendants that reparented before discovery. |

### Process roles

Each process in a discovered tree has a role, a source, and short evidence; each tree has counts by role. `agtop ps` and `top` show the counts and roles, `agtop roles` lists the catalog, and the library exposes the same fields. Roles are tree-contextual and use this display order:

| Role | Meaning |
| --- | --- |
| `agent` | The tree's root agent and its re-exec or shim chain |
| `subagent` | Another agent harness running under an agent |
| `mcp-server` | A Model Context Protocol server |
| `inference-server` | A local model inference server |
| `dev-server` | A development or preview web server |
| `language-server` | An LSP or editor intelligence server |
| `test-runner` | A test framework or one of its workers |
| `build` | A compiler, bundler, or build system |
| `package-manager` | A package installer or script runner |
| `git` | Git and other version control commands or helpers |
| `browser` | A browser, headless browser, or WebDriver |
| `shell` | A shell or terminal multiplexer |
| `tool` | Any other command run in the agent tree |

Classification checks nested job tags, MCP rules, the harness catalog, other command rules, inherited roles, then listening sockets, and finally uses `tool`. Evidence uses catalog rule IDs, PIDs, harness/job IDs, and socket endpoints; it does not expose raw arguments. For example: `socket: listening 127.0.0.1:5173`.

Roles are hints from process names, executable paths, safe command anchors, tree position, tags, and listeners. In-process subagents such as an agent's internal task tool are invisible. Cwd-only harness detection is not applied to nested processes, so `text-generation-webui` is not recognized as a nested inference server. `npm run dev` is classified as `package-manager`; its server child can be a `dev-server`. Docker-launched MCP servers are `tool`. A listening socket indicates a listener, not activity, model execution, or hardware use.

Socket evidence currently formats IPv6 role endpoints without brackets (for example, `::1:3000`), so the host and port can be ambiguous. MCP `listening` values use bracketed IPv6 notation.

## GPU and NPU usage

`agtop ps`, `agtop top`, and the desktop show measured accelerator use when the platform exposes it. `agtop gpu` (or `agtop accelerators`) shows detected devices and measurement status; `--json` prints the snapshot. `agtop ps --json` adds optional process fields (`accelerators`) and tree totals (`gpuPercent`, `npuPercent`, `gpuMemoryMb`). Undefined fields mean agtop could not measure that value; they are omitted or left blank, never shown as zero.

| OS / source | What's measured | Privileges | Known gaps |
| --- | --- | --- | --- |
| Windows / `windows-pdh` | GPU Engine process utilization and dedicated memory, with compute-only adapters classified as NPUs | No elevation | Per-process utilization depends on reported PDH instances; NPU detection through compute-only adapters is not yet tested on NPU hardware |
| Linux / `linux-drm-fdinfo` | Per-process DRM engine time and local/VRAM resident memory for processes in agent trees | No elevation; other-user fdinfo may be denied | Other-user processes can be skipped when permissions deny fdinfo access; some drivers expose memory only |
| Linux / `nvml` | NVIDIA device utilization and per-process engine utilization or memory when supported | No elevation | NVIDIA consumer cards may not expose per-process utilization |
| macOS / `darwin-iokit` | Best-effort per-process GPU counters and device utilization from undocumented IOKit counters | No elevation | Counters are undocumented and may vary by OS version; no Neural Engine per-process usage is exposed |
| Unsupported / `none` | No accelerator telemetry | — | The platform has no configured provider, telemetry was disabled, or no devices were found |

Per-process utilization is the maximum across the process's engines on a device. Tree GPU/NPU totals sum processes per device, clamp at 100%, then show the busiest device; two GPUs at 60% each therefore report 60%. GPU memory is the sum of measured per-process GPU memory. A process needs two samples before interval-based utilization appears, so the first sample is blank. Set `AGTOP_ACCELERATORS=0` to disable accelerator sampling.

### Recognition

Passive discovery does not require agent cooperation. agtop reads the OS process table (CIM on Windows, `/proc` on Linux, and libproc on macOS) and matches a process by executable basename, interpreter entry point, install path, Python module, or a disambiguating subcommand:

- `claude`, `codex`, `opencode`, `crush`, `ollama`, `llama-server`, `tritonserver`
- `node .../@anthropic-ai/claude-code/cli.js`, `node .../@openai/codex/bin/codex.js`
- `python -m aider`, `python -m vllm.entrypoints.openai.api_server`, `uvx aider`
- `goose session`, `gh copilot`, `q chat`, `tabby serve`

It never searches prompts or arbitrary arguments, so `git commit -m codex` and `node -e "console.log('claude')"` are not agents. Generic names such as `agent`, `gh`, `q`, `cn`, `goose`, and `tabby` require a second signal (a subcommand, package path, or working directory) to avoid false positives. `agtop harnesses [QUERY]` lists the catalog and its agent/server classification.

Managed launches do not rely on recognition: agtop writes a job record and injects `AGTOP_JOB_ID`, `AGTOP_HARNESS`, `AGTOP_PEER`, and `AGTOP_WORKTREE` before the harness starts. Children inherit those tags automatically; agtop does not attach to or tag processes that are already running. On Windows, Job Object membership is authoritative even when an intermediate shell exits; on Linux, a cgroup provides the same guarantee, while the process-group fallback is best effort.

To use cgroups, provide a **previously delegated writable cgroup v2 directory**:

```sh
agtop run --cgroup-root /sys/fs/cgroup/YOUR_DELEGATED_GROUP --harness codex -- codex
```

The library accepts `cgroupRoot`; `AGTOP_CGROUP_ROOT` supplies a default. This does not automatically configure systemd delegation or elevate privileges. If an explicitly requested cgroup is unavailable, launch fails. Linux needs `cgroup.kill` support (Linux 5.14+). Native cgroup termination handles concurrent forks within the group. See the [kernel cgroup documentation](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html) and Microsoft's [creation-time Job Object assignment explanation](https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812/).

These mechanisms manage process lifetimes; they are not a security sandbox. No filesystem, network, memory, CPU, or privilege restrictions are configured. A process with sufficient permissions can evade Linux containment. Tags can be changed or cleared, and a process group can be escaped with `setsid`. Linux fallback and passive termination use pidfds when the kernel and libc support them, with creation-time-checked signaling as a compatibility fallback on older systems. In fallback mode, a helper watches the manager pipe and kills tagged processes and process-group members after manager failure. It cannot protect against the helper being killed, privileged evasion, or descendants that remove their tags and escape the process group. Windows uses non-inherited Job Object handles and kill-on-close.

Job records live under the current user's local state directory (`LOCALAPPDATA/agtop` on Windows; `XDG_STATE_HOME/agtop` or `~/.local/state/agtop` on Linux). `AGTOP_STATE_DIR` overrides it. This lets separate `ps` and `kill` commands find a live supervisor's jobs. Job IDs are unique reservations. Records whose supervisor PID and creation time are gone and whose containment unit has no live members are stale; `ps` omits them. `agtop cleanup --stale` removes proven stale records, `--dry-run` previews removal, and `--json` prints machine-readable results. Reusing a stale ID removes its old record during reservation. If the OS cannot verify process or containment state, agtop keeps the record.

Linux reads command lines, creation times, CPU time, RSS, cwd, and selected environment tags from `/proc`. Windows uses an asynchronous CIM snapshot for command lines, CPU time, RSS, and creation times; it uses Koffi for Job Object operations. It does not read another process's PEB. Permission-denied process details may be unavailable. Scanner failures are reported rather than returned as an empty list.

Git attribution walks upward from cwd and reads `.git`, `HEAD`, and `commondir`, supporting linked worktrees, submodules, and detached HEADs without spawning Git. Passive Windows processes have no reliable cwd in CIM, so their worktree is unknown. Managed Windows jobs retain their launch directory. Detection matches executable names and known interpreter entry points, not words inside arbitrary prompts.

## Lemonade

`agtop lemonade` probes `/v1/health` and `/v1/models`, with `/api/v1` compatibility fallbacks. It reports loaded models separately from available models. Requests time out and do not follow redirects. Authenticated Lemonade servers may reject this unauthenticated status probe.

`run --lemonade` sets `OPENAI_BASE_URL`, `OPENAI_API_BASE`, and `ANTHROPIC_BASE_URL` without replacing your API credentials. Use `--lemonade-url URL` for another base URL. Check your harness's endpoint configuration requirements. Current endpoints are described in the [Lemonade API documentation](https://lemonade-server.ai/docs/api/lemonade/).

Backend labels include their evidence. agtop attributes established loopback TCP connections from an agent tree to the listening process when it recognizes a local inference server. Evidence includes the client PID, endpoint, server harness, and server PID (for example, `socket: pid 1234 -> 127.0.0.1:11434 (ollama, pid 999)`). Connections to the known Lemonade port 13305 are labeled Lemonade even when its process is not recognized. A local port without a recognized server remains `unknown` and names the observed endpoint; remote peers are never labeled local. Explicit Lemonade launch settings still indicate intended routing. Socket evidence shows a connection, not model execution or hardware activity.

## Daemon

```sh
agtop daemon --port 13309
```

The server binds to `127.0.0.1`. Its startup message gives the token file path. Supply its contents as `Authorization: Bearer TOKEN` on every request. A random token is generated unless `AGTOP_DAEMON_TOKEN` supplies one of at least 24 characters. Browser-origin requests are rejected, no CORS access is granted, and request bodies are limited to 64 KiB. POSIX token files use mode 0600; Windows relies on the user's profile ACLs.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/v1/harnesses` | Supported harness catalog: id, label and kind |
| GET | `/v1/agents` | Agent trees, CPU/RSS, worktree and containment metadata |
| GET | `/v1/accelerators` | Accelerator devices and measurement status; no per-process data |
| GET | `/v1/lemonade` | Local server status |
| POST | `/v1/agents` | Spawn options JSON; returns job ID, PID and containment mode |
| POST | `/v1/agents/:id/kill` | Confirmed exits, remaining PIDs and errors |

Daemon-created processes use ignored stdio. Graceful shutdown terminates jobs created by that daemon. The token authorizes local process execution and termination, including passive discovered agents, so treat it as a local control credential. Command lines in snapshots can contain application-supplied secrets; only allow trusted consumers to access them.

## MCP server

`agtop mcp` is a stdio MCP server for agents. It provides **task-scoped containment**: an agent can start a long-lived helper or subagent, inspect it, wait for it, and stop it, but cannot stop jobs created by another session. `list` includes `roleCounts` and GPU/NPU tree totals; `status` includes each process's role, listening ports, and accelerator usage only for jobs owned by this MCP session. The `accelerators` tool reports devices and measurement status without per-process data.

| Tool | Purpose |
| --- | --- |
| `list` | Read-only summaries of all jobs; command lines are omitted for jobs this session does not own |
| `status` | Inspect one job; full process details only for owned jobs |
| `run` | Start a contained task and return its job ID |
| `wait` | Wait for an owned job to exit, with a timeout |
| `kill` | Stop an owned job and report exited/failed PIDs |
| `cleanup` | Stop every job created by this MCP session |
| `harnesses` | Search the supported harness catalog |
| `lemonade` | Probe the local Lemonade server |
| `accelerators` | Show accelerator devices and measurement status without per-process data |

The job ID is the task ID: pass your orchestrator or thread task ID as `jobId`, and a peer label as `peer`. OpenCode passes its session ID in MCP metadata; the server appends it to `AGTOP_PEER` automatically. `cleanup` and server shutdown terminate owned jobs, so a finished task does not leave watchers or dev servers behind. MCP `cleanup` also removes records proven stale; it never removes another session's live records. Output is discarded; use the agent's normal shell for commands whose stdout the agent needs.

Register it globally. OpenCode V2 (`~/.config/opencode/opencode.json`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "agtop": {
        "type": "local",
        "command": ["C:\\path\\to\\agtop.exe", "mcp"],
        "codemode": false
      }
    }
  }
}
```

Codex CLI (`~/.codex/config.toml`):

```toml
[mcp_servers.agtop]
command = "C:\\path\\to\\agtop.exe"
args = ["mcp"]
```

Claude Code: `claude mcp add --scope user agtop -- "C:\...\agtop.exe" mcp`. Cursor uses the standard `mcpServers` shape in `~/.cursor/mcp.json`. Kiro and Antigravity use their ACP `mcpServers` configuration.

The server's initialization instructions tell the agent when to use it. For a stronger prompt, install the skill in `skills/agtop/SKILL.md` into the agent's global skills directory.

This is least-privilege: the MCP server only stops jobs it created; the authenticated daemon remains the full-control surface for the orchestrator. agtop is lifecycle containment, not a security sandbox, and command lines can contain secrets, so only expose the daemon view to trusted consumers.

## Build and verify

```sh
bun run check
bun test
bun run test:mcp
bun run bench:containment
bun run build
bun run compile
```

`bun run test:mcp` starts the MCP server, exercises the tool surface, verifies scoped kill and cleanup, and checks that closing the session reaps its jobs. `bun run bench:containment` compares a direct spawn with agtop normal exit and cancellation; the baseline intentionally leaks one detached grandchild, and the script kills its own leftovers in a `finally` block.

`compile` produces `dist/agtop.exe` on Windows or `dist/agtop` on Linux and macOS, embedding the Bun runtime and Koffi native modules. Build on the target OS. The Windows executable has been tested from a separate directory without `node_modules`. It is larger than a native Rust binary. Keep Koffi as a runtime dependency when distributing the unbundled JavaScript library.

On macOS, the libproc scanner needs same-user process access. Other users' processes appear with reduced details; TCC restrictions can also reduce access. Processes in an App Sandbox are unsupported. The opt-in `AGTOP_DARWIN_SCANNER=ps` fallback is read-only and loses environment tags, sockets, CPU/RSS, cwd, and precise argv; it cannot launch or stop jobs. In this mode stale-record cleanup keeps every macOS record, so `agtop cleanup --stale` prunes nothing and a crashed job's `--id` remains reserved until its record is removed manually. macOS RSS is resident memory from the kernel. A DYLD environment that prevents loading system libraries can prevent the libproc scanner from starting. macOS state uses `$XDG_STATE_HOME/agtop` or `~/.local/state/agtop`.

The process-group sweep after a group fully exits matches `pgid === rootPid` without checking the root identity again; if PID wraparound reuses that PID as an unrelated group leader during the roughly 400 ms quiet window, that group could be affected. This is unlikely.

In Node `dist` and library use, `NODE_ENV=test` together with `AGTOP_TEST_WATCHDOG_COMMAND` can replace the crash-cleanup watchdog command, including with a test command that disables cleanup. This hook is unavailable in the compiled binary. It is for testing only; never set it in production.

Tests exercise real disposable process trees, cross-process discovery/termination, normal cleanup, argument preservation, duplicate IDs, daemon authentication, and manager-crash cleanup. Parser and correlation tests cover Linux stat fields, CPU deltas, PID reuse, worktree attribution, backend evidence, and harness recognition (interpreter paths, Python modules, subcommand disambiguation, and false-positive cases). The MCP smoke test and containment benchmark exercise task-scoped ownership, scoped termination, session shutdown, and detached-grandchild cleanup. Set `AGTOP_TEST_CGROUP_ROOT` to run the delegated-cgroup integration test. GitHub Actions runs Windows, Linux, and macOS test and desktop legs; all are blocking. macOS behavior is verified in GitHub Actions on Apple silicon and has not been run on the Windows development host.
