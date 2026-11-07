import type { AcceleratorDevice, AcceleratorStatus } from "./types.js";
import type { AcceleratorProvider, RawEngineSample } from "./accelerators.js";

const IOKIT_PATH = "/System/Library/Frameworks/IOKit.framework/IOKit";
const CORE_FOUNDATION_PATH = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const CF_STRING_ENCODING_UTF8 = 0x08000100;
const CF_NUMBER_SINT64 = 4;
const MAX_CF_DEPTH = 8;
const MAX_CF_ITEMS = 512;
const MAX_CF_STRING_BYTES = 4096;

type NativeFn = (...args: any[]) => any;
type KoffiLibrary = { func(signature: string): NativeFn };
type KoffiRuntime = {
  load(path: string): KoffiLibrary;
  alloc(type: string, length: number): unknown;
  decode(pointer: unknown, type: string, length: number): unknown;
  free(pointer: unknown): void;
};

export type CFPlainValue = string | number | bigint | CFPlainValue[] | { [key: string]: CFPlainValue };

/** Small adapter around CF type operations; plain-JS implementations make the decoder testable off macOS. */
export interface CFValueAccess {
  readonly stringTypeId: number;
  readonly numberTypeId: number;
  readonly arrayTypeId: number;
  readonly dictionaryTypeId: number;
  getTypeId(value: unknown): number;
  getString(value: unknown): string | undefined;
  getNumber(value: unknown): number | bigint | undefined;
  getArrayCount(value: unknown): number;
  getArrayValue(value: unknown, index: number): unknown;
  getDictionaryEntries(value: unknown, limit: number): Array<[unknown, unknown]>;
}

/** Convert borrowed CF values to bounded JS values. Keys and collection elements are Get-rule borrows. */
export function decodeCFValue(value: unknown, access: CFValueAccess): CFPlainValue | undefined {
  const budget = { remaining: MAX_CF_ITEMS };
  const decode = (current: unknown, depth: number): CFPlainValue | undefined => {
    if (current === null || current === undefined || depth > MAX_CF_DEPTH || budget.remaining <= 0) return undefined;
    budget.remaining--;
    let typeId: number;
    try { typeId = access.getTypeId(current); } catch { return undefined; }

    if (typeId === access.stringTypeId) {
      const text = access.getString(current);
      return typeof text === "string" ? text.slice(0, MAX_CF_STRING_BYTES) : undefined;
    }
    if (typeId === access.numberTypeId) {
      const number = access.getNumber(current);
      return typeof number === "bigint" || (typeof number === "number" && Number.isFinite(number)) ? number : undefined;
    }
    if (typeId === access.arrayTypeId) {
      let count: number;
      try { count = access.getArrayCount(current); } catch { return undefined; }
      if (!Number.isSafeInteger(count) || count < 0) return undefined;
      const result: CFPlainValue[] = [];
      for (let index = 0; index < Math.min(count, MAX_CF_ITEMS, budget.remaining); index++) {
        let child: unknown;
        try { child = access.getArrayValue(current, index); } catch { continue; }
        const decoded = decode(child, depth + 1);
        if (decoded !== undefined) result.push(decoded);
      }
      return result;
    }
    if (typeId === access.dictionaryTypeId) {
      let entries: Array<[unknown, unknown]>;
      try { entries = access.getDictionaryEntries(current, Math.min(MAX_CF_ITEMS, budget.remaining)); }
      catch { return undefined; }
      const result: Record<string, CFPlainValue> = Object.create(null) as Record<string, CFPlainValue>;
      for (const [key, child] of entries.slice(0, MAX_CF_ITEMS)) {
        const decodedKey = decode(key, depth + 1);
        if (typeof decodedKey !== "string") continue;
        const decodedValue = decode(child, depth + 1);
        if (decodedValue !== undefined) result[decodedKey] = decodedValue;
        if (budget.remaining <= 0) break;
      }
      return result;
    }
    return undefined;
  };
  return decode(value, 0);
}

export type DarwinIOObject = number;

