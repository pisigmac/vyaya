import { z } from "zod";

/** Shared primitive env fields. Env vars arrive as strings; these helpers
 *  coerce/validate them into typed values. Empty string means "unset" for
 *  optional fields, matching .env.example placeholders. */

export const nodeEnvField = z
  .enum(["development", "test", "production"])
  .default("development");

export const logLevelField = z
  .enum(["debug", "info", "warn", "error"])
  .default("info");

const TRUE_VALUES = new Set(["true", "1", "yes"]);
const FALSE_VALUES = new Set(["false", "0", "no"]);

export function boolField(defaultValue: boolean) {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined || raw.trim() === "") return defaultValue;
      const v = raw.trim().toLowerCase();
      if (TRUE_VALUES.has(v)) return true;
      if (FALSE_VALUES.has(v)) return false;
      ctx.addIssue({
        code: "custom",
        message: `expected a boolean string (true/false), got ${JSON.stringify(raw)}`,
      });
      return z.NEVER;
    });
}

export function intField(
  defaultValue: number,
  opts: { min?: number; max?: number } = {},
) {
  let s = z.coerce.number().int();
  if (opts.min !== undefined) s = s.min(opts.min);
  if (opts.max !== undefined) s = s.max(opts.max);
  return s.default(defaultValue);
}

export function floatField(
  defaultValue: number,
  opts: { min?: number; max?: number } = {},
) {
  let s = z.coerce.number();
  if (opts.min !== undefined) s = s.min(opts.min);
  if (opts.max !== undefined) s = s.max(opts.max);
  return s.default(defaultValue);
}

export function portField(defaultPort: number) {
  return intField(defaultPort, { min: 1, max: 65535 });
}

/** Optional string: "" and undefined both map to undefined. */
export const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));

/** Optional URL: "" and undefined map to undefined; otherwise must be a URL. */
export const optionalUrl = optionalString.pipe(z.url().optional());

export const requiredUrl = z.url();

/** Comma-separated list field; empty/unset maps to []. */
export const csvField = z
  .string()
  .optional()
  .transform((v) =>
    v === undefined || v.trim() === ""
      ? []
      : v
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
  );

/** 32-byte key as 64 hex characters (AES-256 master key). */
export const hexKey32Field = z
  .string()
  .regex(
    /^[0-9a-fA-F]{64}$/,
    "expected a 32-byte key as 64 hex characters (generate with: openssl rand -hex 32)",
  );

export const postgresUrlField = z
  .string()
  .regex(
    /^postgres(ql)?:\/\/.+/,
    "expected a postgres:// connection string",
  );
