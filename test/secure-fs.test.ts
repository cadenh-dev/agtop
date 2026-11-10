import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  assertPrivateFile,
  createPrivateFileExclusive,
  ensurePrivateDir,
  hardenWindowsAcl,
  writePrivateFileAtomic,
} from "../src/secure-fs.js";

const IS_WINDOWS = process.platform === "win32";

let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.AGTOP_STATE_DIR;
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-secure-fs-"));
  process.env.AGTOP_STATE_DIR = stateDir;
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.AGTOP_STATE_DIR;
  else process.env.AGTOP_STATE_DIR = previousStateDir;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const mode = (file: string): number => fs.statSync(file).mode & 0o777;

describe.skipIf(IS_WINDOWS)("POSIX permissions", () => {
  test("creates nested directories with mode 0700", () => {
    const dir = path.join(stateDir, "fleet", "jobs", "job-1");
    ensurePrivateDir(dir);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(mode(dir)).toBe(0o700);
  });

  test("chmods an existing 0755 directory to 0700", () => {
    const dir = path.join(stateDir, "existing");
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o755);
    expect(mode(dir)).toBe(0o755);
    ensurePrivateDir(dir);
    expect(mode(dir)).toBe(0o700);
  });

  test("writes files with mode 0600 and assertPrivateFile accepts them", () => {
    const dir = path.join(stateDir, "fleet");
    ensurePrivateDir(dir);
    const file = path.join(dir, "policy.json");
    writePrivateFileAtomic(file, "{}");
    expect(mode(file)).toBe(0o600);
    expect(() => assertPrivateFile(file)).not.toThrow();
  });

  test("assertPrivateFile rejects a 0644 file", () => {
    const dir = path.join(stateDir, "fleet");
    ensurePrivateDir(dir);
    const file = path.join(dir, "policy.json");
    writePrivateFileAtomic(file, "{}");
    fs.chmodSync(file, 0o644);
    expect(() => assertPrivateFile(file)).toThrow();
  });

  test("hardenWindowsAcl is a no-op off Windows", () => {
    expect(hardenWindowsAcl(stateDir)).toEqual({ ok: true });
  });
});

describe("atomic and exclusive writes", () => {
  test("atomic write replaces content and leaves no temp file", () => {
    const dir = path.join(stateDir, "fleet");
    ensurePrivateDir(dir);
    const file = path.join(dir, "lock");
    writePrivateFileAtomic(file, "first");
    writePrivateFileAtomic(file, "second");
    expect(fs.readFileSync(file, "utf8")).toBe("second");
    expect(fs.readdirSync(dir).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });

  test("exclusive create returns true then false", () => {
    const dir = path.join(stateDir, "fleet");
    ensurePrivateDir(dir);
    const file = path.join(dir, "kill.request");
    expect(createPrivateFileExclusive(file, "one")).toBe(true);
    expect(createPrivateFileExclusive(file, "two")).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("one");
    if (!IS_WINDOWS) expect(mode(file)).toBe(0o600);
  });

  test("exclusive create rethrows errors other than EEXIST", () => {
    expect(() => createPrivateFileExclusive(path.join(stateDir, "missing", "file"), "x")).toThrow();
  });
});

describe.skipIf(!IS_WINDOWS)("Windows ACL hardening", () => {
  test("ensurePrivateDir leaves no inherited or public ACEs", () => {
    const dir = path.join(stateDir, "fleet");
    ensurePrivateDir(dir);
    const output = execFileSync("icacls.exe", [dir], { encoding: "utf8", windowsHide: true });
    expect(output).not.toContain("(I)");
    expect(output).not.toMatch(/Everyone/i);
    expect(output).not.toMatch(/BUILTIN\\Users/i);
    expect(output).not.toMatch(/Authenticated Users/i);
  });
});
