# agtop design: per-process GPU and NPU usage

Status: plan for implementation (units A1–A5). Base: master after PR #19.
Research basis: `docs/design/accelerators-research.md` (copied from the research report; treat its claims as leads to verify, not facts).

## 0. Goals and honesty rules

- Show, per agent-tree process and per tree, how much GPU and NPU each process is using, plus GPU memory where the OS exposes it.
- Never invent numbers. Every value is either measured over an interval or absent. Absent values carry a reason (`unavailable` with a short machine-readable reason and a human message).
- Same sampling model as CPU today (`CpuSampler` in `src/discovery.ts`): a value needs two samples of a cumulative counter; the first snapshot of a process reports no utilisation, not 0.
- Only processes that are already in an agent tree are measured (bounds cost on Linux, where fdinfo must be read per process). Windows/macOS sources return all processes at once; filter to tree PIDs.
- No elevated privileges, no spawning helper processes per snapshot, no new runtime dependencies (Koffi only).
- Importing the library on any OS has no side effects; native libraries load lazily on first sample, and a load failure becomes an `unavailable` status, never a crash or a failed snapshot.

## 1. Data model (`src/types.ts`, additive only)

```ts
export type AcceleratorKind = "gpu" | "npu";

/** One accelerator device as seen by agtop. `id` is stable for the life of the device. */
export interface AcceleratorDevice {
  id: string;                 // win: "luid:0x00000000_0x0000963c"; linux drm: "drm:0000:03:00.0"; nvml: "nvml:<uuid>"; mac: "agx:0"
  kind: AcceleratorKind;
  name?: string;              // human name when known
  vendor?: string;            // "amd" | "intel" | "nvidia" | "apple" | "qualcomm" | other
  utilizationPercent?: number;// device-level busy %, when the OS provides it
}

/** Usage of one device by one process over the last sampling interval. */
export interface AcceleratorUsage {
  deviceId: string;
  kind: AcceleratorKind;
  utilizationPercent?: number; // max over engines of (engine busy time / wall time) * 100, clamped 0..100; undefined on first sample or when not measurable
  engine?: string;             // engine with the highest utilisation, e.g. "compute", "3d", "gfx", "npu"
  memoryBytes?: number;        // dedicated/resident device memory attributed to the process, when exposed
}

export type AcceleratorSource =
  | "windows-pdh" | "linux-drm-fdinfo" | "nvml" | "darwin-iokit" | "none";

export interface AcceleratorStatus {
  source: AcceleratorSource;
  kind: AcceleratorKind | "any";
  available: boolean;
  reason?: string;            // machine-readable when unavailable: "no-devices" | "load-failed" | "not-supported" | "permission-denied" | "platform-limit" | "error" | "timeout"
  message?: string;           // one short human sentence, no paths with user names
}

// RawOsProcess gains:
accelerators?: AcceleratorUsage[];

// AgentProcessTree gains:
gpuPercent?: number;      // see §2.4
npuPercent?: number;
gpuMemoryMb?: number;     // sum of process memoryBytes on gpu devices / 1 MiB

// New top-level snapshot info (exposed via a new function, not by changing listAgentTrees' return type):
export interface AcceleratorSnapshot {
  devices: AcceleratorDevice[];
  status: AcceleratorStatus[];
  sampledAt: number;        // performance.now() of the sample
}
```

All new fields are optional so existing JSON consumers (desktop serde, `ps --json`) keep working.

## 2. Sampling core (`src/accelerators.ts`)

### 2.1 Provider interface
```ts
export interface RawEngineSample {     // cumulative counters, one per (process, device, engine)
  pid: number; startTime?: string;      // startTime when the provider knows it (else matched via RawOsProcess)
  deviceId: string; kind: AcceleratorKind; engine: string;
  busyNs?: bigint;                      // cumulative busy time in ns (fdinfo, IOKit, D3DKMT)
  percent?: number;                     // already-rated instantaneous % (PDH, NVML) — used as-is
  memoryBytes?: number;
  clientKey?: string;                   // dedup key (linux: `${pdev}:${client-id}`)
}
export interface AcceleratorProvider {
  readonly source: AcceleratorSource;
  sample(pids: ReadonlySet<number>, processes: ReadonlyMap<number, RawOsProcess>): Promise<{
    samples: RawEngineSample[]; devices: AcceleratorDevice[]; status: AcceleratorStatus[];
  }>;
  close?(): void;
}
```

