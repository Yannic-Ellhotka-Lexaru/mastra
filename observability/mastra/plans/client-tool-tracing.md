# Plan: Trace client-side tool execution

Closes mastra-ai/mastra#10889.

## Goal

Tools defined via `@mastra/client-js`'s `clientTools` feature run in the
browser, not on the server. Today their execution is invisible to Mastra's
observability pipeline. This plan adds a new `CLIENT_TOOL_CALL` AI tracing
span type, propagates W3C trace context to the client, and ships
client-emitted spans/logs/metrics back through the Mastra server (not around
it) so they land in whatever exporters the user already has configured.

## Constraints

- `@mastra/core` should not gain new OpenTelemetry dependencies in this PR.
  All OTEL code lives in `@mastra/observability`, which already depends on
  `@opentelemetry/api`.
- Telemetry must flow back through the Mastra server. External OTLP exporters
  on the client are out of scope; the server is the only egress point so
  existing exporter configuration (Langfuse, Braintrust, custom, etc.) keeps
  working without per-client wiring.
- Server owns the lifecycle of the `CLIENT_TOOL_CALL` span so a client crash
  cannot orphan it.
- Tracing degrades to a no-op when `@mastra/observability` is not installed.

## Architecture

```
[server agent run]
  └─ tool builder sees a 'client-tool' typed call
  └─ creates CLIENT_TOOL_CALL span (parent = current model/agent span)
  └─ if client-tool tracing ingest is registered:
       - inject(span) → { traceparent, tracestate?, baggage? }
       - attach to outgoing tool-call chunk
       │
       ▼
  [@mastra/client-js] (with @mastra/client-js/observability opted in)
    └─ extract W3C context from chunk
    └─ run clientTool.execute() inside that context
    └─ buffer child spans/logs/metrics via in-memory OTEL providers
    └─ flush as OTLP/JSON, attach to outgoing tool-result payload
       │
       ▼
[server tool-result handler]
  └─ if observability.otlp present + ingest registered:
       - ingestOtlp(payload, clientToolSpan)
         · validate every span's traceId == parent traceId
         · validate parents resolve to clientToolSpan or another span in payload
         · enforce size/count caps
         · forward each span/log/metric to existing observability bus
  └─ clientToolSpan.end({ output }) or .error({ error })
```

The wire format is OTLP/JSON because it is a stable, public spec that does
not require the client and server to share JS imports — they only share bytes.

## Package boundaries

### `@mastra/core` — interface only, zero new deps

**`packages/core/src/observability/types/tracing.ts`**

- Add `SpanType.CLIENT_TOOL_CALL = 'client_tool_call'`.
- Add `ClientToolCallAttributes extends AIBaseAttributes` with:
  - `toolType?: string`
  - `toolDescription?: string`
  - `clientEnvironment?: string`
- Register in `SpanTypeMap`.
- Note: success/failure is conveyed by `output` vs `errorInfo` on the span,
  not by an attribute. The existing server-side `TOOL_CALL` /
  `MCP_TOOL_CALL` spans currently set `success` as an attribute; that is a
  pre-existing inconsistency and is **out of scope** for this PR.

**New: `packages/core/src/observability/client-tool-tracing.ts`**

```ts
import type { AnySpan } from './types/tracing';

export interface ClientToolTracingContext {
  traceparent: string;
  tracestate?: string;
  baggage?: string;
}

export interface ClientToolTracingIngest {
  /** Inject current span context into the chunk going to the client. */
  inject(parentSpan: AnySpan): ClientToolTracingContext;

  /**
   * Ingest OTLP/JSON returned by the client, parented under the given span.
   * Implementations must validate that traceIds match and parent links
   * resolve before forwarding to the observability bus.
   */
  ingestOtlp(payload: unknown, parentSpan: AnySpan): void;
}
```

**`packages/core/src/stream/types.ts`**

- Add optional `tracing?: ClientToolTracingContext` to the tool-call chunk
  payload.
- Add optional `observability?: { otlp: unknown }` to the tool-result
  payload. Typed as `unknown` so core never has to know the OTLP shape.

**`packages/core/src/tools/tool-builder/builder.ts`**

When a tool is detected as `'client-tool'` typed (existing path that today
defers execution to the client):

1. Create the `CLIENT_TOOL_CALL` span as a child of the current span. Input
   = the tool args. Attributes = `toolDescription`, `toolType`.
2. If `mastra.observability.clientToolIngest` is registered, call
   `inject(span)` and attach the result to the outgoing tool-call chunk.
