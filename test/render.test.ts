import { expect, test } from "bun:test";
import { renderTrees } from "../src/cli.js";
import type { AcceleratorSnapshot, AgentProcessTree } from "../src/types.js";

test("tree text includes role summary and process role between name and CPU", () => {
  const tree: AgentProcessTree = {
    jobId: "render-test",
    harness: "custom",
    backend: "unknown",
    backendEvidence: "",
    userOrPeer: "test",
    rootPid: 10,
    containmentMode: "passive-ppid",
    totalCpuPercent: 1,
    totalMemoryMb: 2,
    roleCounts: { agent: 1, shell: 1, "dev-server": 1, tool: 0 },
    processes: [
      {
        pid: 10, ppid: 0, name: "root", cmdline: "root", startTime: "1", cpuSeconds: 0,
        cpuPercent: 1, memoryMb: 2, role: "agent", roleSource: "job", roleEvidence: "root",
      },
      {
        pid: 11, ppid: 10, name: "vite", cmdline: "vite", startTime: "2", cpuSeconds: 0,
        cpuPercent: 3, memoryMb: 4, role: "dev-server", roleSource: "catalog", roleEvidence: "dev-servers: binary vite",
      },
      {
        pid: 12, ppid: 10, name: "bash", cmdline: "bash", startTime: "3", cpuSeconds: 0,
        cpuPercent: 0, memoryMb: 1, role: "shell", roleSource: "catalog", roleEvidence: "shells: binary bash",
      },
    ],
  };
  const output = renderTrees([tree]);
  expect(output).toContain("roles: agent 1, dev-server 1, shell 1");
  expect(output).not.toContain("tool 0");
  expect(output).toContain("root  agent  1.0%");
  expect(output).toContain("vite  dev-server  3.0%");
});

test("accelerator output is present only for measured values and lists unavailable statuses", () => {
  const tree: AgentProcessTree = {
    jobId: "accel-render", harness: "custom", backend: "unknown", backendEvidence: "", userOrPeer: "test",
    rootPid: 10, containmentMode: "passive-ppid", totalCpuPercent: 1, totalMemoryMb: 2,
    roleCounts: { agent: 1 },
    gpuPercent: 44.25, gpuMemoryMb: 128, processes: [{
      pid: 10, ppid: 0, name: "root", cmdline: "root", startTime: "1", cpuSeconds: 0,
      cpuPercent: 1, memoryMb: 2, role: "agent", roleSource: "job", roleEvidence: "root",
      accelerators: [{ deviceId: "gpu0", kind: "gpu", utilizationPercent: 23.4 }],
    }],
  };
  const snapshot: AcceleratorSnapshot = {
    devices: [], sampledAt: 1,
    status: [{ source: "darwin-iokit", kind: "npu", available: false, reason: "platform-limit", message: "NPU not exposed" }],
  };
  const output = renderTrees([tree], snapshot);
  expect(output).toContain("GPU 44.3%  GPU mem 128.0 MiB");
  expect(output).not.toContain("NPU 0%");
  expect(output).toContain("gpu 23.4%");
  expect(output).not.toContain("npu 0%");
  expect(output.match(/npu: unavailable/g)).toHaveLength(1);
  const blank = renderTrees([{ ...tree, gpuPercent: undefined, npuPercent: undefined, gpuMemoryMb: undefined, processes: [{ ...tree.processes[0], accelerators: undefined }] }], { ...snapshot, status: [] });
  expect(blank).not.toContain("GPU ");
  expect(blank).not.toContain("NPU ");
  expect(blank).not.toContain("gpu ");
});
