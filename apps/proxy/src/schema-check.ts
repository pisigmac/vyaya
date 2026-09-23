import { Ajv } from "ajv";
import type { SchemaValidationResult } from "@vyaya/core";

/**
 * Server-side response_format validation. After passthrough (never
 * blocking or mutating the response), the assistant content is checked
 * against the client's declared format and the result is recorded as
 * schema_validation on the request log — the schema_failure_burn signal.
 *
 * Semantics:
 *   - no response_format, or type "text", or no content to check
 *     (upstream error)                       -> "not_requested"
 *   - json_object: content parses as JSON    -> passed / failed
 *   - json_schema: content parses AND validates against the declared
 *     JSON schema                            -> passed / failed
 *   - an invalid declared schema             -> "failed" (the caller asked
 *     for a guarantee no response can satisfy)
 */

export interface DeclaredResponseFormat {
  type: string;
  json_schema?: { schema?: unknown } | undefined;
}

const ajv = new Ajv({
  strict: false,
  allErrors: false,
  validateSchema: false,
});

export function validateResponseFormat(
  format: DeclaredResponseFormat | null,
  contentText: string | null,
): SchemaValidationResult {
  if (format === null || format.type === "text" || contentText === null) {
    return "not_requested";
  }
  if (format.type === "json_object") {
    return parsesAsJson(contentText) ? "passed" : "failed";
  }
  if (format.type === "json_schema") {
    const schema = format.json_schema?.schema;
    if (typeof schema !== "object" || schema === null) return "failed";
    let parsed: unknown;
    try {
      parsed = JSON.parse(contentText);
    } catch {
      return "failed";
    }
    try {
      return ajv.validate(schema as Record<string, unknown>, parsed)
        ? "passed"
        : "failed";
    } catch {
      // Undeclarable schema (bad $ref, etc.) — no response can satisfy it.
      return "failed";
    }
  }
  return "not_requested";
}

function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