3. When the matching tool result returns:
   - If it carries `observability.otlp` and an ingest is registered, call
     `ingestOtlp(payload, span)`.
   - `span.end({ output: result })` on success, `span.error({ error })` on
     failure.
4. If no ingest is registered, skip steps 2 and 3 entirely. The span is
   still created and ended; only the cross-boundary telemetry flow is
   disabled.

**`packages/core/src/mastra/index.ts`**

- Allow registering an ingest implementation:
  `new Mastra({ observability: { clientToolIngest } })` or
  `mastra.useClientToolTracing(impl)`. Exact shape to follow whatever
  convention `@mastra/observability` already uses.

### `@mastra/observability` — implementation

Already depends on `@opentelemetry/api`. Add `@opentelemetry/core` (~27 KB
gzipped) and `@opentelemetry/otlp-transformer` here. These are acceptable in
a dedicated observability package.

**New: `observability/mastra/src/client-tool-tracing.ts`**

- Exports `createClientToolTracing(): ClientToolTracingIngest`.
- `inject(parentSpan)`:
  - Builds an OTEL `Context` from `parentSpan.traceId` / `parentSpan.spanId`.
  - Uses `W3CTraceContextPropagator.inject()` and
    `W3CBaggagePropagator.inject()` to populate a carrier object.
  - Adds `mastra.tracingPolicy=...` and `mastra.runId=...` to baggage so the
    client can short-circuit when sampled out.
- `ingestOtlp(payload, parentSpan)`:
  - Decodes via `@opentelemetry/otlp-transformer`.
  - Walks `resourceSpans[].scopeSpans[].spans[]`.
  - Validation (security-critical, reject the entire payload on any failure):
    - Every span's `traceId` must equal `parentSpan.traceId`.
    - Every span's `parentSpanId` must resolve to `parentSpan.spanId` or
      another spanId present in this payload (no orphans, no cross-trace
      injection).
    - Hard caps: `maxSpans` (default 1000), `maxLogs` (default 1000),
      `maxMetricPoints` (default 1000), `maxPayloadBytes` (default 1 MiB).
  - Forwards each accepted span/log/metric into the existing observability
    bus using the same internal entry points server-side spans use.
  - Uses the first child span's `startTime` (or an explicit
    `mastra.actualStartTime` baggage entry) as the effective start of the
    `CLIENT_TOOL_CALL` span so latency is measured from real client-side
    execution start, not from chunk emission.

### `@mastra/client-js` — opt-in subpath, full OTEL stack

Base `@mastra/client-js` bundle stays unchanged. Tracing lives behind a
subpath export so users only pay for it if they use it.

**New: `client-sdks/client-js/src/observability/index.ts`**

- New subpath export: `@mastra/client-js/observability`.
- Adds `@opentelemetry/api`, `@opentelemetry/sdk-trace-base`,
  `@opentelemetry/core`, `@opentelemetry/otlp-transformer` as dependencies
  (only loaded when the subpath is imported).
- Exports `createObservabilityCollector(tracing: ClientToolTracingContext)`:
  - Lazily instantiates a `BasicTracerProvider` with one in-memory
    `SpanProcessor` that buffers `ReadableSpan`s.
  - (Phase 2) similar in-memory `LoggerProvider` and `MeterProvider`.
  - Reads `tracing.traceparent` / `tracing.baggage`, calls
    `propagation.extract(ROOT_CONTEXT, carrier)`, returns a `Context`.
  - `withContext(ctx, fn)` runs the user's `execute` inside it, so any OTEL
    instrumentation in the user's app naturally parents under
    `CLIENT_TOOL_CALL`.
  - If baggage carries `mastra.tracingPolicy=off`, the collector is a
    singleton no-op — zero allocations, no provider instantiation.
  - `flush()` returns OTLP/JSON via
    `@opentelemetry/otlp-transformer`'s `createExportTraceServiceRequest`
    (and equivalents for logs/metrics in phase 2).

**`client-sdks/client-js/src/resources/agent.ts`**

Around `executeToolCallAndRespond` (lines 61–105 today). The collector is
attached via a registration hook so the base SDK does not import the
observability subpath:

```ts
const collector = collectorFactory?.(toolCallChunk.tracing);
let result, error;
try {
  result = collector
    ? await collector.withContext(() =>
        clientTool.execute({ context: args, runtimeContext, tracingContext: { currentSpan: collector.rootSpan } })
      )
    : await clientTool.execute({ context: args, runtimeContext });
} catch (e) {
  error = e;
}

await sendToolResult({
  toolCallId,
  result,
  error,
  observability: collector ? { otlp: collector.flush() } : undefined,
});

if (error) throw error;
return result;
```