### 2.2 `AcceleratorSampler`
- Holds providers chosen for `process.platform` (A1 ships only a null provider; A2–A4 register real ones via a small registry function `providersFor(platform)` in `src/accelerators.ts`).
- `sample(trees: AgentProcessTree[], at = performance.now())`:
  1. Collect tree PIDs; call every provider in parallel; a provider that throws contributes `status: {available:false, reason:"error"}` and nothing else.
  2. For `busyNs` samples: dedupe by `clientKey` (keep one per key; a key shared by several PIDs is attributed to the lowest PID that is in a tree and noted in tests), keep previous cumulative values keyed by `pid|startTime|deviceId|engine|clientKey`; utilisation = Δbusy / Δwall × 100. First sight or counter decrease (reset, PID reuse) ⇒ undefined.
  3. For `percent` samples: use directly.
  4. Per (process, device): `utilizationPercent = max over engines` (Task Manager semantics), clamp 0..100, round to 0.1; `engine` = argmax; `memoryBytes` = sum of memory samples for that device (dedup by clientKey).
  5. Attach `accelerators` to each process in the trees (mutate the tree process objects), compute tree totals (§2.4), and store the latest `AcceleratorSnapshot`.
- Prunes state for PIDs no longer present.
- Must be cheap: no I/O itself; target < 5 ms overhead per snapshot excluding providers.

### 2.3 Integration
- `src/manager.ts` `listAgentTrees()`: after `correlateTrees`, `await accelSampler.sample(trees)` inside the existing de-duplicated `scanning` promise. Failures never reject `listAgentTrees`.
- New exported `getAcceleratorSnapshot(): AcceleratorSnapshot | undefined` (latest), re-exported from `src/index.ts`.
- Env `AGTOP_ACCELERATORS=0` disables all providers (status `{source:"none", available:false, reason:"disabled"}`).

### 2.4 Tree totals
- For each kind, per device: sum of process utilisation on that device across the tree, clamped to 100. Tree `gpuPercent` = max over gpu devices of that per-device sum; same for `npuPercent`. (A tree using two GPUs at 60% each shows 60%, not 120%; matches "how busy is the busiest accelerator this tree uses".)
- `gpuMemoryMb` = sum of gpu `memoryBytes` / 1048576.
- Undefined when no process in the tree has a measured value of that kind.

## 3. Windows provider (`src/accel-windows.ts`) — unit A3

- PDH through Koffi (`pdh.dll`), one persistent query for the process lifetime: counters `\GPU Engine(*)\Utilization Percentage` and `\GPU Process Memory(*)\Dedicated Usage` via `PdhAddEnglishCounterW`, `PdhCollectQueryData` per snapshot, `PdhGetFormattedCounterArrayW` with `PDH_FMT_DOUBLE` (two-call size pattern; verify struct layout `PDH_FMT_COUNTERVALUE_ITEM_W` on x64 against the SDK and test it on this machine). First collection primes; later calls give rated values (`percent`).
- Instance parsing (pure, unit-tested): `pid_<pid>_luid_<hi>_<lo>_phys_<n>_eng_<n>_engtype_<type>` and `pid_<pid>_luid_<hi>_<lo>_phys_<n>`. Engine name = lowercased engtype (`3d`, `compute`, `copy`, `videodecode`, …). Instances for PIDs outside the tree set are ignored.
- Device kind: query each new LUID once with `D3DKMTOpenAdapterFromLuid` + `D3DKMTQueryAdapterInfo(KMTQAITYPE_ADAPTERTYPE)` (gdi32) and read the `ComputeOnly` bit → `npu` (MCDM compute-only adapters such as Ryzen AI / Intel AI Boost / Hexagon), else `gpu`. Name via `KMTQAITYPE_ADAPTERREGISTRYINFO` or `KMTQAITYPE_DRIVER_DESCRIPTION` if simple, else omit. Close handles. Any failure ⇒ kind `gpu`, name omitted, and a debug note in status message. Struct layouts must be checked against the Windows SDK `d3dkmthk.h`; keep only fixed-size fields.
- No `D3DKMTQueryStatistics` (fragile layouts; needs process handles).
- Status: `windows-pdh` available when the query opens and at least one GPU Engine instance exists; else `no-devices`.
- Verification: this dev host has an Intel UHD iGPU (no NPU) → live test runs a small GPU load if feasible (e.g. a DirectX/WebGPU-free approach is hard; acceptable: assert the provider opens, parses real instance names for at least the current desktop compositor/some process, and returns well-formed devices) plus pure parser tests. NPU classification is tested with a fake adapter-type function.

## 4. Linux providers — unit A2

