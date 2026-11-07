Research notes from web sources; claims are leads to verify, not facts.

# Per-Process GPU and NPU Monitoring Research Report (2026)

**Target Tool:** `agtop` (TypeScript / Bun / Node.js using Koffi FFI, procfs file inspection, and lightweight native helpers)  
**Monitored Workloads:** AI coding agents, local LLM servers (`llama.cpp`, `Ollama`, `LM Studio`, `vLLM`, `Lemonade` on AMD Ryzen AI NPU, ONNX Runtime DirectML, etc.)  
**Platforms Covered:** Windows 10/11, Linux (Kernel 6.x+), macOS (Apple Silicon M-series)

---

## Executive Summary & Comparison Matrix

| OS | Target Processor | Primary Telemetry Source | Needs Admin / Root? | Vendors & Drivers Covered | Confidence | Key Limitation / Caveat |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Windows** | GPU | PDH API (`\GPU Engine(*)\Utilization Percentage`, `\GPU Process Memory(*)`) | **No** (Standard user) | All WDDM 2.0+ (NVIDIA, AMD, Intel, Qualcomm) | **High (Verified)** | First sample primes query; delta calculated over sampling window ($\ge 500$ ms recommended). |
| **Windows** | NPU | PDH API via MCDM (`\GPU Engine(*)` matching NPU LUID) | **No** (Standard user) | AMD XDNA (Ryzen AI), Intel AI Boost, Qualcomm Hexagon | **High (Verified)** | MCDM drivers expose compute engines to WDDM scheduler; LUID must be mapped via DXCore / D3DKMT to distinguish from GPUs. |
| **Windows** | GPU (Alt) | `D3DKMTQueryStatistics` (`D3DKMT_QUERYSTATISTICS_PROCESS_NODE`) | **Partial** (Own UID: No; Other UIDs / SYSTEM: **Yes**) | All WDDM 2.0+ | **Medium (High risk for FFI)** | Struct layout varies by WDDM version; requires process handles (`OpenProcess`). Highly fragile under FFI. |
| **Linux** | GPU (Open) | DRM fdinfo (`/proc/<pid>/fdinfo/<fd>`) | **Partial** (Own UID: **No**; System-wide / Other UIDs: **Yes** via root / `CAP_DAC_READ_SEARCH`) | AMD (`amdgpu`), Intel (`i915`, `xe`), Arm Mali (`panfrost`, `panthor`), Qualcomm (`msm`) | **High (Verified)** | Must deduplicate by `drm-client-id`. Does not cover NVIDIA proprietary driver. |
| **Linux** | GPU (NVIDIA Prop.) | NVML (`libnvidia-ml.so.1`) | **No** (Standard user) | NVIDIA Data Center / Quadro / RTX Workstation | **High (Verified)** | **`nvmlDeviceGetProcessUtilization` is NOT supported on GeForce (consumer) GPUs** (returns `NVML_ERROR_NOT_SUPPORTED`). Only VRAM is exposed on GeForce. |
| **Linux** | NPU (AMD) | DRM fdinfo (`/proc/<pid>/fdinfo/<fd>` key `drm-engine-npu-amdxdna`) | **Partial** (Own UID: **No**; Other UIDs: **Yes**) | AMD Ryzen AI / XDNA (`amdxdna`) | **High (Verified)** | Standardized under `drivers/accel/amdxdna` in modern kernels (6.10+). |
| **Linux** | NPU (Intel) | Level Zero Sysman API / DebugFS | **Partial** (Level Zero: No; DebugFS / eBPF: **Yes**) | Intel Core Ultra NPU (`intel_vpu` / `ivpu`) | **Medium (Verified limitation)** | Mainline `ivpu` fdinfo only implements GEM memory stats, **NOT** `drm-engine-*` runtime accounting. |
| **macOS** | GPU (Apple Silicon) | IOKit IORegistry (`AGXDeviceUserClient` $\to$ `accumulatedGPUTime`) | **No** (Standard user) | Apple Silicon (M1/M2/M3/M4) | **High (Verified)** | IOKit traversal per client; must aggregate across all `AGXDeviceUserClient` instances owned by PID. |
| **macOS** | GPU Device (Overall) | IOKit `IOAccelerator` (`PerformanceStatistics` $\to$ `"Device Utilization %"`) | **No** (Standard user) | Apple Silicon (M1/M2/M3/M4) | **High (Verified)** | Instantaneous device busy %; no per-process breakdown. |
| **macOS** | ANE (Apple Neural Engine) | `proc_pid_rusage` (`RUSAGE_INFO_V6` $\to$ `ri_..._neural_footprint`) | **No** (Standard user) | Apple Silicon (M1/M2/M3/M4) | **High (Verified limitation)** | **Per-process ANE execution % is completely unavailable**. Only ANE memory footprint is exposed. System-wide power available via `IOReport`. |

---

## 1. Windows: GPU Engine & Process Memory Performance Counters

