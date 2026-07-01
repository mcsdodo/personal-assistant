// Side-effect bootstrap: initialize OpenTelemetry BEFORE any metric instrument
// is constructed. Worker-side counters (metrics.ts, invoice/intake-worker.ts)
// are created at module-load via `meter.createCounter(...)`. OTel JS's
// ProxyMeter does NOT upgrade instruments created before
// `metrics.setGlobalMeterProvider(...)` runs, so any counter constructed before
// initTracing() silently exports nothing (traces are unaffected — spans are
// created at call time, so the ProxyTracer upgrades correctly).
//
// Importing this module FIRST in the worker entrypoint guarantees initTracing()
// runs (registering the real MeterProvider) before the counter-defining modules
// are evaluated. Without this, invoice_worker_* / personal_assistant_guidance_*
// metrics never reach Prometheus (regression latent since the task-64 worker
// split — every worker counter was created at import time, before init).
//
// initTracing is idempotent (guarded by an `initialized` flag), so worker.ts's
// own initTracing("worker") call becomes a harmless no-op second invocation.
import { initTracing } from "./tracing";

initTracing("worker");
