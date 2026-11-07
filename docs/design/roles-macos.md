# agtop design: per-process roles and macOS support

Status: implementation-ready design. Author role: design sub-agent (read-only). Date: 2026-11-07.

Baseline: `github.com/cadenh-dev/agtop` `master` at `2afa942` ("Merge pull request #2 from cadenh-dev/feat/stale-job-records"). PR #2 (stale job records) and PR #12 (Lemonade test string) have both merged. Every unit below is written against that tree. The brief named `fe54b71`. Master moved while this design was being written, and the only differences are PR #2 and PR #12.

Readers are implementers with no other context. Each unit in §6 is self-contained, but read §1–§5 first. They define the shared vocabulary, data shapes, and platform facts the units rely on.

---

## 0. Decision summary

| # | Decision | Section |
|---|---|---|
| D1 | 13 roles: `agent`, `subagent`, `mcp-server`, `inference-server`, `dev-server`, `language-server`, `test-runner`, `build`, `package-manager`, `git`, `browser`, `shell`, `tool` (fallback). | §2.2 |
| D2 | Roles are tree-contextual. They are computed in `correlateTrees()` by a pure function (`src/roles.ts`) and make no extra OS calls. The only new input is the listening sockets the socket scan already reads. | §2.4, §2.9 |
| D3 | Rule table `ROLE_DEFINITIONS` is data-driven like `HARNESS_DEFINITIONS`, evaluated first-match-wins in two phases around the harness catalog (MCP rules run before harness detection; all other rules run after it). | §2.6–§2.8 |
| D4 | Role matching never reads cwd, never unwraps shells, never reads inline-code arguments (`-e`, `-c`, …), and only treats the first program token after an interpreter or package runner as an anchor. Evidence strings contain only catalog literals, PIDs, harness/job IDs and socket endpoints, never raw argv. | §2.5, §2.6 |
| D5 | stdio-pipe relationships are not used in v1. They are ubiquitous for shell tools and cannot be observed on Windows. | §2.4 |
| D6 | MCP: `roleCounts` is visible for every job; per-process `role`/`roleEvidence`/`listening` appear only in `status` for owned jobs (the existing redaction boundary). | §2.10 |
| D7 | macOS discovery uses libproc and sysctl through Koffi (`/usr/lib/libSystem.B.dylib`). The struct offsets used are fixed-width and identical on arm64 and x86_64, and verified (§3.2.3). An ABI self-check fails loudly. A reduced `ps` scanner exists only as an explicit, read-only opt-in (`AGTOP_DARWIN_SCANNER=ps`). | §3.2 |
| D8 | Processes owned by other users stay in the snapshot with PID, PPID, PGID, executable path and start time, but no argv/env/cwd/CPU/RSS/sockets. | §3.2.6 |
| D9 | New containment mode `darwin-env-pgid`: same launcher/tag/process-group design as `linux-env-pgid`, identity-checked SIGKILL, and **no atomic containment**. kqueue is not used (§3.4.3). | §3.4 |
| D10 | The POSIX crash-cleanup helper is generalized (`src/watchdog.ts`). This also fixes three latent bugs on master: the helper cannot start from `dist/` (Node) or from the compiled binary, it dies with the terminal (SIGHUP/SIGINT), and launch never learns that it failed. | §3.4.4 |
| D11 | State directory on macOS stays `$XDG_STATE_HOME/agtop` or `~/.local/state/agtop`, identical to Linux. This needs no TS or Rust change (see open question Q3). | §3.5 |
| D12 | Desktop on macOS: GPUI 0.2.2 needs Xcode plus the Metal toolchain, or the new `runtime-shaders` crate feature. It ships as a bare `dist/agtop-desktop` executable. Signing, notarization, `.app` bundling and universal binaries are deferred. | §3.6 |
| D13 | CI adds `macos-latest` (arm64, macOS 26 image) to both jobs with `fail-fast: false`. The macOS *test* leg is non-blocking until the last unit flips it. The macOS *desktop* leg blocks from the first unit. | §3.7 |

---

## 1. Facts about the current code that the design depends on

- `src/types.ts` is type-only and is re-exported from `src/index.ts` with `export type *`. Runtime constants must live elsewhere (for example `src/roles.ts`).
- `correlateTrees(processes, jobs, members)` (`src/trees.ts`) assigns each PID to exactly one tree. Managed jobs go first, smallest membership first, then tag-only (`unmanaged-<id>`) trees, then passive harness roots in ancestor-first order. A passive nested harness is therefore **inside** its outer passive tree. That is the only place a `subagent` role can be observed. Managed or tagged nested launches become their own trees.
- `detectHarness()` (`src/harnesses.ts`) is evidence-based: basenames, wrapper unwrapping (interpreters **and shells**), all path-like wrapper entries, `-m` modules, a first-positional subcommand, and **cwd** (used only by `text-generation-webui`). Role matching must not inherit the cwd or shell-unwrapping behaviour (§2.5).
- `collectSocketConnections()` (`src/sockets.ts`) already fetches every TCP row with an owning PID (Linux: `/proc/net/tcp*` and `/proc/*/fd`; Windows: `GetExtendedTcpTable`). It keeps only established loopback client connections and throws away listener rows after matching. Errors are swallowed by design ("Errors only omit socket evidence").
- Linux fallback containment (`src/manager.ts`) works like this. It runs a `/bin/sh -c 'read -r gate <&3 || exit 125; exec 3<&-; exec "$@"'` launcher with `detached: true` (setsid, so a new process group), records `rootPid` and `startTime`, writes the job, spawns `src/linux-watchdog.ts` with fd 3 as a pipe, then releases the gate. On exit it scans and SIGKILLs tagged and process-group members with identity checks. The watchdog blocks on fd 3, and on EOF it scans until four consecutive quiet scans.
- **Latent bugs on master** (fixed by unit U4):
  1. `new URL("./linux-watchdog.ts", import.meta.url)` points at a `.ts` file, which does not exist under `dist/`. So `node dist/cli.js run …` spawns a watchdog that exits immediately. In the Bun-compiled binary the module path is virtual, and `process.execPath <path>` re-enters the CLI with an unknown command. Crash cleanup therefore only works when running from source with Bun. CI does not notice because it only kills a manager in the source-mode test.
  2. The watchdog shares the manager's process group and session. Closing the terminal (SIGHUP) or pressing Ctrl+C sends the signal to both, so the watchdog dies with the manager it is meant to outlive.
  3. A watchdog that fails to start is never noticed (stdio ignored, no handshake).