/** Native boundary used by the provider and replaceable with a plain fake in tests. */
export interface DarwinIOKitLayer {
  getMatchingServices(className: string): { result: number; iterator?: DarwinIOObject };
  getChildIterator(entry: DarwinIOObject): { result: number; iterator?: DarwinIOObject };
  iteratorNext(iterator: DarwinIOObject): DarwinIOObject | undefined;
  releaseIOObject(object: DarwinIOObject): void;
  registryEntryId(entry: DarwinIOObject): bigint | undefined;
  parentEntry(entry: DarwinIOObject): DarwinIOObject | undefined;
  createCFProperty(entry: DarwinIOObject, key: string): unknown;
  decodeCFValue(value: unknown): CFPlainValue | undefined;
  releaseCFObject(value: unknown): void;
}

function isNullHandle(value: unknown): value is null | undefined | 0 | 0n {
  return value === undefined || value === null || value === 0 || value === 0n;
}

/** IOUserClientCreator is "pid <number>, <name>"; the process name may itself contain commas. */
export function parseIOUserClientCreator(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^\s*pid\s+(\d+)\s*,/.exec(value);
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/** Sum valid cumulative GPU nanosecond counters; malformed AppUsage rows contribute nothing. */
export function sumAppUsage(value: unknown): bigint | undefined {
  if (!Array.isArray(value)) return undefined;
  let sum = 0n;
  let found = false;
  for (const row of value) {
    if (row === null || typeof row !== "object" || Array.isArray(row) || !Object.hasOwn(row, "accumulatedGPUTime")) continue;
    const counter = (row as Record<string, unknown>).accumulatedGPUTime;
    if (typeof counter === "bigint") {
      if (counter < 0n) continue;
      sum += counter;
      found = true;
    } else if (typeof counter === "number" && Number.isSafeInteger(counter) && counter >= 0) {
      sum += BigInt(counter);
      found = true;
    }
  }
  return found ? sum : undefined;
}

const UTILIZATION_KEYS = ["Device Utilization %", "GPU Activity(%)", "Renderer Utilization %"] as const;

/** Read the documented design keys in priority order and keep a malformed preferred field from masking fallback data. */
export function performanceStatistics(value: unknown): number | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const stats = value as Record<string, unknown>;
  for (const key of UTILIZATION_KEYS) {
    if (!Object.hasOwn(stats, key)) continue;
    const raw = stats[key];
    const percent = typeof raw === "bigint" ? Number(raw) : raw;
    if (typeof percent === "number" && Number.isFinite(percent) && percent >= 0) return Math.min(100, percent);
  }
  return undefined;
}

const NPU_STATUS: AcceleratorStatus = {
  source: "darwin-iokit", kind: "npu", available: false, reason: "platform-limit",
  message: "macOS does not expose per-process Neural Engine usage.",
};

function readProperty(api: DarwinIOKitLayer, entry: DarwinIOObject, key: string): CFPlainValue | undefined {
  const property = api.createCFProperty(entry, key);
  if (isNullHandle(property)) return undefined;
  try { return api.decodeCFValue(property); }
  finally { api.releaseCFObject(property); }
}

function enumerateServices(api: DarwinIOKitLayer, className: string, visit: (entry: DarwinIOObject) => void): number {
  const matching = api.getMatchingServices(className);
  const iterator = matching.iterator;
  if (isNullHandle(iterator)) return 0;
  let count = 0;
  try {
    if (matching.result !== 0) return 0;
    for (;;) {
      const entry = api.iteratorNext(iterator);
      if (isNullHandle(entry)) break;
      try { visit(entry); }
      finally { api.releaseIOObject(entry); }
      count++;
    }
  } finally { api.releaseIOObject(iterator); }
  return count;
}

function enumerateChildren(api: DarwinIOKitLayer, parent: DarwinIOObject, visit: (entry: DarwinIOObject) => void): number {
  const matching = api.getChildIterator(parent);
  const iterator = matching.iterator;
  if (isNullHandle(iterator)) return 0;
  let count = 0;
  try {
    if (matching.result !== 0) return 0;
    for (;;) {
      const entry = api.iteratorNext(iterator);
      if (isNullHandle(entry)) break;
      try { visit(entry); }
      finally { api.releaseIOObject(entry); }
      count++;
    }
  } finally { api.releaseIOObject(iterator); }
  return count;
}

