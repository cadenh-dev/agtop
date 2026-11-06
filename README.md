<img src="assets/icon.svg" width="64" height="64" alt="">

# agtop

Agent-aware process discovery and containment for Windows and Linux. Use it as a terminal monitor, a TypeScript library, or a local HTTP service for an Electron application.

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
| `linux-env-pgid` | Default Linux fallback: a detached process group plus inherited `AGTOP_*` tags. This supports attribution of many reparented children, but termination is best effort. |
| `passive-ppid` | Discovery of independently started processes. Termination uses the observed processes with creation-time checks. It cannot provide atomic containment or recover arbitrary descendants that reparented before discovery. |

### Recognition

Passive discovery does not require agent cooperation. agtop reads the OS process table (CIM on Windows, `/proc` on Linux) and matches a process by executable basename, interpreter entry point, install path, Python module, or a disambiguating subcommand:

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

These mechanisms manage process lifetimes; they are not a security sandbox. No filesystem, network, memory, CPU, or privilege restrictions are configured. A process with sufficient permissions can evade Linux containment. Tags can be changed or cleared, and a process group can be escaped with `setsid`. Linux fallback termination checks process creation times but still has a check-to-signal race; it does not use pidfds. A hard crash of the Linux manager does not automatically kill its children. Windows uses non-inherited Job Object handles and kill-on-close.

Job records live under the current user's local state directory (`LOCALAPPDATA/agtop` on Windows; `XDG_STATE_HOME/agtop` or `~/.local/state/agtop` on Linux). `AGTOP_STATE_DIR` overrides it. This lets separate `ps` and `kill` commands find a live supervisor's jobs. Job IDs are unique reservations. A crashed manager can leave an inactive record; choose a new ID or remove the stale record after verifying that its job no longer exists.

Linux reads command lines, creation times, CPU time, RSS, cwd, and selected environment tags from `/proc`. Windows uses an asynchronous CIM snapshot for command lines, CPU time, RSS, and creation times; it uses Koffi for Job Object operations. It does not read another process's PEB. Permission-denied process details may be unavailable. Scanner failures are reported rather than returned as an empty list.

Git attribution walks upward from cwd and reads `.git`, `HEAD`, and `commondir`, supporting linked worktrees, submodules, and detached HEADs without spawning Git. Passive Windows processes have no reliable cwd in CIM, so their worktree is unknown. Managed Windows jobs retain their launch directory. Detection matches executable names and known interpreter entry points, not words inside arbitrary prompts.

## Lemonade

`agtop lemonade` probes `/v1/health` and `/v1/models`, with `/api/v1` compatibility fallbacks. It reports loaded models separately from available models. Requests time out and do not follow redirects. Authenticated Lemonade servers may reject this unauthenticated status probe.

`run --lemonade` sets `OPENAI_BASE_URL`, `OPENAI_API_BASE`, and `ANTHROPIC_BASE_URL` without replacing your API credentials. Use `--lemonade-url URL` for another base URL. Check your harness's endpoint configuration requirements. Current endpoints are described in the [Lemonade API documentation](https://lemonade-server.ai/docs/api/lemonade/).

Backend labels include their evidence. A configured local port 13305 or an explicit Lemonade launch option indicates intended routing, not measured GPU/NPU activity. Without observable evidence the backend remains `unknown`; server availability alone does not classify every agent as local. Socket attribution and GPU/NPU utilization measurement are not implemented.

## Daemon

```sh
agtop daemon --port 13309
```

The server binds to `127.0.0.1`. Its startup message gives the token file path. Supply its contents as `Authorization: Bearer TOKEN` on every request. A random token is generated unless `AGTOP_DAEMON_TOKEN` supplies one of at least 24 characters. Browser-origin requests are rejected, no CORS access is granted, and request bodies are limited to 64 KiB. POSIX token files use mode 0600; Windows relies on the user's profile ACLs.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/v1/harnesses` | Supported harness catalog: id, label and kind |
| GET | `/v1/agents` | Agent trees, CPU/RSS, worktree and containment metadata |
| GET | `/v1/lemonade` | Local server status |
| POST | `/v1/agents` | Spawn options JSON; returns job ID, PID and containment mode |
| POST | `/v1/agents/:id/kill` | Confirmed exits, remaining PIDs and errors |

Daemon-created processes use ignored stdio. Graceful shutdown terminates jobs created by that daemon. The token authorizes local process execution and termination, including passive discovered agents, so treat it as a local control credential. Command lines in snapshots can contain application-supplied secrets; only allow trusted consumers to access them.

## Build and verify

```sh
bun run check
bun test
bun run build
bun run compile
```

`compile` produces `dist/agtop.exe` on Windows or `dist/agtop` on Linux, embedding the Bun runtime and Koffi native modules. Build on the target OS. The Windows executable has been tested from a separate directory without `node_modules`. It is larger than a native Rust binary. Keep Koffi as a runtime dependency when distributing the unbundled JavaScript library.

Tests exercise real disposable process trees, cross-process discovery/termination, normal cleanup, argument preservation, duplicate IDs, daemon authentication, and Windows manager-crash cleanup. Parser and correlation tests cover Linux stat fields, CPU deltas, PID reuse, worktree attribution, backend evidence, and harness recognition (interpreter paths, Python modules, subcommand disambiguation, and false-positive cases). Set `AGTOP_TEST_CGROUP_ROOT` to run the delegated-cgroup integration test. GitHub Actions runs Windows and Linux checks, including a delegated cgroup test on Linux. Linux runtime behavior has not been locally verified on the Windows development host.
