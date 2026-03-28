/**
 * Shared OpenTelemetry tracing module for personal-assistant channels.
 *
 * Usage:
 *   import { initTracing, getTracer, withSpan, createLogger } from "./tracing";
 *   initTracing("email-watcher");
 *   const tracer = getTracer("email-watcher");
 */

import { trace, context, SpanStatusCode, propagation } from "@opentelemetry/api";
import type { Span, Tracer, SpanOptions } from "@opentelemetry/api";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

let initialized = false;
let provider: BasicTracerProvider | null = null;

/**
 * Initialize OTel tracing. Call once per process at startup.
 * Safe to call multiple times (no-op after first call).
 */
export function initTracing(component: string): void {
  if (initialized) return;
  initialized = true;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    // No endpoint configured — tracing disabled, all operations become no-ops
    return;
  }

  // Use HTTP endpoint (port 4318) for Bun compatibility
  // If endpoint is gRPC port (4317), adjust to HTTP port (4318)
  let httpEndpoint = endpoint;
  if (httpEndpoint.endsWith(":4317")) {
    httpEndpoint = httpEndpoint.replace(/:4317$/, ":4318");
  }
  // Append /v1/traces if not already a full URL path
  const tracesUrl = httpEndpoint.includes("/v1/traces")
    ? httpEndpoint
    : `${httpEndpoint}/v1/traces`;

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: "personal-assistant",
    [ATTR_SERVICE_VERSION]: "0.2.0",
    "service.component": component,
  });

  const exporter = new OTLPTraceExporter({ url: tracesUrl });

  provider = new BasicTracerProvider({
    resource,
    spanProcessors: [
      new BatchSpanProcessor(exporter, {
        maxQueueSize: 100,
        maxExportBatchSize: 50,
        scheduledDelayMillis: 5000,
      }),
    ],
  });
  provider.register({
    contextManager: new AsyncLocalStorageContextManager(),
  });

  // Graceful shutdown
  const shutdown = async () => {
    await provider?.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

/**
 * Get a named tracer.
 */
export function getTracer(name: string): Tracer {
  return trace.getTracer(name, "0.2.0");
}

/**
 * Wrap an async function in an OTel span.
 * Automatically sets span status to ERROR on exception.
 */
export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  attributes: Record<string, string | number | boolean | undefined>,
  fn: (span: Span) => Promise<T>,
  options?: SpanOptions,
): Promise<T> {
  // Filter out undefined attributes
  const cleanAttrs: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attributes)) {
    if (v !== undefined) cleanAttrs[k] = v;
  }

  return tracer.startActiveSpan(name, { attributes: cleanAttrs, ...options }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Inject W3C traceparent header into an outgoing headers object.
 * Use this before fetch() calls to propagate trace context.
 */
export function injectTraceHeaders(headers: Record<string, string>): Record<string, string> {
  propagation.inject(context.active(), headers);
  return headers;
}

/**
 * Create a logger function that includes trace_id when a span is active.
 * Format: [channel] message (trace_id=abc123)
 */
export function createLogger(channel: string): (msg: string) => void {
  return (msg: string) => {
    const span = trace.getActiveSpan();
    if (span) {
      const ctx = span.spanContext();
      console.error(`[${channel}] ${msg} (trace_id=${ctx.traceId} span_id=${ctx.spanId})`);
    } else {
      console.error(`[${channel}] ${msg}`);
    }
  };
}

// Re-export commonly used OTel types
export { SpanStatusCode, context, trace, propagation } from "@opentelemetry/api";
export type { Span, Tracer } from "@opentelemetry/api";
