// Who may see, read, or stop a fleet job (contracts 8.7; threat model section 3).
// Every surface goes through these functions; there is no other path to output.
import { timingSafeEqual } from "node:crypto";
import { FleetError } from "./fleet-errors.js";
import type { SessionIdentity } from "./job-runtime.js";
import type { DaemonPeer, JobRecordV2 } from "./types.js";

export type Caller =
  | { kind: "admin" }
  | { kind: "session"; session: SessionIdentity; peer: string }
  | { kind: "peer"; peer: DaemonPeer };

export type OwnershipAction = "output" | "events" | "kill" | "read";

/** Fixed denial text per action; never echoes the token or its hash. */
const DENIED: Record<OwnershipAction, string> = {
  output: "only jobs created by this MCP session can be read.",
  events: "only jobs created by this MCP session can be read.",
  kill: "only jobs created by this MCP session can be stopped.",
  read: "this job is not visible to this caller.",
};

/** Constant-time hash compare; an empty stored hash or a length mismatch never matches. */
function hashMatches(stored: string, offered: string): boolean {
  if (stored === "" || stored.length !== offered.length) return false;
  try {
    return timingSafeEqual(Buffer.from(stored, "utf8"), Buffer.from(offered, "utf8"));
  } catch {
    return false;
  }
}

export function isOwner(record: JobRecordV2, caller: Caller): boolean {
  if (caller.kind === "admin") return false;
  if (caller.kind === "peer") return record.owner.remotePeerId === caller.peer.id;
  return record.owner.sessionId === caller.session.sessionId && hashMatches(record.owner.tokenHash, caller.session.tokenHash);
}

export function canSee(record: JobRecordV2, caller: Caller): boolean {
  if (caller.kind === "admin" || caller.kind === "session") return true;
  if (isOwner(record, caller)) return true;
  return caller.peer.jobPeerPrefixes.some((prefix) => record.peer.startsWith(prefix));
}

export function canSeeCommand(record: JobRecordV2, caller: Caller): boolean {
  return caller.kind === "admin" || isOwner(record, caller);
}

export function canReadOutput(record: JobRecordV2, caller: Caller): boolean {
  if (caller.kind === "admin") return true;
  if (caller.kind === "session") {
    return isOwner(record, caller) || record.visibility === "all" ||
      (record.visibility === "peer" && record.peer === caller.peer);
  }
  return canSee(record, caller) && (isOwner(record, caller) || record.visibility === "all");
}

export function canKill(record: JobRecordV2, caller: Caller): boolean {
  if (caller.kind === "admin") return true;
  if (caller.kind === "session") return isOwner(record, caller);
  return isOwner(record, caller) || (canSee(record, caller) && caller.peer.scopes.includes("jobs:kill-any"));
}

/** Throws FleetError("E_NOT_OWNER") with a fixed message per action. */
export function assertAllowed(action: OwnershipAction, record: JobRecordV2, caller: Caller): void {
  const allowed = action === "read" ? canSee(record, caller)
    : action === "kill" ? canKill(record, caller)
      : canReadOutput(record, caller);
  if (!allowed) throw new FleetError("E_NOT_OWNER", DENIED[action]);
}
