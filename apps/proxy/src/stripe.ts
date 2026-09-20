import type { Logger } from "pino";

/**
 * Stripe meter events (STRIPE_ENABLED, test-mode plumbing only in v1).
 *
 * Recording is fire-and-forget behind an interface; the proxy never blocks
 * or fails a request because of billing. Two side effects per record:
 *   1. an outbox row in stripe_meter_events (the worker reconciles/flushes;
 *      idempotency_key = request id makes replays safe)
 *   2. a best-effort direct meter-event call through StripeApi (stubbed in
 *      tests via injected fetch)
 */

export interface StripeMeterEvent {
  eventName: string;
  payload: Record<string, string>;
  /** Unix seconds. */
  timestamp: number;
}

/** The Stripe API boundary. Stubbed when disabled or unconfigured. */
export interface StripeApi {
  createMeterEvent(event: StripeMeterEvent): Promise<{ id: string }>;
}

export class StubStripeApi implements StripeApi {
  readonly calls: StripeMeterEvent[] = [];

  createMeterEvent(event: StripeMeterEvent): Promise<{ id: string }> {
    this.calls.push(event);
    return Promise.resolve({ id: "stub" });
  }
}

export interface HttpStripeApiOptions {
  secretKey: string;
  fetchFn?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

/** Thin v2 billing meter-events client (test-mode keys; no live checkout). */
export class HttpStripeApi implements StripeApi {
  readonly #secretKey: string;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(options: HttpStripeApiOptions) {
    this.#secretKey = options.secretKey;
    this.#fetch = options.fetchFn ?? fetch;
    this.#baseUrl = options.baseUrl ?? "https://api.stripe.com";
    this.#timeoutMs = options.timeoutMs ?? 2_000;
  }

  async createMeterEvent(event: StripeMeterEvent): Promise<{ id: string }> {
    const body = new URLSearchParams();
    body.set("event_name", event.eventName);
    body.set("timestamp", String(event.timestamp));
    for (const [k, v] of Object.entries(event.payload)) {
      body.set(`payload[${k}]`, v);
    }
    const res = await this.#fetch(`${this.#baseUrl}/v2/billing/meter_events`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`stripe meter event failed: HTTP ${res.status}`);
    }
    const json = (await res.json()) as { id?: string };
    return { id: json.id ?? "unknown" };
  }
}

export interface UsageRecord {
  workspaceId: string;
  requestId: string;
  totalTokens: number;
  atMs: number;
}

/** Fire-and-forget usage recording boundary. */
export interface UsageRecorder {
  record(usage: UsageRecord): void;
}

export class NoopUsageRecorder implements UsageRecorder {
  record(): void {
    // STRIPE_ENABLED=false — metering is off.
  }
}

/** Inserts one outbox row; fire-and-forget. */
export type OutboxInsertFn = (row: {
  workspaceId: string;
  requestId: string;
  eventName: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}) => Promise<void>;

export interface StripeUsageRecorderOptions {
  api: StripeApi;
  eventName: string;
  insertOutbox: OutboxInsertFn | null;
  logger: Logger;
}

export class StripeUsageRecorder implements UsageRecorder {
  readonly #api: StripeApi;
  readonly #eventName: string;
  readonly #insertOutbox: OutboxInsertFn | null;
  readonly #logger: Logger;
  #recorded = 0;
  #failures = 0;

  constructor(options: StripeUsageRecorderOptions) {
    this.#api = options.api;
    this.#eventName = options.eventName;
    this.#insertOutbox = options.insertOutbox;
    this.#logger = options.logger;
  }

  record(usage: UsageRecord): void {
    if (usage.totalTokens <= 0) return;
    const event: StripeMeterEvent = {
      eventName: this.#eventName,
      payload: {
        request_id: usage.requestId,
        workspace_id: usage.workspaceId,
        tokens: String(usage.totalTokens),
      },
      timestamp: Math.floor(usage.atMs / 1000),
    };
    this.#recorded += 1;
    const jobs: Promise<unknown>[] = [this.#api.createMeterEvent(event)];
    if (this.#insertOutbox !== null) {
      jobs.push(
        this.#insertOutbox({
          workspaceId: usage.workspaceId,
          requestId: usage.requestId,
          eventName: this.#eventName,
          idempotencyKey: usage.requestId,
          payload: { ...event.payload, timestamp: event.timestamp },
        }),
      );
    }
    Promise.allSettled(jobs).then((results) => {
      for (const r of results) {
        if (r.status === "rejected") {
          this.#failures += 1;
          this.#logger.warn(
            { requestId: usage.requestId },
            "stripe usage record failed (fire-and-forget)",
          );
        }
      }
    });
  }

  metrics(): { recorded: number; failures: number } {
    return { recorded: this.#recorded, failures: this.#failures };
  }
}
