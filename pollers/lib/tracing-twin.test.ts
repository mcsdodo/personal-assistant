import { expect, test } from "bun:test";

// tracing.ts is the one remaining twin: it cannot live in shared/ because it
// imports @opentelemetry/* and shared/ is dependency-free by design (see
// shared/workflow-schemas.ts header). This test locks the twin: any edit to
// claude-code/channels/tracing.ts must be mirrored here verbatim.
const HEADER = "// keep in sync with claude-code/channels/tracing.ts — guarded by tracing-twin.test.ts\n";

test("pollers/lib/tracing.ts is byte-identical to the channels source (+ header)", async () => {
  const pollers = await Bun.file(new URL("./tracing.ts", import.meta.url)).text();
  const channels = await Bun.file(
    new URL("../../claude-code/channels/tracing.ts", import.meta.url),
  ).text();
  expect(pollers).toBe(HEADER + channels);
});
