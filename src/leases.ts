import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fleetDir } from "./event-store.js";
import { FleetError } from "./fleet-errors.js";
import { DEFAULT_ADMISSION_POLICY } from "./policy.js";
import { supervisorAlive } from "./reconcile.js";
import { processSnapshot, type ProcessIdentity } from "./registry.js";
import { createPrivateFileExclusive, ensurePrivateDir, writePrivateFileAtomic } from "./secure-fs.js";
import type { LeaseHolder, ListenerInfo, PortLease, SupervisorIdentity } from "./types.js";

const MIN_PORT = 1, MAX_PORT = 65_535, MIN_TTL_MS = 10_000, MAX_TTL_MS = 86_400_000;
/** D18: the default liveness snapshot is taken lazily, at most once per 5 s. */
const SNAPSHOT_TTL_MS = 5_000;
/** Retries for a lease file that exists but is not readable yet (contracts 8.1). */
const UNREADABLE_RETRIES = 20, UNREADABLE_RETRY_MS = 5;
/** An unreadable lease file younger than this may be a winner still writing; never delete it. */
const UNREADABLE_STALE_MS = 2000;
function olderThan(file: string, ms: number, nowMs: number): boolean {
  try { return nowMs - fs.statSync(file).mtimeMs >= ms; } catch { return false; }
}
/**
 * Deletes `file` only if its contents still satisfy `matches`. Read-then-delete would let a slow
 * process delete a lease another process just created, so the file is renamed aside first (only
 * one process can move it), checked, and restored with link() (never overwrites) if it no longer
 * matches. Same approach as the fleet lock takeover in reconcile.ts.
 */
