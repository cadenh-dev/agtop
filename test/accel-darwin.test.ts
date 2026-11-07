import { describe, expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createProvider, decodeCFValue, parseIOUserClientCreator, performanceStatistics, sumAppUsage,
  type CFValueAccess, type DarwinIOKitLayer,
} from "../src/accel-darwin.js";
import type { RawOsProcess } from "../src/types.js";
import { readDarwinProcesses } from "../src/darwin.js";

type FakeEntry = { className: string; id?: bigint; parent?: FakeEntry; children?: FakeEntry[]; properties?: Record<string, unknown> };
type FakeHandle = { entry?: FakeEntry; rows?: FakeEntry[]; index?: number; label: string };
type FakeProperty = { value: unknown; key: string };

function fakeIOKit(classes: Record<string, FakeEntry[]>): {
  api: DarwinIOKitLayer;
  matchingClasses: string[];
  propertyReads: Array<{ className: string; id?: bigint; key: string }>;
  assertAllReleased(): void;
} {
  const matchingClasses: string[] = [];
  const propertyReads: Array<{ className: string; id?: bigint; key: string }> = [];
  const issuedIO = new Set<object>();
  const releasedIO = new Set<object>();
  const createdProperties = new Set<FakeProperty>();
  const releasedProperties = new Set<FakeProperty>();
  let matchingCreated = 0;
  let matchingConsumed = 0;
  const issueIO = (handle: FakeHandle): FakeHandle => { issuedIO.add(handle); return handle; };

  const api: DarwinIOKitLayer = {
    getMatchingServices(className) {
      matchingClasses.push(className);
      matchingCreated++;
      matchingConsumed++; // IOServiceGetMatchingServices consumes the IOServiceMatching dictionary.
      return { result: 0, iterator: issueIO({ rows: classes[className] ?? [], index: 0, label: `iterator:${className}` }) };
    },
    getChildIterator(object) {
      const entry = (object as FakeHandle).entry!;
      return { result: 0, iterator: issueIO({ rows: entry.children ?? [], index: 0, label: `children:${entry.className}` }) };
    },
    iteratorNext(iterator) {
      const iter = iterator as FakeHandle;
      const entry = iter.rows?.[iter.index ?? 0];
      if (!entry) return undefined;
      iter.index = (iter.index ?? 0) + 1;
      return issueIO({ entry, label: `service:${entry.className}` });
    },
    releaseIOObject(object) {
      const handle = object as object;
      if (!issuedIO.has(handle)) throw new Error("Attempted to release an IOKit object that was not owned.");
      if (releasedIO.has(handle)) throw new Error("IOKit object was released more than once.");
      releasedIO.add(handle);
    },
    registryEntryId(object) { return (object as FakeHandle).entry?.id; },
    parentEntry(object) {
      const entry = (object as FakeHandle).entry?.parent;
      return entry ? issueIO({ entry, label: `parent:${entry.className}` }) : undefined;
    },
    createCFProperty(object, key) {
      const entry = (object as FakeHandle).entry!;
      propertyReads.push({ className: entry.className, id: entry.id, key });
      if (!entry.properties || !Object.hasOwn(entry.properties, key)) return undefined;
      const property = { key, value: entry.properties[key] };
      createdProperties.add(property);
      return property;
    },
    decodeCFValue(value) { return (value as FakeProperty).value as never; },
    releaseCFObject(value) {
      const property = value as FakeProperty;
      if (!createdProperties.has(property)) throw new Error("Attempted to release a CF object that was not owned.");
      if (releasedProperties.has(property)) throw new Error("CF object was released more than once.");
      releasedProperties.add(property);
    },
  };

  return {
    api, matchingClasses, propertyReads,
    assertAllReleased() {
      expect(releasedIO.size).toBe(issuedIO.size);
      expect(releasedProperties.size).toBe(createdProperties.size);
      expect(matchingConsumed).toBe(matchingCreated);
    },
  };
}

function plainCFValueAccess(): CFValueAccess {
  return {
    stringTypeId: 1, numberTypeId: 2, arrayTypeId: 3, dictionaryTypeId: 4,
    getTypeId(value) {
      if (typeof value === "string") return 1;
      if (typeof value === "number" || typeof value === "bigint") return 2;
      if (Array.isArray(value)) return 3;
      if (value !== null && typeof value === "object") return 4;
      return -1;
    },
    getString(value) { return typeof value === "string" ? value : undefined; },
    getNumber(value) { return typeof value === "number" || typeof value === "bigint" ? value : undefined; },
    getArrayCount(value) { return (value as unknown[]).length; },
    getArrayValue(value, index) { return (value as unknown[])[index]; },
    getDictionaryEntries(value, limit) { return Object.entries(value as Record<string, unknown>).slice(0, limit); },
  };
}

