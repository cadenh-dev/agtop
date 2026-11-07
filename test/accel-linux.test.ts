import { describe, expect, test } from "bun:test";
import { createProvider, parseDrmFdinfo, type LinuxAccelFs } from "../src/accel-linux.js";

describe("DRM fdinfo parser", () => {
  test("parses amdgpu engine nanoseconds and legacy VRAM bytes", () => {
    const parsed = parseDrmFdinfo("drm-driver: amdgpu\ndrm-pdev: 0000:03:00.0\ndrm-client-id: 7\ndrm-engine-gfx: 125 ns\ndrm-engine-compute: 900 ns\ndrm-memory-vram: 2 MiB\ndrm-memory-gtt: 64 KiB");
    expect(parsed.engines.get("gfx")).toBe(125n);
    expect(parsed.memory).toContainEqual({ type: "memory", region: "vram", bytes: 2 * 1024 * 1024 });
    expect(parsed.memory).toContainEqual({ type: "memory", region: "gtt", bytes: 64 * 1024 });
  });
  test("parses i915 and xe engines, including capacity normalization metadata", () => {
    expect(parseDrmFdinfo("drm-driver: i915\ndrm-pdev: 0000:00:02.0\ndrm-client-id: 1\ndrm-engine-render: 2 ns\ndrm-engine-copy: 4 ns\ndrm-engine-video: 6 ns").engines.size).toBe(3);
    const xe = parseDrmFdinfo("drm-driver: xe\ndrm-pdev: 0000:00:02.0\ndrm-client-id: 2\ndrm-engine-rcs: 100 ns\ndrm-engine-capacity-rcs: 4\ndrm-engine-ccs: 80 ns\ndrm-engine-capacity-ccs: 2");
    expect(xe.capacities.get("rcs")).toBe(4);
    expect(xe.capacities.get("ccs")).toBe(2);
  });
  test("handles NPU, memory-only, panfrost, and malformed input", () => {
    expect(parseDrmFdinfo("drm-driver: amdxdna\ndrm-pdev: 0000:01:00.0\ndrm-client-id: 2\ndrm-engine-npu: 45 ns").engines.get("npu")).toBe(45n);
    const ivpu = parseDrmFdinfo("drm-driver: intel_vpu\ndrm-pdev: 0000:00:0b.0\ndrm-client-id: 3\ndrm-resident-local: 512 KiB");
    expect(ivpu.memory[0].bytes).toBe(512 * 1024);
    expect(parseDrmFdinfo("drm-driver: panfrost\ndrm-pdev: platform:gpu\ndrm-client-id: 4\ndrm-engine-fragment: 10 ns").driver).toBe("panfrost");
    expect(parseDrmFdinfo("nonsense\ndrm-engine-x: not ns\ndrm-engine-capacity-y: 0\ndrm-total-vram: abc").engines.size).toBe(0);
  });
});

function fakeFs(entries: Record<string, { target: string; content: string }>, nodes: string[] = ["card0"]): LinuxAccelFs {
  return {
    async readdir(path) {
      if (path === "/dev/dri" || path === "/dev/accel") return nodes;
      const match = /^\/proc\/(\d+)\/fd$/.exec(path);
      if (match) return Object.keys(entries).filter(key => key.startsWith(`${match[1]}:`)).map(key => key.split(":")[1]);
      const error = Object.assign(new Error("ENOENT"), { code: "ENOENT" }); throw error;
    },
    async readlink(path) {
      const match = /^\/proc\/(\d+)\/fd\/(\d+)$/.exec(path)!;
      const entry = entries[`${match[1]}:${match[2]}`];
      if (!entry) { const error = Object.assign(new Error("ENOENT"), { code: "ENOENT" }); throw error; }
      return entry.target;
    },
    async readFile(path) {
      const match = /^\/proc\/(\d+)\/fdinfo\/(\d+)$/.exec(path)!;
      const entry = entries[`${match[1]}:${match[2]}`];
      if (!entry) { const error = Object.assign(new Error("ENOENT"), { code: "ENOENT" }); throw error; }
      return entry.content;
    },
  };
}
const info = (driver: string, client: string, tail = "drm-engine-gfx: 100 ns\ndrm-resident-vram: 10 KiB") => `drm-driver: ${driver}\ndrm-pdev: 0000:03:00.0\ndrm-client-id: ${client}\n${tail}`;

