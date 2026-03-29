/**
 * Bun test preload: mock @opentelemetry/* packages that are only installed
 * inside the Docker container. This allows invoice-worker tests to run locally.
 */
import { mock } from "bun:test";

const noopSpan = {
  setAttribute: () => {},
  setStatus: () => {},
  recordException: () => {},
  end: () => {},
  spanContext: () => ({ traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 }),
  isRecording: () => false,
};
const noopTracer = {
  startActiveSpan: (_name: string, _opts: any, fn: any) => {
    const callback = typeof _opts === "function" ? _opts : fn;
    return callback(noopSpan);
  },
  startSpan: () => noopSpan,
};

mock.module("@opentelemetry/api", () => ({
  trace: {
    getTracer: () => noopTracer,
    getActiveSpan: () => undefined,
    setSpanContext: (_ctx: any) => ({}),
  },
  context: { active: () => ({}) },
  propagation: { inject: () => {} },
  SpanStatusCode: { OK: 0, ERROR: 2, UNSET: 1 },
  TraceFlags: { SAMPLED: 1 },
}));
mock.module("@opentelemetry/sdk-trace-base", () => ({
  BasicTracerProvider: class { register() {} shutdown() { return Promise.resolve(); } },
  BatchSpanProcessor: class {},
}));
mock.module("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: class {},
}));
mock.module("@opentelemetry/resources", () => ({
  Resource: class { constructor() {} },
}));
mock.module("@opentelemetry/semantic-conventions", () => ({
  ATTR_SERVICE_NAME: "service.name",
  ATTR_SERVICE_VERSION: "service.version",
}));
mock.module("@opentelemetry/context-async-hooks", () => ({
  AsyncLocalStorageContextManager: class {},
}));