describe("Darwin accelerator parsing", () => {
  test("parses the PID before names that contain commas and rejects missing or malformed PIDs", () => {
    expect(parseIOUserClientCreator("pid 4245, Chrome Helper, GPU")).toBe(4245);
    expect(parseIOUserClientCreator("  pid 8, Browser, Renderer, Metal  ")).toBe(8);
    expect(parseIOUserClientCreator("Chrome Helper, pid 8")).toBeUndefined();
    expect(parseIOUserClientCreator("pid nope, app")).toBeUndefined();
    expect(parseIOUserClientCreator(undefined)).toBeUndefined();
  });

  test("sums AppUsage nanoseconds as bigint and skips missing or non-number fields", () => {
    expect(sumAppUsage([
      { accumulatedGPUTime: 9_007_199_254_740_993n },
      { accumulatedGPUTime: 17 },
      {}, { accumulatedGPUTime: "12" }, { accumulatedGPUTime: 1.5 },
      { accumulatedGPUTime: -3n }, null,
    ])).toBe(9_007_199_254_741_010n);
    expect(sumAppUsage([{ accumulatedGPUTime: 0 }])).toBe(0n);
    expect(sumAppUsage([{}, { accumulatedGPUTime: "5" }])).toBeUndefined();
    expect(sumAppUsage(undefined)).toBeUndefined();
  });

  test("uses PerformanceStatistics keys in priority order and skips malformed values", () => {
    expect(performanceStatistics({ "Device Utilization %": 54, "GPU Activity(%)": 31 })).toBe(54);
    expect(performanceStatistics({ "Device Utilization %": "n/a", "GPU Activity(%)": 31 })).toBe(31);
    expect(performanceStatistics({ "Renderer Utilization %": 17n })).toBe(17);
    expect(performanceStatistics({ "Device Utilization %": 140 })).toBe(100);
    expect(performanceStatistics({ "Device Utilization %": -2 })).toBeUndefined();
    expect(performanceStatistics(undefined)).toBeUndefined();
  });

  test("decodes bounded CF values to plain JS strings, bigints, arrays, and objects", () => {
    const decoded = decodeCFValue({
      API: "Metal", accumulatedGPUTime: 123n, nested: ["entry", { value: 2 }],
    }, plainCFValueAccess());
    expect(decoded).toEqual({ API: "Metal", accumulatedGPUTime: 123n, nested: ["entry", { value: 2 }] });
    const tooDeep: unknown[] = [];
    let current: unknown = "end";
    for (let index = 0; index < 20; index++) current = [current];
    tooDeep.push(current);
    expect(decodeCFValue(tooDeep, plainCFValueAccess())).toBeDefined();
    expect(decodeCFValue({ unsupported: true }, plainCFValueAccess())).toEqual({});
  });
});

