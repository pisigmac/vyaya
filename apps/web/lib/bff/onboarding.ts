import { spawn } from "node:child_process";

/**
 * Onboarding helpers: the "send a test request" button and the dev-only
 * "run the classifier now" button.
 */

export interface TestRequestResult {
  ok: boolean;
  status: number;
  latencyMs: number;
}

/** Send one real chat completion through the proxy with the pasted key. */
export async function sendTestRequest(options: {
  proxyBaseUrl: string;
  apiKey: string;
  fetchFn?: typeof fetch;
}): Promise<TestRequestResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const started = performance.now();
  const res = await fetchFn(`${options.proxyBaseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-vyaya-key": options.apiKey,
      "x-vyaya-tag": "onboarding",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Say hello to Vyaya." }],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const latencyMs = Math.round(performance.now() - started);
  // Drain the body so the proxy's tap completes and the request is logged.
  await res.text().catch(() => "");
  return { ok: res.status === 200, status: res.status, latencyMs };
}

export interface ClassifierRunResult {
  wasteEvents: number;
  requestsScanned: number;
  durationMs: number;
}

/**
 * DEV ONLY: run the worker classifier immediately
 * (`node dist/index.js --job classify --once`). The web process spawns the
 * worker CLI as a subprocess so the dev loop needs no separate terminal.
 */
export async function runClassifierNow(options: {
  workerCliPath: string | undefined;
  spawnFn?: typeof spawn;
}): Promise<ClassifierRunResult> {
  if (options.workerCliPath === undefined || options.workerCliPath === "") {
    throw new Error("WORKER_CLI_PATH is not configured");
  }
  const spawnFn = options.spawnFn ?? spawn;
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawnFn(
      process.execPath,
      [options.workerCliPath!, "--job", "classify", "--once"],
      { env: process.env },
    );
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`classifier exited ${code}: ${err.slice(0, 500)}`));
    });
  });
  // The worker prints a JSON summary line on --once runs.
  const summaryLine = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .find((obj) => obj !== null && "wasteEvents" in obj);
  return {
    wasteEvents: Number(summaryLine?.["wasteEvents"] ?? 0),
    requestsScanned: Number(summaryLine?.["requestsScanned"] ?? 0),
    durationMs: Number(summaryLine?.["durationMs"] ?? 0),
  };
}
