/**
 * Bun test preload: mock @opentelemetry/* packages that are only installed
 * inside the Docker container. This allows invoice-worker tests to run locally.
 */
import { mock } from "bun:test";

// Set env vars required by production code but not needed in tests.
// PAPERLESS_URL: invoice-worker.ts and workflow-mcp.ts throw if missing;
// tests mock all HTTP calls so the actual value is irrelevant.
process.env.PAPERLESS_URL ??= "http://paperless-mock";

const noopSpan = {
  setAttribute: () => {},
  setStatus: () => {},
  recordException: () => {},
  addEvent: () => {},
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

const noopCounter = { add: () => {} };
const noopMeter = {
  createCounter: () => noopCounter,
  createHistogram: () => ({ record: () => {} }),
  createUpDownCounter: () => noopCounter,
  createObservableGauge: () => ({ addCallback: () => {} }),
};

mock.module("@opentelemetry/api", () => ({
  trace: {
    getTracer: () => noopTracer,
    getActiveSpan: () => undefined,
    setSpanContext: (_ctx: any) => ({}),
  },
  metrics: {
    getMeter: () => noopMeter,
    setGlobalMeterProvider: () => {},
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
mock.module("@opentelemetry/sdk-metrics", () => ({
  MeterProvider: class { shutdown() { return Promise.resolve(); } },
  PeriodicExportingMetricReader: class {},
}));
mock.module("@opentelemetry/exporter-metrics-otlp-http", () => ({
  OTLPMetricExporter: class {},
}));

// MCP SDK mocks — prevent real network connections during tests.
// Client.callTool delegates to globalThis hooks so integration tests
// can control behavior dynamically.
mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    _name = "";
    constructor(opts?: any) { this._name = opts?.name ?? ""; }
    connect() { return Promise.resolve(); }
    callTool(args: any) {
      const g = globalThis as any;
      if (this._name.includes("gmail") && typeof g.__ewIntegGmailCallTool === "function")
        return g.__ewIntegGmailCallTool(args);
      if (this._name.includes("outlook") && typeof g.__ewIntegOutlookCallTool === "function")
        return g.__ewIntegOutlookCallTool(args);
      if (typeof g.__gdriveCallTool === "function")
        return g.__gdriveCallTool(args);
      return Promise.resolve({ content: [] });
    }
  },
}));
mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class { constructor() {} },
}));
mock.module("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: class {
    setRequestHandler() {}
    connect() { return Promise.resolve(); }
    async notification() {}
  },
}));
mock.module("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {},
}));
mock.module("@modelcontextprotocol/sdk/types.js", () => ({
  ListToolsRequestSchema: Symbol("ListToolsRequestSchema"),
  CallToolRequestSchema: Symbol("CallToolRequestSchema"),
}));
