import * as fs from "node:fs";
import * as path from "node:path";
import { decodeFrames, encodeFrame, fleetDir } from "./event-store.js";
import { redactText } from "./redact.js";
import { ensurePrivateDir } from "./secure-fs.js";
import type { FleetErrorCode } from "./types.js";

export type AuditEvent =
  | "redact-disabled" | "peer-auth-failed" | "peer-submit" | "peer-kill" | "peer-added" | "peer-removed"
  | "policy-changed" | "admin-kill" | "acl-hardening-failed";
export interface AuditRecord { timestamp: string; event: AuditEvent; actor: string; jobId?: string; peerId?: string; code?: FleetErrorCode; detail?: string }

const AUDIT_FILE = "audit.jsonl";
const AUDIT_PREV_FILE = "audit.prev.jsonl";
const AUDIT_MAX_BYTES = 4_194_304;
const DETAIL_MAX_CHARS = 500;

function rotateIfNeeded(file: string, previous: string, incomingBytes: number): void {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return;
  }
  if (size === 0 || size + incomingBytes <= AUDIT_MAX_BYTES) return;
  try {
    fs.rmSync(previous, { force: true });
  } catch {
    /* Replacing the previous segment is best effort; a failed rename leaves the current file intact. */
  }
  fs.renameSync(file, previous);
}

/** Appends one frame to <fleetDir>/audit.jsonl. Rotates to audit.prev.jsonl at 4 MiB. Never throws. */
export function audit(record: Omit<AuditRecord, "timestamp">): void {
  try {
    const dir = fleetDir();
    ensurePrivateDir(dir);
    const record_: AuditRecord = { ...record, timestamp: new Date().toISOString() };
    if (record_.detail !== undefined) record_.detail = redactText(record_.detail).slice(0, DETAIL_MAX_CHARS);
    const frame = encodeFrame(record_);
    const file = path.join(dir, AUDIT_FILE);
    rotateIfNeeded(file, path.join(dir, AUDIT_PREV_FILE), frame.length);
    const fd = fs.openSync(file, "a", 0o600);
    try {
      fs.writeFileSync(fd, frame);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* Audit failures never break the operation being recorded. */
  }
}

/** Decodes audit.prev.jsonl then audit.jsonl; newest last. Default limit 200. */
export function readAudit(limit = 200): AuditRecord[] {
  const records: AuditRecord[] = [];
  const dir = fleetDir();
  for (const name of [AUDIT_PREV_FILE, AUDIT_FILE]) {
    try {
      const buffer = fs.readFileSync(path.join(dir, name));
      records.push(...decodeFrames<AuditRecord>(buffer).records);
    } catch {
      /* A missing or unreadable segment contributes no records. */
    }
  }
  const count = Math.max(0, Math.floor(limit));
  if (count === 0) return [];
  return records.slice(-count);
}
