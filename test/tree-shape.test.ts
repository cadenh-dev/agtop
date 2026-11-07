import { describe, expect, test } from "bun:test";
import { correlateTrees } from "../src/trees.js";
import type { RawOsProcess } from "../src/types.js";

const proc = (pid: number, name: string, cmdline = name): RawOsProcess => ({
  pid, ppid: 0, name, cmdline, startTime: String(pid), cpuSeconds: 0, cpuPercent: 0, memoryMb: 1,
});

describe("tree role placeholder shape", () => {
  test("assigns role fields and counts every process", () => {
    const trees = correlateTrees([proc(100, "claude"), proc(101, "bash")], [], new Map());
    expect(trees.length).toBeGreaterThan(0);
    for (const tree of trees) {
      expect(Object.values(tree.roleCounts).reduce((sum, count) => sum + count, 0)).toBe(tree.processes.length);
      for (const process of tree.processes) {
        expect(process.role).toBeDefined();
        expect(process.roleSource).toBeDefined();
        expect(process.roleEvidence).toBeDefined();
      }
    }
  });
});