### 4.1 DRM fdinfo (`src/accel-linux.ts`)
- For each tree PID: list `/proc/<pid>/fd`, keep fds whose link target starts with `/dev/dri/` or `/dev/accel/`, read `/proc/<pid>/fdinfo/<fd>`; parse keys `drm-driver`, `drm-pdev`, `drm-client-id`, `drm-engine-<name>` (`<n> ns`), `drm-cycles-*` (ignored in v1), `drm-resident-<region>` / `drm-total-<region>` / legacy `drm-memory-<region>` (`<n> [KiB|MiB]` → bytes; prefer resident, region `vram`/`local` for memoryBytes, ignore `gtt`/`system` for "GPU memory" but keep a test).
- Device id `drm:<pdev>`; kind `npu` when the fd is under `/dev/accel/` or driver ∈ {`amdxdna`, `amdxdna_accel_driver`, `ivpu`, `intel_vpu`}; else `gpu`. Name from driver + pdev; vendor from driver (`amdgpu`/`amdxdna*`→amd, `i915`/`xe`/`ivpu`/`intel_vpu`→intel, `nouveau`/`nova`→nvidia, `msm`→qualcomm, `panfrost`/`panthor`→arm).
- Dedup by `clientKey = pdev:client-id`.
- Errors: `EACCES`/`EPERM` on another user's fdinfo ⇒ skip that PID and record status `permission-denied` with a count; `ENOENT` (exited) ⇒ skip silently.
- Drivers that expose memory but no engine time (e.g. `intel_vpu`): memory only, utilisation undefined, and status message "engine time not exposed by driver".
- Pure parser `parseDrmFdinfo(text)` with fixtures for amdgpu, i915, xe, amdxdna, intel_vpu, panfrost, and a malformed file.

### 4.2 NVML (`src/accel-nvml.ts`) — Linux only in v1
- Lazy `koffi.load("libnvidia-ml.so.1")`; on failure status `{source:"nvml", available:false, reason:"load-failed"}` only if an NVIDIA device node exists (`/dev/nvidiactl`), else no status at all.
- `nvmlInit_v2`, `nvmlDeviceGetCount_v2`, `nvmlDeviceGetHandleByIndex_v2`, `nvmlDeviceGetUUID`, `nvmlDeviceGetName`, `nvmlDeviceGetUtilizationRates` (device-level), per-process: `nvmlDeviceGetProcessUtilization(device, samples, &count, lastSeenTimestamp)` (two-call sizing; keep lastSeen per device). If it returns `NVML_ERROR_NOT_SUPPORTED`, set that device's status `not-supported` and still report memory via `nvmlDeviceGetComputeRunningProcesses_v3` (verify `nvmlProcessInfo_t` v3 layout from `nvml.h`; struct versions matter). Use `smUtil` as the `compute` engine percent.
- The research claims GeForce cards return NOT_SUPPORTED for per-process utilisation; do not assume either way — handle both, and document what CI cannot verify (no NVIDIA in CI).
- Pure struct decoders tested with hand-built buffers; the provider tested with a fake NVML binding.

## 5. macOS provider (`src/accel-darwin.ts`) — unit A4

- IOKit + CoreFoundation through Koffi (`/System/Library/Frameworks/IOKit.framework/IOKit`, `CoreFoundation.framework/CoreFoundation`).
- Per-process GPU: `IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("AGXDeviceUserClient"))` (also try `"IOAccelerationUserClient"` if the first yields nothing), iterate with `IOIteratorNext`; for each: `IORegistryEntryCreateCFProperty(entry, "IOUserClientCreator")` → parse `pid (\d+), (.*)`; read `AppUsage` (CFArray of CFDictionary) and sum `accumulatedGPUTime` (CFNumber, ns). Release every CF object and io_object. Unknown/missing keys ⇒ that client contributes nothing.
- Device-level: `IOServiceMatching("IOAccelerator")` → property `PerformanceStatistics` → `Device Utilization %` (fallback keys `GPU Activity(%)`, `Renderer Utilization %`) → `AcceleratorDevice.utilizationPercent`; `model` property for name if present.
- Device id `agx:<registryEntryID>`; kind `gpu`; vendor `apple`.
- NPU (Apple Neural Engine): per-process utilisation is not available without root ⇒ status `{source:"darwin-iokit", kind:"npu", available:false, reason:"platform-limit", message:"macOS does not expose per-process Neural Engine usage"}`. Do not use private IOReport in v1.
- Write a CF helper layer (CFStringCreateWithCString, CFGetTypeID/CFStringGetTypeID/CFNumberGetTypeID/CFArrayGetTypeID/CFDictionaryGetTypeID, CFNumberGetValue with kCFNumberSInt64Type, CFArrayGetCount/GetValueAtIndex, CFDictionaryGetValue, CFStringGetCString, CFRelease) with pure-logic parts separated from FFI.
- CI: GitHub macOS runners are VMs; the AGX classes may not exist (paravirtual GPU). Live test asserts: provider loads, returns without throwing, statuses well-formed; if any user client exists, values are non-negative. Parsing of `IOUserClientCreator` and AppUsage logic unit-tested with fakes on every OS.

