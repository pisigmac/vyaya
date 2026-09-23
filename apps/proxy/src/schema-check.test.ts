import { describe, expect, it } from "vitest";
import { validateResponseFormat } from "./schema-check.js";

const SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};

describe("validateResponseFormat", () => {
  it("not_requested without a format or with type text", () => {
    expect(validateResponseFormat(null, "anything")).toBe("not_requested");
    expect(validateResponseFormat({ type: "text" }, "anything")).toBe("not_requested");
    expect(validateResponseFormat({ type: "unknown-type" }, "x")).toBe("not_requested");
  });

  it("not_requested when there is no content (upstream error)", () => {
    expect(validateResponseFormat({ type: "json_object" }, null)).toBe("not_requested");
    expect(
      validateResponseFormat({ type: "json_schema", json_schema: { schema: SCHEMA } }, null),
    ).toBe("not_requested");
  });

  it("json_object passes on any JSON value", () => {
    expect(validateResponseFormat({ type: "json_object" }, '{"a":1}')).toBe("passed");
    expect(validateResponseFormat({ type: "json_object" }, "[1,2]")).toBe("passed");
    expect(validateResponseFormat({ type: "json_object" }, "{nope")).toBe("failed");
  });

  it("json_schema validates against the declared schema", () => {
    const fmt = { type: "json_schema", json_schema: { schema: SCHEMA } };
    expect(validateResponseFormat(fmt, '{"answer":"42"}')).toBe("passed");
    expect(validateResponseFormat(fmt, '{"answer":42}')).toBe("failed");
    expect(validateResponseFormat(fmt, '{"other":"x"}')).toBe("failed");
    expect(validateResponseFormat(fmt, "not json")).toBe("failed");
  });

  it("fails when the declared schema is missing or undeclarable", () => {
    expect(validateResponseFormat({ type: "json_schema" }, "{}")).toBe("failed");
    expect(
      validateResponseFormat(
        { type: "json_schema", json_schema: { schema: { $ref: "#/nowhere" } } },
        "{}",
      ),
    ).toBe("failed");
  });
});
