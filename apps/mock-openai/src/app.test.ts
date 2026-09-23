import { describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { createApp } from "./app.js";

const CONFIG = { latencyMs: 0, latencyJitterMs: 0, failureRate: 0, seed: 42 };

function chatBody(extra: Record<string, unknown> = {}) {
  return {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "You are a terse assistant." },
      { role: "user", content: "Summarize Q3 spend anomalies." },
    ],
    ...extra,
  };
}

function postChat(
  app: ReturnType<typeof createApp>,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("mock-openai: determinism", () => {
  it("same input twice produces identical usage and content", async () => {
    const app = createApp(CONFIG);
    const [r1, r2] = await Promise.all([
      postChat(app, chatBody()),
      postChat(app, chatBody()),
    ]);
    expect(r1.status).toBe(200);
    const b1 = await r1.json();
    const b2 = await r2.json();
    expect(b1.usage).toEqual(b2.usage);
    expect(b1.choices[0].message.content).toBe(b2.choices[0].message.content);
    expect(b1.id).toBe(b2.id);
    expect(b1.usage.prompt_tokens).toBeGreaterThan(0);
    expect(b1.usage.completion_tokens).toBeGreaterThan(0);
    expect(b1.usage.total_tokens).toBe(
      b1.usage.prompt_tokens + b1.usage.completion_tokens,
    );
  });

  it("different prompts produce different usage", async () => {
    const app = createApp(CONFIG);
    const r1 = await postChat(app, chatBody());
    const r2 = await postChat(
      app,
      chatBody({
        messages: [
          {
            role: "user",
            content:
              "A substantially longer and entirely different prompt, written to change the deterministic token estimate beyond any doubt.",
          },
        ],
      }),
    );
    const b1 = await r1.json();
    const b2 = await r2.json();
    expect(b2.usage.prompt_tokens).not.toBe(b1.usage.prompt_tokens);
  });

  it("response shape mirrors OpenAI chat.completion", async () => {
    const app = createApp(CONFIG);
    const res = await postChat(app, chatBody());
    const body = await res.json();
    expect(body.object).toBe("chat.completion");
    expect(body.id).toMatch(/^chatcmpl-/);
    expect(typeof body.created).toBe("number");
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0].message.role).toBe("assistant");
    expect(["stop", "length"]).toContain(body.choices[0].finish_reason);
  });
});

describe("mock-openai: completion token control", () => {
  it("max_tokens caps completion_tokens and sets finish_reason=length", async () => {
    const app = createApp(CONFIG);
    const res = await postChat(app, chatBody({ max_tokens: 5 }));
    const body = await res.json();
    expect(body.usage.completion_tokens).toBe(5);
    expect(body.choices[0].finish_reason).toBe("length");
  });

  it("X-Mock-Completion-Tokens forces an exact count", async () => {
    const app = createApp(CONFIG);
    const res = await postChat(app, chatBody(), {
      "X-Mock-Completion-Tokens": "7",
    });
    const body = await res.json();
    expect(body.usage.completion_tokens).toBe(7);
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.choices[0].message.content.split(" ")).toHaveLength(7);
  });

  it("max_completion_tokens also caps", async () => {
    const app = createApp(CONFIG);
    const res = await postChat(
      app,
      chatBody({ max_completion_tokens: 3 }),
      { "X-Mock-Completion-Tokens": "20" },
    );
    const body = await res.json();
    expect(body.usage.completion_tokens).toBe(3);
    expect(body.choices[0].finish_reason).toBe("length");
  });
});

describe("mock-openai: latency and failure injection", () => {
  it("X-Mock-Latency-Ms delays the response", async () => {
    const app = createApp(CONFIG);
    const started = Date.now();
    const res = await postChat(app, chatBody(), { "X-Mock-Latency-Ms": "60" });
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
  });

  it("X-Mock-Fail=500 returns an OpenAI error shape", async () => {
    const app = createApp(CONFIG);
    const res = await postChat(app, chatBody(), { "X-Mock-Fail": "500" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.type).toBe("server_error");
    expect(body.error.message).toContain("injected failure");
  });

  it("X-Mock-Fail=429 returns that status", async () => {
    const app = createApp(CONFIG);
    const res = await postChat(app, chatBody(), { "X-Mock-Fail": "429" });
    expect(res.status).toBe(429);
  });

  it("X-Mock-Fail=invalid-json returns unparseable JSON with 200", async () => {
    const app = createApp(CONFIG);
    const res = await postChat(app, chatBody(), {
      "X-Mock-Fail": "invalid-json",
    });
    expect(res.status).toBe(200);
    await expect(res.json()).rejects.toThrow();
  });

  it("failureRate=1 fails every request", async () => {
    const app = createApp({ ...CONFIG, failureRate: 1 });
    const res = await postChat(app, chatBody());
    expect(res.status).toBe(500);
  });

  it("X-Mock-Fail=timeout holds the connection until the client aborts", async () => {
    const app = createApp(CONFIG);
    const server: ServerType = serve({ fetch: app.fetch, port: 0 });
    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("server did not bind a port");
      }
      await expect(
        fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Mock-Fail": "timeout",
          },
          body: JSON.stringify(chatBody()),
          signal: AbortSignal.timeout(200),
        }),
      ).rejects.toThrow();
    } finally {
      server.close();
    }
  });
});

