import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { ROLE_ORDER } from "../src/roles.js";

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
});
