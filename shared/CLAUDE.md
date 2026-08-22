# `shared/`

**Single source of truth** for code that both `claude-code/channels/` and `pollers/lib/`
need: [workflow-schemas.ts](workflow-schemas.ts), [owner-config.ts](owner-config.ts), and
[workflow/{schema,events,downloads,jobs}.ts](workflow/). The old channel-side and
poller-side paths are now one- or two-line barrels re-exporting from here.

## Dependency-free by design -- a build constraint, not a style preference

It is dependency-free by design (`bun:sqlite` / node builtins only -- no
`@opentelemetry/*`), which is what lets all four image builds `COPY shared /shared` from a
stack-root build context.

`shared/` may import **only** `bun:sqlite` and node builtins. **No `@opentelemetry/*`, no
third-party packages.** That is what lets all four image builds `COPY shared /shared` from a
stack-root build context without dragging a dependency tree into every image.

Adding an import here does not fail locally. It fails at image build, in four places at once.

## `tracing.ts` is the one remaining locked twin

[claude-code/channels/tracing.ts](../claude-code/channels/tracing.ts) imports
`@opentelemetry/*`, so it **cannot** live here. It is duplicated instead:

- edit `claude-code/channels/tracing.ts`,
- then copy it verbatim into [pollers/lib/tracing.ts](../pollers/lib/tracing.ts), under that
  file's one-line header comment.

[pollers/lib/tracing-twin.test.ts](../pollers/lib/tracing-twin.test.ts) asserts
**byte-identity** (header plus channels source) and fails the pollers suite otherwise. The
guard exists because a hand-synced copy is exactly the thing that drifts silently -- a
~600-line poller copy of the workflow schemas did, before it was collapsed into a barrel.

## Runtime validation lives here

[workflow-schemas.ts](workflow-schemas.ts) holds hand-rolled validators (no zod) for the four
boundary contracts: `InvoiceIntakeInput`, `ScanIntakeInput`, `EmailClassificationResult`,
`DocumentClassificationResult`. Each throws `WorkflowSchemaError` naming the schema, field,
expected type and actual value.

They are enforced at three boundaries, which is why a malformed payload fails fast and loudly
instead of half-processing: `submitClassification` validates on write (rejecting malformed
model output), both pollers validate job input before `createJob`, and the worker re-validates
`input_json` on every run.