function deviceId(api: DarwinIOKitLayer, entry: DarwinIOObject): string {
  try {
    const registryId = api.registryEntryId(entry);
    return registryId === undefined ? "agx:0" : `agx:${registryId}`;
  } catch { return "agx:0"; }
}

function clientDeviceId(api: DarwinIOKitLayer, entry: DarwinIOObject): string {
  let parent: DarwinIOObject | undefined;
  try {
    parent = api.parentEntry(entry);
    if (!isNullHandle(parent)) {
      const registryId = api.registryEntryId(parent);
      if (registryId !== undefined) return `agx:${registryId}`;
    }
  } catch { /* The registry parent is not available on every macOS version. */ }
  finally { if (!isNullHandle(parent)) api.releaseIOObject(parent); }
  return "agx:0";
}

function collect(api: DarwinIOKitLayer, pids: ReadonlySet<number>): {
  samples: RawEngineSample[]; devices: AcceleratorDevice[]; hasAccelerator: boolean;
} {
  const devices: AcceleratorDevice[] = [];
  enumerateServices(api, "IOAccelerator", entry => {
    try {
      const id = deviceId(api, entry);
      const model = readProperty(api, entry, "model");
      const statistics = readProperty(api, entry, "PerformanceStatistics");
      const name = typeof model === "string" && model.trim() ? model.trim() : undefined;
      const utilizationPercent = performanceStatistics(statistics);
      devices.push({ id, kind: "gpu", vendor: "apple", ...(name ? { name } : {}),
        ...(utilizationPercent === undefined ? {} : { utilizationPercent }) });
    } catch { /* A malformed registry property must not discard other accelerator devices. */ }
  });

  const samples: RawEngineSample[] = [];
  const readClient = (entry: DarwinIOObject, creatorValue?: CFPlainValue) => {
    try {
      const creator = creatorValue === undefined ? readProperty(api, entry, "IOUserClientCreator") : creatorValue;
      const pid = parseIOUserClientCreator(creator);
      if (pid === undefined || !pids.has(pid)) return;
      const busyNs = sumAppUsage(readProperty(api, entry, "AppUsage"));
      if (busyNs === undefined) return;
      const registryId = api.registryEntryId(entry);
      samples.push({ pid, deviceId: clientDeviceId(api, entry), kind: "gpu", engine: "gpu", busyNs,
        ...(registryId === undefined ? {} : { clientKey: `agx:${registryId}` }) });
    } catch { /* Missing or changed private properties mean this client has no usable sample. */ }
  };

  // metalps documents this per-client AppUsage counter and device PerformanceStatistics path:
  // https://github.com/LoganBarnett/metalps (Architecture / Data sources).
  // It also notes that AGX clients can be unregistered and invisible to service-class matching, so walk accelerator children on a miss.
  const agxCount = enumerateServices(api, "AGXDeviceUserClient", readClient);
  if (agxCount === 0) {
    let childClients = 0;
    enumerateServices(api, "IOAccelerator", accelerator => {
      enumerateChildren(api, accelerator, child => {
        try {
          const creator = readProperty(api, child, "IOUserClientCreator");
          if (creator !== undefined) {
            childClients++;
            readClient(child, creator);
          }
        } catch { /* A changed child registry entry is skipped. */ }
      });
    });
    if (childClients === 0) enumerateServices(api, "IOAccelerationUserClient", readClient);
  }
  return { samples, devices, hasAccelerator: devices.length > 0 };
}

function failedSample(reason: "load-failed" | "error"): {
  samples: RawEngineSample[]; devices: AcceleratorDevice[]; status: AcceleratorStatus[];
} {
  return {
    samples: [], devices: [], status: [
      { source: "darwin-iokit", kind: "gpu", available: false, reason,
        message: reason === "load-failed" ? "Could not load macOS IOKit accelerator support." : "IOKit accelerator sampling failed." },
      NPU_STATUS,
    ],
  };
}