describe("mock-openai: response_format / schema failure simulation", () => {
  const schema = {
    type: "object",
    properties: {
      answer: { type: "string" },
      confidence: { type: "number" },
    },
    required: ["answer", "confidence"],
  };
  const body = () =>
    chatBody({
      response_format: {
        type: "json_schema",
        json_schema: { name: "answer", schema, strict: true },
      },
    });

  it("returns schema-conforming JSON by default", async () => {
    const app = createApp(CONFIG);
    const res = await postChat(app, body());
    expect(res.status).toBe(200);
    const parsed = await res.json();
    const content = JSON.parse(parsed.choices[0].message.content);
    expect(typeof content.answer).toBe("string");
    expect(typeof content.confidence).toBe("number");
  });

  it("X-Mock-Invalid-Schema-Response returns JSON that fails the schema", async () => {
    const app = createApp(CONFIG);
    const res = await postChat(app, body(), {
      "X-Mock-Invalid-Schema-Response": "1",
    });
    expect(res.status).toBe(200);
    const parsed = await res.json();
    const content = JSON.parse(parsed.choices[0].message.content);
    // Declared type is object; the mock returns a number instead.
    expect(typeof content).not.toBe("object");
  });

  it("json_object mode returns parseable JSON", async () => {
    const app = createApp(CONFIG);
    const res = await postChat(
      app,
      chatBody({ response_format: { type: "json_object" } }),
    );
    const parsed = await res.json();
    expect(() => JSON.parse(parsed.choices[0].message.content)).not.toThrow();
  });
});

describe("mock-openai: streaming", () => {
  async function readSse(res: Response) {
    const text = await res.text();
    const frames = text
      .split("\n\n")
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
    const done = frames.at(-1);
    const events = frames
      .filter((f) => f !== "data: [DONE]")
      .map((f) => JSON.parse(f.replace(/^data: /, "")));
    return { events, done };
  }

  it("streams OpenAI-shaped chunks ending in [DONE]", async () => {
    const app = createApp(CONFIG);
    const res = await postChat(app, chatBody({ stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const { events, done } = await readSse(res);
    expect(done).toBe("data: [DONE]");
    expect(events[0].object).toBe("chat.completion.chunk");
    expect(events[0].choices[0].delta.role).toBe("assistant");
    const finish = events.at(-1);
    expect(finish.choices[0].finish_reason).toBe("stop");
    // No usage chunk unless requested.
    expect(events.every((e) => e.usage === undefined)).toBe(true);
    // Content deltas reassemble into the full deterministic text.
    const text = events
      .slice(1, -1)
      .map((e) => e.choices[0].delta.content ?? "")
      .join("");
    expect(text.length).toBeGreaterThan(0);
  });

  it("honors stream_options.include_usage with a final usage chunk", async () => {
    const app = createApp(CONFIG);
    const res = await postChat(
      app,
      chatBody({
        stream: true,
        stream_options: { include_usage: true },
      }),
      { "X-Mock-Completion-Tokens": "9" },
    );
    const { events } = await readSse(res);
    const usageEvent = events.at(-1);
    expect(usageEvent.choices).toEqual([]);
    expect(usageEvent.usage.completion_tokens).toBe(9);
    expect(usageEvent.usage.total_tokens).toBe(
      usageEvent.usage.prompt_tokens + usageEvent.usage.completion_tokens,
    );
  });

  it("streamed usage matches the non-streamed usage for the same input", async () => {
    const app = createApp(CONFIG);
    const streamed = await postChat(
      app,
      chatBody({ stream: true, stream_options: { include_usage: true } }),
    );
    const { events } = await readSse(streamed);
    const plain = await postChat(app, chatBody());
    const plainBody = await plain.json();
    expect(events.at(-1).usage).toEqual(plainBody.usage);
  });
});

describe("mock-openai: embeddings", () => {
  it("same input twice produces identical vectors", async () => {
    const app = createApp(CONFIG);
    const body = { model: "text-embedding-3-small", input: "hello vyaya" };
    const [r1, r2] = await Promise.all([
      app.request("/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      app.request("/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ]);
    const b1 = await r1.json();
    const b2 = await r2.json();
    expect(b1.data[0].embedding).toEqual(b2.data[0].embedding);
    expect(b1.data[0].embedding).toHaveLength(1536);
    expect(b1.usage.prompt_tokens).toBeGreaterThan(0);
  });

  it("batch input returns one vector per input and honors dimensions", async () => {
    const app = createApp(CONFIG);
    const res = await app.request("/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: ["a", "b", "c"], dimensions: 8 }),
    });
    const body = await res.json();
    expect(body.data).toHaveLength(3);
    expect(body.data[0].embedding).toHaveLength(8);
    expect(body.data.map((d: { index: number }) => d.index)).toEqual([0, 1, 2]);
    expect(body.data[0].embedding).not.toEqual(body.data[1].embedding);
  });
});

describe("mock-openai: validation and health", () => {
  it("rejects a request without messages", async () => {
    const app = createApp(CONFIG);
    const res = await postChat(app, { model: "gpt-4o-mini" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("rejects non-JSON bodies", async () => {
    const app = createApp(CONFIG);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("GET /healthz reports ok", async () => {
    const app = createApp(CONFIG);
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});
