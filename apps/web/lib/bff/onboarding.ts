import { execFile } from "node:child_process";
import { HttpError } from "../errors";

/**
 * Onboarding helpers: a real test request through the proxy, and the
 * DEV ONLY "run the classifier now" trigger.
 */

export interface TestRequestResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  model: string;
}

/**
 * Fire one real chat completion through the proxy with the workspace's own
 * key. The proxy forwards to the configured upstream (mock-openai in dev)
 * and logs the request, which is exactly what the classifier consumes.
 */
export async function sendTestRequest(options: {
  proxyBaseUrl: string;
  apiKey: string;
  fetchFn?: typeof fetch;
}): Promise<TestRequestResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const started = Date.now();
  let res: Response;
  try {
    res = await fetchFn(
      `${options.proxyBaseUrl.replace(/\/$/, "")}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-vyaya-key": options.apiKey,
          "x-vyaya-tag": "onboarding",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "user",
              content: "Reply with the single word: hello.",
            },
          ],
          max_tokens: 16,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch (err) {
    throw new HttpError(
      502,
      `could not reach the proxy at ${options.proxyBaseUrl} — is it running? (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }
  await res.arrayBuffer().catch(() => new ArrayBuffer(0));
  return {
    ok: res.ok,
    status: res.status,
    latencyMs: Date.now() - started,
    model: "gpt-4o-mini",
  };
}

export interface ClassifyRunResult {
  ran: boolean;
  /** Human-readable outcome or the manual command to run instead. */
  detail: string;
}

/**
 * DEV ONLY convenience: spawn the worker's one-shot classifier
 * (`--job classify --once`) so the "first waste found" moment can happen
 * immediately after the test request. Production deployments run the worker
 * as its own service on a schedule; this endpoint then returns 403 and the
 * UI hides the button.
 *
 * Safer manual alternative (always available):
 *   pnpm --filter @vyaya/worker start -- --job classify --once
 */
export async function runClassifierNow(options: {
  workerCliPath?: string | undefined;
}): Promise<ClassifyRunResult> {
  if (!options.workerCliPath) {
    throw new HttpError(
      503,
      "WORKER_CLI_PATH is not set. Run it yourself: pnpm --filter @vyaya/worker start -- --job classify --once",
    );
  }
  return new Promise((resolvePromise, rejectPromise) => {
    // The child inherits this process's environment (DATABASE_URL and the
    // worker's job settings all arrive via env, validated by @vyaya/config).
    execFile(
      process.execPath,
      [options.workerCliPath!, "--job", "classify", "--once"],
      { timeout: 120_000 },
      (error: Error | null, _stdout: string, stderr: string) => {
        if (error) {
          rejectPromise(
            new HttpError(
              502,
              `classifier run failed: ${stderr.trim() || error.message}`,
            ),
          );
          return;
        }
        resolvePromise({
          ran: true,
          detail: "Classifier finished. New waste events appear below.",
        });
      },
    );
  });
}
