import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { ROLE_ORDER } from "../src/roles.js";
import type { AcceleratorSource } from "../src/types.js";

const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

describe("README documentation", () => {
  test("lists every process role in the roles table", () => {
    const table = readme.split("### Process roles")[1]?.split("\n### ")[0] ?? "";
    for (const role of ROLE_ORDER) expect(table).toContain(`| \`${role}\` |`);
  });

  test("lists every containment mode in the containment table", () => {
    const table = readme.split("## Containment and discovery")[1]?.split("\n## ")[0] ?? "";
    const modes = ["win32-job-object", "linux-cgroup", "linux-env-pgid", "darwin-env-pgid", "passive-ppid"];
    for (const mode of modes) expect(table).toContain(`| \`${mode}\` |`);
  });

  test("documents the reduced macOS scanner", () => {
    expect(readme).toContain("AGTOP_DARWIN_SCANNER=ps");
  });

  test("documents accelerator usage and every source", () => {
    const section = readme.split("## GPU and NPU usage")[1]?.split("\n## ")[0] ?? "";
    expect(section).not.toBe("");
    const sources: AcceleratorSource[] = ["windows-pdh", "linux-drm-fdinfo", "nvml", "darwin-iokit", "none"];
    for (const source of sources) expect(section).toContain(`\`${source}\``);
  });
});

describe("agtop skill and MCP instructions", async () => {
  const skill = await readFile(new URL("../skills/agtop/SKILL.md", import.meta.url), "utf8");
  const mcpSource = await readFile(new URL("../src/mcp.ts", import.meta.url), "utf8");
  const description = skill.match(/^description: (.+)$/m)?.[1] ?? "";
  const instructions = mcpSource.match(/const instructions = `([^`]+)`/)?.[1] ?? "";

  test("skill description lists triggers, not the workflow", () => {
    expect(description).toStartWith("Use when");
    expect(description).toContain("Not for short commands whose output you need");
    expect(description).not.toMatch(/\brun, wait\b|\bCovers\b/);
  });

  test("skill and MCP instructions agree on the key rules", () => {
    expect(instructions).not.toBe("");
    for (const text of [skill, instructions]) {
      expect(text).toMatch(/discards (stdout|output)/);
      expect(text).toContain("cleanup");
      expect(text).toMatch(/times out/);
      expect(text).toContain("only accepts jobs created by this MCP session");
    }
  });
});