Users opt in once at SDK construction:

```ts
import { MastraClient } from '@mastra/client-js';
import { createObservabilityCollector } from '@mastra/client-js/observability';

const client = new MastraClient({
  baseUrl,
  observability: { collectorFactory: createObservabilityCollector },
});
```

## Tests

- `packages/core/src/observability/types/tracing.test.ts` — enum + type map
  sanity for `CLIENT_TOOL_CALL`.
- `packages/core/src/agent/__tests__/tools.test.ts` — extend the existing
  client-tool tests (around line 358) to assert:
  - The tool-call chunk carries `tracing.traceparent` when an ingest is
    registered.
  - A `CLIENT_TOOL_CALL` span appears in the in-memory exporter as a child
    of the agent run span, with input/output set, when the client returns a
    result.
  - The span carries `errorInfo` when the client returns an error.
  - With no ingest registered, no `tracing` field is emitted and no OTLP
    payload is consumed; the span is still created.
- `observability/mastra/src/client-tool-tracing.test.ts`:
  - W3C inject roundtrip.
  - OTLP/JSON happy path: child spans land in the exporter under the parent.
  - Validation rejections: traceId mismatch, orphan parent, oversized
    payload.
- `client-sdks/client-js/src/observability/collector.test.ts`:
  - `tracingPolicy=off` returns a no-op singleton.
  - Extract/inject roundtrip.
  - `flush()` produces OTLP/JSON whose only span has the expected parent
    spanId from the carrier.

## Docs and changeset

- Update the AI tracing span types reference doc to list `CLIENT_TOOL_CALL`.
- Update `docs/src/content/en/reference/client-js/agents.mdx` "Client tools"
  section to note executions are now traced and link to the new doc.
- New short doc: "Tracing client-side tools" — how to enable the collector,
  what users see in their existing exporters.
- `pnpm changeset` — minor bumps for `@mastra/core`, `@mastra/client-js`,
  `@mastra/observability`.

## Resolved during planning

1. **Tool result return path.** Client tool results are not sent on a
   side-channel. The client SDK's `executeToolCallAndRespond` appends the
   result as a `tool` role message and re-invokes `agent.generate()` /
   `agent.stream()` via `respondFn`
   (`client-sdks/client-js/src/resources/agent.ts:107-137`, bound at line
   559). Server-side this becomes a fresh POST to
   `/agents/:agentId/stream`
   (`packages/server/src/server/handlers/agents.ts:1299-1378`).
   **Implication:** the `observability.otlp` field rides at the top level
   of the agent execution request body, added to
   `agentExecutionBodySchema` and plumbed through stream/generate options.
   A single request may carry results for multiple client tool calls;
   ingest resolves each child span to its `CLIENT_TOOL_CALL` parent by
   spanId lookup against currently-pending spans.

2. **`@mastra/observability` registration.** `Mastra` already accepts
   `observability: ObservabilityEntrypoint`
   (`packages/core/src/mastra/index.ts:162-182`), instantiated as
   `new Observability({...})` from `@mastra/observability`
   (`observability/mastra/src/default.ts:47`). The
   `ObservabilityEntrypoint` interface
   (`packages/core/src/observability/types/core.ts:263-319`) is the right
   home for a new accessor: add
   `getClientToolIngest(): ClientToolTracingIngest | undefined`. The
   `NoOpObservability` returns `undefined`; the real `Observability`
   class in `@mastra/observability` returns a working implementation that
   uses the OTEL libraries. Tool builder reads
   `mastra.observability.getClientToolIngest()` and skips the entire
   propagation/ingest path when undefined. No new registration call site
   — purely additive to an existing interface.

## Deferred

1. **Phase 2 — logs and metrics.** Initial implementation is spans only.
   Logs and metrics support is additive: same OTLP/JSON payload, more
   sections, same validation rules.

## Out of scope

- Fixing the pre-existing `success` attribute on `TOOL_CALL` /
  `MCP_TOOL_CALL` spans. Tracked separately.
- Direct-to-backend OTLP exporters from the browser. Telemetry must flow
  through the Mastra server.
- Auto-instrumentation of `fetch` / `XMLHttpRequest` inside client tools.
  Users who want it can register their own OTEL instrumentation; it will
  parent correctly under `CLIENT_TOOL_CALL` because the collector
  `withContext`s the execution.
