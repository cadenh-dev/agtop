import { describe, expect, test } from "bun:test";
import { FleetError, FLEET_ERROR_STATUS } from "../src/fleet-errors.js";
import { isLegalTransition, isTerminal, LEGAL_TRANSITIONS, RUNNING_STATES, TERMINAL_STATES } from "../src/job-state.js";
import type { FleetErrorCode, JobState } from "../src/types.js";

const STATES: readonly JobState[] = ["queued", "starting", "running", "exiting", "exited", "failed", "killed", "lost"];

/** The contract table (fleet-contracts.md section 14), written as transitions rather than arrays. */
const LEGAL_PAIRS: readonly string[] = [
  "queued>starting", "queued>killed", "queued>failed", "queued>lost",
  "starting>running", "starting>failed", "starting>lost",
  "running>exiting", "running>lost",
  "exiting>exited", "exiting>killed", "exiting>failed", "exiting>lost",
];

const CODES: readonly FleetErrorCode[] = [
  "E_UNAUTHORIZED", "E_SIGNATURE_INVALID", "E_CLOCK_SKEW", "E_REPLAY", "E_REPLAY_CACHE_FULL",
  "E_FORBIDDEN_SCOPE", "E_NOT_OWNER",
  "E_INVALID_REQUEST", "E_BODY_TOO_LARGE", "E_ROUTE_NOT_FOUND",
  "E_JOB_NOT_FOUND", "E_JOB_EXISTS", "E_DEPENDENCY_NOT_FOUND", "E_DEPENDENCY_CYCLE", "E_QUEUE_FULL",
  "E_CAPTURE_DISABLED", "E_OUTPUT_UNAVAILABLE", "E_KILL_INCOMPLETE",
  "E_LEASE_CONFLICT", "E_LEASE_NOT_FOUND",
  "E_PEER_NOT_FOUND", "E_PEER_UNREACHABLE", "E_PEER_TIMEOUT", "E_PEER_TLS", "E_PEER_PROTOCOL",
  "E_INTERNAL",
];

/** The HTTP status table (fleet-contracts.md section 2.7). */
const EXPECTED_STATUS: Record<FleetErrorCode, number> = {
  E_UNAUTHORIZED: 401, E_SIGNATURE_INVALID: 401, E_CLOCK_SKEW: 401, E_REPLAY: 401, E_REPLAY_CACHE_FULL: 429,
  E_FORBIDDEN_SCOPE: 403, E_NOT_OWNER: 403,
  E_INVALID_REQUEST: 400, E_BODY_TOO_LARGE: 413, E_ROUTE_NOT_FOUND: 404,
  E_JOB_NOT_FOUND: 404, E_JOB_EXISTS: 409, E_DEPENDENCY_NOT_FOUND: 422, E_DEPENDENCY_CYCLE: 422,
  E_QUEUE_FULL: 429,
  E_CAPTURE_DISABLED: 409, E_OUTPUT_UNAVAILABLE: 410, E_KILL_INCOMPLETE: 409,
  E_LEASE_CONFLICT: 409, E_LEASE_NOT_FOUND: 404,
  E_PEER_NOT_FOUND: 404, E_PEER_UNREACHABLE: 502, E_PEER_TIMEOUT: 504, E_PEER_TLS: 502, E_PEER_PROTOCOL: 502,
  E_INTERNAL: 500,
};

describe("job state table", () => {
  test("LEGAL_TRANSITIONS equals the contract table", () => {
    expect(Object.keys(LEGAL_TRANSITIONS).sort()).toEqual([...STATES].sort());
    for (const from of STATES) {
      const actual = LEGAL_TRANSITIONS[from].map((to) => `${from}>${to}`).sort();
      const expected = LEGAL_PAIRS.filter((pair) => pair.startsWith(`${from}>`)).sort();
      expect(actual).toEqual(expected);
    }
  });

  test("isLegalTransition is true for exactly the legal pairs", () => {
    let checked = 0;
    for (const from of STATES) {
      for (const to of STATES) {
        const pair = `${from}>${to}`;
        expect(isLegalTransition(from, to)).toBe(LEGAL_PAIRS.includes(pair));
        checked += 1;
      }
    }
    expect(checked).toBe(64);
  });

  test("isLegalTransition from null admits only queued", () => {
    for (const to of STATES) expect(isLegalTransition(null, to)).toBe(to === "queued");
  });

  test("terminal and running state sets match the contract", () => {
    expect([...STATES].filter((s) => isTerminal(s))).toEqual(["exited", "failed", "killed", "lost"]);
    for (const state of STATES) {
      expect(TERMINAL_STATES.has(state)).toBe(isTerminal(state));
      expect(RUNNING_STATES.has(state)).toBe(state === "starting" || state === "running" || state === "exiting");
    }
    expect([...TERMINAL_STATES].sort()).toEqual(["exited", "failed", "killed", "lost"]);
    expect([...RUNNING_STATES].sort()).toEqual(["exiting", "running", "starting"]);
  });
});

describe("fleet errors", () => {
  test("every code has the contract status", () => {
    expect(Object.keys(FLEET_ERROR_STATUS).sort()).toEqual([...CODES].sort());
    for (const code of CODES) expect(FLEET_ERROR_STATUS[code]).toBe(EXPECTED_STATUS[code]);
  });

  test("toBody carries error, code and details", () => {
    const error = new FleetError("E_INVALID_REQUEST", "cwd is not a directory", { field: "cwd" });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("FleetError");
    expect(error.message).toBe("cwd is not a directory");
    expect(error.code).toBe("E_INVALID_REQUEST");
    expect(error.details).toEqual({ field: "cwd" });
    expect(error.toBody()).toEqual({ error: "cwd is not a directory", code: "E_INVALID_REQUEST", details: { field: "cwd" } });
  });

  test("toBody omits details when they were not supplied", () => {
    const body = new FleetError("E_INTERNAL", "boom").toBody();
    expect(body).toEqual({ error: "boom", code: "E_INTERNAL" });
    expect("details" in body).toBe(false);
  });
});
