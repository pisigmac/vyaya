import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  type JsonWebKey,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * RSA keyring for the mock issuer. Layout on disk (keysDir):
 *   current.private.pem   (0600)
 *   current.public.pem
 *   previous.private.pem  (0600, after rotation)
 *   previous.public.pem   (after rotation)
 *
 * Env-provided PEMs (MOCK_DESKID_PRIVATE_KEY_PEM / MOCK_DESKID_PUBLIC_KEY_PEM)
 * take precedence and are never written to disk.
 */

export interface SigningKey {
  kid: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

export interface Keyring {
  current: SigningKey;
  previous: SigningKey | null;
}

/** Mutable holder so POST /v1/admin/rotate-keys can swap the ring in place. */
export interface KeyringHolder {
  keyring: Keyring;
  /** null when keys come from env (nothing to persist). */
  keysDir: string | null;
}

/** kid = first 16 base64url chars of SHA-256 over the SPKI DER. */
export function deriveKid(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({
    format: "der",
    type: "spki",
  });
  return createHash("sha256").update(der).digest("base64url").slice(0, 16);
}

export function generateSigningKey(): SigningKey {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const publicKeyPem = publicKey
    .export({ format: "pem", type: "spki" })
    .toString();
  const privateKeyPem = privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  return { kid: deriveKid(publicKeyPem), publicKeyPem, privateKeyPem };
}

/**
 * Env PEMs arrive either as literal PEM (with real or escaped newlines) or as
 * base64-encoded PEM (single line, per .env.example).
 */
function decodeEnvPem(raw: string): string {
  if (raw.includes("BEGIN")) return raw.replace(/\\n/g, "\n");
  return Buffer.from(raw, "base64").toString("utf8");
}

function persistKey(keysDir: string, role: "current" | "previous", key: SigningKey) {
  mkdirSync(keysDir, { recursive: true });
  const privPath = join(keysDir, `${role}.private.pem`);
  writeFileSync(privPath, key.privateKeyPem, { mode: 0o600 });
  chmodSync(privPath, 0o600);
  writeFileSync(join(keysDir, `${role}.public.pem`), key.publicKeyPem);
}

function loadKey(keysDir: string, role: "current" | "previous"): SigningKey | null {
  const privPath = join(keysDir, `${role}.private.pem`);
  const pubPath = join(keysDir, `${role}.public.pem`);
  if (!existsSync(privPath) || !existsSync(pubPath)) return null;
  const privateKeyPem = readFileSync(privPath, "utf8");
  const publicKeyPem = readFileSync(pubPath, "utf8");
  return { kid: deriveKid(publicKeyPem), publicKeyPem, privateKeyPem };
}

export interface LoadKeyringOptions {
  keysDir: string;
  privateKeyPem?: string | undefined;
  publicKeyPem?: string | undefined;
}

/**
 * Resolution order: env pair (ephemeral, wins) -> persisted keyring under
 * keysDir -> generate a fresh pair and persist it.
 */
export function loadKeyring(options: LoadKeyringOptions): KeyringHolder {
  const { keysDir, privateKeyPem, publicKeyPem } = options;
  if (privateKeyPem !== undefined || publicKeyPem !== undefined) {
    if (privateKeyPem === undefined || publicKeyPem === undefined) {
      throw new Error(
        "MOCK_DESKID_PRIVATE_KEY_PEM and MOCK_DESKID_PUBLIC_KEY_PEM must be set together",
      );
    }
    const pub = decodeEnvPem(publicKeyPem);
    const priv = decodeEnvPem(privateKeyPem);
    return {
      keyring: {
        current: { kid: deriveKid(pub), publicKeyPem: pub, privateKeyPem: priv },
        previous: null,
      },
      keysDir: null,
    };
  }
  const current = loadKey(keysDir, "current");
  if (current !== null) {
    return {
      keyring: { current, previous: loadKey(keysDir, "previous") },
      keysDir,
    };
  }
  const fresh = generateSigningKey();
  persistKey(keysDir, "current", fresh);
  return { keyring: { current: fresh, previous: null }, keysDir };
}

/** Rotate: current becomes previous, a fresh key becomes current. */
export function rotateKeyring(holder: KeyringHolder): Keyring {
  const next: Keyring = {
    current: generateSigningKey(),
    previous: holder.keyring.current,
  };
  if (holder.keysDir !== null) {
    persistKey(holder.keysDir, "current", next.current);
    persistKey(holder.keysDir, "previous", next.previous as SigningKey);
  }
  holder.keyring = next;
  return next;
}

/** JWKS document advertising current + previous keys (rotation overlap). */
export function jwksFor(keyring: Keyring): { keys: JsonWebKey[] } {
  const keys: JsonWebKey[] = [];
  for (const key of [keyring.current, keyring.previous]) {
    if (key === null) continue;
    const jwk = createPublicKey(key.publicKeyPem).export({ format: "jwk" });
    keys.push({ ...jwk, kid: key.kid, alg: "RS256", use: "sig" });
  }
  return { keys };
}
