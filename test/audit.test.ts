import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { audit, readAudit } from "../src/audit.js";

const AUDIT_LIMIT_BYTES = 4_194_304;

let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.AGTOP_STATE_DIR;
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agtop-audit-"));
  process.env.AGTOP_STATE_DIR = stateDir;
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.AGTOP_STATE_DIR;
  else process.env.AGTOP_STATE_DIR = previousStateDir;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const auditDir = (): string => path.join(stateDir, "fleet");
const auditFile = (): string => path.join(auditDir(), "audit.jsonl");

describe("audit append and read", () => {
  test("round trips records in append order with an ISO timestamp", () => {
    audit({ event: "peer-added", actor: "admin", peerId: "peer-1", detail: "added" });
    audit({ event: "peer-submit", actor: "peer:peer-1", jobId: "job-1", detail: "submitted" });

    const records = readAudit();
    expect(records).toHaveLength(2);
    expect(records.map(record => record.event)).toEqual(["peer-added", "peer-submit"]);
    expect(records[1]!.peerId).toBeUndefined();
    expect(records[1]!.jobId).toBe("job-1");
    expect(new Date(records[0]!.timestamp).toISOString()).toBe(records[0]!.timestamp);
  });

  test("returns only the newest limit records, newest last", () => {
    for (let i = 0; i < 5; i++) audit({ event: "admin-kill", actor: `actor-${i}`, jobId: `job-${i}` });
    const records = readAudit(2);
    expect(records.map(record => record.actor)).toEqual(["actor-3", "actor-4"]);
    expect(readAudit(0)).toEqual([]);
  });

  test("uses the default limit of 200", () => {
    for (let i = 0; i < 205; i++) audit({ event: "peer-added", actor: `a${i}` });
    const records = readAudit();
    expect(records).toHaveLength(200);
    expect(records[199]!.actor).toBe("a204");
  });

  test("creates the fleet directory and file", () => {
    audit({ event: "peer-added", actor: "admin" });
    expect(fs.statSync(auditDir()).isDirectory()).toBe(true);
    expect(fs.statSync(auditFile()).isFile()).toBe(true);
  });
});

describe("detail handling", () => {
  test("redacts secrets in detail", () => {
    audit({ event: "redact-disabled", actor: "admin", detail: "Authorization: hunter2" });
    const [record] = readAudit();
    expect(record!.detail).toContain("[REDACTED:auth-header]");
    expect(record!.detail).not.toContain("hunter2");
  });

  test("cuts detail to 500 characters after redaction", () => {
    audit({ event: "policy-changed", actor: "admin", detail: "x".repeat(600) });
    const [record] = readAudit();
    expect(record!.detail).toHaveLength(500);
  });
});

describe("rotation", () => {
  test("rotates to audit.prev.jsonl at 4 MiB", () => {
    const actor = "a".repeat(1_500_000);
    for (let i = 0; i < 3; i++) audit({ event: "peer-added", actor });
    const previous = path.join(auditDir(), "audit.prev.jsonl");
    expect(fs.existsSync(previous)).toBe(true);
    expect(fs.statSync(auditFile()).size).toBeLessThanOrEqual(AUDIT_LIMIT_BYTES);
    expect(readAudit(10)).toHaveLength(3);
  });
});

describe("failure tolerance", () => {
  test("never throws when the fleet directory path is a regular file", () => {
    const file = path.join(os.tmpdir(), `agtop-audit-blocked-${process.pid}-${Date.now()}`);
    fs.writeFileSync(file, "not a directory");
    process.env.AGTOP_STATE_DIR = file;
    try {
      expect(() => audit({ event: "acl-hardening-failed", actor: "system" })).not.toThrow();
      expect(readAudit()).toEqual([]);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});
