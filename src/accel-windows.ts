import type { AcceleratorDevice, AcceleratorKind } from "./types.js";
import type { AcceleratorProvider, RawEngineSample } from "./accelerators.js";

const PDH_FMT_DOUBLE = 0x00000200;
const PDH_MORE_DATA = 0x800007d2;
const PDH_CSTATUS_NO_INSTANCE = 0x800007d1;
const PDH_NO_DATA = 0x800007d5;
const PDH_CSTATUS_INVALID_DATA = 0xc0000bba;
const PDH_CSTATUS_VALID_DATA = 0;
const PDH_COUNTER_BUFFER_LIMIT = 64 * 1024 * 1024;
const ENGINE_COUNTER = "\\GPU Engine(*)\\Utilization Percentage";
const MEMORY_COUNTER = "\\GPU Process Memory(*)\\Dedicated Usage";

export interface ParsedEngineInstance {
  pid: number;
  /** Normalized high and low DWORDs, for example `0x00000000_0x0000963c`. */
  luid: string;
  phys: number;
  engIndex: number;
  engType: string;
}

export interface ParsedMemoryInstance {
  pid: number;
  /** Normalized high and low DWORDs, for example `0x00000000_0x0000963c`. */
  luid: string;
  phys: number;
}

function parseDecimal(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function normalizeLuidWord(value: string): string | undefined {
  const digits = value.replace(/^0x/i, "");
  if (!/^[0-9a-f]{1,8}$/i.test(digits)) return;
  return `0x${digits.toLowerCase().padStart(8, "0")}`;
}

function parseInstanceParts(name: string): { pid: number; luid: string; phys: number } | undefined {
  const match = /^pid_(\d+)_luid_((?:0x)?[\da-f]{1,8})_((?:0x)?[\da-f]{1,8})_phys_(\d+)$/i.exec(name);
  if (!match) return;
  const pid = parseDecimal(match[1]);
  const high = normalizeLuidWord(match[2]);
  const low = normalizeLuidWord(match[3]);
  const phys = parseDecimal(match[4]);
  if (pid === undefined || pid === 0 || high === undefined || low === undefined || phys === undefined) return;
  return { pid, luid: `${high}_${low}`, phys };
}

/** Parse a Windows GPU Engine PDH instance name. Invalid names are ignored. */
export function parseEngineInstance(name: string): ParsedEngineInstance | undefined {
  const match = /^pid_(\d+)_luid_((?:0x)?[\da-f]{1,8})_((?:0x)?[\da-f]{1,8})_phys_(\d+)_eng_(\d+)_engtype_([\da-z_-]*)$/i.exec(name);
  if (!match) return;
  const pid = parseDecimal(match[1]);
  const high = normalizeLuidWord(match[2]);
  const low = normalizeLuidWord(match[3]);
  const phys = parseDecimal(match[4]);
  const engIndex = parseDecimal(match[5]);
  if (pid === undefined || pid === 0 || high === undefined || low === undefined || phys === undefined || engIndex === undefined) return;
  return { pid, luid: `${high}_${low}`, phys, engIndex, engType: match[6].toLowerCase() || "unknown" };
}

/** Parse a Windows GPU Process Memory PDH instance name. Invalid names are ignored. */
export function parseMemoryInstance(name: string): ParsedMemoryInstance | undefined {
  return parseInstanceParts(name);
}

export interface FormattedCounterItem {
  name: string;
  status: number;
  value: number;
}

/**
 * Decode PDH_FMT_COUNTERVALUE_ITEM_W entries from a 64-bit Windows buffer.
 * The callback receives the pointer stored at byte zero of each 24-byte item,
 * plus the backing buffer and field offset for safe native string decoding.
 */
export function decodeFormattedCounterItems(
  buffer: Buffer,
  count: number,
  decodeWideString: (pointer: bigint, buffer: Buffer, offset: number) => string | null,
): FormattedCounterItem[] {
  const itemSize = 24;
  if (!Number.isSafeInteger(count) || count < 0 || count > Math.floor(buffer.byteLength / itemSize)) {
    throw new RangeError("Invalid PDH formatted counter item buffer.");
  }
  const items: FormattedCounterItem[] = [];
  for (let index = 0; index < count; index++) {
    const offset = index * itemSize;
    const namePointer = buffer.readBigUInt64LE(offset);
    if (namePointer === 0n) continue;
    let name: string | null;
    try { name = decodeWideString(namePointer, buffer, offset); }
    catch { continue; }
    if (typeof name !== "string" || name.length === 0) continue;
    items.push({ name, status: buffer.readUInt32LE(offset + 8), value: buffer.readDoubleLE(offset + 16) });
  }
  return items;
}

export interface PdhArrayResult {
  status: number;
  items: FormattedCounterItem[];
}

/** Small native-like interface so provider behavior can be tested without PDH. */
export interface PdhBinding {
  openQuery(): { status: number; query?: unknown };
  addEnglishCounter(query: unknown, path: string): { status: number; counter?: unknown };
  collectQueryData(query: unknown): number;
  getFormattedCounterArray(counter: unknown, format: number): PdhArrayResult;
  closeQuery(query: unknown): number;
}

export interface AdapterClassification {
  computeOnly: boolean;
  name?: string;
  vendor?: string;
}

export type AdapterClassifier = (luid: string) => AdapterClassification | Promise<AdapterClassification>;

export interface WindowsProviderOptions {
  /** Test seam. Production loads `pdh.dll` on first sample. */
  pdh?: PdhBinding;
  /** Test seam. Production queries the adapter type through D3DKMT. */
  classifyAdapter?: AdapterClassifier;
}

type KoffiFunction = (...args: any[]) => any;
interface KoffiLibrary { func(convention: string, name: string, result: string, args: unknown[]): KoffiFunction }
interface KoffiRuntime {
  load(path: string): KoffiLibrary;
  out(type: unknown): unknown;
  inout(type: unknown): unknown;
  opaque(name: string): unknown;
  pointer(type: unknown, count?: number): unknown;
  decode(pointer: unknown, type: string): unknown;
  decode(pointer: unknown, offset: number, type: string): unknown;
  address(value: unknown): bigint;
}

function unsignedStatus(value: number): number { return Number(value) >>> 0; }

function isEmptyPdhResult(status: number): boolean {
  const code = unsignedStatus(status);
  return code === PDH_CSTATUS_NO_INSTANCE || code === PDH_NO_DATA;
}

function createNativePdhBinding(koffi: KoffiRuntime): PdhBinding {
  const library = koffi.load("pdh.dll");
  const queryType = koffi.opaque("PDH_HQUERY");
  const counterType = koffi.opaque("PDH_HCOUNTER");
  const queryHandle = koffi.pointer(queryType);
  const counterHandle = koffi.pointer(counterType);
  const openQuery = library.func("__stdcall", "PdhOpenQueryW", "int32", [
    "str16", "uintptr_t", koffi.out(koffi.pointer(queryType, 2)),
  ]);
  const addEnglishCounter = library.func("__stdcall", "PdhAddEnglishCounterW", "int32", [
    queryHandle, "str16", "uintptr_t", koffi.out(koffi.pointer(counterType, 2)),
  ]);
  const collectQueryData = library.func("__stdcall", "PdhCollectQueryData", "int32", [queryHandle]);
  const getFormattedCounterArray = library.func("__stdcall", "PdhGetFormattedCounterArrayW", "int32", [
    counterHandle, "uint32", koffi.inout(koffi.pointer("uint32")), koffi.out(koffi.pointer("uint32")), koffi.pointer("uint8"),
  ]);
  const closeQuery = library.func("__stdcall", "PdhCloseQuery", "int32", [queryHandle]);

  const readArray = (counter: unknown, format: number): PdhArrayResult => {
    const byteCount = [0];
    const itemCount = [0];
    const firstStatus = unsignedStatus(getFormattedCounterArray(counter, format, byteCount, itemCount, null));
    if (isEmptyPdhResult(firstStatus)) return { status: 0, items: [] };
    if (firstStatus === 0) return { status: 0, items: [] };
    if (firstStatus !== PDH_MORE_DATA) return { status: firstStatus, items: [] };
    const size = Number(byteCount[0]);
    if (!Number.isSafeInteger(size) || size <= 0 || size > PDH_COUNTER_BUFFER_LIMIT) return { status: 0x800007d2, items: [] };

    const buffer = Buffer.alloc(size);
    const filledBytes = [size];
    const filledCount = [0];
    const secondStatus = unsignedStatus(getFormattedCounterArray(counter, format, filledBytes, filledCount, buffer));
    if (isEmptyPdhResult(secondStatus)) return { status: 0, items: [] };
    if (secondStatus !== 0) return { status: secondStatus, items: [] };
    const koffiDecode = (_pointer: bigint, source: Buffer, offset: number) => koffi.decode(source, offset, "str16") as string | null;
    try {
      return { status: 0, items: decodeFormattedCounterItems(buffer, Number(filledCount[0]), koffiDecode) };
    } catch {
      return { status: 0x800007d2, items: [] };
    }
  };

  return {
    openQuery() {
      const output: unknown[] = [null];
      return { status: unsignedStatus(openQuery(null, 0, output)), query: output[0] };
    },
    addEnglishCounter(query, path) {
      const output: unknown[] = [null];
      return { status: unsignedStatus(addEnglishCounter(query, path, 0, output)), counter: output[0] };
    },
    collectQueryData(query) { return unsignedStatus(collectQueryData(query)); },
    getFormattedCounterArray: readArray,
    closeQuery(query) { return unsignedStatus(closeQuery(query)); },
  };
}

function createKmtClassifier(koffi: KoffiRuntime): AdapterClassifier {
  let openAdapter: KoffiFunction | undefined;
  let queryAdapterInfo: KoffiFunction | undefined;
  let closeAdapter: KoffiFunction | undefined;
  const initialize = () => {
    if (openAdapter) return;
    const gdi = koffi.load("gdi32.dll");
    openAdapter = gdi.func("__stdcall", "D3DKMTOpenAdapterFromLuid", "int32", ["void *"]);
    queryAdapterInfo = gdi.func("__stdcall", "D3DKMTQueryAdapterInfo", "int32", ["void *"]);
    closeAdapter = gdi.func("__stdcall", "D3DKMTCloseAdapter", "int32", ["void *"]);
  };

  return (luid) => {
    initialize();
    const match = /^0x([\da-f]{8})_0x([\da-f]{8})$/i.exec(luid);
    if (!match) return { computeOnly: false };
    const openData = Buffer.alloc(12); // LUID (8) + D3DKMT_HANDLE (4).
    openData.writeUInt32LE(Number.parseInt(match[2], 16) >>> 0, 0); // LUID.LowPart
    openData.writeInt32LE(Number.parseInt(match[1], 16) | 0, 4); // LUID.HighPart
    if (openAdapter!(openData) !== 0) return { computeOnly: false };

    const adapter = openData.readUInt32LE(8);
    const adapterType = Buffer.alloc(4); // D3DKMT_ADAPTERTYPE is a UINT union.
    const queryData = Buffer.alloc(24); // hAdapter, enum, pointer, UINT size, x64 alignment.
    queryData.writeUInt32LE(adapter, 0);
    queryData.writeUInt32LE(15, 4); // KMTQAITYPE_ADAPTERTYPE
    queryData.writeBigUInt64LE(koffi.address(adapterType), 8);
    queryData.writeUInt32LE(adapterType.byteLength, 16);
    const closeData = Buffer.alloc(4);
    closeData.writeUInt32LE(adapter, 0);
    try {
      if (queryAdapterInfo!(queryData) !== 0) return { computeOnly: false };
      const value = adapterType.readUInt32LE(0);
      return { computeOnly: (value & (1 << 11)) !== 0 }; // D3DKMT_ADAPTERTYPE.ComputeOnly, bit 11.
    } finally {
      closeAdapter!(closeData);
    }
  };
}

interface ProcessDeviceSamples {
  pid: number;
  luid: string;
  engines: Map<string, number | undefined>;
  memoryByPhys: Map<number, number>;
}

function vendorFromName(name: string | undefined): string | undefined {
  if (!name) return;
  const lower = name.toLowerCase();
  if (/intel|arc|uhd|iris/.test(lower)) return "intel";
  if (/nvidia|geforce|quadro/.test(lower)) return "nvidia";
  if (/amd|radeon/.test(lower)) return "amd";
  if (/qualcomm|adreno/.test(lower)) return "qualcomm";
}

class WindowsAcceleratorProvider implements AcceleratorProvider {
  readonly source = "windows-pdh" as const;
  private readonly options: WindowsProviderOptions;
  private koffi?: KoffiRuntime;
  private pdh?: PdhBinding;
  private query?: unknown;
  private engineCounter?: unknown;
  private memoryCounter?: unknown;
  private initPromise?: Promise<boolean>;
  private initStatus?: AcceleratorProviderStatus;
  private primed = false;
  private closed = false;
  private readonly classification = new Map<string, AdapterClassification>();
  private classifier?: AdapterClassifier;
  private sampleQueue: Promise<void> = Promise.resolve();

  constructor(options: WindowsProviderOptions) {
    this.options = options;
    this.pdh = options.pdh;
    this.classifier = options.classifyAdapter;
  }

  private async initialize(): Promise<boolean> {
    if (this.closed) {
      this.initStatus = { available: false, reason: "error", message: "Windows GPU counters are closed." };
      return false;
    }
    if (!this.initPromise) this.initPromise = this.initializeOnce();
    return this.initPromise;
  }

  private async initializeOnce(): Promise<boolean> {
    try {
      if (!this.pdh) {
        const imported = await import("koffi");
        this.koffi = imported.default as unknown as KoffiRuntime;
        this.pdh = createNativePdhBinding(this.koffi);
      }
      const opened = this.pdh.openQuery();
      if (unsignedStatus(opened.status) !== 0 || opened.query == null) throw new Error("PDH query open failed.");
      this.query = opened.query;
      const engine = this.pdh.addEnglishCounter(this.query, ENGINE_COUNTER);
      if (unsignedStatus(engine.status) !== 0 || engine.counter == null) throw new Error("PDH engine counter setup failed.");
      this.engineCounter = engine.counter;
      const memory = this.pdh.addEnglishCounter(this.query, MEMORY_COUNTER);
      if (unsignedStatus(memory.status) !== 0 || memory.counter == null) throw new Error("PDH memory counter setup failed.");
      this.memoryCounter = memory.counter;
      if (!this.classifier && this.koffi) this.classifier = createKmtClassifier(this.koffi);
      return true;
    } catch {
      if (this.query !== undefined && this.pdh) {
        try { this.pdh.closeQuery(this.query); } catch { /* best effort during setup failure */ }
      }
      this.query = undefined;
      this.engineCounter = undefined;
      this.memoryCounter = undefined;
      this.initStatus = { available: false, reason: "load-failed", message: "Windows GPU counters could not be initialized." };
      return false;
    }
  }

  private async classify(luid: string): Promise<AdapterClassification> {
    const cached = this.classification.get(luid);
    if (cached) return cached;
    let result: AdapterClassification = { computeOnly: false };
    try { if (this.classifier) result = await this.classifier(luid); }
    catch { result = { computeOnly: false }; }
    const classification = {
      computeOnly: result.computeOnly === true,
      ...(typeof result.name === "string" && result.name.trim() ? { name: result.name.trim() } : {}),
      ...(typeof result.vendor === "string" && result.vendor.trim() ? { vendor: result.vendor.trim().toLowerCase() } : {}),
    };
    this.classification.set(luid, classification);
    return classification;
  }

  async sample(pids: ReadonlySet<number>, _processes: ReadonlyMap<number, import("./types.js").RawOsProcess>) {
    let release!: () => void;
    const previous = this.sampleQueue;
    this.sampleQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await this.sampleOnce(pids); }
    finally { release(); }
  }

  private async sampleOnce(pids: ReadonlySet<number>) {
    const status = (value: AcceleratorProviderStatus) => ({ source: this.source, kind: "any" as const, ...value });
    if (!(await this.initialize())) return { samples: [], devices: [], status: [status(this.initStatus ?? {
      available: false, reason: "load-failed", message: "Windows GPU counters could not be initialized.",
    })] };

    try {
      const collectStatus = unsignedStatus(this.pdh!.collectQueryData(this.query));
      if (collectStatus !== 0) throw new Error("PDH collection failed.");
      const wasPrimed = this.primed;
      this.primed = true;

      const engineResult = this.pdh!.getFormattedCounterArray(this.engineCounter, PDH_FMT_DOUBLE);
      if (unsignedStatus(engineResult.status) !== 0 && !(!wasPrimed && unsignedStatus(engineResult.status) === PDH_CSTATUS_INVALID_DATA)) {
        throw new Error("PDH engine read failed.");
      }
      const memoryResult = this.pdh!.getFormattedCounterArray(this.memoryCounter, PDH_FMT_DOUBLE);
      if (unsignedStatus(memoryResult.status) !== 0) throw new Error("PDH memory read failed.");

      let engineInstanceCount = 0;
      const observedLuids = new Set<string>();
      const byProcessDevice = new Map<string, ProcessDeviceSamples>();
      const entryFor = (pid: number, luid: string) => {
        const key = `${pid}|${luid}`;
        let entry = byProcessDevice.get(key);
        if (!entry) byProcessDevice.set(key, entry = { pid, luid, engines: new Map(), memoryByPhys: new Map() });
        return entry;
      };

      for (const item of engineResult.items) {
        const parsed = parseEngineInstance(item.name);
        if (!parsed) continue;
        engineInstanceCount++;
        observedLuids.add(parsed.luid);
        if (item.status !== PDH_CSTATUS_VALID_DATA) continue;
        if (!pids.has(parsed.pid)) continue;
        const entry = entryFor(parsed.pid, parsed.luid);
        const engine = parsed.engType;
        const prior = entry.engines.get(engine);
        const value = Number.isFinite(item.value) ? item.value : undefined;
        if (prior === undefined || (value !== undefined && value > prior)) entry.engines.set(engine, value);
      }

      for (const item of memoryResult.items) {
        if (item.status !== PDH_CSTATUS_VALID_DATA || !Number.isFinite(item.value) || item.value < 0) continue;
        const parsed = parseMemoryInstance(item.name);
        if (!parsed) continue;
        observedLuids.add(parsed.luid);
        if (!pids.has(parsed.pid)) continue;
        const entry = entryFor(parsed.pid, parsed.luid);
        const prior = entry.memoryByPhys.get(parsed.phys);
        if (prior === undefined || item.value > prior) entry.memoryByPhys.set(parsed.phys, item.value);
      }

      const devices = new Map<string, AcceleratorDevice>();
      const samples: RawEngineSample[] = [];
      for (const luid of [...observedLuids].sort()) {
        const classified = await this.classify(luid);
        const kind: AcceleratorKind = classified.computeOnly ? "npu" : "gpu";
        const deviceId = `luid:${luid}`;
        const name = classified.name;
        const vendor = classified.vendor ?? vendorFromName(name);
        devices.set(deviceId, {
          id: deviceId,
          kind,
          ...(name ? { name } : {}),
          ...(vendor ? { vendor } : {}),
        });
      }
      const orderedEntries = [...byProcessDevice.values()].sort((a, b) => a.pid - b.pid || a.luid.localeCompare(b.luid));
      for (const entry of orderedEntries) {
        const classified = await this.classify(entry.luid);
        const kind: AcceleratorKind = classified.computeOnly ? "npu" : "gpu";
        const deviceId = `luid:${entry.luid}`;
        const memoryBytes = entry.memoryByPhys.size
          ? [...entry.memoryByPhys.values()].reduce((sum, value) => sum + value, 0)
          : undefined;
        const engineSamples: RawEngineSample[] = [...entry.engines.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([engine, value]) => ({
          pid: entry.pid,
          deviceId,
          kind,
          engine,
          ...(wasPrimed && value !== undefined ? { percent: value } : {}),
        }));
        if (memoryBytes !== undefined) {
          if (engineSamples.length) engineSamples[0].memoryBytes = memoryBytes;
          else engineSamples.push({ pid: entry.pid, deviceId, kind, engine: "memory", memoryBytes });
        }
        samples.push(...engineSamples);
      }

      const resultStatus = engineInstanceCount > 0 || (!wasPrimed && unsignedStatus(engineResult.status) === PDH_CSTATUS_INVALID_DATA)
        ? status({ available: true })
        : status({ available: false, reason: "no-devices", message: "No GPU Engine counter instances are available." });
      return { samples, devices: [...devices.values()].sort((a, b) => a.id.localeCompare(b.id)), status: [resultStatus] };
    } catch {
      return {
        samples: [],
        devices: [],
        status: [status({ available: false, reason: "error", message: "Windows GPU counters could not be sampled." })],
      };
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.query !== undefined && this.pdh) {
      try { this.pdh.closeQuery(this.query); } catch { /* close is best effort */ }
    }
    this.query = undefined;
  }
}

interface AcceleratorProviderStatus {
  available: boolean;
  reason?: string;
  message?: string;
}

export function createProvider(options: WindowsProviderOptions = {}): AcceleratorProvider | undefined {
  if (process.platform !== "win32" && !options.pdh) return undefined;
  return new WindowsAcceleratorProvider(options);
}
