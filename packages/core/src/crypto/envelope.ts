import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

/**
 * AES-256-GCM envelope encryption for prompt/response bodies.
 *
 * Scheme: each workspace has a random 256-bit data encryption key (DEK).
 * The DEK is wrapped (encrypted) with the master key from env
 * (MASTER_ENCRYPTION_KEY) so bodies stay unreadable if the database leaks
 * without the master key. A KMS adapter (master key fetched from a KMS at
 * boot) is the documented upgrade path — this class only depends on key
 * material, not on where it came from.
 *
 * All binary fields are base64-encoded for storage in text/JSONB columns.
 */

export const DEK_BYTES = 32;
export const IV_BYTES = 12; // 96-bit nonce, recommended for AES-GCM
export const AUTH_TAG_BYTES = 16;

export class EnvelopeKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeKeyError";
  }
}

export class EnvelopeDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeDecryptError";
  }
}

export interface WrappedDek {
  /** base64 AES-256-GCM ciphertext of the DEK. */
  wrappedKey: string;
  /** base64 12-byte IV. */
  iv: string;
  /** base64 16-byte GCM auth tag. */
  authTag: string;
}

export interface EncryptedPayload {
  /** base64 ciphertext. */
  ciphertext: string;
  /** base64 12-byte IV. */
  iv: string;
  /** base64 16-byte GCM auth tag. */
  authTag: string;
}

export class EnvelopeCipher {
  readonly #masterKey: Buffer;

  /**
   * @param masterKey exactly 32 bytes. Use EnvelopeCipher.masterKeyFromHex
   *   for the MASTER_ENCRYPTION_KEY env var format.
   */
  constructor(masterKey: Buffer) {
    if (masterKey.length !== DEK_BYTES) {
      throw new EnvelopeKeyError(
        `master key must be ${DEK_BYTES} bytes, got ${masterKey.length}`,
      );
    }
    this.#masterKey = Buffer.from(masterKey);
  }

  /** Parse a 64-char hex string (MASTER_ENCRYPTION_KEY) into key bytes. */
  static masterKeyFromHex(hex: string): Buffer {
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new EnvelopeKeyError(
        "master key hex must be exactly 64 hex characters (32 bytes)",
      );
    }
    return Buffer.from(hex, "hex");
  }

  /** Generate a fresh random per-workspace DEK. */
  static generateDek(): Buffer {
    return randomBytes(DEK_BYTES);
  }

  /** Wrap (encrypt) a workspace DEK with the master key. */
  wrapDek(dek: Buffer): WrappedDek {
    if (dek.length !== DEK_BYTES) {
      throw new EnvelopeKeyError(
        `DEK must be ${DEK_BYTES} bytes, got ${dek.length}`,
      );
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#masterKey, iv);
    const wrappedKey = Buffer.concat([cipher.update(dek), cipher.final()]);
    return {
      wrappedKey: wrappedKey.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    };
  }

  /** Unwrap (decrypt) a workspace DEK with the master key. */
  unwrapDek(wrapped: WrappedDek): Buffer {
    const iv = decodeField(wrapped.iv, "iv");
    const authTag = decodeField(wrapped.authTag, "authTag");
    const wrappedKey = decodeField(wrapped.wrappedKey, "wrappedKey");
    const decipher = createDecipheriv("aes-256-gcm", this.#masterKey, iv);
    decipher.setAuthTag(authTag);
    try {
      return Buffer.concat([decipher.update(wrappedKey), decipher.final()]);
    } catch {
      throw new EnvelopeDecryptError(
        "failed to unwrap DEK: wrong master key or corrupted wrapped key",
      );
    }
  }

  /**
   * Encrypt a body with the workspace DEK.
   * @param aad optional additional authenticated data (e.g. workspace id) —
   *   binds ciphertext to context; must match at decrypt time.
   */
  encrypt(
    dek: Buffer,
    plaintext: Buffer | string,
    aad?: Buffer,
  ): EncryptedPayload {
    assertDek(dek);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", dek, iv);
    if (aad !== undefined) cipher.setAAD(aad);
    const data =
      typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    };
  }

  /** Decrypt a body with the workspace DEK. Throws on any tampering. */
  decrypt(dek: Buffer, payload: EncryptedPayload, aad?: Buffer): Buffer {
    assertDek(dek);
    const iv = decodeField(payload.iv, "iv");
    const authTag = decodeField(payload.authTag, "authTag");
    const ciphertext = decodeField(payload.ciphertext, "ciphertext");
    const decipher = createDecipheriv("aes-256-gcm", dek, iv);
    decipher.setAuthTag(authTag);
    if (aad !== undefined) decipher.setAAD(aad);
    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new EnvelopeDecryptError(
        "failed to decrypt payload: wrong key, wrong AAD, or tampered data",
      );
    }
  }

  /** Convenience: encrypt string bodies straight to base64 text. */
  encryptText(dek: Buffer, plaintext: string, aad?: Buffer): EncryptedPayload {
    return this.encrypt(dek, plaintext, aad);
  }

  decryptText(dek: Buffer, payload: EncryptedPayload, aad?: Buffer): string {
    return this.decrypt(dek, payload, aad).toString("utf8");
  }
}

function assertDek(dek: Buffer): void {
  if (dek.length !== DEK_BYTES) {
    throw new EnvelopeKeyError(
      `DEK must be ${DEK_BYTES} bytes, got ${dek.length}`,
    );
  }
}

function decodeField(value: string, name: string): Buffer {
  const buf = Buffer.from(value, "base64");
  if (buf.length === 0 && value.length > 0) {
    throw new EnvelopeDecryptError(`invalid base64 in field ${name}`);
  }
  return buf;
}