describe("Darwin accelerator provider", () => {
  test("filters clients to requested PIDs, resolves device IDs, and releases each owned object once", async () => {
    const device: FakeEntry = { className: "IOAccelerator", id: 41n, properties: {
      model: "Apple M3 Pro", PerformanceStatistics: { "Device Utilization %": 37 },
    } };
    const inTree: FakeEntry = { className: "AGXDeviceUserClient", id: 201n, parent: device, properties: {
      IOUserClientCreator: "pid 42, Browser Helper, GPU",
      AppUsage: [{ accumulatedGPUTime: 100n }, { accumulatedGPUTime: 25n }],
    } };
    const outOfTree: FakeEntry = { className: "AGXDeviceUserClient", id: 202n, parent: device, properties: {
      IOUserClientCreator: "pid 99, Other Process", AppUsage: [{ accumulatedGPUTime: 500n }],
    } };
    const fake = fakeIOKit({ IOAccelerator: [device], AGXDeviceUserClient: [inTree, outOfTree] });
    const provider = createProvider(fake.api)!;
    const result = await provider.sample(new Set([42]), new Map());

    expect(result.samples).toEqual([{
      pid: 42, deviceId: "agx:41", kind: "gpu", engine: "gpu", busyNs: 125n, clientKey: "agx:201",
    }]);
    expect(result.devices).toEqual([{ id: "agx:41", kind: "gpu", vendor: "apple", name: "Apple M3 Pro", utilizationPercent: 37 }]);
    expect(result.status).toContainEqual({ source: "darwin-iokit", kind: "gpu", available: true });
    expect(result.status).toContainEqual({ source: "darwin-iokit", kind: "npu", available: false,
      reason: "platform-limit", message: "macOS does not expose per-process Neural Engine usage." });
    expect(fake.propertyReads).not.toContainEqual({ className: "AGXDeviceUserClient", id: 202n, key: "AppUsage" });
    expect(fake.propertyReads.filter(read => read.key === "AppUsage")).toHaveLength(1);
    fake.assertAllReleased();
  });

  test("uses IOAccelerationUserClient when AGX matching is empty and reports no devices", async () => {
    const oldClient: FakeEntry = { className: "IOAccelerationUserClient", id: 700n, properties: {
      IOUserClientCreator: "pid 42, Legacy Client", AppUsage: [{ accumulatedGPUTime: 55n }],
    } };
    const fake = fakeIOKit({ IOAccelerationUserClient: [oldClient] });
    const provider = createProvider(fake.api)!;
    const result = await provider.sample(new Set([42]), new Map());
    expect(fake.matchingClasses).toEqual(["IOAccelerator", "AGXDeviceUserClient", "IOAccelerator", "IOAccelerationUserClient"]);
    expect(result.samples).toEqual([{ pid: 42, deviceId: "agx:0", kind: "gpu", engine: "gpu", busyNs: 55n, clientKey: "agx:700" }]);
    expect(result.devices).toEqual([]);
    expect(result.status).toContainEqual(expect.objectContaining({ kind: "gpu", available: false, reason: "no-devices" }));
    fake.assertAllReleased();
  });

  test("walks IOAccelerator children when unregistered AGX clients are absent from class matching", async () => {
    const hiddenClient: FakeEntry = { className: "AGXDeviceUserClient", id: 701n, properties: {
      IOUserClientCreator: "pid 42, Metal Client, Helper", AppUsage: [{ accumulatedGPUTime: 80n }],
    } };
    const device: FakeEntry = { className: "IOAccelerator", id: 70n, children: [hiddenClient],
      properties: { model: "Apple GPU", PerformanceStatistics: { "GPU Activity(%)": 20 } } };
    hiddenClient.parent = device;
    const fake = fakeIOKit({ IOAccelerator: [device] });
    const provider = createProvider(fake.api)!;
    const result = await provider.sample(new Set([42]), new Map());
    expect(fake.matchingClasses).toEqual(["IOAccelerator", "AGXDeviceUserClient", "IOAccelerator"]);
    expect(result.samples).toEqual([{ pid: 42, deviceId: "agx:70", kind: "gpu", engine: "gpu", busyNs: 80n, clientKey: "agx:701" }]);
    expect(result.devices[0]).toMatchObject({ id: "agx:70", utilizationPercent: 20 });
    fake.assertAllReleased();
  });
});

describe("live Darwin accelerator provider", () => {
  test.skipIf(process.platform !== "darwin")("samples twice without throwing and reports whether AGX clients are visible", async () => {
    const provider = createProvider();
    expect(provider).toBeDefined();
    const pids = new Set([process.pid]);
    const emptyProcesses = new Map<number, RawOsProcess>();
    const first = await provider!.sample(pids, emptyProcesses);
    await delay(500);
    const second = await provider!.sample(pids, emptyProcesses);
    for (const result of [first, second]) {
      expect(result.status.length).toBeGreaterThanOrEqual(2);
      expect(result.status).toContainEqual(expect.objectContaining({ source: "darwin-iokit", kind: "gpu", available: expect.any(Boolean) }));
      expect(result.status).toContainEqual(expect.objectContaining({ source: "darwin-iokit", kind: "npu", available: false,
        reason: "platform-limit", message: "macOS does not expose per-process Neural Engine usage." }));
      expect(result.devices.every(device => device.utilizationPercent === undefined || device.utilizationPercent >= 0)).toBe(true);
      expect(result.samples.every(sample => sample.busyNs === undefined || sample.busyNs >= 0n)).toBe(true);
    }
    const allPids = new Set(readDarwinProcesses().map(row => row.pid));
    const visibleClients = await provider!.sample(allPids, emptyProcesses);
    console.info(`AGX user clients visible on this macOS runner: ${visibleClients.samples.length > 0 ? "yes" : "no"}`);
  }, 20_000);
});