describe("Linux DRM provider", () => {
  test("deduplicates duplicated fds by client id and maps kind/vendor/device", async () => {
    const provider = createProvider(fakeFs({
      "10:3": { target: "/dev/dri/renderD128", content: info("amdgpu", "7") },
      "10:4": { target: "/dev/dri/card0", content: info("amdgpu", "7") },
      "11:3": { target: "/dev/accel/accel0", content: info("amdxdna", "8", "drm-engine-npu: 4 ns") },
    }));
    const result = await provider.sample(new Set([10, 11]), new Map());
    expect(result.samples.filter(s => s.pid === 10)).toHaveLength(1);
    expect(result.samples.find(s => s.pid === 10)?.memoryBytes).toBe(10 * 1024);
    expect(result.devices).toContainEqual({ id: "drm:0000:03:00.0", kind: "npu", name: "amdxdna 0000:03:00.0", vendor: "amd" });
    expect(result.samples.find(s => s.pid === 11)?.kind).toBe("npu");
  });
  test("divides grouped engine counters by declared engine capacity", async () => {
    const provider = createProvider(fakeFs({ "12:3": { target: "/dev/dri/renderD129", content: "drm-driver: xe\ndrm-pdev: 0000:00:02.0\ndrm-client-id: 2\ndrm-engine-rcs: 400 ns\ndrm-engine-capacity-rcs: 4" } }));
    const result = await provider.sample(new Set([12]), new Map());
    expect(result.samples[0].busyNs).toBe(100n);
  });
  test("reports permission denial once and skips vanished PIDs", async () => {
    const fs: LinuxAccelFs = {
      async readdir(path) { if (path === "/proc/1/fd") { const e = Object.assign(new Error(), { code: "EACCES" }); throw e; } if (path === "/proc/2/fd") return ["3"]; if (path.startsWith("/dev/")) return ["card0"]; return []; },
      async readlink() { return "/dev/dri/renderD128"; },
      async readFile() { const e = Object.assign(new Error(), { code: "ENOENT" }); throw e; },
    };
    const result = await createProvider(fs).sample(new Set([1, 2]), new Map());
    expect(result.samples).toEqual([]);
    expect(result.status).toContainEqual({ source: "linux-drm-fdinfo", kind: "any", available: true, reason: "permission-denied", message: "Some processes belong to other users; their GPU usage is not visible." });
    expect(result.status.some(s => s.reason === "no-devices")).toBe(false);
  });
  test("skips every sample for a PID when any fdinfo read is denied", async () => {
    const fs: LinuxAccelFs = {
      async readdir(path) { if (path === "/proc/1/fd") return ["3", "4"]; if (path.startsWith("/dev/")) return ["card0"]; return []; },
      async readlink(path) { return path.endsWith("/3") ? "/dev/dri/renderD128" : "/dev/dri/card0"; },
      async readFile(path) { if (path.endsWith("/3")) { const e = Object.assign(new Error(), { code: "EACCES" }); throw e; } return info("amdgpu", "8"); },
    };
    const result = await createProvider(fs).sample(new Set([1]), new Map());
    expect(result.samples).toEqual([]);
    expect(result.status[0].reason).toBe("permission-denied");
  });
  test("distinguishes absent hardware nodes from present nodes with no observed fds", async () => {
    const noNodes = await createProvider(fakeFs({}, [])).sample(new Set([1]), new Map());
    const nodes = await createProvider(fakeFs({}, ["renderD128"])).sample(new Set([1]), new Map());
    expect(noNodes.status[0]).toMatchObject({ available: false, reason: "no-devices" });
    expect(nodes.status[0]).toMatchObject({ available: true });
  });
  test.skipIf(process.platform !== "linux")("live provider sample resolves on Linux hosts without a GPU", async () => {
    await expect(createProvider()!.sample(new Set(), new Map())).resolves.toMatchObject({ samples: expect.any(Array), devices: expect.any(Array), status: expect.any(Array) });
  }, 30_000);
});
