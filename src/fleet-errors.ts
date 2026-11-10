import type { FleetErrorBody, FleetErrorCode } from "./types.js";

/** An error that carries a contract error code and an HTTP status (contracts 2.7). */
export class FleetError extends Error {
  constructor(readonly code: FleetErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "FleetError";
  }

  toBody(): FleetErrorBody {
    const body: FleetErrorBody = { error: this.message, code: this.code };
    if (this.details !== undefined) body.details = this.details;
    return body;
  }
}

export const FLEET_ERROR_STATUS: Record<FleetErrorCode, number> = {
  E_UNAUTHORIZED: 401,
  E_SIGNATURE_INVALID: 401,
  E_CLOCK_SKEW: 401,
  E_REPLAY: 401,
  E_REPLAY_CACHE_FULL: 429,
  E_FORBIDDEN_SCOPE: 403,
  E_NOT_OWNER: 403,
  E_INVALID_REQUEST: 400,
  E_BODY_TOO_LARGE: 413,
  E_ROUTE_NOT_FOUND: 404,
  E_JOB_NOT_FOUND: 404,
  E_JOB_EXISTS: 409,
  E_DEPENDENCY_NOT_FOUND: 422,
  E_DEPENDENCY_CYCLE: 422,
  E_QUEUE_FULL: 429,
  E_CAPTURE_DISABLED: 409,
  E_OUTPUT_UNAVAILABLE: 410,
  E_KILL_INCOMPLETE: 409,
  E_LEASE_CONFLICT: 409,
  E_LEASE_NOT_FOUND: 404,
  E_PEER_NOT_FOUND: 404,
  E_PEER_UNREACHABLE: 502,
  E_PEER_TIMEOUT: 504,
  E_PEER_TLS: 502,
  E_PEER_PROTOCOL: 502,
  E_INTERNAL: 500,
};
