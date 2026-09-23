import type { Logger } from "pino";

/**
 * OTel spans into KubeMind sentinel (SENTINEL_ENABLED + SENTINEL_OTEL_URL).
 *
 * Graceful no-op when disabled or when the SDK fails to initialize: the
 * dynamic imports below keep the flag-off path free of any OTel
 * initialization, and init errors degrade to the no-op tracer with a warn
 * line. Proxy requests are never affected by tracing.
 */

export type SpanAttributes = Record<string, string | number | boolean>;

export interface ProxySpan {
  setAttribute(key: string, value: string | number | boolean): void;
  end(): void;
}

export interface ProxyTracer {
  startSpan(name: string, attributes: SpanAttributes): ProxySpan;
  shutdown(): Promise<void>;
}

const NOOP_SPAN: ProxySpan = {
  setAttribute: () => {},
  end: () => {},
};

export function createNoopTracer(): ProxyTracer {
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

export async function createTracer(options: OtelOptions): Promise<ProxyTracer> {
  if (!options.enabled || options.otelUrl === undefined) {
    return createNoopTracer();
  }
  try {
    const [{ NodeTracerProvider, BatchSpanProcessor }, { resourceFromAttributes }, { ATTR_SERVICE_NAME }, { OTLPTraceExporter }] =
      await Promise.all([
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
        [ATTR_SERVICE_NAME]: options.serviceName ?? "vyaya-proxy",
      }),
      spanProcessors: [new BatchSpanProcessor(exporter)],
    });
    provider.register();
    const tracer = provider.getTracer("vyaya-proxy");
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
