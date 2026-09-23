import { describe, expect, it } from "vitest";
import {
  contentToText,
  estimateChatPromptTokens,
  estimateTokens,
  normalizeChatMessages,
  normalizeEmbeddingInput,
  promptHashHex,
} from "./normalize.js";

describe("prompt normalization", () => {
  it("flattens string content", () => {
    expect(contentToText("hello")).toBe("hello");
  });

  it("flattens content part arrays, keeping only text parts", () => {
    expect(
      contentToText([
        { type: "text", text: "hi" },
        { type: "image_url", image_url: { url: "https://x" } },
        { type: "text", text: "there" },
      ]),
    ).toBe("hi there");
  });

  it("maps null and non-string content to empty text", () => {
    expect(contentToText(null)).toBe("");
    expect(contentToText(42)).toBe("");
  });

  it("normalizes chat messages as role:text lines", () => {
    expect(
      normalizeChatMessages([
        { role: "system", content: "be brief" },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ]),
    ).toBe("system:be brief\nuser:hi");
  });

  it("normalizes embedding inputs", () => {
    expect(normalizeEmbeddingInput("one")).toBe("one");
    expect(normalizeEmbeddingInput(["a", "b"])).toBe("a\nb");
  });

  it("hashes deterministically", () => {
    const a = promptHashHex("user:hello");
    const b = promptHashHex("user:hello");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(promptHashHex("user:hello!")).not.toBe(a);
  });

  it("estimates tokens at ~4 chars each with a floor of 1", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("ab")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("estimates chat prompt tokens with priming and per-message overhead", () => {
    const n = estimateChatPromptTokens([
      { role: "system", content: "be brief" },
      { role: "user", content: "hello there" },
    ]);
    expect(n).toBe(3 + (4 + 2) + (4 + 3));
  });
});
