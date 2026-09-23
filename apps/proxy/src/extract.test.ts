import { describe, expect, it } from "vitest";
import { parseRequestFacts } from "./extract.js";

describe("parseRequestFacts chat", () => {
  it("extracts model, stream, max tokens, messages, response_format", () => {
    const facts = parseRequestFacts(
      JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        max_completion_tokens: 500,
        max_tokens: 400,
        response_format: { type: "json_schema", json_schema: { schema: {} } },
      }),
      "/v1/chat/completions",
    );
    expect(facts.model).toBe("gpt-4o");
    expect(facts.stream).toBe(true);
    expect(facts.maxTokens).toBe(500); // max_completion_tokens wins
    expect(facts.messages).toHaveLength(1);
    expect(facts.responseFormat?.type).toBe("json_schema");
  });

  it("falls back to max_tokens", () => {
    const facts = parseRequestFacts(
      JSON.stringify({ model: "gpt-4o", messages: [], max_tokens: 123 }),
      "/v1/chat/completions",
    );
    expect(facts.maxTokens).toBe(123);
  });

  it("returns fallbacks for invalid JSON (observe-only: still forwarded)", () => {
    const facts = parseRequestFacts("{broken", "/v1/chat/completions");
    expect(facts.model).toBe("unknown");
    expect(facts.messages).toBeNull();
  });

  it("returns fallbacks for schema-mismatched bodies", () => {
    const facts = parseRequestFacts(JSON.stringify(42), "/v1/chat/completions");
    expect(facts.model).toBe("unknown");
  });
});

describe("parseRequestFacts embeddings", () => {
  it("extracts model and input", () => {
    const facts = parseRequestFacts(
      JSON.stringify({ model: "text-embedding-3-small", input: ["a", "b"] }),
      "/v1/embeddings",
    );
    expect(facts.model).toBe("text-embedding-3-small");
    expect(facts.embeddingInput).toEqual(["a", "b"]);
    expect(facts.stream).toBe(false);
  });
});