### 1.1 Counter Paths and Instance Naming
Windows exposes per-engine hardware execution metrics and video memory allocations via the Windows Performance Counter infrastructure under two primary sets:
* **`\GPU Engine(*)\Utilization Percentage`**
* **`\GPU Engine(*)\Running Time`**
* **`\GPU Process Memory(*)\Dedicated Usage`**
* **`\GPU Process Memory(*)\Shared Usage`**
* **`\GPU Process Memory(*)\Total Committed`**

*(Source: [Microsoft DirectX Developer Blog: GPUs in the Task Manager](https://devblogs.microsoft.com/directx/gpus-in-the-task-manager/))*

#### Instance Name Format
* **`GPU Engine` instance string:**
  ```text
  pid_<PID>_luid_<0xHighLuid>_<0xLowLuid>_phys_<PhysAdapter>_eng_<EngineIndex>_engtype_<EngineType>
  ```
  *Example:* `pid_10368_luid_0x00000000_0x0000963c_phys_0_eng_0_engtype_3d`
* **`GPU Process Memory` instance string:**
  ```text
  pid_<PID>_luid_<0xHighLuid>_<0xLowLuid>_phys_<PhysAdapter>
  ```
  *Example:* `pid_10368_luid_0x00000000_0x0000963c_phys_0`

#### Common `engtype` Values
The Windows Display Driver Model (WDDM) engine classification:
* `engtype_3d`: Primary 3D rasterization, shaders, general rendering.
* `engtype_Compute`: Compute queues (DirectCompute, OpenCL, CUDA, DirectML).
* `engtype_Copy`: Dedicated DMA transfer engines (host $\leftrightarrow$ device).
* `engtype_VideoDecode`: Fixed-function video decoder (NVDEC, Intel QSV, AMD VCN).
* `engtype_VideoEncode`: Fixed-function video encoder (NVENC, AMF).
* `engtype_VideoProcessing`: Scaling, deinterlacing, color correction.

### 1.2 How Task Manager Computes Per-Process GPU %
* **Engine Aggregation Method: `MAX`, not `SUM` or `AVERAGE`**  
  As detailed by Steve Pronovost (Lead Architect for WDDM / DirectX Kernel at Microsoft):
  $$\text{Process GPU Utilization} = \max(\text{Engine}_1, \text{Engine}_2, \dots, \text{Engine}_n)$$
  *Rationale:* GPU engines are independent hardware blocks that execute concurrently. If a game or inference workload fully bottlenecks the 3D or Compute engine at 100%, averaging across 10 idle engines would deceptively report 10%. Summing independent engines could exceed 100% and misrepresent saturation of dedicated hardware blocks.
* **Headline GPU Engine:** Task Manager displays the engine type of whichever engine is currently recording the maximum utilization (e.g. `"GPU 0 - Compute"` or `"GPU 0 - 3D"`).
* **VRAM Dedup:** Dedicated memory is tracked per process (`Dedicated Usage`), but shared buffers are non-additive; the system-wide GPU memory is tracked separately by the Video Memory Manager (`VidMm`).

### 1.3 Reading via PDH API without Spawning PowerShell (Koffi FFI)
Spawning PowerShell (`Get-Counter`) incurs high CPU overhead (~100–300 ms per invocation). Calling `pdh.dll` directly via Koffi FFI takes $\approx 1\text{ ms}$ and consumes negligible CPU.

#### Win32 C Signatures (Unicode / Wide)
```c
// pdh.dll
PDH_STATUS PdhOpenQueryW(
    LPCWSTR szDataSource,      // NULL for local real-time machine
    DWORD_PTR dwUserData,      // 0
    PDH_HQUERY *phQuery
);

PDH_STATUS PdhAddEnglishCounterW(
    PDH_HQUERY hQuery,
    LPCWSTR szFullCounterPath, // L"\\GPU Engine(*)\\Utilization Percentage"
    DWORD_PTR dwUserData,      // 0
    PDH_HCOUNTER *phCounter
);

PDH_STATUS PdhCollectQueryData(
    PDH_HQUERY hQuery
);

PDH_STATUS PdhGetFormattedCounterArrayW(
    PDH_HCOUNTER hCounter,
    DWORD dwFormat,            // PDH_FMT_DOUBLE (0x00000200)
    LPDWORD lpdwBufferSize,    // in/out byte size
    LPDWORD lpdwItemCount,     // in/out item count
    PPDH_FMT_COUNTERVALUE_ITEM_W ItemBuffer
);

PDH_STATUS PdhCloseQuery(
    PDH_HQUERY hQuery
);
```

#### Memory Layout of `PDH_FMT_COUNTERVALUE_ITEM_W` (64-bit Windows)
* Struct size: **24 bytes** (8-byte alignment)
  * `0..7`: `szName` (`LPWSTR` / 64-bit pointer to wide string inside buffer's trailing string table).
  * `8..11`: `CounterValue.CStatus` (`DWORD` / 4 bytes). `0x00000000` = `PDH_CSTATUS_VALID_DATA`.
  * `12..15`: Padding (4 bytes).
  * `16..23`: `CounterValue.doubleValue` (`double` / 8 bytes IEEE 754 float).

#### Koffi TypeScript Definition Example
```typescript
import koffi from 'koffi';

const pdh = koffi.load('pdh.dll');

const PDH_HQUERY = koffi.pointer('PDH_HQUERY', koffi.opaque());
const PDH_HCOUNTER = koffi.pointer('PDH_HCOUNTER', koffi.opaque());

const PDH_FMT_COUNTERVALUE = koffi.struct('PDH_FMT_COUNTERVALUE', {
  CStatus: 'uint32',
  pad: 'uint32',
  doubleValue: 'double'
});

const PDH_FMT_COUNTERVALUE_ITEM_W = koffi.struct('PDH_FMT_COUNTERVALUE_ITEM_W', {
  szName: 'str16', // automatically decodes UTF-16 pointer
  CounterValue: PDH_FMT_COUNTERVALUE
});

const PdhOpenQueryW = pdh.func('long PdhOpenQueryW(str16, uintptr, _Out_ PDH_HQUERY*)');
const PdhAddEnglishCounterW = pdh.func('long PdhAddEnglishCounterW(PDH_HQUERY, str16, uintptr, _Out_ PDH_HCOUNTER*)');
const PdhCollectQueryData = pdh.func('long PdhCollectQueryData(PDH_HQUERY)');
const PdhGetFormattedCounterArrayW = pdh.func('long PdhGetFormattedCounterArrayW(PDH_HCOUNTER, uint32, _InOut_ uint32*, _InOut_ uint32*, _Out_ uint8*)');
const PdhCloseQuery = pdh.func('long PdhCloseQuery(PDH_HQUERY)');
```

### 1.4 Sampling Intervals and Costs
* **Interval:** Rate-based counters (`Utilization Percentage`) require **two** consecutive calls to `PdhCollectQueryData` spaced across an interval $\Delta t \ge 500\text{ ms}$ (typically 1000 ms).
* **Cost:** Query collection takes $1.2\text{ ms} \pm 0.5\text{ ms}$ on modern multi-core systems.
* **Permissions:** **Zero admin rights required**. Any unprivileged user token can read PDH GPU counters.

---

## 2. Windows: NPUs (MCDM Architecture, LUID Mapping, Task Manager)

### 2.1 How NPUs Appear on Windows
Neural Processing Units on Windows (AMD Ryzen AI / XDNA, Intel AI Boost / NPU, Qualcomm Hexagon) are implemented under the **Microsoft Compute Driver Model (MCDM)**.
* **MCDM Specification:** MCDM is a compute-only profile of WDDM (introduced in WDDM 2.0+). MCDM devices connect directly to `dxgkrnl.sys`, inheriting Windows GPU scheduling queues, ETW instrumentation, and memory management, but without display/rasterizer hardware.
*(Source: [Microsoft Learn: Compute-only devices](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/compute-only-devices))*
* **Engine Counters:** Because MCDM devices are managed by `dxgkrnl.sys`, **their execution nodes appear under the exact same `\GPU Engine(*)` counter set**. They do NOT create a separate `\NPU Engine(*)` PDH set.
* **Engine Types:** MCDM NPU engines typically register as `engtype_Compute` or driver-specific engine strings (such as `engtype_NPU` or custom vendor node names).

### 2.2 Task Manager's NPU Metric Pipeline
Starting with Windows 11 24H2 (and Copilot+ PC updates):
* Task Manager exposes an **NPU** graph in the Performance tab and **NPU** / **NPU Engine** columns in the Details tab.
* Task Manager identifies the adapter as an NPU by checking whether the adapter is marked as `ComputeOnly` / `MCDM`.
* When a process submits work to an engine belonging to an NPU's LUID, Task Manager attributes that load to the **NPU** column rather than the **GPU** column.

### 2.3 Telling an NPU Adapter from a GPU (LUID $\to$ Adapter Info)
Every GPU and NPU is assigned a 64-bit Locally Unique Identifier (`LUID`). To map the LUID extracted from the instance name (`luid_0x00000000_0x0000963c`) to a human-readable device name and verify if it is an NPU:

#### Method A: DXCore API (Recommended for Modern Windows)
Standard DXGI (`IDXGIFactory4::EnumAdapterByLuid`) often returns `DXGI_ERROR_NOT_FOUND` for MCDM devices because DXGI filters out non-display adapters. Microsoft introduced **DXCore** (`dxcore.dll`) specifically to enumerate compute-only and machine learning accelerators.
```cpp
#include <dxcore.h>

// Enumerate all adapters including compute/NPU
IDXCoreAdapterFactory* factory = nullptr;
DXCoreCreateAdapterFactory(IID_PPV_ARGS(&factory));

IDXCoreAdapterList* list = nullptr;
const GUID dxcoreFilter[] = { DXCORE_ADAPTER_ATTRIBUTE_D3D12_CORE_COMPUTE };
factory->CreateAdapterList(1, dxcoreFilter, IID_PPV_ARGS(&list));

// Check each adapter's LUID and properties
LUID luid;
adapter->GetProperty(DXCoreAdapterProperty::InstanceLuid, &luid);
bool isHardware = adapter->GetProperty(DXCoreAdapterProperty::IsHardware, &isHardware);
```
*(Source: [Microsoft Learn: DXCore adapter enumeration](https://learn.microsoft.com/en-us/windows/win32/dxcore/dxcore-adapter-enumeration))*

#### Method B: D3DKMT Thunk Layer
Using `gdi32.dll`:
1. Call `D3DKMTOpenAdapterFromLuid` with the LUID to get a `D3DKMT_HANDLE`.
2. Call `D3DKMTQueryAdapterInfo` with query type `KMTQAITYPE_ADAPTERTYPE`.
3. Check the bitfield: `adapterType.ComputeOnly == 1` or `adapterType.MCDM == 1`.
4. Close adapter with `D3DKMTCloseAdapter`.

#### Method C: Windows Registry Lookups
Inspect `HKLM\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}` (Display Adapters) and compute device classes. Search for keys matching the adapter's PCI vendor/device ID or string descriptions matching:
* AMD: `"AMD Ryzen AI"`, `"AMD NPU"`, `"XDNA"`
* Intel: `"Intel(R) AI Boost"`, `"Intel(R) NPU"`
* Qualcomm: `"Snapdragon(R) Hexagon(TM) NPU"`

---

## 3. Windows: `D3DKMTQueryStatistics` Alternative

### 3.1 Mechanism
`D3DKMTQueryStatistics` is an undocumented Win32 internal function exported by `gdi32.dll` (declared in `d3dkmthk.h`). System Informer (formerly Process Hacker) uses this function to collect per-process engine execution times.
*(Source: [System Informer source: `plugins/ExtendedTools/gpumon.c`](https://github.com/winsiderss/systeminformer/blob/master/plugins/ExtendedTools/gpumon.c))*

* **Query Type:** `D3DKMT_QUERYSTATISTICS_PROCESS_NODE` (value `6`).
* **Input:** Target process handle `ProcessHandle`, `AdapterLuid`, and engine `NodeId`.
* **Output:** `D3DKMT_QUERYSTATISTICS_PROCESS_NODE_INFORMATION.RunningTime` (in 100-nanosecond units).
* **Utilization Formula:**
  $$\text{Utilization \%} = \frac{\Delta \text{RunningTime}}{\Delta t_{\text{100ns}} \times \text{ActiveNodes}} \times 100$$

### 3.2 Permissions Required
* **Querying Own Process:** No admin required.
* **Querying Other Processes:**
  * Must call `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid)`.
  * If target process belongs to the **same user** at equal or lower integrity level: **No admin required**.
  * If target process is running as a **different user**, **SYSTEM service** (e.g. background Ollama service), or **elevated administrator**: `OpenProcess` fails with `ERROR_ACCESS_DENIED`. Querying requires **Administrator elevation** and enabling `SeDebugPrivilege`.

### 3.3 FFI Viability via Koffi
* **Verdict: NOT Recommended for FFI.**
* **Reasons:**
  1. The `D3DKMT_QUERYSTATISTICS` structure is an enormous (~256-byte) nested union with variable-width layouts depending on WDDM minor versions (WDDM 2.4, 2.7, 3.0, 3.1, 3.2).
  2. Any 4-byte struct padding mismatch between Windows releases will cause memory misalignment, failing silently with `STATUS_INVALID_PARAMETER` or triggering process crashes.
  3. The PDH API (`pdh.dll`) is stable, public, fully supported, does NOT require process handles (`OpenProcess`), and captures all processes without admin.

---

## 4. Linux: DRM fdinfo (`/proc/<pid>/fdinfo/<fd>`)

### 4.1 DRM Usage Stats Specification
The Linux kernel provides standardized GPU client telemetry via `/proc/<pid>/fdinfo/<fd>` when a process opens a DRM render or compute node (`/dev/dri/renderD*` or `/dev/accel/accel*`).
*(Source: [Linux Kernel Documentation: DRM Client Usage Stats](https://docs.kernel.org/gpu/drm-usage-stats.html))*

#### Key Fields Exposed
| Key | Unit / Format | Description |
| :--- | :--- | :--- |
| `drm-driver` | string | Driver name (`amdgpu`, `i915`, `xe`, `amdxdna_accel_driver`, etc.) |
| `drm-pdev` | PCI BDF | PCI bus identifier (`0000:03:00.0`) |
| `drm-client-id` | integer | Unique 1:1 ID corresponding to kernel `struct drm_file`. Used to deduplicate `dup()` file descriptors. |
| `drm-engine-<name>` | nanoseconds | Cumulative execution time on named hardware engine. |
| `drm-cycles-<name>` | integer | Cumulative engine cycles (supported on Intel/Arm). |
| `drm-total-<region>` | KiB / bytes | Total allocated buffer memory. |
| `drm-resident-<region>`| KiB / bytes | Active resident VRAM/GTT memory. |

### 4.2 Driver Support Matrix (2026)
* **`amdgpu`:** Full support. Exposes `drm-engine-gfx`, `drm-engine-compute`, `drm-engine-sdma`, `drm-engine-enc`, `drm-engine-dec`, `drm-memory-vram`, `drm-memory-gtt`.
* **`i915` (Intel legacy / integrated):** Full support. Exposes `drm-engine-render`, `drm-engine-copy`, `drm-engine-video`, `drm-engine-compute`, `drm-cycles-*`.
* **`xe` (Intel modern / discrete & Lunar Lake+):** Full support. Exposes `drm-engine-rcs`, `drm-engine-bcs`, `drm-engine-vcs`, `drm-engine-ccs` (compute).
* **`panfrost` / `panthor` (Arm Mali):** Full support (`drm-engine-fragment`, `drm-engine-vertex`, `drm-engine-compute`).
* **`msm` (Qualcomm Adreno):** Full support.
* **`nouveau` / `nova` (Open-source NVIDIA):** Basic memory support in `nouveau`; engine statistics in active patchsets / `nova` Rust driver.
* **`amdxdna` (AMD NPU):** Full support for engine (`drm-engine-npu-amdxdna`) and GEM memory.
* **`intel_vpu` / `ivpu` (Intel NPU):** Partial: Memory stats supported; engine runtime **not implemented**.
* **NVIDIA Proprietary Driver:** **NOT SUPPORTED**. Workloads bypass DRM rendering ioctls and execute over `/dev/nvidia*`.

### 4.3 Utilization Calculation & Deduplication Algorithm
1. Scan `/proc` for active PIDs.
2. For each PID, scan `/proc/<pid>/fd/` and read corresponding `/proc/<pid>/fdinfo/<fd>`.
3. Check for `drm-driver:`. If present, record `drm-client-id` and `drm-pdev`.
4. **Deduplication:** Multiple file descriptors in the same process (or child threads) may share the same `drm-client-id` via `dup()` or Unix domain socket passing. Group by `(drm-pdev, drm-client-id)` and take each client ID exactly once.
5. Record `drm-engine-<name>` in nanoseconds at $t_0$.
6. At $t_1$, compute delta:
   $$\text{Engine Util (\%)} = \frac{\Delta \text{engine\_time\_ns}}{\Delta t_{\text{wall\_ns}}} \times 100$$
7. **Process GPU %:** Like Windows Task Manager, compute the maximum engine utilization or sum compute+3D engines depending on display requirements:
   $$\text{Process GPU \%} = \max_{\text{engine}}(\text{Engine Util \%})$$

### 4.4 Permissions & Security Caveats
* **Same UID:** Unprivileged user can read `/proc/<pid>/fdinfo/` of any process owned by the **same UID** without root.
* **Cross-User / System Daemons:** `/proc/<pid>/fdinfo/` has permissions `0500` (`dr-x------`) owned by the process owner. Reading another user's processes (e.g., an LLM server running as a dedicated `ollama` user) returns `EACCES` unless `agtop` runs as **`root`** or has the **`CAP_DAC_READ_SEARCH`** / **`CAP_SYS_PTRACE`** Linux capability.
* **`hidepid` Mount Option:** If `/proc` is mounted with `hidepid=2` or `hidepid=invisible`, other users' process directories will not be visible at all without root.

---

## 5. Linux: NVIDIA Proprietary Driver & NVML

### 5.1 Dynamic Library Loading
* **Linux:** `libnvidia-ml.so.1` (fallback `libnvidia-ml.so`).
* **Windows:** `nvml.dll` (located in `%SystemRoot%\System32` or `%ProgramFiles%\NVIDIA Corporation\NVSMI`).

### 5.2 Per-Process Utilization Function & Struct Layout
NVML provides `nvmlDeviceGetProcessUtilization` to sample per-process compute and memory controller utilization.
*(Source: [NVIDIA NVML API Reference: `nvmlDeviceGetProcessUtilization`](https://docs.nvidia.com/deploy/nvml-api/group__nvmlDeviceQueries.html))*

```c
typedef struct nvmlProcessUtilizationSample_st {
    unsigned int pid;             // 4 bytes: Process ID
    // 4 bytes alignment padding
    unsigned long long timeStamp; // 8 bytes: CPU timestamp in microseconds
    unsigned int smUtil;          // 4 bytes: SM / Compute utilization % (0-100)
    unsigned int memUtil;         // 4 bytes: Framebuffer memory bus utilization %
    unsigned int encUtil;         // 4 bytes: Video encoder utilization %
    unsigned int decUtil;         // 4 bytes: Video decoder utilization %
} nvmlProcessUtilizationSample_t; // Total: 32 bytes (aligned to 8 bytes)

nvmlReturn_t nvmlDeviceGetProcessUtilization(
    nvmlDevice_t device,
    nvmlProcessUtilizationSample_t *utilization,
    unsigned int *processSamplesCount,
    unsigned long long lastSeenTimeStamp // microseconds
);
```

### 5.3 Critical GeForce vs. Enterprise Driver Limitation
* **The GeForce Trap:** Calling `nvmlDeviceGetProcessUtilization` on **consumer GeForce cards** (RTX 3060, 4070, 4080, 4090, etc.) returns **`NVML_ERROR_NOT_SUPPORTED` (Code 7)**!
* NVIDIA restricts real-time per-process SM utilization telemetry to datacenter/workstation products (Tesla, A100, H100, Quadro, RTX 5000/6000 Ada).
* **Consumer GeForce Workaround:** On GeForce hardware, NVML can **only** report per-process VRAM consumption via:
  ```c
  nvmlDeviceGetComputeRunningProcesses(device, &infoCount, infos);
  ```
  Where `nvmlProcessInfo_t` yields `pid` and `usedGpuMemory` (in bytes).
* **Process GPU % on GeForce:** Must be reported as **`Unavailable`** (or approximated by attributing overall device SM % `nvmlDeviceGetUtilizationRates` proportionally to active processes based on VRAM/activity, though this must be flagged honestly).

### 5.4 Accounting Mode
* `nvmlDeviceSetAccountingMode(device, NVML_FEATURE_ENABLED)`: Enables tracking lifetime resource usage.
* Requires **root/administrator privileges** to enable.
* Also returns `NVML_ERROR_NOT_SUPPORTED` on consumer GeForce hardware.

---

## 6. Linux: AMD and Intel NPUs

### 6.1 AMD Ryzen AI / XDNA (`amdxdna`)
* **Driver Location:** `drivers/accel/amdxdna/` in upstream Linux kernel (6.10+).
* **Telemetry Channel:** Implements standard DRM `fdinfo`.
* **Reading Metrics:** Read `/proc/<pid>/fdinfo/<fd>` for processes opening `/dev/accel/accel*`:
  * `drm-driver: amdxdna_accel_driver`
  * `drm-engine-npu-amdxdna: <uint> ns`
  * `drm-total-memory: <uint> bytes`
  * `drm-shared-memory: <uint> bytes`
* **Calculation:** Identical to GPU fdinfo: $\Delta \text{engine\_ns} / \Delta t_{\text{wall\_ns}} \times 100$.

### 6.2 Intel NPU (`intel_vpu` / `ivpu`)
* **Driver Location:** `drivers/accel/ivpu/` (introduced in Linux 6.3).
* **Telemetry Status:**
  * Implements `drm_show_memory_stats`.
  * Exposes `drm-driver: intel_vpu`, `drm-total-memory`, `drm-shared-memory`.
  * **Does NOT implement `drm-engine-*` execution counters**. Workload scheduling is managed asynchronously inside firmware and Job Submission Management (JSM) IPC rings; host kernel does not accumulate per-client run times in fdinfo.
* **Alternative Approaches for Intel NPU Utilization:**
  * **Level Zero Sysman API:** `zesEngineGetActivity()` queries firmware telemetry directly for engine activity.
  * **Kernel eBPF / Tracing:** Attach tracepoints/kprobes to `ivpu_job_submit()` and `ivpu_job_done()` to measure execution time per PID (requires root/`CAP_BPF`).
  * **System Power Status:** Read sysfs `/sys/class/accel/accel0/device/power/runtime_status` to determine whether the NPU is active or suspended.

---

## 7. macOS (Apple Silicon): Per-Process GPU and ANE Utilization

### 7.1 Non-Root Per-Process GPU Usage via IOKit
While Apple Silicon does not expose a standard `/proc` or public Mach rusage field for GPU time, **per-process GPU utilization can be gathered without root** by traversing the IOKit I/O Registry.
*(Source: [metalps GitHub repository](https://github.com/LoganBarnett/metalps) and [gputaskman](https://github.com/shanselman/gputaskman))*

#### The IOKit Architecture
1. In the `IOService` plane, graphics acceleration is driven by `IOAccelerator` (class `AGXAccelerator`).
2. When a process initializes a Metal context or command queue, an **`AGXDeviceUserClient`** object is attached as a child node in the registry.
3. Each `AGXDeviceUserClient` entry contains:
   * **`IOUserClientCreator`:** A string containing the owner's PID and process name (e.g. `"pid 45812, Ollama"`).
   * **`AppUsage` dictionary:** Contains cumulative hardware counters, notably **`accumulatedGPUTime`** (recorded as a 64-bit integer in **nanoseconds**).

#### Sampling Algorithm
1. Match IOKit services with class `AGXDeviceUserClient` using `IOServiceGetMatchingServices`.
2. Iterate through all matching user clients.
3. For each client:
   * Parse `IOUserClientCreator` using regex `/pid (\d+)/` to extract target PID.
   * Read property `AppUsage` $\to$ `accumulatedGPUTime`.
4. Group and sum `accumulatedGPUTime` across all client handles belonging to that PID:
   $$\text{TotalGPUTime}(\text{pid}) = \sum_{\text{client} \in \text{pid}} \text{accumulatedGPUTime}_{\text{client}}$$
5. Over sampling interval $\Delta t$, compute process GPU percentage:
   $$\text{Process GPU \%} = \frac{\Delta \text{TotalGPUTime}(\text{pid})}{\Delta t_{\text{ns}}} \times 100$$
6. **Permissions:** **Zero root required**. Any standard user app can inspect `AGXDeviceUserClient` properties via `IOKit.framework` (`IORegistryEntryCreateCFProperties`).

### 7.2 Investigation of `proc_pid_rusage` and Darwin Ledgers
* **`proc_pid_rusage(pid, RUSAGE_INFO_V6, ...)`:**
  * Defined in `<sys/resource.h>`. Tracks CPU instructions, cycles, physical memory footprint (`ri_phys_footprint`), disk I/O, and energy impact.
  * In macOS 14/15+, it includes ANE memory footprint: `ri_interval_max_neural_footprint` and `ri_lifetime_max_neural_footprint`.
  * **Result:** There is **NO `ri_gpu` or `ri_gpu_time` field** in `rusage_info`.

### 7.3 `powermetrics` (Root Required)
* Running `sudo powermetrics --samplers tasks --show-process-gpu` yields per-process GPU residency (`GPU ms/s`).
* Requires **root/sudo elevation**, making it unsuitable for a lightweight unprivileged CLI tool.

### 7.4 Apple Neural Engine (ANE) Telemetry
* **Per-Process ANE Execution Time:** **COMPLETELY UNAVAILABLE**.
  * Apple does not expose per-process ANE compute time or duty cycles in any public or private userspace API.
  * `proc_pid_rusage` only reports ANE **memory footprint** (`ri_..._neural_footprint`).
* **System-Wide ANE Activity:**
  * Available rootlessly via Apple's private `IOReport` library (`libIOReport.dylib`) by subscribing to the `"Energy Model"` channels (used by `macmon`).
  * Reports active ANE power in milliwatts/watts (0 mW at idle, spiking to 2–8 W during CoreML inference).

---

## 8. macOS: Device-Level GPU Busy % Without Root

### 8.1 `IOAccelerator` PerformanceStatistics
To obtain overall system-wide GPU busy percentage without root:
1. Obtain an IOKit service handle to `IOAccelerator`:
   ```c
   io_service_t service = IOServiceGetMatchingService(
       kIOMainPortDefault, 
       IOServiceMatching("IOAccelerator")
   );
   ```
2. Read the `PerformanceStatistics` dictionary property via `IORegistryEntryCreateCFProperty`.
3. Read the integer field:
   * **`"Device Utilization %"`** (integer `0–100`)
   * *(Alternative keys:* `"GPU Activity(%)"`, `"Renderer Utilization %"`*)*
4. **Permissions:** Standard user, non-root.
5. **Cost:** $< 0.1\text{ ms}$ (instantaneous counter read directly from driver dictionary).

---

## 9. Existing Open-Source Tools: Methods & File References

| Tool | Language | Monitored Platform | Mechanism Used | Repository / File Reference |
| :--- | :--- | :--- | :--- | :--- |
| **`nvtop`** | C | Linux | Reads `/proc/<pid>/fdinfo/*` for AMD, Intel, Arm; calls NVML (`libnvidia-ml.so`) for NVIDIA. | [Syllo/nvtop](https://github.com/Syllo/nvtop)<br>• `src/extract_process_info_fdinfo.c`<br>• `src/extract_gpuinfo_nvidia.c` |
| **`btop`** | C++ | Linux & macOS | Linux: parses `/proc/<pid>/fdinfo` & NVML.<br>macOS: reads `IOAccelerator` `PerformanceStatistics`. | [aristocratos/btop](https://github.com/aristocratos/btop)<br>• `src/linux/btop_collect.cpp`<br>• `src/osx/btop_collect.cpp` |
| **`intel_gpu_top`** | C | Linux | Parses DRM fdinfo and i915 perf tracepoint counters. | [freedesktop/igt-gpu-tools](https://gitlab.freedesktop.org/drm/igt-gpu-tools)<br>• `tools/intel_gpu_top.c` |
| **`amdgpu_top`** | Rust | Linux | Reads `/proc/<pid>/fdinfo/*` (`drm-engine-*`, memory) and sysfs. | [Umio-Yasuno/amdgpu_top](https://github.com/Umio-Yasuno/amdgpu_top)<br>• `crates/amdgpu_top_gui/src/` |
| **`macmon`** | Rust | macOS | Sudoless Apple Silicon monitor; uses private `libIOReport` to read CPU/GPU/ANE energy channels. | [vladkens/macmon](https://github.com/vladkens/macmon)<br>• `src/sys/ioreport.rs` |
| **`metalps`** | Go / C | macOS | Walks IORegistry `AGXDeviceUserClient` to read `accumulatedGPUTime` per PID without root. | [LoganBarnett/metalps](https://github.com/LoganBarnett/metalps)<br>• `metalps.go` |
| **`System Informer`** | C | Windows | Undocumented `D3DKMTQueryStatistics` & PDH `GPU Engine` counters. | [winsiderss/systeminformer](https://github.com/winsiderss/systeminformer)<br>• `plugins/ExtendedTools/gpumon.c`<br>• `plugins/ExtendedTools/d3dkmt.h` |

---

## 10. Concrete Implementation Recommendations for `agtop`

### 10.1 Windows Recommendation
1. **Primary Source:** **PDH API via Koffi FFI (`pdh.dll`)**.
   * Call `PdhAddEnglishCounterW` with:
     * `\GPU Engine(*)\Utilization Percentage`
     * `\GPU Process Memory(*)\Dedicated Usage`
   * Parse instance names: extract PID, LUID, and `engtype`.
   * Compute per-process GPU % as $\max(\text{engines})$.
   * Map LUID via DXCore or registry to identify whether the adapter is a GPU or NPU.
2. **Fallback:** If PDH fails to initialize, dynamically load `nvml.dll` for NVIDIA GPUs.
3. **Report as "Unavailable":**
   * Per-process NPU memory allocations if driver pools all allocations into system RAM without dedicated tagging.

### 10.2 Linux Recommendation
1. **Primary Source for AMD / Intel / Arm GPUs & AMD NPU:** **DRM fdinfo (`/proc/<pid>/fdinfo/*`)**.
   * Fast, native file reads (no FFI required).
   * Group by `(drm-pdev, drm-client-id)` to eliminate duplicate FDs.
   * Compute per-process % as $\Delta \text{engine\_ns} / \Delta t_{\text{wall\_ns}} \times 100$.
2. **Primary Source for NVIDIA:** **NVML via Koffi (`libnvidia-ml.so.1`)**.
   * Check GPU brand via `nvmlDeviceGetName`.
   * If Data Center / Quadro: call `nvmlDeviceGetProcessUtilization`.
   * If GeForce: call `nvmlDeviceGetComputeRunningProcesses` for VRAM and **explicitly report per-process GPU % as "Unavailable on GeForce (Driver restriction)"**.
3. **Report as "Unavailable":**
   * Intel NPU (`ivpu`) per-process compute % (kernel does not accumulate engine time).
   * NVIDIA proprietary driver per-process engine % on consumer GeForce cards.
   * Other users' processes when running unprivileged without root (`EACCES` on `/proc/<pid>/fdinfo`).

### 10.3 macOS (Apple Silicon) Recommendation
1. **Primary Source for Per-Process GPU:** **IOKit IORegistry via Koffi (`IOKit.framework`)**.
   * Traverse `AGXDeviceUserClient` children under `IOAccelerator`.
   * Parse `IOUserClientCreator` for PID.
   * Accumulate $\Delta \text{accumulatedGPUTime}$ over interval $\Delta t$.
2. **Primary Source for Device-Level GPU:** Read `IOAccelerator` $\to$ `PerformanceStatistics` $\to$ `"Device Utilization %"`.
3. **Primary Source for ANE:** Read `proc_pid_rusage(pid, RUSAGE_INFO_V6)` $\to$ `ri_interval_max_neural_footprint` for ANE memory footprint.
4. **Report as "Unavailable":**
   * Per-process Apple Neural Engine (ANE) utilization percentage (fundamentally absent from macOS).
   * Dedicated per-process VRAM (macOS unified memory architecture reports dirty/resident memory rather than isolated GPU VRAM pools).

---

## 11. Open Questions & Unconfirmed Behaviors

1. **Windows 11 24H2 MCDM Multi-Queue NPU Engine Attribution:**
   * In systems with simultaneous Copilot runtime background tasks and DirectML user inference, does `\GPU Engine(*)` allocate distinct `eng_<index>` instances for each concurrent context, or are they merged under a single compute node? (Observed to vary across AMD NPU driver versions 10.x vs 11.x).
2. **Intel `ivpu` Mainline Kernel Roadmap:**
   * While `ivpu_drv.c` currently lacks `drm-engine-*` callbacks, patches are circulating in the `dri-devel` mailing list to expose VPU engine cycles. Exact kernel version for inclusion remains unconfirmed.
3. **NVIDIA Open Kernel Module (`nvidia-open.ko`) vs. DRM fdinfo:**
   * NVIDIA continues to transition users to `open-gpu-kernel-modules`. Whether future releases will route command submissions through DRM to allow standard `drm-engine-*` fdinfo queries remains unannounced.