- `src/registry.ts` (PR #2) `processSnapshot()` throws `Unsupported platform` on anything but win32/linux. `isStaleJob()` then returns `false`, so records are kept. `isStaleJob` only treats `linux-env-pgid` on Linux as prunable.
- `scripts/process-probe.ts` (used by `test/mcp.test.ts`, `scripts/mcp-smoke.ts`, `scripts/ab-containment.ts`) reads `/proc` on every non-Windows platform. On macOS it throws.
- `test/stale-records.test.ts` builds records with `mode: "linux-env-pgid"` on every non-Windows platform. On macOS the "dead supervisor is stale" test would fail until it uses the platform's pgid mode.
- `test/discovery-edge.test.ts` mocks `node:fs/promises` and `node:child_process` and runs the Linux and Windows scanners on whatever OS runs the tests. Any new real-FFI socket lookup inside `collectSocketConnections` would contaminate those fixtures on macOS. This is why §3.3 adds a `platform` guard.
- Koffi 2.16.3 is installed and ships prebuilt `darwin_arm64` and `darwin_x64` modules (`node_modules/koffi/build/koffi/`). `koffi.errno()` exists (`index.d.ts`).
- The desktop crate's `Cargo.lock` already contains the macOS GPUI dependencies (`cocoa`, `core-text`, `metal`, `objc`, `bindgen`, `cbindgen`), so `--locked` builds can resolve on macOS.

---

## 2. Feature 1: per-process role classifier

### 2.1 Goals and non-goals

Goals: every process in every `AgentProcessTree` carries `role`, `roleSource` and `roleEvidence`. Each tree carries `roleCounts`. Classification is deterministic, explainable, cheap, and resistant to prompt text.

Non-goals: no new OS calls per process, no measurement of what a process actually does (CPU/GPU use, model execution), no detection of in-process subagents (for example Claude Code's Task tool, which runs inside the agent process), and no reading of agent configuration files.

### 2.2 Role enum (final)

| Role | Label | Meaning | Primary signals |
|---|---|---|---|
| `agent` | Agent | The tree's root agent and its own re-exec/shim chain | tree root of an agent-kind tree; same-harness direct child of an `agent` process; custom-tree root with no other match |
| `subagent` | Subagent | Another agent harness running under an agent | harness catalog (agent kind) on a non-root process; foreign `AGTOP_JOB_ID` tag |
| `mcp-server` | MCP server | Model Context Protocol server | MCP role rules, evaluated **before** harness detection |
| `inference-server` | Inference server | Local model server | tree root of a server-kind tree; harness catalog (server kind) |
| `dev-server` | Dev server | Development or preview web server the agent started | dev-server rules; otherwise any unmatched process with a listening TCP socket |
| `language-server` | Language server | LSP and similar editor-intelligence servers | language-server rules |
| `test-runner` | Test runner | Test frameworks and their workers | test-runner rules |
| `build` | Build | Compilers, bundlers, build systems | build rules |
| `package-manager` | Package manager | Installers and script runners (`npm`, `pip`, `cargo install`, …) | package-manager rules |
| `git` | Version control | git, its helpers, `gh`, `glab`, `hg`, `jj`, `svn` | version-control rules |
| `browser` | Browser | Browsers, headless browsers, WebDriver | browser rules |
| `shell` | Shell | Interactive or `-c` shells, terminal multiplexers | shell rules |
| `tool` | Tool | Anything else: a command the agent ran | fallback |

Display order everywhere (`ROLE_ORDER`) is the table order.

### 2.3 Data shapes (owned by U1 in `src/types.ts`)

```ts
export type ProcessRole =
  | "agent" | "subagent" | "mcp-server" | "inference-server" | "dev-server" | "language-server"
  | "test-runner" | "build" | "package-manager" | "git" | "browser" | "shell" | "tool";

/** Which signal produced a role. */
export type RoleSource = "job" | "harness" | "catalog" | "socket" | "inherited" | "fallback";

export interface ListeningSocket { address: string; port: number }

export interface RawOsProcess {
  // ...existing fields unchanged...
  /** TCP sockets this process is listening on, from the same socket snapshot as socketConnections. */
  listeningSockets?: ListeningSocket[];
}

export interface AgentProcess extends RawOsProcess {
  role: ProcessRole;
  roleSource: RoleSource;
  /** Built only from catalog literals, PIDs, harness/job IDs and socket endpoints. Never raw argv or cwd. */
  roleEvidence: string;
}

export interface AgentProcessTree {
  // ...existing fields unchanged except:
  processes: AgentProcess[];
  /** Count of processes per role in this tree; roles with zero processes are omitted. */
  roleCounts: Partial<Record<ProcessRole, number>>;
}

export type ContainmentMode = "linux-cgroup" | "linux-env-pgid" | "darwin-env-pgid" | "win32-job-object" | "passive-ppid";
```

`AgentProcess` is a superset of `RawOsProcess`, so library consumers that read the old fields keep working. JSON example of one process:

```json
{ "pid": 4312, "ppid": 4290, "name": "node", "cmdline": "node /w/node_modules/vite/bin/vite.js",
  "startTime": "1762500000123456", "cpuSeconds": 1.2, "cpuPercent": 3.1, "memoryMb": 88.2,
  "listeningSockets": [{ "address": "127.0.0.1", "port": 5173 }],
  "role": "dev-server", "roleSource": "catalog", "roleEvidence": "dev-servers: binary vite" }
```

### 2.4 Signals, cost, and what is deliberately not used

| Signal | Source | Cost |
|---|---|---|
| argv / executable / process name | existing scan | none |
| tree position (root, parent, depth) | `correlateTrees` | O(n) |
| managed-job record and tags (`AGTOP_JOB_ID`, `AGTOP_HARNESS`) | existing scan and records | none |
| harness catalog (`detectHarness`, without cwd) | existing code | one call per in-tree process |
| listening TCP sockets | rows that `collectSocketConnections` already fetches | none (no new syscalls) |
| ~~stdio pipe relationship~~ | not used | — |

Why stdio is not used: agent shell tools capture stdout through pipes, so "stdin and stdout are pipes to the agent" is true for MCP servers *and* for every `bash -c` tool call. The signal does not separate the roles we care about. Windows CIM cannot observe it at all, and on macOS it would need per-fd `PROC_PIDFDPIPEINFO` calls. It is listed as a possible future opt-in heuristic in §5.

Classification runs only over processes inside trees (typically tens to a few hundred). Matching is string operations over about 11 definitions with about 60 rules. Budget: 10,000 in-tree processes classified in under 250 ms on CI hardware. U2 tests this.

### 2.5 Command analysis for roles (`analyzeCommand`, owned by U2 in `src/roles.ts`)

U2 exports the low-level helpers `base`, `normalize` and `tokens` from `src/harnesses.ts`, adding only the `export` keyword with no logic change. Role analysis is stricter than harness analysis:

```ts
export interface CommandAnchor { name: string; path: string; rest: readonly string[] }
export interface CommandFacts {
  anchors: readonly CommandAnchor[];
  module?: { name: string; rest: readonly string[] };
}
export function analyzeCommand(p: Pick<RawOsProcess, "name" | "cmdline" | "argv">): CommandFacts;
```

Algorithm (exact):

1. `argv = p.argv?.length ? p.argv : tokens(p.cmdline)`. If that is empty, use `[p.name]`. `exe = argv[0]`, `entry = argv.slice(1)`.
2. `positional(list)`: walk `list`. Skip tokens that start with `-`. Skip the token right after any member of `SKIP_NEXT`. Lowercase what remains.
   `SKIP_NEXT = {"-e","--eval","-p","--print","-c","--command","-r","--require","--import","--loader","--experimental-loader","-C","--conditions","--env-file","-X","-W","--from","--with","--python","--package","--cwd","--config"}`.
   This set covers inline code (`node -e`, `python -c`, `bash -c`) and the common value-taking flags of interpreters and package runners. `--flag=value` is a single token and is skipped because it starts with `-`.
3. Anchor 0: `{ name: base(exe), path: normalize(exe), rest: positional(entry) }`. If `base(p.name) !== base(exe)`, also add `{ name: base(p.name), path: normalize(p.name), rest: positional(entry) }`.
4. Unwrapping. This applies only if `base(exe)` or `base(p.name)` is an interpreter or package runner: `ROLE_INTERPRETERS = {node, nodejs, bun, bunx, deno, npx, pnpx, uv, uvx, pipx, py, env}` or `/^python\d*(\.\d+)?$/`. **Shells are deliberately not unwrapped** (`bash`, `sh`, `zsh`, `fish`, `cmd`, `powershell`, `pwsh`). Walk `entry` from i = 0:
   - `t === "-m"` with a next token: `module = { name: entry[i+1] lowercased with "\\" replaced by "/", rest: positional(entry.slice(i+2)) }`. Stop.
   - `t ∈ SKIP_NEXT`: skip `t` and `entry[i+1]`.
   - `t` starts with `-`: skip.
   - If `base(exe) === "env"` and `t` matches `/^[A-Za-z_][A-Za-z0-9_]*=/`: skip (environment assignment).
   - `t.toLowerCase() ∈ {"run","tool","exec","x","dlx"}`, and this is the first program token so far: skip.
   - Otherwise: `tok = stripPackageSpec(t)`. Push `{ name: base(tok), path: normalize(tok), rest: positional(entry.slice(i+1)) }`. **Stop.** Only the first program token is an anchor. Everything after it is that program's own arguments.
5. `stripPackageSpec(t)`: if `t` matches `/^(@[^/@\s]+\/[^/@\s]+|[^/@\s]+)(?:@[^/\s]*|==[^/\s]*)$/`, return group 1. This turns `@playwright/mcp@latest` into `@playwright/mcp` and `mcp-server-fetch==1.2` into `mcp-server-fetch`. Otherwise return `t` unchanged.
6. **cwd is never consulted** for roles. An agent working in `/work/vite` or `/work/my-mcp-server` must not mark its shells as dev servers or MCP servers.

Harness detection inside the classifier calls `detectHarness({ name: p.name, cmdline: p.cmdline, argv: p.argv })` with no cwd, for the same reason. Consequence, documented in README: `text-generation-webui`, which is recognized only through cwd, is never a nested `inference-server`. It is still recognized as a passive tree root.

### 2.6 Rule table format and matching (U2)

```ts
export interface RoleRule {
  /** Exact anchor basenames (lowercase, platform extension stripped by base()). */
  binaries?: readonly string[];
  binaryPrefixes?: readonly string[];
  /** Matches only when the name is longer than the suffix. */
  binarySuffixes?: readonly string[];
  /** Normalized substrings of an anchor path (executable, process name, first program token). Never cwd. */
  paths?: readonly string[];
  /** `-m` module equal to one of these, or a dotted child of one. */
  modules?: readonly string[];
  modulePrefixes?: readonly string[];
  /** Space-separated positional sequences. The positionals after the matched anchor (or module) must start with one of them. */
  args?: readonly string[];
  /** The rule is skipped when any anchor path contains one of these. */
  excludePaths?: readonly string[];
}
type CatalogRole = Exclude<ProcessRole, "agent" | "subagent" | "tool">;
export interface RoleDefinition { id: string; role: CatalogRole; label: string; rules: readonly RoleRule[]; note?: string }
export const ROLE_DEFINITIONS: readonly RoleDefinition[];
export function matchRoleRule(rule: RoleRule, facts: CommandFacts): string | undefined; // returns the "how" part of the evidence
```

Matching rules:

- If `excludePaths` hits any anchor path, the rule does not match.
- For each anchor in order, compute `how`:
  - `binaries.includes(name)` gives `binary <literal>`.
  - A matching prefix gives `binary prefix <literal>`.
  - A matching suffix gives `binary suffix <literal>`.
  - `paths.find(f => anchor.path.includes(f))` gives `path <literal>`.
  - When `how` is set, `args` must be absent or satisfied: some `seq` where `seq.split(" ").every((part, i) => rest[i] === part)`. On success, return `how` plus ` + args "<seq>"` when args were used.
- Otherwise, if `facts.module` is present: `modules` equality or dotted prefix gives `module <literal>`, and `modulePrefixes` gives `module prefix <literal>`. Then apply the same `args` check against `module.rest`.
- Evidence for a definition match is `${definition.id}: ${how}`, for example `dev-servers: binary next + args "dev"`. Only rule literals appear, so a secret in argv can never leak through evidence. U2 has a test for this.

Table invariants, asserted by U2 tests:
- Definition IDs are unique kebab-case.
- Every literal is lowercase, with `/` separators and no `\`.
- No rule is empty.
- `args` sequences contain no flags.
- Every `CatalogRole` value has at least one definition except `inference-server`, which comes only from the harness catalog.

### 2.7 Initial `ROLE_DEFINITIONS` (U2; order is significant)

Phase A (evaluated before harness detection):

```ts
{ id: "agent-mcp-mode", role: "mcp-server", label: "Agent CLI in MCP server mode", rules: [
  { binaries: ["codex"], args: ["mcp-server"] },
  { binaries: ["claude"], args: ["mcp serve"] },
  { paths: ["@anthropic-ai/claude-code"], args: ["mcp serve"] },
  { binaries: ["goose"], args: ["mcp"] },
  { binaries: ["agtop"], args: ["mcp"] },
] },
{ id: "mcp-servers", role: "mcp-server", label: "Model Context Protocol servers", rules: [
  { paths: ["@modelcontextprotocol/server-", "@playwright/mcp"] },
  { binaryPrefixes: ["mcp-server-", "mcp-remote", "mcp-proxy"] },
  { binarySuffixes: ["-mcp", "-mcp-server", "_mcp"] },
  { modulePrefixes: ["mcp_server_"] },
  { modules: ["mcp_server", "fastmcp"] },
  { binaries: ["fastmcp", "mcp"], args: ["run", "dev"] },
] },
```

Phase B (evaluated after harness detection, first match wins):

```ts
{ id: "language-servers", role: "language-server", label: "Language servers", rules: [
  { binarySuffixes: ["-language-server", "-langserver", "-languageserver", "-lsp", "_lsp"] },
  { binaries: ["tsserver", "typingsinstaller", "vtsls", "rust-analyzer", "gopls", "clangd", "jdtls", "pylsp", "pyls",
      "solargraph", "zls", "omnisharp", "csharp-ls", "terraform-ls", "marksman", "svelteserver", "elixir-ls", "metals",
      "tinymist", "texlab", "nixd", "haskell-language-server-wrapper"] },
  { binaries: ["ruff"], args: ["server"] },
  { binaries: ["biome"], args: ["lsp-proxy", "__run_server"] },
  { binaries: ["deno"], args: ["lsp"] },
  { binaries: ["taplo"], args: ["lsp"] },
  { modules: ["pylsp", "pyls", "jedi_language_server", "ruff_lsp"] },
] },
{ id: "test-runners", role: "test-runner", label: "Test runners", rules: [
  { binaries: ["jest", "vitest", "mocha", "jasmine", "pytest", "py.test", "tox", "nox", "phpunit", "rspec", "karma",
      "ctest", "cargo-nextest", "gotestsum", "nyc", "c8"] },
  { binaries: ["playwright"], args: ["test"] },
  { binaries: ["cypress"], args: ["run", "open"] },
  { binaries: ["bun", "deno", "swift", "dotnet"], args: ["test"] },
  { binaries: ["cargo"], args: ["test", "nextest"] },
  { binaries: ["go"], args: ["test"] },
  { binaries: ["mvn", "mvnw", "gradle", "gradlew"], args: ["test"] },
  { modules: ["pytest", "unittest", "nose2", "tox"] },
  { paths: ["/jest-worker/", "/vitest/dist/", "/tinypool/dist/", "/@playwright/test/", "/_pytest/"] },
] },
{ id: "build-subcommands", role: "build", label: "Build subcommands", rules: [
  { binaries: ["vite", "next", "nuxt", "nuxi", "astro", "parcel", "remix", "ng", "svelte-kit"], args: ["build"] },
  { binaries: ["bun"], args: ["build"] },
  { binaries: ["deno"], args: ["compile", "bundle"] },
  { binaries: ["cargo"], args: ["build", "check", "clippy", "doc", "rustc"] },
  { binaries: ["go"], args: ["build", "install", "vet", "generate"] },
  { binaries: ["dotnet"], args: ["build", "publish", "pack"] },
  { binaries: ["swift", "zig"], args: ["build"] },
] },
{ id: "dev-servers", role: "dev-server", label: "Dev servers", rules: [
  { binaries: ["vite", "webpack-dev-server", "parcel", "nodemon", "live-server", "http-server", "browser-sync",
      "start-storybook", "uvicorn", "gunicorn", "hypercorn", "daphne", "jupyter-lab", "jupyter-notebook"] },
  { binaries: ["next", "nuxt", "nuxi", "astro", "remix", "wrangler", "netlify", "vercel", "storybook"], args: ["dev", "start", "preview"] },
  { binaries: ["webpack", "ng", "vue-cli-service"], args: ["serve"] },
  { binaries: ["react-scripts"], args: ["start"] },
  { binaries: ["rails"], args: ["server", "s"] },
  { binaries: ["manage", "django-admin"], args: ["runserver"] },
  { binaries: ["flask"], args: ["run"] },
  { binaries: ["php"], args: ["artisan serve"] },
  { binaries: ["hugo", "jekyll", "mkdocs", "docusaurus"], args: ["server", "serve", "start"] },
  { binaries: ["jupyter"], args: ["lab", "notebook", "server"] },
  { binaries: ["streamlit"], args: ["run"] },
  { binaries: ["caddy"], args: ["run", "file-server"] },
  { modules: ["http.server", "uvicorn", "gunicorn", "hypercorn", "jupyterlab", "notebook"] },
  { modules: ["flask", "streamlit"], args: ["run"] },
  { modules: ["django"], args: ["runserver"] },
] },
{ id: "build-tools", role: "build", label: "Compilers, bundlers and build systems", rules: [
  { binaries: ["tsc", "tsgo", "esbuild", "webpack", "rollup", "rolldown", "tsup", "tsdown", "swc", "babel", "make", "gmake",
      "ninja", "cmake", "msbuild", "bazel", "bazelisk", "buck2", "rustc", "cc1", "cc1plus", "cc1obj", "clang", "clang++",
      "gcc", "g++", "ld", "ld64", "lld", "ld.lld", "swiftc", "swift-frontend", "javac", "kotlinc", "xcodebuild", "mvn",
      "mvnw", "gradle", "gradlew", "sbt"] },
] },
{ id: "browsers", role: "browser", label: "Browsers and WebDriver", rules: [
  { binaries: ["chrome", "chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "google chrome",
      "google chrome for testing", "chrome-headless-shell", "headless_shell", "msedge", "microsoft edge", "firefox",
      "firefox-bin", "chromedriver", "geckodriver", "msedgedriver", "safaridriver"] },
  { binaryPrefixes: ["google chrome", "chromium", "microsoft edge", "chrome_crashpad"] },
  { paths: ["/ms-playwright/", "/.cache/puppeteer/"] },
] },
{ id: "version-control", role: "git", label: "Version control", rules: [
  { binaries: ["git", "gh", "glab", "hg", "jj", "svn", "lazygit", "tig", "gitui"] },
  { binaryPrefixes: ["git-"] },
  { paths: ["/libexec/git-core/"] },
] },
{ id: "package-managers", role: "package-manager", label: "Package managers and script runners", rules: [
  { binaries: ["npm", "npm-cli", "pnpm", "yarn", "yarnpkg", "corepack", "pip", "pip3", "poetry", "pdm", "pipenv", "conda",
      "mamba", "micromamba", "brew", "port", "apt", "apt-get", "dnf", "yum", "pacman", "apk", "zypper", "winget", "choco",
      "scoop", "gem", "bundle", "bundler", "composer", "nuget", "rustup", "cargo-binstall", "volta"] },
  { binaryPrefixes: ["pip3."] },
  { binaries: ["bun"], args: ["install", "i", "add", "a", "remove", "rm", "update", "upgrade", "link", "unlink", "pm", "outdated", "publish", "patch"] },
  { binaries: ["deno"], args: ["install", "add", "remove", "outdated", "cache"] },
  { binaries: ["uv"], args: ["pip", "add", "remove", "sync", "lock", "venv", "tool install", "tool upgrade", "tool uninstall"] },
  { binaries: ["cargo"], args: ["install", "add", "remove", "fetch", "update", "vendor"] },
  { binaries: ["go"], args: ["get", "mod"] },
  { binaries: ["dotnet"], args: ["restore", "add", "tool"] },
  { binaries: ["pipx"], args: ["install", "upgrade", "uninstall", "inject", "reinstall"] },
  { modules: ["pip", "ensurepip", "poetry", "pipenv"] },
] },
{ id: "shells", role: "shell", label: "Shells and terminal multiplexers", rules: [
  { binaries: ["sh", "bash", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh", "nu", "elvish", "xonsh", "cmd",
      "powershell", "pwsh", "-sh", "-bash", "-zsh", "-fish", "tmux", "screen", "login"] },
] },
```

Ordering notes, all tested:
- `build-subcommands` comes before `dev-servers`, so `vite build` is a build and `vite` alone is a dev server.
- `dev-servers` comes before `build-tools`, so `webpack serve` is a dev server and `webpack` alone is a build.
- `test-runners` comes before `build-tools`, so `mvn test` is a test runner and `mvn package` is a build.
- Phase A comes before harness detection, so `codex mcp-server` is an MCP server, not a subagent.
- Harness detection comes before Phase B, so `gh copilot` is a subagent, not git.

Deliberate choices, documented in README:
- `npm run dev` is classified as `package-manager`. The real server is its child, which gets `dev-server` from a rule or from its listening socket.
- `bun run dev`, `cargo run` and `go run` stay `tool` unless their children or sockets say more.
- `make test` is `build`.
- Docker-launched MCP servers (`docker run … mcp/x`) are `tool`.

### 2.8 Classification algorithm and precedence (U2)

```ts
export interface RoleTreeInput {
  jobId: string; harness: HarnessType; rootPid: number;
  /** Job ID carried in AGTOP_JOB_ID by this tree's own processes: record.jobId, or <id> for unmanaged-<id>. */
  tagId?: string;
  /** True for record-backed and tag-backed trees. */
  managed: boolean;
  processes: readonly RawOsProcess[];
}
export interface RoleAssignment { role: ProcessRole; source: RoleSource; evidence: string }
export function classifyTreeRoles(tree: RoleTreeInput): Map<number, RoleAssignment>;
export function countRoles(processes: readonly { role: ProcessRole }[]): Partial<Record<ProcessRole, number>>;
export const ROLE_ORDER: readonly ProcessRole[];
export const ROLE_INFO: Readonly<Record<ProcessRole, { label: string; description: string }>>;
export function roleCatalog(): Array<{ role: ProcessRole; label: string; description: string; definitions: string[] }>;
```

Processing order: compute each process's depth within the tree by walking `ppid` only through in-tree PIDs, guarding against cycles with a visited set. Sort by depth ascending, then PID ascending, so ancestors are always classified before their descendants and the result does not depend on input order. `parent(p)` means the in-tree process with `pid === p.ppid`, or none.

For the **root** (`p.pid === tree.rootPid`):
1. `harnessKind(tree.harness) === "agent"`: `agent`. Source and evidence: `job` / `root of job <jobId> (<harness>)` when managed, otherwise `harness` / `root: harness <harness>`.
2. Kind `server`: `inference-server`, with the same source rule. Evidence: `root: harness <harness>` or `root of job <jobId> (<harness>)`.
3. Kind `custom`: run B2, then B3 with a root override (an agent-kind match gives `agent`, never `subagent`; a server-kind match gives `inference-server`; source `harness`, evidence `root: harness <h>`), then B4, then B6. B1 and B5 do not apply to a root. If none matches: `agent` / `job` / `root of job <jobId> (custom command)`.

For **every other process** (first rule that applies wins):
- B1 **Nested job tag.** `p.envTags?.AGTOP_JOB_ID` is present and differs from `tree.tagId`, and `AGTOP_HARNESS` is a known harness. Agent kind gives `subagent`; server kind gives `inference-server`. Source `job`, evidence `nested job <id> (<harness>)`.
- B2 **Phase A rules** (MCP). Source `catalog`.
- B3 **Harness catalog.** `h = detectHarness(p without cwd)`.
  - Agent kind:
    - (a) **Launcher chain.** `parent(p)` exists, has role `agent` or `subagent`, and its harness is `h`. The parent's harness is `tree.harness` when the parent is the root, otherwise `detectHarness(parent)`. Result: same role as the parent, source `harness`, evidence `launcher chain: harness <h> under pid <ppid>`.
    - (b) **Orphaned launcher.** `parent(p)` is absent (the recorded root exited), `h === tree.harness`, and no in-tree process has `pid === rootPid`. Result: `agent`, source `harness`, evidence `harness <h>; recorded root pid <rootPid> not running`.
    - (c) Otherwise: `subagent`, source `harness`, evidence `nested harness <h>`.
  - Server kind: `inference-server`, source `harness`, evidence `harness <h>`.
- B4 **Phase B rules.** Source `catalog`.
- B5 **Inheritance.** Walk up through in-tree ancestors, skipping those whose role is `tool`, until the first ancestor with any other role. If that role is in `INHERITABLE = {mcp-server, language-server, test-runner, build, dev-server, browser, inference-server}`, inherit it: source `inherited`, evidence `inherited from pid <ancestor> (<role>)`. Otherwise stop. `agent`, `subagent`, `shell`, `git` and `package-manager` never pass down.
- B6 **Listening socket.** `p.listeningSockets?.length`: `dev-server`, source `socket`, evidence `socket: listening <address>:<port>` using the lowest port.
- B7 **Fallback.** `tool`, source `fallback`, evidence `no matching rule`.

Inheritance (B5) runs before the socket rule (B6) on purpose. A test fixture server inside `jest` stays a `test-runner`, and a DevTools port inside Chrome stays a `browser`. An unknown listener under `npm`, a shell or the agent becomes a `dev-server`.

### 2.9 Integration in `correlateTrees` (U1 placeholder, U2 real)

In `add()` (`src/trees.ts`), after `procs` is final:

```ts
const assignments = classifyTreeRoles({ jobId, harness, rootPid, processes: procs,
  managed: !!record || jobId.startsWith("unmanaged-"),
  tagId: record?.jobId ?? (jobId.startsWith("unmanaged-") ? jobId.slice("unmanaged-".length) : undefined) });
const processes: AgentProcess[] = procs.map(p => ({ ...p, ...toFields(assignments.get(p.pid)!) }));
// toFields maps {role, source, evidence} to {role, roleSource, roleEvidence}
trees.push({ ..., processes, roleCounts: countRoles(processes) });
```

Spread copies keep scanner objects unmutated. Totals still sum over `procs`. The `correlateTrees` signature does not change.

### 2.10 Where roles surface

| Surface | Behaviour | Unit |
|---|---|---|
| Library | `AgentProcessTree.processes[*].role/roleSource/roleEvidence`, `roleCounts`. `src/index.ts` also exports `ROLE_ORDER`, `ROLE_INFO`, `roleCatalog`, `classifyTreeRoles`. | U1 types, U2 exports |
| `agtop ps` / `top` text | Tree header gains a 4th line, `  roles: agent 1, shell 2, dev-server 1`, in `ROLE_ORDER` order with zero counts omitted. The process row becomes `  {indent}{*\|-} {pid} {name}  {role}  {cpu}%  {mem} MiB`. The first three header lines are unchanged. | U5 |
| `agtop ps --json` | New fields serialize automatically. | — |
| `agtop roles [QUERY] [--json]` | Lists `roleCatalog()`: role, label, description, definition IDs. Mirrors `agtop harnesses`. | U5 |
| Daemon `GET /v1/agents` | New fields serialize automatically. No new route. | — |
| MCP `list` | `summary()` adds `roleCounts`. The `query` filter also matches role IDs present in `roleCounts`, so `query: "dev-server"` finds jobs running a dev server. The tool description mentions roles. | U5 |
| MCP `status` | Owned job with `includeProcesses`: each process adds `role`, `roleEvidence`, and `listening: ["127.0.0.1:5173", …]`, which lets an agent find the port its dev server bound. Non-owned job: summary only (`roleCounts`), and processes stay redacted. This is the existing redaction boundary, unchanged. | U5 |
| Desktop `model.rs` | `Process.role`, `role_source`, `role_evidence` (`#[serde(default)]`), `Agent.role_counts: BTreeMap<String, u32>` (`#[serde(default)]`), `ROLE_ORDER`, `role_label()`, `Agent::role_summary()`, `Agent::has_role()`. `Agent::matches()` also searches role IDs and labels. Older daemons without roles still deserialize. | U5 |
| Desktop `ui.rs` | A "Role" column (width 120 px) between Process and PID in the process table, as a text badge: `agent`/`subagent` in `ACCENT`, `shell`/`tool` in `MUTED`, others in `TEXT`. The badge gets a GPUI tooltip with the evidence. A "Roles" fact line in the details pane shows the summary. A "Roles" section in the navigation lists each role present in the snapshot with its total process count; clicking toggles `role_filter: Option<String>`, and `filtered_agents(agents, query, filter, role)` keeps agents whose `role_counts` contains the role. | U5 |
| README | A "Process roles" section: role table, signal order, limits (§2.11 false positives, in-process subagents invisible, cwd-only harnesses, `npm run dev` choice). | U6 |

Tooltip implementation note for U5. GPUI 0.2.2 core provides `StatefulInteractiveElement::tooltip(impl Fn(&mut Window, &mut App) -> AnyView)`. Define `struct RoleTooltip(SharedString)` implementing `Render` (padded `RAISED` box, 12 px text), and build it with `cx.new(|_| RoleTooltip(text.clone())).into()`. Rows need `.id(("process", i))`. The desktop compiles only in CI. If this API does not compile under 0.2.2, fall back to rendering the evidence as a second muted 11 px line under the process name, and note it in the PR.

### 2.11 Test plan for roles (U2: `test/roles.test.ts`)

Fixture helper: `tree(target, { harness = "claude-code", parents = [claude(1), bash(2, ppid 1)], extra = [] })` builds a `RoleTreeInput` whose target has `ppid` 2 unless overridden. The test asserts `role`, `source`, and an evidence regex for the target PID.

**Positive cases** (`test.each`):

| # | target argv (name = basename of argv[0] unless noted) | expected role / source / evidence contains |
|---|---|---|
| P1 | `node /h/.npm/_npx/a/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js /w` | mcp-server / catalog / `mcp-servers: path @modelcontextprotocol/server-` |
| P2 | `npx -y @modelcontextprotocol/server-github` | mcp-server |
| P3 | `uvx mcp-server-git --repository /w` | mcp-server / `binary prefix mcp-server-` |
| P4 | `python3 -m mcp_server_fetch` | mcp-server / `module prefix mcp_server_` |
| P5 | `npx @playwright/mcp@latest` | mcp-server / `path @playwright/mcp` |
| P6 | `chrome-devtools-mcp --headless` | mcp-server / `binary suffix -mcp` |
| P7 | `codex mcp-server` | mcp-server / `agent-mcp-mode: binary codex + args "mcp-server"` |
| P8 | `claude mcp serve` | mcp-server |
| P9 | `node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js mcp serve` | mcp-server / `path @anthropic-ai/claude-code + args "mcp serve"` |
| P10 | `agtop mcp`; `goose mcp developer` | mcp-server |
| P11 | `codex exec "fix tests"` | subagent / harness / `nested harness codex` |
| P12 | `gh copilot suggest "x"` | subagent (not git) |
| P13 | root `node …/@openai/codex/bin/codex.js` (harness codex), target `…/@openai/codex/vendor/aarch64-apple-darwin/codex/codex` with ppid = root | agent / harness / `launcher chain` |
| P14 | harness codex, rootPid 10 absent, target `codex` with ppid 10 | agent / `recorded root pid 10 not running` |
| P15 | `ollama serve`; in a server tree, `ollama runner --model /m` under root `ollama serve` | inference-server / harness |
| P16 | `typescript-language-server --stdio`; `node /w/node_modules/typescript/lib/tsserver.js`; `rust-analyzer`; `gopls`; `ruff server`; `deno lsp`; `python -m pylsp` | language-server |
| P17 | `vitest run`; `npx vitest`; `jest --watch`; `python -m pytest -x tests/`; `node /w/node_modules/jest-worker/build/workers/processChild.js`; `bun test`; `cargo test`; `go test ./...`; `mvn test` | test-runner |
| P18 | `vite build`; `next build`; `cargo build`; `go build ./...`; `tsc --watch`; `webpack --mode production`; `make -j8`; `cc1plus`; `bun build ./x.ts` | build |
| P19 | `vite`; `node /w/node_modules/vite/bin/vite.js`; `next dev`; `webpack serve`; `python manage.py runserver`; `uvicorn app:app --reload`; `python -m http.server 8000`; `env NODE_ENV=development vite --port 3000` | dev-server / catalog |
| P20 | `/h/.cache/ms-playwright/chromium-1140/chrome-linux/chrome --headless=new`; name `Google Chrome Helper (Renderer)`; `chromedriver` | browser |
| P21 | `git status`; `git-remote-https origin https://x`; `gh pr create` | git |
| P22 | `npm run dev`; `node /usr/lib/node_modules/npm/bin/npm-cli.js run dev`; `pnpm install`; `pip install x`; `/usr/bin/python3 /usr/bin/pip install x`; `cargo install rg`; `bun install`; `uv pip install x` | package-manager |
| P23 | `bash -c "npm run dev"`; `cmd.exe /c npm test`; `-zsh`; `pwsh -File x.ps1` | shell |
| P24 | parents `[claude, bash, npm run dev]`, target `node server.js` with `listeningSockets: [{address:"127.0.0.1",port:3000}]` | dev-server / socket / `socket: listening 127.0.0.1:3000` |
| P25 | parents `[claude, bash, jest]`, target `node -e "work()"` | test-runner / inherited / `inherited from pid` |
| P26 | parents `[claude, bash, jest]`, target `node fixture.js` that is listening | test-runner / inherited (B5 before B6) |
| P27 | custom tree, root `npm run dev` | root → package-manager / catalog |
| P28 | custom tree, root `bun -e "setInterval(()=>{},1000)"` | root → agent / job / `root of job` |
| P29 | target with `envTags {AGTOP_JOB_ID:"inner", AGTOP_HARNESS:"codex"}` in tree with `tagId "outer"` | subagent / job / `nested job inner (codex)` |
| P30 | parents `[claude, bash, next dev]`, target `node …/next/dist/server/lib/start-server.js` | dev-server / inherited |

**False-positive cases** (must not get the named role):

| # | target argv | must be |
|---|---|---|
| F1 | `git commit -m "start the vite dev server"` | git (not dev-server) |
| F2 | `node -e "require('vite')"` | tool |
| F3 | `node -e "require('/x/node_modules/@modelcontextprotocol/server-x')"` | tool (inline code skipped) |
| F4 | `claude -p "run pytest and fix mcp-server-git"` | subagent (not mcp-server or test-runner) |
| F5 | `codex exec mcp-server` | subagent (`mcp-server` is not the first positional) |
| F6 | `node /work/my-mcp-server-project/index.js` | tool |
| F7 | `bash` with `cwd: "/work/vite"` | shell (cwd ignored) |
| F8 | `python server.py` with `cwd: "/work/text-generation-webui"` | tool |
| F9 | `cat vite.config.ts`; `grep -r tsserver .`; `go version`; `ruff check .` | tool |
| F10 | `python script.py --mcp-server` | tool (flags are never anchors) |
| F11 | `ssh-agent -s` | tool |
| F12 | `mcp-inspector` | tool |
| F13 | `docker run -i --rm mcp/github` | tool (documented gap) |
| F14 | `bun run server.ts` (no socket) | tool |
| F15 | `tabby`; `goose up`; `server --model x.gguf` | tool |
| F16 | `bun -e "test"` | tool (inline code is not a positional) |
| F17 | parents `[claude, bash]`, target `node app.js` (no socket) | tool |
| F18 | parents `[claude, bash, npm run dev]`, target `node app.js` (no socket) | tool (package-manager is not inheritable) |

**Structural tests:**
- Precedence pairs: `vite`/`vite build`, `webpack`/`webpack serve`, `mvn`/`mvn test`, `codex`/`codex mcp-server`, `gh`/`gh copilot`.
- Order independence: shuffling `processes` gives identical assignments.
- A 10,000-deep chain and a 10,000-wide fan-out each classify in under 250 ms with no stack overflow.
- Cycle in `ppid` within the tree terminates.
- Evidence safety: inject the token `S3CRET-TOKEN-123` into argv positions, `cmdline`, `cwd` and env values across all positive fixtures; no evidence string contains it.
- Catalog invariants (§2.6).
- `countRoles` sums to `processes.length`.
- `correlateTrees()` integration: every tree has `roleCounts`, and every process has the three role fields.

---

## 3. Feature 2: macOS support

### 3.1 Scope and honesty statement

Supported: macOS 13+ on arm64 and x86_64, for CLI, library, daemon, MCP and desktop (bare executable). CI verifies arm64 only (`macos-latest`). x86_64 is expected to work because every layout used is fixed-width and identical, but it is unverified until an Intel leg exists (Q6).

README must say plainly:
- macOS has **no atomic containment**. `darwin-env-pgid` is a process group plus inherited tags, like Linux's fallback. A process can escape with `setsid()` or by clearing its tags.
- There is no pidfd. Termination re-checks the creation time immediately before each signal, and a residual PID-reuse race remains (§3.4.3).
- Processes owned by other users show only PID, parent, group, executable path and start time.
- macOS support has not been run on the development machine (Windows), only in GitHub Actions on Apple silicon.

### 3.2 Discovery: libproc and sysctl through Koffi (U3, `src/darwin.ts`)

#### 3.2.1 Bindings

Load the library lazily on the first darwin call, never at module top level. `src/darwin.ts` is imported on every platform by `sockets.ts` and `registry.ts`.

```ts
const lib = koffi.load("/usr/lib/libSystem.B.dylib"); // dyld resolves it from the shared cache on macOS 11+
const proc_listallpids = lib.func("int proc_listallpids(void *buffer, int buffersize)");
const proc_pidinfo     = lib.func("int proc_pidinfo(int pid, int flavor, uint64 arg, void *buffer, int buffersize)");
const proc_pidfdinfo   = lib.func("int proc_pidfdinfo(int pid, int fd, int flavor, void *buffer, int buffersize)");
const proc_pidpath     = lib.func("int proc_pidpath(int pid, void *buffer, uint32 buffersize)");
const sysctl           = lib.func("int sysctl(int *name, uint32 namelen, void *oldp, _Inout_ size_t *oldlenp, void *newp, size_t newlen)");
const mach_timebase_info = lib.func("int mach_timebase_info(void *info)");
```

- Pass `Buffer` for `void *`, which is shared memory, the same as `windows.ts` does with `GetProcessTimes`.
- Pass `Int32Array.from(mib)` for `int *name`.
- Pass `[length]` for `_Inout_ size_t *`, the same as `windows.ts` does with `InitializeProcThreadAttributeList`.
- Read `koffi.errno()` immediately after a call that returns 0 or -1.
- `proc_pidinfo` and `proc_pidfdinfo` return the number of bytes copied, or 0 on error with errno set.

Injectable interface, so tests run on every OS:

```ts
export interface DarwinNative {
  listAllPids(): number[];                                               // throws DarwinScannerError on failure
  pidInfo(pid: number, flavor: number, size: number): { data: Buffer; bytes: number; errno: number };
  pidFdInfo(pid: number, fd: number, flavor: number, size: number): { data: Buffer; bytes: number; errno: number };
  pidPath(pid: number): string | undefined;
  procArgs(pid: number): Buffer | undefined;   // exactly the bytes sysctl reported
  kinfoProc(pid: number): Buffer | undefined;  // 648 bytes, or undefined when no such process
  readonly timebase: { numer: number; denom: number };
}
export class DarwinScannerError extends Error {}
export function nativeDarwin(): DarwinNative; // memoized; runs the ABI self-check (§3.2.7)
```

#### 3.2.2 Constants

```
PROC_PIDLISTFDS=1  PROC_PIDTASKALLINFO=2  PROC_PIDTBSDINFO=3  PROC_PIDVNODEPATHINFO=9  PROC_PIDT_SHORTBSDINFO=13
PROC_PIDFDSOCKETINFO=3  PROX_FDTYPE_SOCKET=2  SOCKINFO_TCP=2  AF_INET=2  AF_INET6=30  INI_IPV4=0x1  INI_IPV6=0x2
TSI_S_LISTEN=1  TSI_S_ESTABLISHED=4  SIDL=1 SRUN=2 SSLEEP=3 SSTOP=4 SZOMB=5
CTL_KERN=1  KERN_ARGMAX=8  KERN_PROC=14  KERN_PROC_PID=1  KERN_PROCARGS2=49
EPERM=1  ESRCH=3  ENOMEM=12  PROC_PIDPATHINFO_MAXSIZE=4096  MAXPATHLEN=1024  MAXCOMLEN=16
```

#### 3.2.3 Struct layouts (byte offsets; little-endian; identical on arm64 and x86_64)

Every field below is fixed-width (`uint32_t`, `uint64_t`, `int32_t`, char arrays, `off_t` = int64), and both architectures are LP64 little-endian. Layouts come from `bsd/sys/proc_info.h` in xnu. The offsets were checked with an LP64 struct model during design. `sizeof(proc_taskallinfo) = 232` also matches an independent crate assertion (see Sources).

`struct proc_bsdinfo` (size **136**), which is also the first 136 bytes of `proc_taskallinfo`:

| off | field | type |
|---|---|---|
| 0 | pbi_flags | u32 |
| 4 | pbi_status | u32 (SZOMB=5) |
| 12 | pbi_pid | u32 |
| 16 | pbi_ppid | u32 |
| 20 | pbi_uid | u32 |
| 48 | pbi_comm | char[16], NUL-padded |
| 64 | pbi_name | char[32], may be empty |
| 96 | pbi_nfiles | u32 |
| 100 | pbi_pgid | u32 |
| 120 | pbi_start_tvsec | u64 |
| 128 | pbi_start_tvusec | u64 |

`struct proc_taskinfo` (size 96) at offset **136** of `proc_taskallinfo` (total **232**):

| off (abs) | field | units |
|---|---|---|
| 136 | pti_virtual_size | bytes |
| 144 | pti_resident_size | bytes |
| 152 | pti_total_user | **Mach absolute-time ticks** |
| 160 | pti_total_system | **Mach absolute-time ticks** |

`struct proc_bsdshortinfo` (size **64**): pbsi_pid@0, pbsi_ppid@4, pbsi_pgid@8, pbsi_status@12, pbsi_comm@16 (char[16]), pbsi_uid@36.

`struct proc_vnodepathinfo` (size **2352**) = two `vnode_info_path` of 1176 bytes each (`vnode_info` 152 + `char[1024]`). The **cwd path is a NUL-terminated string at offset 152**, max 1024 bytes. The root directory path at 1176+152 is unused.

`struct kinfo_proc` (size **648**, from `sysctl KERN_PROC_PID`): `kp_proc.p_starttime.tv_sec` int64@0, `tv_usec` int32@8, `p_pid` int32@40. Only these three fields are used: start time, plus the PID for a sanity check.

`struct proc_fdinfo` (size 8): proc_fd int32@0, proc_fdtype u32@4.

`struct socket_fdinfo` (size **792**) = `proc_fileinfo` (24) + `socket_info` (768):

| off (abs) | field |
|---|---|
| 180 | soi_protocol (int32; 6 = TCP) |
| 184 | soi_family (int32; AF_INET 2, AF_INET6 30) |
| 256 | soi_kind (int32; SOCKINFO_TCP = 2) |
| 264 | insi_fport. An int that holds a network-order u16 in its low two bytes, so **read `readUInt16BE(264)`**. |
| 268 | insi_lport (`readUInt16BE(268)`) |
| 288 | insi_vflag (u8; INI_IPV4 = 1, INI_IPV6 = 2) |
| 296 | insi_faddr (16 bytes. IPv4 address at +12, i.e. abs 308. IPv6 uses all 16.) |
| 312 | insi_laddr (16 bytes. IPv4 address at abs 324.) |
| 344 | tcpsi_state (int32; LISTEN = 1, ESTABLISHED = 4) |

`KERN_PROCARGS2` buffer: `int32 argc` | exec path (NUL-terminated) | NUL padding | `argc` NUL-terminated argv strings | NUL-terminated env strings, ending at an empty string | apple strings (ignored).

#### 3.2.4 Units and conversions

- **CPU:** `cpuSeconds = Number((user + system) * BigInt(numer) / BigInt(denom)) / 1e9`, with `numer/denom` from `mach_timebase_info` read once. Apple silicon reports 125/3, so one tick is 41.67 ns. Intel reports 1/1. Never assume nanoseconds: skipping the conversion makes Apple silicon CPU about 42× too low (Sources). Assert `denom > 0` at initialization.
- **RSS:** `memoryMb = Number(pti_resident_size) / 1048576`. This is resident size, like `ps rss`, not Activity Monitor's "memory footprint". README states the difference.
- **Start time:** `startTime = String(tv_sec * 1_000_000n + tv_usec)`, decimal microseconds since the Unix epoch. It comes from `p_start` (set at fork) and is constant for the life of the process, so it is a valid identity. It is also strictly comparable between parent and child, which `correlateTrees` needs for its reused-parent check. `proc_bsdinfo` and `kinfo_proc` both expose `p_start`; a CI live test asserts they agree.
- **Name:** `basename(proc_pidpath)`, falling back to `pbi_name`, then `pbi_comm`. This matches Windows' executable-name semantics and avoids `MAXCOMLEN` truncation.
- **argv/cmdline:** argv from `KERN_PROCARGS2`. `cmdline = argv.join(" ") || execPath || name`.
- **envTags:** `parseEnvironment(env.join("\0"))`, using the same allowlist as Linux. The procargs environment is the exec-time environment, like `/proc/<pid>/environ`, so inherited `AGTOP_*` tags are present.
- **state:** a letter from `pbi_status` (1 I, 2 R, 3 S, 4 T, 5 Z). Zombies are skipped, matching Linux.

#### 3.2.5 Per-snapshot algorithm (`readDarwinProcesses(native = nativeDarwin()): DarwinProcessRecord[]`)

```
pids = native.listAllPids()        // n = proc_listallpids(null, 0); cap = n + 64; buf = cap * 4 bytes;
                                   // got = proc_listallpids(buf, cap * 4); got <= 0 → throw DarwinScannerError(errno);
                                   // got >= cap → cap *= 2 and retry (max 4 tries); dedupe; drop pid <= 0
for pid in pids:
  r = pidInfo(pid, PROC_PIDTASKALLINFO, 232)
  if r.bytes === 232:
    bsd = parse(r.data); skip if bsd.status === SZOMB or bsd.pid !== pid
    execPath = pidPath(pid); args = procArgs(pid) → parseProcArgs2; cwd = vnodePath(pid)   // each may be undefined
    re = pidInfo(pid, PROC_PIDTBSDINFO, 136); skip if re.bytes !== 136 or start(re) !== start(bsd)   // same instance
    push full record (restricted = false)
  else if r.errno === ESRCH: continue                                  // exited
  else:                                                                // EPERM: another user's or a protected process; or other errno
    s = pidInfo(pid, PROC_PIDT_SHORTBSDINFO, 64); skip unless s.bytes === 64; skip zombie
    start = darwinIdentity(pid)    // kinfo_proc, any user; skip if undefined
    push reduced record { argv: execPath ? [execPath] : undefined, env: [], cwd: undefined,
                          cpuSeconds: 0, residentBytes: 0, restricted: true }
if records is empty: throw DarwinScannerError("macOS process scan returned no readable processes")
```

`darwinIdentity(pid): string | undefined` uses `sysctl([CTL_KERN, KERN_PROC, KERN_PROC_PID, pid])` into a 648-byte buffer. If `oldlen < 648` (no such process) or `p_pid !== pid`, it returns `undefined`. Otherwise it returns the start time in microseconds. It works for every user and is synchronous.

`darwinIdentities(): Array<{ pid: number; startTime: string; pgid?: number; tag?: string }>` is a synchronous snapshot for `registry.ts`. It reuses `readDarwinProcesses()` and takes `tag` from the `AGTOP_JOB_ID=` entry in the record's env strings.

`parseProcArgs2(buf, length)`:
- `argc = readInt32LE(0)`, rejected if outside 0–65,536.
- Read the exec path up to its NUL, then skip consecutive NULs (padding).
- Read up to `argc` strings, each up to its NUL or `length`. Empty strings are valid: `""` arguments are preserved because counting is by `argc`.
- Read env strings until an empty string or `length`. Never read past `length`, and stop cleanly when truncated.
- Allocate one buffer of `KERN_ARGMAX` bytes (clamped to 64 KiB–4 MiB; 1 MiB if the query fails), reuse it, and reset `oldlen` before every call.

`discovery.ts` (U3) maps each record to a `RawOsProcess` (`pid, ppid, pgid, name, cmdline, argv, startTime, cpuSeconds, cpuPercent: 0, memoryMb, cwd, envTags, state`) and then calls `collectSocketConnections(results, "darwin")`.

#### 3.2.6 Permission behaviour

| Target | TASKALLINFO / PROCARGS2 / VNODEPATHINFO / LISTFDS | SHORTBSDINFO / pidpath / kinfo_proc | Result |
|---|---|---|---|
| Same user, including hardened-runtime and platform binaries run by the user | allowed | allowed | full record |
| Other user / root daemons (agtop not root) | EPERM (xnu `CHECK_SAME_USER`) | allowed | reduced record: pid, ppid, pgid, exe path, start time; `cmdline` = exe path; no CPU/RSS/env/cwd/sockets |
| Any process, agtop running as root | allowed | allowed | full |
| agtop inside an App Sandbox host (for example a sandboxed Electron build) | denied | may be denied | reduced or missing. **Unsupported**; documented. |
| Setuid processes started by the user | PROCARGS2 may fail (EINVAL) | allowed | argv falls back to `[execPath]` |

Termination of other users' processes fails with EPERM from `kill()`. That error is reported in `KillResult.errors`.

#### 3.2.7 Failure reporting

- Library load failure, `mach_timebase_info` failure, or an **ABI self-check** failure throws `DarwinScannerError`. The self-check runs once: `TASKALLINFO(process.pid)` must return exactly 232 bytes with `pbi_pid === process.pid` and `pbi_ppid === process.ppid`, and `PROC_PIDT_SHORTBSDINFO(process.pid)` must return 64. The error message names the call, the byte count or errno, and the remedy: "Set AGTOP_DARWIN_SCANNER=ps for the reduced read-only scanner." `listAgentTrees()` rejects with it, so the CLI prints it, the daemon returns HTTP 400 with the message, and MCP returns a tool error. This keeps the existing rule that "scanner failures are reported rather than returned as an empty list."
- `proc_listallpids` failure throws. Per-PID failures are skipped. A scan with zero readable processes throws, because agtop can always read itself, so zero means an environment problem.
- A future macOS that grows a struct makes `proc_pidinfo` fail with ENOMEM for the 232-byte buffer. The self-check catches that, so it surfaces as an error rather than as missing data.
- Socket enumeration errors are swallowed by `collectSocketConnections`, keeping the existing contract. Their only effect is missing socket evidence.

#### 3.2.8 Reduced `ps` fallback (opt-in only)

`AGTOP_DARWIN_SCANNER=ps` switches discovery to:

```
/bin/ps -axww -o pid=,ppid=,pgid=,rss=,time=,lstart=,state=,command=     (env LC_ALL=C, timeout 20 s, maxBuffer 32 MiB)
```

Parsing (`parseDarwinPs(stdout): RawOsProcess[]`, pure and tested):
- Split each line on whitespace into 11 leading fields: pid, ppid, pgid, rss (KiB), time, then the five `lstart` tokens (weekday month day HH:MM:SS year). The `state` field comes next, and the remainder is `command`.
- `time` accepts `[[D-]H:]M:SS.ss`.
- `lstart` is parsed manually (`C` locale month names, local time) into microseconds at whole-second resolution.
- `name = basename(first token of command)`. Rows with `Z` in state are skipped.

What the fallback loses: env tags (managed jobs keep process-group membership but lose tag membership), cwd (no git attribution), exact argv boundaries (tokenized like Windows `cmdline`), microsecond start times (second resolution weakens PID-reuse protection), CPU precision (centiseconds), all socket evidence and listeners, and argv for other users' processes.

The fallback is **read-only**. On macOS, `spawnContainedAgent` and `killAgentTree` throw "AGTOP_DARWIN_SCANNER=ps is read-only; launching and stopping processes on macOS require the libproc scanner." Identity semantics differ between the two scanners, so they must not be mixed.

### 3.3 Socket attribution on macOS (U3)

`darwinTcpRows(pids: number[], native = nativeDarwin()): TcpRow[]` in `src/darwin.ts`:

```
for pid in pids:
  fds = PROC_PIDLISTFDS into a buffer of 64 × 8 bytes; while bytes returned === buffer size: double it (cap 65,536 entries); EPERM/ESRCH → skip pid
  for each {fd, type} where type === PROX_FDTYPE_SOCKET:
    r = pidFdInfo(pid, fd, PROC_PIDFDSOCKETINFO, 792); skip unless r.bytes === 792
    s = parseSocketFdInfo(r.data); skip unless family ∈ {2, 30} and kind === SOCKINFO_TCP
    rows.push({ pid, state: s.state === 1 ? 2 : s.state === 4 ? 5 : 100 + s.state,
                localAddress, localPort, remoteAddress, remotePort })
```

Address decoding: if `vflag & INI_IPV6`, use 16 bytes and `formatIpv6()` (exported by U1 from `sockets.ts`, producing exactly the strings the Windows parser produces today). Otherwise use the IPv4 bytes at offset +12 and `formatIpv4()`. A dual-stack wildcard listener renders as `0:0:0:0:0:0:0:0`, which `isWildcard()` already accepts.

`collectSocketConnections(processes, platform = process.platform)`. U1 adds the parameter and U3 adds the darwin branch. Rows are fetched **only** when `platform === process.platform`, and the darwin branch passes the scanned PIDs. This stops the mocked Linux and Windows scanner tests in `test/discovery-edge.test.ts` from picking up real macOS sockets. The existing `attributeTcpRows` and the new listener attachment (U1) work unchanged on the macOS rows.

Cost: one `LISTFDS` per same-user process plus one call per socket fd, all synchronous. Other users' processes fail fast with EPERM. As on Linux without root, a root-owned listener is invisible and shows up as "unrecognised listener".

### 3.4 Containment on macOS (U4)

#### 3.4.1 Platform adapter (`src/platform.ts`)

```ts
export type SignalOutcome = "pidfd" | "fallback" | "checked" | "reused";
export interface PosixOps {
  platform: "linux" | "darwin";
  fallbackMode: "linux-env-pgid" | "darwin-env-pgid";
  scan(): Promise<RawOsProcess[]>;
  identity(pid: number): Promise<string | undefined>;
  signal(pid: number, expectedStartTime: string, signal: number): Promise<SignalOutcome>;
  /** Throws in AGTOP_DARWIN_SCANNER=ps mode; no-op otherwise. */
  assertWritable(): void;
}
export function assertSupportedPlatform(platform?: NodeJS.Platform): void; // "agtop supports Windows, Linux, and macOS."
export function scanProcesses(): Promise<RawOsProcess[]>;                  // win32 | linux | darwin dispatch
export function posixOps(platform?: NodeJS.Platform): PosixOps;           // throws on win32
export function isPgidMode(mode: ContainmentMode): mode is "linux-env-pgid" | "darwin-env-pgid";
export async function signalDarwinProcess(pid: number, expectedStartTime: string, signal: number,
  identity?: (pid: number) => string | undefined): Promise<"checked" | "reused">;
```

- Linux `signal` is the existing `signalLinuxProcess`. `src/linux.ts` does not change.
- Darwin `signal`: `if (identity(pid) !== expected) return "reused"; process.kill(pid, signal); return "checked";`. Errors propagate, so `ESRCH` is ignored by callers exactly as today and `EPERM` lands in `errors`.

#### 3.4.2 `darwin-env-pgid` in `src/manager.ts`

- `supported()` calls `assertSupportedPlatform()`.
- Every `process.platform === "win32" ? scanWindowsProcesses() : scanLinuxProcesses()` becomes `scanProcesses()`.
- `members()`: the `linux-env-pgid` branch becomes `isPgidMode(job.mode)`, with identical logic: tagged processes plus process-group members once the root identity is verified.
- `killAgentTree()`: on non-Windows, call `posixOps().assertWritable()` before any signal. In the non-atomic loop, non-Windows calls `posixOps().signal(p.pid, p.startTime, 9)`.
- `spawnContainedAgent()` changes:
  - `if (process.platform !== "linux" && opts?.cgroupRoot) throw new Error("cgroupRoot is supported only on Linux.")`.
  - `AGTOP_CGROUP_ROOT` is honoured only on Linux.
  - Default mode is `win32-job-object`, `linux-env-pgid`, or `darwin-env-pgid`.
  - Call `posixOps().assertWritable()` before reserving the job ID.
  - The launcher (`/bin/sh` gate, `detached: true`) is unchanged.
  - `record.startTime = await posixOps().identity(rootPid)`.
  - Exit cleanup uses `posixOps().scan()` and `.signal()`.
- macOS caveat for README: SIP removes `DYLD_*` variables when executing protected binaries such as `/bin/sh`, so `DYLD_*` set for a managed harness do not reach it. `AGTOP_*` and all other variables are unaffected.

`src/registry.ts`:
- `processSnapshot()` gets a darwin branch that returns `darwinIdentities()`.
- `isStaleJob()` treats `darwin-env-pgid` on darwin like `linux-env-pgid` on Linux.
- Unknown or failed state is still kept, never pruned.

#### 3.4.3 Kill semantics, residual race, and kqueue

Sequence per process: read the creation time with `kinfo_proc`, compare it with the snapshot, then `kill(pid, SIGKILL)`. The residual race is real: the process could exit and its PID be reused by an unrelated process between the check and the `kill()` syscall. On macOS the window is microseconds, and the kernel assigns PIDs sequentially up to 99,999 while skipping in-use PIDs, process-group IDs and session IDs. Reuse inside the window would need a full wraparound, so it is very unlikely, but it is not impossible. Linux closes this gap with pidfds. macOS has no equivalent handle.

kqueue `EVFILT_PROC`/`NOTE_EXIT` was considered. Registering a knote first, verifying identity, then polling with zero timeout before `kill()` narrows the window from "check → kill" to "poll → kill", but it cannot close it, because a knote is not a signalling handle. The gain is negligible for the added FFI surface (`kqueue`, `kevent`, the 32-byte `struct kevent`). **Decision: do not use kqueue in v1.** README states the residual race. The pidfd path stays Linux-only.

Not atomic: a fork that happens during the kill loop is not in the snapshot. `killAgentTree` reports such a process in `failedPids` after its re-scans. The exit-time cleanup and the watchdog re-scan until quiet, which catches most stragglers. A process that calls `setsid()` and clears its tags escapes. Both statements already apply to Linux's fallback and are restated for macOS.

#### 3.4.4 Crash cleanup: generalized watchdog (`src/watchdog.ts`, `src/watchdog-main.ts`)

This replaces `src/linux-watchdog.ts` (deleted) and serves Linux fallback and macOS.

```ts
export const WATCHDOG_ARG = "__agtop-watchdog";
export interface WatchdogCommand { command: string; args: string[]; env: NodeJS.ProcessEnv }
export function watchdogCommand(pgid: number, jobId: string, options?: {
  moduleUrl?: string; exists?: (file: string) => boolean; execPath?: string; electron?: boolean }): WatchdogCommand;
export function launchWatchdog(cmd: WatchdogCommand, timeoutMs?: number): Promise<{ child: ChildProcess; pipe: Writable }>;
export async function runWatchdog(args: string[], ops?: PosixOps): Promise<number>;
```

- `watchdogCommand` resolution:
  1. Let `ext = path.extname(fileURLToPath(moduleUrl ?? import.meta.url))`, which is `.ts` from source and `.js` from `dist/`.
  2. Let `script = fileURLToPath(new URL(\`./watchdog-main${ext}\`, moduleUrl ?? import.meta.url))`.
  3. The build counts as **compiled** when the module URL contains `/$bunfs/` or `~BUN`, or when `!exists(script)`.
  4. Compiled: `{ command: execPath, args: [WATCHDOG_ARG, String(pgid), jobId] }`.
  5. Otherwise: `{ command: execPath, args: [script, String(pgid), jobId] }`.
  6. `env` is `process.env` minus `AGTOP_JOB_ID`, `AGTOP_HARNESS`, `AGTOP_PEER`, `AGTOP_WORKTREE`, `AGTOP_BACKEND` and `AGTOP_DAEMON_TOKEN`, plus `ELECTRON_RUN_AS_NODE=1` when `process.versions.electron` is set (library use inside Electron's main process).
- `src/cli.ts` (U4 adds this, nothing else): the **first** statement of `main()` is `if (args[0] === WATCHDOG_ARG) { process.exitCode = await runWatchdog(args.slice(1)); return; }`. It is not listed in help.
- `launchWatchdog`:
  - Spawn with `{ stdio: ["ignore", "pipe", "ignore", "pipe"], env, detached: true }`. `detached` gives the watchdog its own session, so terminal SIGHUP and SIGINT never reach it.
  - Read stdout until the line `ready`. If the child exits first, or the timeout passes (default 10 s), kill it and reject with `Error("Crash-cleanup helper failed to start (exit <code>)")`.
  - On success: `stdout.destroy()`, `child.unref()`, `(child.stdio[3] as Socket).unref?.()`. Unreferencing lets the manager exit promptly.
- `runWatchdog(args)`:
  - Validate `pgid` (positive safe integer) and `jobId` (`validateJobId`), returning 2 on failure.
  - `fs.fstatSync(3)` must succeed, otherwise return 2.
  - Write `ready\n` to fd 1.
  - Block on `fs.readSync(3, …)` until EOF or error. This is the existing loop.
  - Cleanup loop, as today: targets are `pgid === pgid || envTags.AGTOP_JOB_ID === jobId` excluding `process.pid`; send identity-checked SIGKILL; exit after 4 consecutive quiet scans 100 ms apart.
  - New: a scan that throws counts as not-quiet. Retry after 250 ms, at most 40 consecutive failures, then return 1.
- `spawnContainedAgent` (POSIX, non-cgroup) order:
  1. Launcher spawned.
  2. Identity recorded.
  3. `writeJob`.
  4. `await launchWatchdog(watchdogCommand(rootPid, id))`. If this rejects, the existing `catch` kills the gated launcher (which never ran the harness) and releases the reservation. Launch fails loudly, matching Windows' "setup failures abort launch".
  5. Release the gate.
  6. On exit, `pipe.end()` as today.

### 3.5 State directory, platform gates, git, compile target, Koffi

- **State dir:** unchanged code. On macOS, `stateDir()` resolves to `$XDG_STATE_HOME/agtop` or `~/.local/state/agtop`, and the desktop `client.rs` computes the same path (HOME branch), so no Rust change is needed. README documents it. See Q3 for `~/Library/Application Support`.
- **Platform gates:**
  - `manager.ts` uses `assertSupportedPlatform()` (U4).
  - CLI help gains "macOS uses a process group with inherited tags; there is no atomic containment." (U5).
  - The MCP `run` description changes from "(Windows Job Object or Linux cgroup/process group)" to "(Windows Job Object, Linux cgroup or process group, or macOS process group)" (U5).
  - `package.json` description gains "and macOS" (U6).
  - `desktop.ts` already uses `agtop-desktop` on non-Windows.
- **Git attribution:** works unchanged now that macOS processes have a cwd. The kernel reports real paths (`/private/var/...`, `/private/tmp/...`), while `AGTOP_WORKTREE` holds the path as given. Both resolve to the same repository. Tests that compare paths must `fs.realpathSync()` both sides. Reading `.git` in `~/Desktop`, `~/Documents` or `~/Downloads` can make macOS show a TCC "Files and Folders" prompt for the host app (Terminal, or whatever launched the daemon). README documents this.
- **Bun compile:** `bun build src/cli.ts --compile --outfile dist/agtop` on the macOS host produces a host-arch binary (arm64 on `macos-latest`). Koffi's `darwin_arm64` module is embedded the same way as on Linux and Windows. Apple silicon requires at least an ad-hoc code signature. U6 adds a CI check, `codesign --verify dist/agtop`, that runs `codesign --force --sign - dist/agtop` if verification fails. The README compile note becomes "dist/agtop on Linux and macOS". Cross-compiling for x64 (`--target=bun-darwin-x64`) is deferred (Q6).
- **Koffi:** 2.16.3 ships `darwin_arm64` and `darwin_x64`. No dependency change.

### 3.6 Desktop on macOS

- **Build dependencies.** GPUI 0.2.2's `build.rs` on macOS generates dispatch bindings with `bindgen` (needs libclang; Xcode or the Command Line Tools provide it), generates `scene.h` with `cbindgen`, and compiles Metal shaders with `xcrun -sdk macosx metal` and `metallib` **unless** the `runtime_shaders` feature is enabled. Since Xcode 26 the Metal toolchain is a separate component, installed with `xcodebuild -downloadComponent MetalToolchain`, and builds without it fail with "cannot execute tool 'metal'". Requirements:
  - Default build: full Xcode plus the Metal toolchain.
  - Or: Command Line Tools plus `AGTOP_GPUI_RUNTIME_SHADERS=1`, which enables the desktop crate feature `runtime-shaders = ["gpui/runtime_shaders"]`. Shaders then compile at first launch through the Metal framework, which is always present.
- **U1:**
  - `desktop/Cargo.toml` adds `[features] runtime-shaders = ["gpui/runtime_shaders"]`. Features do not change `Cargo.lock`.
  - `scripts/build-desktop.ts` on darwin for `build|check|test|clippy`: when `AGTOP_GPUI_RUNTIME_SHADERS=1`, add `--features runtime-shaders`. Otherwise preflight `xcrun -sdk macosx metal -v` and, if it fails, exit with "Metal compiler unavailable. Install Xcode and run `xcodebuild -downloadComponent MetalToolchain`, or set AGTOP_GPUI_RUNTIME_SHADERS=1."
  - The output name stays `dist/agtop-desktop`, the same as Linux.
- **U5:**
  - `theme.rs` uses `FONT = ".SystemUIFont"` and `MONO = "Menlo"` on macOS. DejaVu is not installed on macOS.
  - Shortcuts use Cmd on macOS. In `ui.rs`: `#[cfg(target_os = "macos")] const NEW_AGENT_SHORTCUT = "cmd-n"`, refresh `"cmd-r"`, quit `"cmd-q"`. In `input.rs`: `cmd-a`, `cmd-c`, `cmd-v`, `cmd-x`. Other platforms keep `ctrl-*`. The shortcut tests use the constants.
  - The launch-form placeholder stays `codex`.
- **Deferred** (README "Not yet"): `.app` bundle with `Info.plist` and icon, Developer ID signing, hardened runtime, notarization, DMG, universal `lipo` binary, menu bar. The bare executable runs from Terminal or `agtop ui`, and shows a generic Dock icon.

### 3.7 CI (`.github/workflows/ci.yml`)

U1 makes these changes:

```yaml
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
        include:
          - os: macos-latest
            experimental: true        # U6 removes this once macOS units land
    runs-on: ${{ matrix.os }}
    continue-on-error: ${{ matrix.experimental == true }}
    steps:
      # ...existing steps unchanged...
      - name: Compiled crash cleanup (POSIX)
        if: runner.os != 'Windows'
        shell: bash
        run: |
          if [ -f test/posix-crash.test.ts ]; then   # guard removed by U6
            AGTOP_TEST_BIN="$GITHUB_WORKSPACE/dist/agtop" bun test test/posix-crash.test.ts
          fi
  desktop:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
    steps:
      # ...existing...
      - name: Ensure Metal toolchain
        if: runner.os == 'macOS'
        run: |
          if ! xcrun -sdk macosx metal -v >/dev/null 2>&1; then xcodebuild -downloadComponent MetalToolchain; fi
          xcrun -sdk macosx metal -v
```

The macOS desktop leg is **blocking** from U1. If it cannot be made green without editing `desktop/src` (outside U1's scope), U1 marks it experimental the same way and records the failure for U5.

U6 then:
- deletes the `include: experimental` entry,
- removes the `-f` guard,
- adds the `codesign --verify` step after `bun run compile` on macOS,
- keeps `fail-fast: false`.

`macos-latest` currently resolves to macOS 26 on arm64. macOS 14 images retired on 2026-11-02, and Intel images end in fall 2027 (Sources).

### 3.8 macOS test plan

- `test/darwin-parse.test.ts` (U3; runs on every OS; pure Buffers and a fake `DarwinNative`):
  - TASKALLINFO parse: pid, ppid, pgid, comm/name NUL trimming, status, start µs string, RSS MiB, ticks to seconds with timebase 125/3 and 1/1.
  - SHORTBSDINFO parse.
  - cwd at offset 152 with NUL termination, and a 1024-byte path without NUL.
  - `parseProcArgs2`: exec path, padding, argv with `""` and Unicode, allowlisted env, truncation mid-argv and mid-env, negative or huge argc.
  - `parseSocketFdInfo`: IPv4 established 127.0.0.1:50000 to 127.0.0.1:11434, IPv6 `::1` listen, dual-stack wildcard, IPv4 over an AF_INET6 socket, non-TCP kind ignored, UDP ignored.
  - kinfo start parse and PID mismatch.
  - `parseDarwinPs`: lstart with padded day, all time formats, command with spaces, zombie skip.
  - Fake-native scans: EPERM gives a reduced record with `argv [execPath]` and real start time; ESRCH is skipped; start-time recheck mismatch is skipped; zero readable records throws; ABI self-check with 0 bytes and errno ENOMEM throws `DarwinScannerError` mentioning `AGTOP_DARWIN_SCANNER`.
  - `collectSocketConnections(rows, "darwin")` while running on another OS does not call native code.
- `test/darwin-live.test.ts` (U3; `skipIf(process.platform !== "darwin")`):
  - The scan contains `process.pid` with argv equal to `process.argv`, cwd equal to `fs.realpathSync(process.cwd())`, and `startTime === darwinIdentity(process.pid)`.
  - A spawned child with `AGTOP_JOB_ID=live-x` shows `envTags.AGTOP_JOB_ID`.
  - A busy-loop child's `cpuSeconds` rises by at least 0.2 within 1 s (proves timebase conversion), and RSS is above 1 MiB.
  - A child listening on `127.0.0.1:0` produces a LISTEN row with the right port, and a client connection produces an established row attributed to the client PID.
  - PID 1 (launchd) appears restricted with a non-`"0"` start time.
  - `ps -o ppid=,pgid= -p <child>` matches the scan.
- `test/posix-crash.test.ts` (U4; Linux and macOS):
  - Source mode: the existing `linux-crash` scenario, made generic (`ps -o stat= -p PID` for liveness).
  - Compiled mode when `AGTOP_TEST_BIN` is set: run `<bin> run --id posix-crash-compiled -- <bun> -e <spawns detached grandchild>`, SIGKILL the binary, assert both descendants die within 5 s.
- `test/watchdog.test.ts` (U4; every OS):
  - Command resolution for `.ts`, `.js`, `$bunfs`, `~BUN`, a missing script, and Electron.
  - `runWatchdog` argument validation.
  - `launchWatchdog` rejects for a command that exits immediately and for a timeout.
- Existing tests updated by U4:
  - `integration.test.ts` mode expectation becomes a per-platform map.
  - `stale-records.test.ts` uses the platform pgid mode.
  - `mcp.test.ts` runs the crash-reaping test on all three platforms.

---

## 4. Risks and open questions (with recommendations)

| ID | Risk / question | Recommendation |
|---|---|---|
| R1 | Struct offsets wrong on some macOS version | Use only the fixed-width fields listed, keep the ABI self-check, and have live tests compare against `ps`. A future struct growth surfaces as ENOMEM and so as a loud error, not bad data. |
| R2 | Koffi `errno()` not captured for a given call | Wrap every native call in one helper that reads `koffi.errno()` right after a 0 or -1 return. The live test asserts EPERM for pid 1 when not root. |
| R3 | Synchronous libproc scan blocks the event loop (about 20–80 ms for 1,000 processes) | Accept for v1, and record timing in the live test. If the daemon gets slow, move it to a `worker_threads` worker later. |
| R4 | GPUI tooltip API differs in 0.2.2 | Use the documented second-line fallback (§2.10). Desktop compiles only in CI, so U5 must watch the desktop job. |
| R5 | Metal toolchain download in CI is slow or flaky | Keep the precompiled-shader path, because it is what ships. If it flakes more than once, set `AGTOP_GPUI_RUNTIME_SHADERS=1` on the macOS desktop leg only, and keep a weekly job on the default path. |
| R6 | A Bun-compiled binary is unsigned on arm64 (killed: 9) | U6 adds `codesign --verify` with an ad-hoc re-sign fallback. Gatekeeper and quarantine for downloaded binaries need notarization, which is deferred. |
| R7 | Watchdog readiness handshake adds about 50–300 ms per POSIX launch | Accept. It turns a silent loss of crash cleanup into a reported launch failure. |
| R8 | Role heuristics mislabel uncommon tools | Evidence is always shown, the catalog is data-driven, and `tool` is the honest default. Add cases as reported, each with a false-positive test. |
| R9 | `npm run dev` labelled `package-manager` surprises users | Keep it, because the child carries the role. README explains it. Revisit if feedback asks for script-name inference. |
| R10 | SIP strips `DYLD_*` through `/bin/sh` | Document it. A future launcher that does `execve` through Koffi could avoid it, but it is out of scope. |
| R11 | `AGTOP_DARWIN_SCANNER=ps` users expect kill/launch | It is explicitly read-only, and the error message says why. |
| R12 | GitHub-hosted runner image changes (macOS 26, Xcode 26.x) | Pin nothing yet. If an Xcode update breaks GPUI, pin `xcode-version` with `maxim-lobanov/setup-xcode`. |
| R13 | Interactive `agtop run` on POSIX: the harness is in its own session, so SIGWINCH goes to agtop, not the TUI (also true on Linux today) | Out of scope. Note it as a follow-up: forward SIGWINCH from `run`. |
| Q1 | Should nested managed jobs link to their parent tree (`parentJobId`)? | Not in v1. Add it later if the desktop wants a nested view. The classifier already records foreign tags (B1). |
| Q2 | Should stdio pipes become an MCP heuristic? | Not in v1 (§2.4). A future opt-in rule: "a long-lived direct child of an agent with stdin and stdout piped to that agent and no listener" gives `mcp-server`, with evidence `stdio pipes to pid N`. It is observable on Linux and macOS only. |
| Q3 | macOS state dir: XDG path vs `~/Library/Application Support/agtop` | Keep the XDG path (zero cross-component change, no spaces in printed token paths). A later move must change `registry.ts` and `desktop/src/client.rs` together and migrate or scan both directories. |
| Q4 | Should the daemon expose `GET /v1/roles`? | Not needed: the desktop hardcodes `ROLE_ORDER`, and the CLI has `agtop roles`. Add it if a third-party UI asks. |
| Q5 | `Codex.app` bundle layout (`excludePaths: ["codex.app/contents/macos/"]`) | The exclusion is harmless if the layout differs. U1 adds it with a test. Verify against a real install when one is available. |
| Q6 | x86_64 macOS verification | Optional `macos-15-intel` test leg, available until fall 2027, or a `--target=bun-darwin-x64` cross-compile smoke test. Recommendation: add an Intel leg only when someone ships x64 binaries. |
| Q7 | Other users' processes: should they be hidden? | No. Keep reduced records so trees and PPID chains stay coherent and other users' inference servers can still be recognized by executable path. |

---

## 5. Out of scope / follow-ups

kqueue-based exit waiting, stdio-pipe MCP heuristic, `parentJobId`, macOS `.app` packaging and notarization, universal binaries, a `GET /v1/roles` route, SIGWINCH forwarding, a sandboxed-host fallback, and killpg-based group sweeps.

---

## 6. Implementation units

Dependency graph:

```
U1 ──┬── U2 ───────────────┐
     └── U3 ── U4 ─────────┴── U5 ── U6
```

- After U1, **U2 and U3 run in parallel**.
- U4 can overlap with U2.
- U5 needs U2 and U4.
- U6 is last.

Write scopes of units that can run at the same time are disjoint. Sequential reuse of a file is allowed only along a dependency edge, and each such reuse is listed explicitly.

Global rules for every unit:
- Base the branch on the previous unit's merged master.
- Keep `bun run check` and `bun test` green on Windows (the dev host) plus Linux and Windows CI.
- Never weaken an existing test. Update an expectation only where this spec says so.
- Commit message trailer per repository convention.

---

### U1. Shared interfaces, listener sockets, CI and desktop build scaffolding

- **Objective:** Land every shared type and the CI matrix first, so later units can work in parallel without touching shared files.
- **Difficulty:** standard.
- **Depends on:** nothing.
- **Write scope:** `src/types.ts`, `src/sockets.ts`, `src/trees.ts` (placeholder roles only), `src/harnesses.ts` (one `excludePaths` addition only), `desktop/Cargo.toml`, `scripts/build-desktop.ts`, `.github/workflows/ci.yml`, `test/sockets.test.ts`, `test/harnesses.test.ts`, `test/tree-shape.test.ts` (new).
- **Must not touch:** `src/manager.ts`, `src/registry.ts`, `src/discovery.ts`, `src/cli.ts`, `src/mcp.ts`, `src/daemon.ts`, `src/linux*.ts`, `desktop/src/**`, `README.md`, `scripts/process-probe.ts`.
- **Exposes:**
  ```ts
  // types.ts: exactly §2.3 (ProcessRole, RoleSource, ListeningSocket, AgentProcess, AgentProcessTree.processes/roleCounts,
  //           RawOsProcess.listeningSockets, ContainmentMode + "darwin-env-pgid")
  // sockets.ts
  export function formatIpv4(bytes: Uint8Array): string;           // "a.b.c.d"
  export function formatIpv6(bytes: Uint8Array): string;           // byte-for-byte the current Windows parser output
  export function listenersByPid(rows: TcpRow[]): Map<number, ListeningSocket[]>;
  export async function collectSocketConnections(processes: RawOsProcess[], platform?: NodeJS.Platform): Promise<void>;
  ```
- **Steps:**
  1. `types.ts`: add the §2.3 types. It stays type-only.
  2. `sockets.ts`:
     - Extract the IPv4/IPv6 formatting from `parseWindowsTcpTable` into `formatIpv4`/`formatIpv6` and make the parser use them, with no output change.
     - Add `listenersByPid`: rows with `state === 2`, address display `0:0:0:0:0:0:0:1` → `::1` and `0:0:0:0:0:0:0:0` → `::`, deduped by address and port, sorted by port then address.
     - In `collectSocketConnections`, build a `pid → process` map, fetch rows only when `platform === process.platform` (default `process.platform`), attach `socketConnections` as today, and attach `listeningSockets` only when non-empty.
     - Keep the swallow-errors contract.
  3. `trees.ts`: map `procs` to `AgentProcess` with `role: "tool", roleSource: "fallback", roleEvidence: "role classification unavailable"`, and set `roleCounts: { tool: n }`. Totals still sum over `procs`.
  4. `harnesses.ts`: change the codex rule `{ binaries: ["codex"] }` to `{ binaries: ["codex"], excludePaths: ["codex.app/contents/macos/"] }`.
  5. `desktop/Cargo.toml`: add `[features] runtime-shaders = ["gpui/runtime_shaders"]`.
  6. `scripts/build-desktop.ts`: darwin preflight and feature flag (§3.6). The build output copy is unchanged.
  7. `ci.yml`: exactly §3.7, U1 part.
- **Tests:**
  - `test/sockets.test.ts`:
    - (a) Linux fixture with a `0A` listener row attaches `listeningSockets` to the owning PID.
    - (b) Windows IPv4 and IPv6 listener rows (state 2) attach with `::` and `::1` display.
    - (c) A duplicate listener row is deduped.
    - (d) `collectSocketConnections(procs, other)` with `other = process.platform === "win32" ? "linux" : "win32"` fetches no rows: assert no `socketConnections` or `listeningSockets` keys are added. This works on every OS.
    - (e) `formatIpv6` equals the old outputs for loopback, wildcard and v4-mapped.
  - `test/harnesses.test.ts`:
    - `/Applications/Codex.app/Contents/MacOS/Codex` (as name and `argv[0]`) is undefined.
    - `/Applications/Codex.app/Contents/Resources/codex app-server` is `codex`.
    - `/Applications/Claude.app/Contents/MacOS/Claude` is undefined.
  - `test/tree-shape.test.ts`: `correlateTrees` output has `roleCounts` summing to `processes.length`, and every process has `role`, `roleSource` and `roleEvidence`.
- **Acceptance:**
  - `bun run check`, `bun test` and `bun run build` pass locally.
  - CI: ubuntu and windows test and desktop jobs green.
  - The macos desktop job is green (or marked experimental with a recorded reason).
  - The macos test job runs; failures are allowed in U1.

### U2. Role classifier core

- **Objective:** Implement §2.5–§2.9 and §2.11.
- **Difficulty:** hard (precedence, safety and table-driven tests).
- **Depends on:** U1.
- **Write scope:** `src/roles.ts` (new), `src/trees.ts`, `src/harnesses.ts` (add `export` to `base`, `normalize`, `tokens`; no other change), `src/index.ts` (add role exports), `test/roles.test.ts` (new).
- **Must not touch:** `src/types.ts` (frozen; request changes from the U1 owner), `src/sockets.ts`, `src/discovery.ts`, `src/darwin.ts`, `src/manager.ts`, `src/cli.ts`, `src/mcp.ts`, `desktop/**`, CI, README.
- **Exposes:**
  ```ts
  export interface CommandAnchor { name: string; path: string; rest: readonly string[] }
  export interface CommandFacts { anchors: readonly CommandAnchor[]; module?: { name: string; rest: readonly string[] } }
  export function analyzeCommand(p: Pick<RawOsProcess, "name" | "cmdline" | "argv">): CommandFacts;
  export interface RoleRule { /* §2.6 */ }
  export interface RoleDefinition { id: string; role: Exclude<ProcessRole, "agent" | "subagent" | "tool">; label: string; rules: readonly RoleRule[]; note?: string }
  export const ROLE_DEFINITIONS: readonly RoleDefinition[];   // §2.7, Phase A entries first, then Phase B
  export const PRE_HARNESS_ROLES: ReadonlySet<ProcessRole>;    // {"mcp-server"}
  export function matchRoleRule(rule: RoleRule, facts: CommandFacts): string | undefined;
  export interface RoleTreeInput { jobId: string; harness: HarnessType; rootPid: number; tagId?: string; managed: boolean; processes: readonly RawOsProcess[] }
  export interface RoleAssignment { role: ProcessRole; source: RoleSource; evidence: string }
  export function classifyTreeRoles(tree: RoleTreeInput): Map<number, RoleAssignment>;
  export function countRoles(processes: readonly { role: ProcessRole }[]): Partial<Record<ProcessRole, number>>;
  export const ROLE_ORDER: readonly ProcessRole[];
  export const ROLE_INFO: Readonly<Record<ProcessRole, { label: string; description: string }>>;
  export function roleCatalog(): Array<{ role: ProcessRole; label: string; description: string; definitions: string[] }>;
  ```
- **Steps:**
  1. Export the three helpers from `harnesses.ts`. All existing harness tests must stay green.
  2. Write `analyzeCommand` exactly as in §2.5.
  3. Write the table (§2.7) and `matchRoleRule` (§2.6).
  4. Write `classifyTreeRoles` (§2.8). Use iterative depth computation, no recursion, and memoize `detectHarness` per PID inside one call.
  5. Wire it into `trees.ts` (§2.9), replacing U1's placeholder.
  6. Export the public names from `src/index.ts`.
- **Tests:** `test/roles.test.ts` with every positive (P1–P30), false-positive (F1–F18) and structural case from §2.11, plus a `correlateTrees` integration case: passive claude tree with bash, a vite child and an `ollama serve` grandchild gives roles agent, shell, dev-server, inference-server. Existing `test/core.test.ts`, `test/discovery-edge.test.ts` and `test/harnesses.test.ts` must pass unchanged.
- **Acceptance:** `bun run check`, then `bun test test/roles.test.ts test/core.test.ts test/discovery-edge.test.ts test/harnesses.test.ts`, then `bun test` all pass. The performance test passes on CI Linux and Windows.

### U3. macOS discovery and socket attribution

- **Objective:** Implement §3.2 and §3.3: libproc scanner, identity, reduced ps fallback, TCP rows, and the macOS test probe.
- **Difficulty:** hard (FFI, binary layouts; only CI can verify it).
- **Depends on:** U1. Runs in parallel with U2.
- **Write scope:** `src/darwin.ts` (new), `src/discovery.ts`, `src/sockets.ts` (darwin branch and platform plumbing only), `scripts/process-probe.ts`, `test/darwin-parse.test.ts` (new), `test/darwin-live.test.ts` (new).
- **Must not touch:** `src/types.ts`, `src/trees.ts`, `src/roles.ts`, `src/harnesses.ts`, `src/manager.ts`, `src/registry.ts`, `src/cli.ts`, `src/mcp.ts`, `desktop/**`, CI, README.
- **Exposes (consumed by U4):**
  ```ts
  // src/darwin.ts (no top-level native loading)
  export class DarwinScannerError extends Error {}
  export interface DarwinNative { /* §3.2.1 */ }
  export function nativeDarwin(): DarwinNative;
  export interface DarwinProcessRecord { pid: number; ppid: number; pgid: number; status: number; name: string; execPath?: string;
    argv?: string[]; env: string[]; cwd?: string; startTime: string; cpuSeconds: number; residentBytes: number; restricted: boolean }
  export function readDarwinProcesses(native?: DarwinNative): DarwinProcessRecord[];
  export function darwinIdentity(pid: number, native?: DarwinNative): string | undefined;
  export function darwinIdentities(native?: DarwinNative): Array<{ pid: number; startTime: string; pgid?: number; tag?: string }>;
  export function darwinTcpRows(pids: number[], native?: DarwinNative): TcpRow[];
  export function darwinScannerMode(): "libproc" | "ps";        // from AGTOP_DARWIN_SCANNER
  export function parseProcArgs2(buf: Buffer, length: number): { execPath: string; argv: string[]; env: string[] } | undefined;
  export function parseTaskAllInfo(buf: Buffer): { pid: number; ppid: number; pgid: number; status: number; comm: string; name: string;
    nfiles: number; startTime: string; residentBytes: bigint; userTicks: bigint; systemTicks: bigint };
  export function parseShortBsdInfo(buf: Buffer): { pid: number; ppid: number; pgid: number; status: number; comm: string; uid: number };
  export function parseVnodeCwd(buf: Buffer): string | undefined;
  export function parseSocketFdInfo(buf: Buffer): { family: number; state: number; localAddress: string; localPort: number; remoteAddress: string; remotePort: number } | undefined;
  export function parseKinfoStart(buf: Buffer, pid: number): string | undefined;
  export function parseDarwinPs(stdout: string): RawOsProcess[];
  // src/discovery.ts
  export async function scanDarwinProcesses(): Promise<RawOsProcess[]>;   // libproc or ps mode; then collectSocketConnections(r, "darwin") in libproc mode
  ```
- **Steps:**
  1. `darwin.ts`: constants (§3.2.2), offset readers (§3.2.3), conversions (§3.2.4), native binding with an errno-capturing call helper, the ABI self-check (§3.2.7), `readDarwinProcesses` (§3.2.5), `darwinIdentity`/`darwinIdentities`, `darwinTcpRows` (§3.3), and the ps parser (§3.2.8). Import `TcpRow` as a type only from `sockets.ts`.
  2. `discovery.ts`: add `scanDarwinProcesses()` (records to `RawOsProcess`, using `parseEnvironment`). Pass an explicit platform to `collectSocketConnections` from each scanner: `"linux"`, `"win32"`, `"darwin"`.
  3. `sockets.ts`: when `platform === "darwin"`, rows are `darwinTcpRows(processes.map(p => p.pid))`.
  4. `scripts/process-probe.ts`: darwin branch using `ps -axww -o pid=,ppid=,stat=,command=`. Skip `Z` states. Name is the basename of the first token.
- **Tests:** §3.8, the `darwin-parse` (all OS) and `darwin-live` (darwin only) lists. `test/discovery-edge.test.ts` must stay green on all three OSes. On macOS, the platform guard is what keeps it green.
- **Acceptance:**
  - Locally: `bun run check` and `bun test test/darwin-parse.test.ts test/discovery-edge.test.ts test/sockets.test.ts`.
  - CI: in the macOS test job log (still experimental), every test in `test/darwin-parse.test.ts` and `test/darwin-live.test.ts` passes. Linux and Windows jobs stay green.

### U4. Generalized POSIX containment, `darwin-env-pgid`, and watchdog fixes

- **Objective:** Implement §3.4 and the registry changes. Make launch, kill and crash cleanup work on macOS, and fix the three watchdog bugs on every POSIX platform.
- **Difficulty:** hard (process lifecycle, three run modes, CI-only verification).
- **Depends on:** U1, U3. Can overlap with U2.
- **Write scope:** `src/platform.ts` (new), `src/watchdog.ts` (new), `src/watchdog-main.ts` (new), `src/linux-watchdog.ts` (delete), `src/manager.ts`, `src/registry.ts`, `src/cli.ts` (**only** the `WATCHDOG_ARG` dispatch at the top of `main()` plus its import), `test/posix-crash.test.ts` (new), `test/linux-crash.test.ts` (delete), `test/watchdog.test.ts` (new), `test/integration.test.ts` (mode expectation), `test/stale-records.test.ts` (platform mode), `test/mcp.test.ts` (crash-test gate and comment only).
- **Must not touch:** `src/darwin.ts` (consume only), `src/discovery.ts`, `src/sockets.ts`, `src/types.ts`, `src/trees.ts`, `src/roles.ts`, `src/harnesses.ts`, `src/linux.ts`, `src/mcp.ts`, `src/daemon.ts`, `desktop/**`, CI, README.
- **Exposes:** the §3.4.1 `platform.ts` API and the §3.4.4 `watchdog.ts` API.
- **Steps:**
  1. `platform.ts` (§3.4.1). Darwin `identity` is `async pid => darwinIdentity(pid)`. `assertWritable` throws in ps mode.
  2. `watchdog.ts` and `watchdog-main.ts` (§3.4.4). `watchdog-main.ts` is just `process.exitCode = await runWatchdog(process.argv.slice(2));`.
  3. `cli.ts`: hidden dispatch as the first statement of `main()`. Change nothing else in that file.
  4. `manager.ts` (§3.4.2), including the watchdog launch order and failure handling.
  5. `registry.ts`: darwin `processSnapshot` branch and `isStaleJob` darwin-env-pgid (§3.4.2).
  6. Delete `src/linux-watchdog.ts` and `test/linux-crash.test.ts`. Their behaviour moves into the new files.
  7. Tests:
     - `integration.test.ts` line 49 becomes `({ win32: "win32-job-object", linux: "linux-env-pgid", darwin: "darwin-env-pgid" } as Record<string, string>)[process.platform]`.
     - `stale-records.test.ts` `record()` uses `darwin-env-pgid` on darwin and `linux-env-pgid` on Linux.
     - `mcp.test.ts`: change `skipIf(process.platform !== "win32")` on the crash-reaping test to `skipIf(!["win32", "linux", "darwin"].includes(process.platform))`, rename it to "killing the MCP server process reaps owned jobs", and update the comment (POSIX reaping is done by the watchdog).
- **Tests:** §3.8, the `posix-crash` and `watchdog` lists. Existing `test/cli.test.ts`, `test/daemon-security.test.ts`, `test/integration.test.ts`, `test/stale-records.test.ts`, `test/linux-pidfd.test.ts`, `test:mcp` and `bench:containment` must pass on Linux and macOS.
- **Acceptance:**
  - Locally: `bun run check`, `bun test`, `bun run test:mcp`, `bun run bench:containment` (Windows paths unchanged).
  - CI Linux (blocking): the full suite plus the new compiled crash step, now active because the test file exists.
  - CI macOS test job: the full suite passes, including `posix-crash` in source and compiled modes and `node dist/cli.js run -- …`. The job is still marked experimental, but the log must be fully green.

### U5. Role and macOS surfaces: CLI, MCP, desktop

- **Objective:** Expose roles everywhere (§2.10) and finish the macOS user-facing polish (help text, MCP wording, desktop fonts and shortcuts).
- **Difficulty:** standard (large but mechanical; desktop verified only in CI).
- **Depends on:** U2 (roles), U4 (`cli.ts` and `mcp.test.ts` are edited after U4).
- **Write scope:** `src/cli.ts` (renderer, help, `roles` command), `src/mcp.ts`, `desktop/src/model.rs`, `desktop/src/ui.rs`, `desktop/src/input.rs`, `desktop/src/theme.rs`, `test/cli.test.ts`, `test/mcp.test.ts` (role assertions), `test/render.test.ts` (new).
- **Must not touch:** `src/roles.ts` (consume only; request catalog changes from the U2 owner), `src/types.ts`, `src/manager.ts`, `src/registry.ts`, `src/watchdog.ts`, `src/darwin.ts`, `src/daemon.ts`, `desktop/Cargo.toml`, `scripts/build-desktop.ts`, CI, README.
- **Interfaces consumed:** `ROLE_ORDER`, `ROLE_INFO`, `roleCatalog` from `src/roles.ts`; `AgentProcess` and `roleCounts` from `src/types.ts`.
- **Steps:**
  1. `cli.ts`:
     - `renderTrees` gets the roles line and role column (§2.10).
     - New `agtop roles [QUERY] [--json]`, filtering `roleCatalog()` by substring over role, label, description and definition IDs. Text output is `role  label  description`.
     - Help gains the `roles` line and the macOS containment line (§3.5).
  2. `mcp.ts`:
     - `summary()` adds `roleCounts`.
     - The `list` filter also matches role keys.
     - `status` adds per-process `role`, `roleEvidence` and `listening` (`address:port` strings) for owned jobs only.
     - Descriptions mention roles and the macOS process group.
  3. `model.rs` (§2.10), with serde defaults.
  4. `ui.rs`:
     - Role column, tooltip, details fact, navigation role filter, `filtered_agents(…, role: Option<&str>)`.
     - macOS Cmd shortcut constants, plus the existing tests updated to use the constants.
  5. `input.rs`: `cmd-a`/`cmd-c`/`cmd-v`/`cmd-x` on macOS through `cfg`.
  6. `theme.rs`: macOS fonts.
- **Tests:**
  - `test/render.test.ts`: a synthetic tree renders the `roles: agent 1, shell 1, dev-server 1` line, rows contain the role between name and CPU, and zero-count roles are omitted.
  - `test/cli.test.ts`:
    - `TREE_FIELDS` gains `roleCounts` and `PROCESS_FIELDS` gains `role`, `roleSource`, `roleEvidence`.
    - The managed custom job's root has `role === "agent"` and `roleSource === "job"`.
    - `agtop roles --json` lists all 13 roles in `ROLE_ORDER`.
    - `agtop roles mcp` returns only `mcp-server`.
  - `test/mcp.test.ts`:
    - Owned `status` with `includeProcesses` has `role`, `roleEvidence` and `listening` on each process, and the root is `agent`.
    - `list` includes `roleCounts`.
    - A second session's `status` on a foreign job has `roleCounts` but no `processes`.
    - `list { query: "agent" }` finds the job.
  - Rust:
    - `model.rs`: deserialize JSON with roles; deserialize legacy JSON without roles (defaults); `role_summary` order; `matches("dev-server")`.
    - `ui.rs`: `filtered_agents` with a role filter; the shortcut constants map to actions on the current platform.
- **Acceptance:**
  - Locally: `bun run check`, `bun test`, `bun run test:mcp`.
  - CI: desktop jobs green on ubuntu, windows and macOS (`bun scripts/build-desktop.ts fmt -- --check`, `test --locked`, `build --locked`). The test jobs are green, and the macOS log is fully green.

### U6. Documentation, packaging metadata, CI finalization

- **Objective:** Make docs honest and complete for both features, and make macOS CI blocking.
- **Difficulty:** standard.
- **Depends on:** U1–U5.
- **Write scope:** `README.md`, `desktop/README.md`, `skills/agtop/SKILL.md`, `package.json` (description only), `.github/workflows/ci.yml` (remove `experimental`, remove the `-f` guard, add the macOS `codesign --verify` step after `bun run compile`), `test/docs.test.ts` (new).
- **Must not touch:** any `src/**`, `desktop/src/**`, `scripts/**`, other tests.
- **Steps (README):**
  1. Title line and intro say "Windows, Linux, and macOS".
  2. New "Process roles" section: §2.2 table, signal order (§2.8 in prose), the evidence format, and limits: in-process subagents invisible, cwd-only harness detection not applied to nested processes, the `npm run dev` choice, Docker-launched MCP servers are `tool`, sockets show listening and not activity.
  3. The containment table gains a `darwin-env-pgid` row: "Process group plus inherited `AGTOP_*` tags. A pipe-watched helper in its own session cleans up after manager failure. Termination re-checks creation time before each SIGKILL; there is no pidfd, so a microsecond PID-reuse race remains. Not atomic."
  4. Recognition: "libproc on macOS".
  5. macOS permissions (§3.2.6), the `AGTOP_DARWIN_SCANNER=ps` read-only fallback and what it loses (§3.2.8), RSS semantics, DYLD caveat, TCC note, state dir on macOS.
  6. Desktop on macOS: Xcode plus the Metal toolchain or `AGTOP_GPUI_RUNTIME_SHADERS=1`; Cmd shortcuts; deferred signing and notarization.
  7. "Build and verify": compile output on macOS, CI legs, "macOS behaviour is verified in GitHub Actions on Apple silicon; it has not been run on the Windows development host."
  8. MCP section: `roleCounts` and owned-only process roles and listening ports.
- **Steps (other files):**
  - `SKILL.md`: mention "a macOS process group" in the opening sentence, and that `status` shows each process's role and listening ports for owned jobs.
  - `package.json`: description becomes "Agent-aware process discovery and OS containment for Windows, Linux, and macOS".
- **Tests:** `test/docs.test.ts` reads `README.md` and asserts:
  - every `ROLE_ORDER` ID appears in the roles table,
  - every `ContainmentMode` value appears in the containment table (import the values from a literal list in the test, since the type is erased),
  - `AGTOP_DARWIN_SCANNER` is documented.
- **Acceptance:** `bun run check`, `bun test test/docs.test.ts`, `bun test`. In CI, all six legs (test and desktop × ubuntu, windows, macOS) are green and **blocking**. The workflow file has no remaining `experimental` key.

---

## 7. Sources

- Apple xnu `bsd/sys/proc_info.h` (struct layouts, flavors, `TSI_S_*`, `INI_IPV*`, `PROX_FDTYPE_SOCKET`): https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info.h and https://opensource.apple.com/source/xnu/xnu-7195.81.3/bsd/sys/proc_info.h.auto.html
- xnu `socket_info.c` (how `tcpsi_state` and the ports are filled): https://newosxbook.com/code/xnu-3247.1.106/bsd/kern/socket_info.c.auto.html
- `proc_taskallinfo` size 232 (independent crate assertion): https://docs.rs/crate/darwin-libproc-sys/latest/source/src/pidinfo.rs
- Mach absolute time in `pti_total_user`/`pti_total_system` and the 125/3 timebase on Apple silicon: https://github.com/tfpickard/isotop/wiki/Theory-Sampling-macOS and https://bugzilla.mozilla.org/show_bug.cgi?id=1753310
- GPUI 0.2.2 build script (bindgen, cbindgen, `xcrun metal`, `runtime_shaders`): https://docs.rs/crate/gpui/0.2.2/source/build.rs
- The Metal toolchain is unbundled from Xcode 26 (`xcodebuild -downloadComponent MetalToolchain`): https://searchfox.org/firefox-main/source/third_party/angle/src/libANGLE/renderer/metal/BUILD.gn
- Zed's removal of the Tahoe runtime-shaders callout: https://git.secluded.site/zed/commit/e9244d50a7e82cce9b74bef93655a81abf3f8b24
- GitHub runner images (macos-latest is macOS 26 on arm64; macOS 14 retired 2026-11-02; Intel ends fall 2027): https://github.blog/changelog/2026-10-01-github-actions-macos-14-runner-image-retirement and https://github.blog/changelog/2025-09-19-github-actions-macos-13-runner-image-is-closing-down/
- Bun standalone executables (targets, embedded `.node` addons, `$bunfs` virtual paths): https://bun.com/docs/bundler/executables and https://bun.sh/blog/bun-v1.3.1
- Local evidence: `node_modules/koffi` 2.16.3 prebuilds (`darwin_arm64`, `darwin_x64`) and `koffi.errno()` in `index.d.ts`; `desktop/Cargo.lock` contains the macOS GPUI dependencies.
