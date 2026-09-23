import type { SessionPayload, VyayaRole } from "./session";

/** Typed error carrying an HTTP status; route handlers map it to a response. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function unauthorized(): HttpError {
  return new HttpError(401, "not signed in");
}

export function forbidden(message = "your role can't do that"): HttpError {
  return new HttpError(403, message);
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, message);
}

export function notFound(message = "not found"): HttpError {
  return new HttpError(404, message);
}

const ROLE_RANK: Record<VyayaRole, number> = {
  viewer: 0,
  operator: 1,
  admin: 2,
};

/**
 * RBAC gate for mutating operations. Viewers are read-only everywhere;
 * operators and admins may write. Returns nothing, throws 403 otherwise.
 */
export function requireWrite(session: SessionPayload): void {
  if (ROLE_RANK[session.role] < ROLE_RANK.operator) {
    throw forbidden("viewers are read-only");
  }
}

/** Admin-only gate (e.g. dev classifier trigger). */
export function requireAdmin(session: SessionPayload): void {
  if (ROLE_RANK[session.role] < ROLE_RANK.admin) {
    throw forbidden("admin role required");
  }
}