## 6. Surfaces — unit A5

- CLI text (`renderTrees`): tree header gains `GPU x%` / `NPU y%` / `GPU mem z MiB` only when defined; process rows gain a `gpu x%` / `npu y%` cell only when defined (keep existing column order: name, role, cpu, mem, then accelerators). Bare `agtop` / `top` show the same. A footer line lists unavailable statuses once (e.g. `npu: unavailable (macOS does not expose per-process Neural Engine usage)`).
- `ps --json`: tree and process fields as in §1 (additive). New `agtop gpu [--json]` (name your choice: `accelerators`) prints devices + status table.
- Daemon: `GET /v1/accelerators` returns `AcceleratorSnapshot` (auth as other routes). `/v1/agents` unchanged shape plus new optional fields.
- MCP: `list` summaries gain tree `gpuPercent`/`npuPercent`/`gpuMemoryMb` (aggregate, safe for all jobs); `status` per-process `accelerators` only for owned jobs (existing redaction boundary); a new `accelerators` tool returns devices + status (no per-process data).
- Desktop: model fields (serde defaults), GPU/NPU columns in the process table (blank when undefined), tree totals in details, device/status line in the header area. Explicit test-module imports (no gpui glob) and explicit lifetimes.
- README: new "GPU and NPU usage" section with a per-OS table (source, what is measured, privileges, known gaps), the max-over-engines rule, first-sample behaviour, `AGTOP_ACCELERATORS=0`; remove "GPU/NPU utilization measurement are not implemented". `test/docs.test.ts` asserts the section and every `AcceleratorSource` value appear.

## 7. Units

| Unit | Scope (write) | Depends | Effort |
|---|---|---|---|
| A1 core | `src/types.ts` (additive §1), `src/accelerators.ts` (sampler, provider interface, registry with null provider), `src/manager.ts` (integration only), `src/index.ts` (exports), `test/accelerators.test.ts`, `docs/design/accelerators.md` + `docs/design/accelerators-research.md` (copy) | — | high |
| A2 linux | `src/accel-linux.ts`, `src/accel-nvml.ts`, registry line in `src/accelerators.ts`, `test/accel-linux.test.ts`, `test/accel-nvml.test.ts` | A1 | high |
| A3 windows | `src/accel-windows.ts`, registry line, `test/accel-windows.test.ts` | A1 | xhigh |
| A4 macOS | `src/accel-darwin.ts`, registry line, `test/accel-darwin.test.ts` | A1 | xhigh |
| A5 surfaces | `src/cli.ts`, `src/mcp.ts`, `src/daemon.ts`, `desktop/src/*.rs`, `README.md`, `skills/agtop/SKILL.md`, `test/cli.test.ts`, `test/mcp.test.ts`, `test/render.test.ts`, `test/docs.test.ts`, `test/daemon-security.test.ts` (route auth only) | A1 | high |

A2–A5 run in parallel after A1 merges. The only shared file among A2–A4 is the one-line registry in `src/accelerators.ts`; to avoid conflicts, A1 pre-wires `providersFor()` with lazy, literal dynamic imports of `./accel-linux.js`, `./accel-nvml.js`, `./accel-windows.js`, and `./accel-darwin.js` guarded by try/catch and platform, so bundlers include the providers while importing `accelerators.ts` still loads nothing native. A2–A4 never touch `accelerators.ts` (A1 ships stub files exporting `createProvider(): AcceleratorProvider | undefined` returning undefined; A2–A4 replace the stubs).

Global rules: never weaken existing tests; all CI legs (test + desktop × ubuntu/windows/macOS) green and blocking; evidence/messages contain no raw argv, cwd, or user paths; Koffi loads lazily; every provider failure degrades to a status, never an exception out of `listAgentTrees`.

## 8. Risks

- Windows NPU counters: the research says MCDM NPUs appear in `GPU Engine` counters; unverified here (no NPU on the dev host). Classification via `ComputeOnly` is the plan; if an NPU adapter doesn't report engines, status says so.
- NVML per-process support on consumer GPUs is unclear; handled both ways.
- macOS `AGXDeviceUserClient` / `AppUsage.accumulatedGPUTime` is reverse-engineered, undocumented, may change between macOS versions; must fail soft and be documented as best-effort.
- CI has no GPUs: provider logic is verified with fixtures/fakes; live verification only on this Windows host (Intel iGPU) and whatever the macOS VM exposes.
- Cost: PDH ~1 ms, fdinfo proportional to tree fds, IOKit traversal O(clients). Measure and report in each unit.
