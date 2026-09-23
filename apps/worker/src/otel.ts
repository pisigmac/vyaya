import type { Logger } from "pino";

/**
 * OTel spans into KubeMind sentinel (SENTINEL_ENABLED + SENTINEL_OTEL_URL).
 *
 * Same pattern as apps/proxy/src/otel.ts: graceful no-op when disabled or
 * when the SDK fails to initialize. Dynamic imports keep the flag-off path
 * free of any OTel initialization; init errors degrade to the no-op tracer
 * with a warn line. Jobs are never affected by tracing.
 */

export type SpanAttributes = Record<string, string | number | boolean>;

export interface WorkerSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  end(): void;
}

export interface WorkerTracer {
  startSpan(name: string, attributes: SpanAttributes): WorkerSpan;
  shutdown(): Promise<void>;
}

const NOOP_SPAN: WorkerSpan = {
  setAttribute: () => {},
  end: () => {},
};

export function createNoopTracer(): WorkerTracer {
  return {
    startSpan: () => NOOP_SPAN,
    shutdown: () => Promise.resolve(),
  };
}

export interface OtelOptions {
  enabled: boolean;
  otelUrl: string | undefined;
  serviceName?: string;
  logger: Logger;
}

export async function createTracer(options: OtelOptions): Promise<WorkerTracer> {
  if (!options.enabled || options.otelUrl === undefined) {
    return createNoopTracer();
  }
  try {
    const [
      { NodeTracerProvider, BatchSpanProcessor },
      { resourceFromAttributes },
      { ATTR_SERVICE_NAME },
      { OTLPTraceExporter },
    ] = await Promise.all([
      import("@opentelemetry/sdk-trace-node"),
      import("@opentelemetry/resources"),
      import("@opentelemetry/semantic-conventions"),
      import("@opentelemetry/exporter-trace-otlp-http"),
    ]);
    const exporter = new OTLPTraceExporter({
      url: `${options.otelUrl.replace(/\/+$/, "")}/v1/traces`,
      timeoutMillis: 1_000,
    });
    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: options.serviceName ?? "vyaya-worker",
      }),
      spanProcessors: [new BatchSpanProcessor(exporter)],
    });
    provider.register();
    const tracer = provider.getTracer("vyaya-worker");
    return {
      startSpan(name, attributes) {
        const span = tracer.startSpan(name, { attributes });
        return {
          setAttribute: (key, value) => span.setAttribute(key, value),
          end: () => span.end(),
        };
      },
      shutdown: () =>
        provider
          .shutdown()
          .catch(() => {})
          .then(() => undefined),
    };
  } catch (err) {
    options.logger.warn({ err }, "sentinel/OTel init failed; tracing disabled");
    return createNoopTracer();
  }
}