export function createProvider(injected?: DarwinIOKitLayer): AcceleratorProvider | undefined {
  if (!injected && process.platform !== "darwin") return undefined;
  let api = injected;
  return {
    source: "darwin-iokit",
    async sample(pids) {
      try { api ??= await createDarwinIOKit(); }
      catch { return failedSample("load-failed"); }
      try {
        const result = collect(api, pids);
        const gpuStatus: AcceleratorStatus = result.hasAccelerator
          ? { source: "darwin-iokit", kind: "gpu", available: true }
          : { source: "darwin-iokit", kind: "gpu", available: false, reason: "no-devices", message: "No IOAccelerator services were found." };
        return { samples: result.samples, devices: result.devices, status: [gpuStatus, NPU_STATUS] };
      } catch { return failedSample("error"); }
    },
  };
}

let memoizedNative: Promise<DarwinIOKitLayer> | undefined;

function createDarwinIOKit(): Promise<DarwinIOKitLayer> {
  if (process.platform !== "darwin") throw new Error("IOKit is available only on macOS.");
  if (!memoizedNative) memoizedNative = loadDarwinIOKit();
  return memoizedNative;
}

async function loadDarwinIOKit(): Promise<DarwinIOKitLayer> {
  const imported = await import("koffi") as unknown as { default?: unknown };
  const runtime = (imported.default ?? imported) as KoffiRuntime;

  const iokit = runtime.load(IOKIT_PATH);
  const cf = runtime.load(CORE_FOUNDATION_PATH);

  const IOServiceMatching = iokit.func("void * IOServiceMatching(const char *name)");
  const IOServiceGetMatchingServices = iokit.func("int IOServiceGetMatchingServices(uint32_t mainPort, void *matching, uint32_t *existing)");
  const IOIteratorNext = iokit.func("uint32_t IOIteratorNext(uint32_t iterator)");
  const IOObjectRelease = iokit.func("int IOObjectRelease(uint32_t object)");
  const IORegistryEntryGetChildIterator = iokit.func("int IORegistryEntryGetChildIterator(uint32_t entry, const char *plane, uint32_t *iterator)");
  const IORegistryEntryCreateCFProperty = iokit.func("void * IORegistryEntryCreateCFProperty(uint32_t entry, void *key, void *allocator, uint32_t options)");
  const IORegistryEntryGetRegistryEntryID = iokit.func("int IORegistryEntryGetRegistryEntryID(uint32_t entry, uint64_t *entryID)");
  const IORegistryEntryGetParentEntry = iokit.func("int IORegistryEntryGetParentEntry(uint32_t entry, const char *plane, uint32_t *parent)");

  const CFStringCreateWithCString = cf.func("void * CFStringCreateWithCString(void *allocator, const char *text, uint32_t encoding)");
  const CFGetTypeID = cf.func("uint64_t CFGetTypeID(void *value)");
  const CFStringGetTypeID = cf.func("uint64_t CFStringGetTypeID(void)");
  const CFNumberGetTypeID = cf.func("uint64_t CFNumberGetTypeID(void)");
  const CFArrayGetTypeID = cf.func("uint64_t CFArrayGetTypeID(void)");
  const CFDictionaryGetTypeID = cf.func("uint64_t CFDictionaryGetTypeID(void)");
  const CFNumberGetValue = cf.func("uint8_t CFNumberGetValue(void *number, int numberType, void *valuePtr)");
  const CFStringGetCString = cf.func("uint8_t CFStringGetCString(void *value, char *buffer, long bufferSize, uint32_t encoding)");
  const CFStringGetLength = cf.func("long CFStringGetLength(void *value)");
  const CFStringGetMaximumSizeForEncoding = cf.func("long CFStringGetMaximumSizeForEncoding(long length, uint32_t encoding)");
  const CFArrayGetCount = cf.func("long CFArrayGetCount(void *array)");
  const CFArrayGetValueAtIndex = cf.func("void * CFArrayGetValueAtIndex(void *array, long index)");
  const CFDictionaryGetCount = cf.func("long CFDictionaryGetCount(void *dictionary)");
  const CFDictionaryGetKeysAndValues = cf.func("void CFDictionaryGetKeysAndValues(void *dictionary, void **keys, void **values)");
  const CFRelease = cf.func("void CFRelease(void *value)");

  const stringTypeId = Number(CFStringGetTypeID());
  const numberTypeId = Number(CFNumberGetTypeID());
  const arrayTypeId = Number(CFArrayGetTypeID());
  const dictionaryTypeId = Number(CFDictionaryGetTypeID());
  const valueAccess: CFValueAccess = {
    stringTypeId, numberTypeId, arrayTypeId, dictionaryTypeId,
    getTypeId(value) { return Number(CFGetTypeID(value)); },
    getString(value) {
      const length = Number(CFStringGetLength(value));
      const maxBytes = Number(CFStringGetMaximumSizeForEncoding(length, CF_STRING_ENCODING_UTF8));
      if (!Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_CF_STRING_BYTES) return undefined;
      const buffer = Buffer.alloc(maxBytes + 1);
      if (!CFStringGetCString(value, buffer, buffer.length, CF_STRING_ENCODING_UTF8)) return undefined;
      const nul = buffer.indexOf(0);
      return buffer.toString("utf8", 0, nul < 0 ? buffer.length : nul);
    },
    getNumber(value) {
      const buffer = Buffer.alloc(8);
      if (!CFNumberGetValue(value, CF_NUMBER_SINT64, buffer)) return undefined;
      return buffer.readBigInt64LE(0);
    },
    getArrayCount(value) { return Number(CFArrayGetCount(value)); },
    getArrayValue(value, index) { return CFArrayGetValueAtIndex(value, index); },
    getDictionaryEntries(value, limit) {
      const count = Number(CFDictionaryGetCount(value));
      if (!Number.isSafeInteger(count) || count < 0 || count > limit || count > MAX_CF_ITEMS) return [];
      if (count === 0) return [];
      const keys = runtime.alloc("void *", count);
      const values = runtime.alloc("void *", count);
      try {
        CFDictionaryGetKeysAndValues(value, keys, values);
        const decodedKeys = runtime.decode(keys, "void *", count) as unknown[];
        const decodedValues = runtime.decode(values, "void *", count) as unknown[];
        return decodedKeys.map((key, index) => [key, decodedValues[index]] as [unknown, unknown]);
      } finally {
        runtime.free(values);
        runtime.free(keys);
      }
    },
  };

  const native: DarwinIOKitLayer = {
    getMatchingServices(className) {
      const matching = IOServiceMatching(className);
      if (isNullHandle(matching)) return { result: -1 };
      // IOServiceGetMatchingServices consumes the IOServiceMatching dictionary on success or failure.
      const iteratorOut: number[] = [0];
      let consumed = false;
      try {
        const result = Number(IOServiceGetMatchingServices(0, matching, iteratorOut)); // kIOMainPortDefault/kIOMasterPortDefault == 0
        consumed = true;
        return { result, iterator: iteratorOut[0] };
      } finally {
        if (!consumed) CFRelease(matching);
      }
    },
    getChildIterator(entry) {
      const iteratorOut: number[] = [0];
      const result = Number(IORegistryEntryGetChildIterator(entry, "IOService", iteratorOut));
      return { result, iterator: iteratorOut[0] };
    },
    iteratorNext(iterator) {
      const entry = IOIteratorNext(iterator);
      return isNullHandle(entry) ? undefined : entry;
    },
    releaseIOObject(object) { IOObjectRelease(object); },
    registryEntryId(entry) {
      const value: unknown[] = [0n];
      if (Number(IORegistryEntryGetRegistryEntryID(entry, value)) !== 0) return undefined;
      try { return BigInt(value[0] as bigint | number | string); } catch { return undefined; }
    },
    parentEntry(entry) {
      const parent: number[] = [0];
      if (Number(IORegistryEntryGetParentEntry(entry, "IOService", parent)) !== 0 || isNullHandle(parent[0])) return undefined;
      return parent[0];
    },
    createCFProperty(entry, name) {
      const key = CFStringCreateWithCString(null, name, CF_STRING_ENCODING_UTF8);
      if (isNullHandle(key)) return undefined;
      try { return IORegistryEntryCreateCFProperty(entry, key, null, 0); }
      finally { CFRelease(key); }
    },
    decodeCFValue(value) { return decodeCFValue(value, valueAccess); },
    releaseCFObject(value) { CFRelease(value); },
  };

  return native;
}
