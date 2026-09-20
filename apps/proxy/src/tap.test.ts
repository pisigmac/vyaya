import { describe, expect, it } from "vitest";
import {
  extractFromBufferedJson,
  extractFromSse,
  iterSseDataPayloads,
  sha256Hex,
  tapStream,
} from "./tap.js";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const res = new Response(stream);
  return res.text();
}

describe("tapStream", () => {
  it("passes bytes through untouched while accumulating", async () => {
    const source = streamOf(['{"hel', 'lo":', '"wor', 'ld"}']);
    const tap = tapStream(source);
    const text = await readAll(tap.stream);
    expect(text).toBe('{"hello":"world"}');
    const outcome = await tap.done;
    expect(outcome.completed).toBe(true);
    expect(outcome.bodyText).toBe('{"hello":"world"}');
    expect(outcome.bytes).toBe(17);
    expect(outcome.truncated).toBe(false);
  });

  it("caps accumulation but still forwards everything", async () => {
    const big = "x".repeat(10_000);
    const tap = tapStream(streamOf([big, big]), 8_000);
    const text = await readAll(tap.stream);
    expect(text).toBe(big + big); // client got every byte
    const outcome = await tap.done;
    expect(outcome.truncated).toBe(true);
    expect(outcome.bytes).toBe(20_000);
  });

  it("reports cancellation as incomplete", async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk1"));
        // Never closes: client goes away mid-stream.
      },
      cancel() {
        cancelled = true;
      },
    });
    const tap = tapStream(source);
    const reader = tap.stream.getReader();
    await reader.read();
    await reader.cancel("client gone");
    const outcome = await tap.done;
    expect(outcome.completed).toBe(false);
    expect(outcome.bodyText).toContain("chunk1");
    expect(cancelled).toBe(true); // propagated upstream
  });
});

describe("iterSseDataPayloads", () => {
  it("yields data payloads across events", () => {
    const text = 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n';
    expect([...iterSseDataPayloads(text)]).toEqual(['{"a":1}', '{"b":2}', "[DONE]"]);
  });
});

describe("extractFromSse", () => {
  it("collects usage and content from chunks", () => {
    const text =
      'data: {"id":"c1","model":"gpt-4o-mini","choices":[{"delta":{"role":"assistant"}}]}\n\n' +
      'data: {"id":"c1","choices":[{"delta":{"content":"hello "}}]}\n\n' +
      'data: {"id":"c1","choices":[{"delta":{"content":"world"}}]}\n\n' +
      'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":2}}\n\n' +
      "data: [DONE]\n\n";
    const extracted = extractFromSse(text);
    expect(extracted.usage).toEqual({ promptTokens: 11, completionTokens: 2 });
    expect(extracted.contentText).toBe("hello world");
    expect(extracted.model).toBe("gpt-4o-mini");
  });

  it("handles a stream without usage chunk", () => {
    const text = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
    const extracted = extractFromSse(text);
    expect(extracted.usage).toBeNull();
    expect(extracted.contentText).toBe("hi");
  });

  it("skips malformed data payloads", () => {
    const text = "data: {oops}\n\ndata: {}\n\n";
    const extracted = extractFromSse(text);
    expect(extracted.usage).toBeNull();
    expect(extracted.contentText).toBeNull();
  });
});

describe("extractFromBufferedJson", () => {
  it("extracts chat usage, content, and model", () => {
    const body = JSON.stringify({
      model: "gpt-4o",
      choices: [{ message: { role: "assistant", content: "done" } }],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
    });
    expect(extractFromBufferedJson(body)).toEqual({
      usage: { promptTokens: 5, completionTokens: 7 },
      contentText: "done",
      model: "gpt-4o",
    });
  });

  it("extracts embeddings usage (no completion tokens)", () => {
    const body = JSON.stringify({
      model: "text-embedding-3-small",
      data: [],
      usage: { prompt_tokens: 9, total_tokens: 9 },
    });
    expect(extractFromBufferedJson(body).usage).toEqual({
      promptTokens: 9,
      completionTokens: 0,
    });
  });

  it("returns nulls for error bodies and invalid JSON", () => {
    expect(extractFromBufferedJson("{not json")).toEqual({
      usage: null,
      contentText: null,
      model: null,
    });
    expect(extractFromBufferedJson('{"error":{"message":"x"}}').usage).toBeNull();
  });
});

describe("sha256Hex", () => {
  it("hashes utf8 text", () => {
    expect(sha256Hex("abc")).toMatch(/^[0-9a-f]{64}$/);
  });
});
