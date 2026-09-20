import { createSign, randomUUID } from "node:crypto";
import type { SigningKey } from "./keys.js";

/**
 * RS256 JWT issuance with the exact DeskId claim shape:
 *   sub, email, org_id, workspace_id, aud[], roles { "vyaya": ... },
 *   token_version, iss, iat, exp.
 * Verification lives in @vyaya/core (same code path as real DeskId).
 */

export type VyayaRole = "admin" | "operator" | "viewer";

export interface IssuedClaims {
  sub: string;
  email: string;
  org_id: string | null;
  workspace_id: string | null;
  aud: string[];
  roles: Record<string, VyayaRole>;
  token_version: number;
  iss: string;
  iat: number;
  exp: number;
}

export interface IssueTokenOptions {
  key: SigningKey;
  issuer: string;
  ttlSec: number;
  /** Injectable clock in ms (tests). Defaults to Date.now. */
  now?: () => number;
  sub?: string;
  email?: string;
  orgId?: string | null;
  workspaceId?: string | null;
  /** Always includes "vyaya". */
  audiences?: string[];
  role?: VyayaRole;
  tokenVersion?: number;
}

export function issueToken(options: IssueTokenOptions): {
  token: string;
  claims: IssuedClaims;
} {
  const nowSec = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const audiences = [...new Set(["vyaya", ...(options.audiences ?? [])])];
  const claims: IssuedClaims = {
    sub: options.sub ?? randomUUID(),
    email: options.email ?? "dev-user@vyaya.local",
    org_id: options.orgId !== undefined ? options.orgId : randomUUID(),
    workspace_id:
      options.workspaceId !== undefined ? options.workspaceId : randomUUID(),
    aud: audiences,
    roles: { vyaya: options.role ?? "admin" },
    token_version: options.tokenVersion ?? 1,
    iss: options.issuer,
    iat: nowSec,
    exp: nowSec + options.ttlSec,
  };

  const header = { alg: "RS256", typ: "JWT", kid: options.key.kid };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${headerB64}.${payloadB64}`);
  signer.end();
  const signature = signer.sign(options.key.privateKeyPem, "base64url");
  return { token: `${headerB64}.${payloadB64}.${signature}`, claims };
}