function removeIf(file: string, matches: (raw: string) => boolean): boolean {
  const aside = `${file}.gone.${process.pid}.${randomUUID()}`;
  try { fs.renameSync(file, aside); } catch { return false; }
  try {
    if (matches(fs.readFileSync(aside, "utf8"))) return true;
    try { fs.linkSync(aside, file); } catch { /* A newer lease exists; nothing to restore. */ }
    return false;
  } catch { return false; } finally { fs.rmSync(aside, { force: true }); }
}
const holdsLease = (leaseId: string) => (raw: string): boolean => {
  try { return (JSON.parse(raw) as { leaseId?: unknown } | null)?.leaseId === leaseId; } catch { return false; }
};
const isUnparseable = (raw: string): boolean => { try { return parseLease(JSON.parse(raw)) === null; } catch { return true; } };

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT;
}
function isTimestamp(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
/** A lease file is usable only when every field this module reads has its contract type. */
function parseLease(value: unknown): PortLease | null {
  if (typeof value !== "object" || value === null) return null;
  const lease = value as Partial<PortLease>, holder = lease.holder as Partial<SupervisorIdentity> | undefined;
  if (typeof lease.leaseId !== "string" || !isPort(lease.port)) return null;
  if (lease.jobId !== null && typeof lease.jobId !== "string") return null;
  if (typeof lease.peer !== "string" || typeof lease.sessionId !== "string") return null;
  if (typeof holder?.pid !== "number" || typeof holder.startTime !== "string") return null;
  if (!isTimestamp(lease.acquiredAt) || !isTimestamp(lease.renewedAt) || !isTimestamp(lease.expiresAt)) return null;
  if (typeof lease.ttlMs !== "number" || !Number.isFinite(lease.ttlMs)) return null;
  return lease as PortLease;
}

/**
 * Advisory port leases on disk (contracts 8.1, D18). The `<port>.json` file is created with `wx`
 * semantics, which is the only mutual exclusion; agtop never binds or probes a port.
 */
export class LeaseManager {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly listeners: () => ListenerInfo[];
  private readonly alive: (holder: SupervisorIdentity) => boolean;
  private snapshotTakenAt: number | null = null;
  private snapshotValue: ProcessIdentity[] | undefined;

  constructor(options: { dir?: string; now?: () => number; listeners?: () => ListenerInfo[]; alive?: (holder: SupervisorIdentity) => boolean } = {}) {
    this.dir = options.dir ?? path.join(fleetDir(), "leases");
    this.now = options.now ?? Date.now;
    // D18: no tree snapshot is held here, so the default never triggers a process scan.
    this.listeners = options.listeners ?? (() => []);
    this.alive = options.alive ?? ((holder) => {
      const snapshot = this.snapshot();
      // A snapshot that cannot be taken means "alive": unknown is never treated as dead.
      return snapshot === undefined ? true : supervisorAlive(holder, snapshot);
    });
  }

  /** Throws FleetError("E_LEASE_CONFLICT", …, { holder }) (contracts 8.1). */
  acquire(request: { port: number; jobId: string | null; peer: string; sessionId: string; holder: SupervisorIdentity; ttlMs?: number }): PortLease {
    const { port } = request;
    if (!isPort(port)) throw invalid("port", `Port must be an integer between 1 and 65535: ${String(port)}`);
    const ttlMs = request.ttlMs ?? DEFAULT_ADMISSION_POLICY.defaultLeaseTtlMs;
    if (!Number.isInteger(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
      throw invalid("ttlMs", `ttlMs must be an integer between 10000 and 86400000: ${String(ttlMs)}`);
    }
    const nowMs = this.now(), file = this.file(port);
    // A dead lease is absent; remove it before the check so the port can be taken again.
    const existing = this.read(port);
    if (existing !== null && this.isDead(existing, nowMs)) removeIf(file, holdsLease(existing.leaseId));
    const holder = this.check(port, request.jobId ?? undefined);
    if (holder !== null) throw conflict(port, holder);
    const at = new Date(nowMs).toISOString();
    const lease: PortLease = { leaseId: randomUUID(), port, jobId: request.jobId, peer: request.peer, sessionId: request.sessionId,
      holder: request.holder, acquiredAt: at, renewedAt: at, expiresAt: new Date(nowMs + ttlMs).toISOString(), ttlMs };
    ensurePrivateDir(this.dir);
    const data = JSON.stringify(lease);
    for (let attempt = 0; ; attempt += 1) {
      if (createPrivateFileExclusive(file, data)) return lease;
      // Lost the race: the winner's lease is the holder. An unreadable file is either the winner
      // still writing (it is written right after creation) or garbage that sweep() would remove.
      const winner = this.live(port);
      if (winner !== null) throw conflict(port, leaseHolder(winner));
      if (attempt >= UNREADABLE_RETRIES * 2) throw new FleetError("E_INTERNAL", `Lease file for port ${port} is unreadable`);
      // A dead winner, or old garbage, is removed only if it is still exactly that file.
      const stale = this.read(port);
      if (stale !== null && this.isDead(stale, this.now())) removeIf(file, holdsLease(stale.leaseId));
      else if (stale === null && olderThan(file, UNREADABLE_STALE_MS, Date.now())) removeIf(file, isUnparseable);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, UNREADABLE_RETRY_MS);
    }
  }

  /** Throws E_LEASE_NOT_FOUND, or E_NOT_OWNER when leaseId does not match. */
  renew(port: number, leaseId: string): PortLease {
    const lease = this.live(port);
    if (lease === null) throw new FleetError("E_LEASE_NOT_FOUND", `No lease for port ${port}`);
    if (lease.leaseId !== leaseId) throw new FleetError("E_NOT_OWNER", `Lease ${leaseId} does not hold port ${port}`);
    const nowMs = this.now();
    const renewed: PortLease = { ...lease, renewedAt: new Date(nowMs).toISOString(), expiresAt: new Date(nowMs + lease.ttlMs).toISOString() };
    ensurePrivateDir(this.dir);
    writePrivateFileAtomic(this.file(port), JSON.stringify(renewed));
    return renewed;
  }

  release(port: number, leaseId: string): void {
    const lease = this.live(port);
    if (lease === null) throw new FleetError("E_LEASE_NOT_FOUND", `No lease for port ${port}`);
    if (lease.leaseId !== leaseId) throw new FleetError("E_NOT_OWNER", `Lease ${leaseId} does not hold port ${port}`);
    if (!removeIf(this.file(port), holdsLease(leaseId))) throw new FleetError("E_LEASE_NOT_FOUND", `No lease for port ${port}`);
  }

  /** Releases every lease of a job. Returns the ports. */
  releaseJob(jobId: string): number[] {
    const ports: number[] = [];
    for (const entry of this.entries()) {
      if (entry.lease === null || entry.lease.jobId !== jobId) continue;
      if (removeIf(this.file(entry.port), holdsLease(entry.lease.leaseId))) ports.push(entry.port);
    }
    return ports.sort((a, b) => a - b);
  }

  get(port: number): PortLease | null { return this.live(port); }

  list(): PortLease[] {
    const nowMs = this.now();
    return this.entries().map((entry) => entry.lease)
      .filter((lease): lease is PortLease => lease !== null && !this.isDead(lease, nowMs))
      .sort((a, b) => a.port - b.port);
  }

  /** Why this port cannot be leased to forJobId right now, or null. Does not modify anything. */
  check(port: number, forJobId?: string): LeaseHolder | null {
    if (!isPort(port)) return null;
    const lease = this.live(port);
    if (lease !== null && lease.jobId !== forJobId) return leaseHolder(lease);
    for (const listener of this.listeners()) {
      // Without a job, every listener conflicts (an unrelated process with no jobId must not match "no job").
      if (listener.port !== port || (forJobId !== undefined && listener.jobId === forJobId)) continue;
      return { kind: "listener", port, pid: listener.pid, address: listener.address,
        ...(listener.jobId === undefined ? {} : { jobId: listener.jobId }), ...(listener.peer === undefined ? {} : { peer: listener.peer }) };
    }
    return null;
  }

  /** Deletes expired and dead-holder leases. Returns the ports. */
  sweep(): number[] {
    const nowMs = this.now(), ports: number[] = [];
    for (const entry of this.entries()) {
      if (entry.lease !== null && !this.isDead(entry.lease, nowMs)) continue;
      // A young unreadable file may be a lease another process is still writing.
      if (entry.lease === null && !olderThan(this.file(entry.port), UNREADABLE_STALE_MS, Date.now())) continue;
      const matches = entry.lease === null ? isUnparseable : holdsLease(entry.lease.leaseId);
      if (removeIf(this.file(entry.port), matches)) ports.push(entry.port);
    }
    return ports.sort((a, b) => a - b);
  }

  private file(port: number): string { return path.join(this.dir, `${port}.json`); }
  /** Every `<port>.json` file in the directory; `lease` is null when the content is unusable. */
  private entries(): Array<{ port: number; lease: PortLease | null }> {
    let names: string[];
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    const entries: Array<{ port: number; lease: PortLease | null }> = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const port = Number(name.slice(0, -".json".length));
      // Only canonical lease names are ours; a temp file or a foreign name is left alone.
      if (!isPort(port) || name !== `${port}.json`) continue;
      entries.push({ port, lease: this.read(port) });
    }
    return entries;
  }
  /** The lease on disk, or null when absent or unparseable. Never throws. */
  private read(port: number): PortLease | null {
    if (!isPort(port)) return null;
    try {
      const lease = parseLease(JSON.parse(fs.readFileSync(this.file(port), "utf8")));
      return lease !== null && lease.port === port ? lease : null; // a file's port must match its name
    } catch { return null; }
  }
  /** The live lease on disk: absent, expired and dead-holder leases are all null. */
  private live(port: number): PortLease | null {
    const lease = this.read(port);
    return lease === null || this.isDead(lease, this.now()) ? null : lease;
  }
  /** Dead when `now > expiresAt` or the holder supervisor is gone (contracts 8.1). */
  private isDead(lease: PortLease, nowMs: number): boolean {
    return nowMs > Date.parse(lease.expiresAt) || !this.alive(lease.holder);
  }
  /** D18: one process snapshot per 5 s, taken lazily; undefined means the scan failed. */
  private snapshot(): ProcessIdentity[] | undefined {
    const nowMs = this.now();
    if (this.snapshotTakenAt === null || nowMs - this.snapshotTakenAt > SNAPSHOT_TTL_MS || nowMs < this.snapshotTakenAt) {
      this.snapshotTakenAt = nowMs;
      try { this.snapshotValue = processSnapshot(); } catch { this.snapshotValue = undefined; }
    }
    return this.snapshotValue;
  }
}

function invalid(field: string, message: string): FleetError { return new FleetError("E_INVALID_REQUEST", message, { field }); }
function leaseHolder(lease: PortLease): LeaseHolder {
  return { kind: "lease", port: lease.port, jobId: lease.jobId, peer: lease.peer, expiresAt: lease.expiresAt };
}
function conflict(port: number, holder: LeaseHolder): FleetError {
  return new FleetError("E_LEASE_CONFLICT", `Port ${port} is already ${holder.kind === "lease" ? "leased" : "in use"}`, { holder });
}
