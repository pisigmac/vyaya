import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chatRequestBody,
  eventually,
  FakeTagStore,
  postToProxy,
  startMockUpstream,
  startTestProxy,
  type RunningServer,
  type TestProxy,
} from "./test-utils.js";

/** schema_validation_result is recorded server-side after passthrough. */

const QA_SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};

function withJsonSchema(extra: Record<string, unknown> = {}) {
  return chatRequestBody({
    response_format: {
      type: "json_schema",
      json_schema: { name: "qa", schema: QA_SCHEMA, strict: true },
    },
    ...extra,
  });
}

describe("schema validation recording", () => {
  let upstream: RunningServer;
  let proxy: TestProxy;

  beforeEach(async () => {
    upstream = await startMockUpstream();
    proxy = await startTestProxy({ upstream });
  });

  afterEach(async () => {
    await proxy.close();
    await upstream.close();
  });

  it("conforming response -> schema_validation 'passed'", async () => {
    const res = await postToProxy(proxy, "/v1/chat/completions", withJsonSchema());
    expect(res.status).toBe(200);
    await res.text();
    await eventually(() => proxy.sink.logs.length === 1);
    expect(proxy.sink.logs[0]!.schemaValidation).toBe("passed");
  });

  it("invalid-schema-response injection -> 'failed' recorded, request still 200", async () => {
    const res = await postToProxy(proxy, "/v1/chat/completions", withJsonSchema(), {
      "x-mock-invalid-schema-response": "1",
    });
    expect(res.status).toBe(200);
    await res.text();
    await eventually(() => proxy.sink.logs.length === 1);
    expect(proxy.sink.logs[0]!.schemaValidation).toBe("failed");
  });

  it("json_object with invalid JSON content -> 'failed'", async () => {
    const res = await postToProxy(
      proxy,
      "/v1/chat/completions",
      chatRequestBody({ response_format: { type: "json_object" } }),
      { "x-mock-invalid-schema-response": "1" },
    );
    expect(res.status).toBe(200);
    await res.text();
    await eventually(() => proxy.sink.logs.length === 1);
    expect(proxy.sink.logs[0]!.schemaValidation).toBe("failed");
  });

  it("streaming response_format is validated from accumulated deltas", async () => {
    const res = await postToProxy(
      proxy,
      "/v1/chat/completions",
      withJsonSchema({ stream: true }),
      { "x-mock-invalid-schema-response": "1" },
    );
    expect(res.status).toBe(200);
    await res.text();
    await eventually(() => proxy.sink.logs.length === 1);
    expect(proxy.sink.logs[0]!.schemaValidation).toBe("failed");
  });
});

describe("feature tag allowlist (HTTP)", () => {
  let upstream: RunningServer;
  let proxy: TestProxy;
  let tagStore: FakeTagStore;

  beforeEach(async () => {
    upstream = await startMockUpstream();
    tagStore = new FakeTagStore();
    tagStore.tags = ["chat", "billing"];
    proxy = await startTestProxy({ upstream, tagStore });
  });

  afterEach(async () => {
    await proxy.close();
    await upstream.close();
  });

  it("allowlisted tag is logged", async () => {
    const res = await postToProxy(proxy, "/v1/chat/completions", chatRequestBody(), {
      "x-vyaya-tag": "chat",
    });
    expect(res.status).toBe(200);
    await res.text();
    await eventually(() => proxy.sink.logs.length === 1);
    expect(proxy.sink.logs[0]!.featureTag).toBe("chat");
  });

  it("rejected tag -> request still succeeds, logged with null tag", async () => {
    const res = await postToProxy(proxy, "/v1/chat/completions", chatRequestBody(), {
      "x-vyaya-tag": "not-allowed",
    });
    expect(res.status).toBe(200);
    await res.text();
    await eventually(() => proxy.sink.logs.length === 1);
    expect(proxy.sink.logs[0]!.featureTag).toBeNull();
  });

  it("tag store failure -> null tag, request still succeeds", async () => {
    tagStore.failNext = true;
    const res = await postToProxy(proxy, "/v1/chat/completions", chatRequestBody(), {
      "x-vyaya-tag": "chat",
    });
    expect(res.status).toBe(200);
    await res.text();
    await eventually(() => proxy.sink.logs.length === 1);
    expect(proxy.sink.logs[0]!.featureTag).toBeNull();
  });
});
