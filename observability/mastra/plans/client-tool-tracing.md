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

**New: `packages/core/src/observability/types/client-tool.ts`**

Lives in the `types/` folder alongside the existing tracing types — these
are pure interfaces, no runtime code. Naming is `client-tool` (singular)
so it can hold spans, logs, and any future client-tool observability
concerns without renaming.

```ts
import type { AnySpan } from './tracing';

/**
 * Carrier shipped from server → client over the tool-call chunk.
 * Holds W3C trace context plus any other observability hints the
 * client SDK needs to attach child spans/logs to the right parent.
 */
export interface ClientToolObservabilityContext {
  traceparent: string;
  tracestate?: string;
  baggage?: string;
}

/**
 * OTLP/JSON payload returned from client → server attached to the tool
 * result. Typed as `unknown` at the core boundary; the implementation
 * package validates the actual shape.
 */
export interface ClientToolObservabilityPayload {
  spans?: unknown;
  logs?: unknown;
}

export interface ClientToolObservabilityIngest {
  /** Inject current span context into the chunk going to the client. */
  inject(parentSpan: AnySpan): ClientToolObservabilityContext;

  /**
   * Ingest OTLP/JSON spans + logs returned by the client, parented under
   * the given span. Implementations must validate that traceIds match and
   * parent links resolve before forwarding to the observability bus.
   */
  ingest(payload: ClientToolObservabilityPayload, parentSpan: AnySpan): void;
}
```

Re-exported from `packages/core/src/observability/index.ts`.

**`packages/core/src/stream/types.ts`**

- Add optional `observability?: ClientToolObservabilityContext` to the
  tool-call chunk payload. (Named `observability`, not `tracing`, so it
  can carry log/metric context too without future renames — matches the
  user's preference for observability-shaped context objects over
  tracing-only ones.)
- Add optional `observability?: ClientToolObservabilityPayload` to the
  tool-result payload.

**`packages/core/src/tools/tool-builder/builder.ts`**

When a tool is detected as `'client-tool'` typed (existing path that today
defers execution to the client):

1. **Always** create the `CLIENT_TOOL_CALL` span as a child of the
   current span. Input = the tool args. Attributes = `toolDescription`,
   `toolType`. This happens regardless of whether the client opts into
   the observability subpath — every user gets at least the server-side
   span showing that a client tool ran and how long it took.
2. If `mastra.observability.getClientToolObservabilityIngest()` returns
   an implementation, call `inject(span)` and attach the result to the
   outgoing tool-call chunk's `observability` field.
3. When the matching tool result returns:
   - If it carries `observability` payload and an ingest is registered,
     call `ingest(payload, span)`.
   - `span.end({ output: result })` on success, `span.error({ error })`
     on failure.
4. If no ingest is registered, skip steps 2 and 3. The span is still
   created and ended; only the cross-boundary child span/log flow is
   skipped.

**`packages/core/src/mastra/index.ts`**

- No new registration call site needed. Add a single accessor to the
  existing `ObservabilityEntrypoint` interface
  (`packages/core/src/observability/types/core.ts:263-319`):

  ```ts
  getClientToolObservabilityIngest(): ClientToolObservabilityIngest | undefined;
  ```

  - `NoOpObservability` returns `undefined`.
  - The real `Observability` class in `@mastra/observability` returns a
    working implementation backed by OTEL.
  - The tool builder calls this accessor and skips the cross-boundary
    flow when undefined.

### `@mastra/observability` — implementation

Already depends on `@opentelemetry/api`. Add `@opentelemetry/core`,
`@opentelemetry/sdk-trace-base`, `@opentelemetry/sdk-logs`, and
`@opentelemetry/otlp-transformer`. These are acceptable in a dedicated
observability package.

**New: `observability/mastra/src/client-tool/index.ts`**

- Exports `createClientToolObservabilityIngest(): ClientToolObservabilityIngest`
  and registers it on the `Observability` class so
  `getClientToolObservabilityIngest()` returns it by default.
- `inject(parentSpan)`:
  - Builds an OTEL `Context` from `parentSpan.traceId` / `parentSpan.spanId`.
  - Uses `W3CTraceContextPropagator.inject()` and
    `W3CBaggagePropagator.inject()` to populate a carrier object.
  - Adds `mastra.tracingPolicy=...` and `mastra.runId=...` to baggage so
    the client can short-circuit when sampled out.
- `ingest(payload, parentSpan)`:
  - **Spans:** decode `payload.spans` (OTLP/JSON `ResourceSpans`) via
    `@opentelemetry/otlp-transformer`. Walk
    `resourceSpans[].scopeSpans[].spans[]`.
  - **Logs:** decode `payload.logs` (OTLP/JSON `ResourceLogs`) the same
    way. Walk `resourceLogs[].scopeLogs[].logRecords[]`. Each log record
    is associated with its enclosing span via `spanId` and gets routed
    to the same observability bus path used by server-side logging.
  - Validation (security-critical, reject the entire payload on any
    failure):
    - Every span's `traceId` and every log record's `traceId` must equal
      `parentSpan.traceId`.
    - Every span's `parentSpanId` must resolve to `parentSpan.spanId` or
      another spanId present in this payload (no orphans, no cross-trace
      injection).
    - Every log record's `spanId` must resolve to a span in this payload
      or to `parentSpan.spanId`.
    - Hard caps: `maxSpans` (default 1000), `maxLogs` (default 1000),
      `maxPayloadBytes` (default 1 MiB).
  - Forwards each accepted span/log into the existing observability bus
    using the same internal entry points server-side spans/logs use.
  - Uses the first child span's `startTime` (or an explicit
    `mastra.actualStartTime` baggage entry) as the effective start of
    the `CLIENT_TOOL_CALL` span so latency is measured from real
    client-side execution start, not from chunk emission.

### `@mastra/client-js` — observability via subpath export

The CLIENT_TOOL_CALL parent span is created server-side **regardless of
whether the client opts into the observability subpath**. Every user
already gets:

- A `CLIENT_TOOL_CALL` span in their existing exporters showing that a
  client tool ran, what its inputs were, what it returned, how long it
  took, and whether it errored.

The subpath export is for users who want **richer telemetry from inside
their client tool execute functions** — child spans, logs, and any OTEL
instrumentation they have running in the browser. Following the
established Mastra subpath pattern (e.g. `@mastra/core/auth/ee`,
`@mastra/core/observability/context-storage`, etc. — 21 such exports in
core today), this is added via the `exports` map of `@mastra/client-js`.

**New: `client-sdks/client-js/src/observability/index.ts`**

- New subpath export: `@mastra/client-js/observability` declared in
  `client-sdks/client-js/package.json` `exports`.
- Adds `@opentelemetry/api`, `@opentelemetry/sdk-trace-base`,
  `@opentelemetry/sdk-logs`, `@opentelemetry/core`,
  `@opentelemetry/otlp-transformer` as dependencies (only loaded when
  the subpath is imported — base bundle is unaffected because nothing
  in the main entry references this file).
- Exports `createClientToolObservabilityCollector(ctx: ClientToolObservabilityContext)`:
  - Lazily instantiates a `BasicTracerProvider` with one in-memory
    `SpanProcessor` that buffers `ReadableSpan`s.
  - Lazily instantiates a `LoggerProvider` with one in-memory
    `LogRecordProcessor` that buffers log records.
  - Reads `ctx.traceparent` / `ctx.baggage`, calls
    `propagation.extract(ROOT_CONTEXT, carrier)`, returns a `Context`.
  - `withContext(ctx, fn)` runs the user's `execute` inside it, so any
    OTEL instrumentation in the user's app naturally parents under
    `CLIENT_TOOL_CALL`.
  - If baggage carries `mastra.tracingPolicy=off`, the collector is a
    singleton no-op — zero allocations, no provider instantiation.
  - `flush()` returns
    `{ spans: ResourceSpansJSON, logs: ResourceLogsJSON }` produced via
    `@opentelemetry/otlp-transformer`'s `createExportTraceServiceRequest`
    and `createExportLogsServiceRequest`.

**`client-sdks/client-js/src/resources/agent.ts`**

Around `executeToolCallAndRespond` (lines 61–105 today). The collector is
attached via a registration hook so the base SDK does not import the
observability subpath:

```ts
// observability collector is undefined unless the user opted into the
// subpath. The CLIENT_TOOL_CALL parent span on the server happens
// either way; this only governs whether child spans/logs are collected.
const collector = collectorFactory?.(toolCallChunk.observability);
let result, error;
try {
  result = collector
    ? await collector.withContext(() =>
        clientTool.execute({
          context: args,
          runtimeContext,
          tracingContext: { currentSpan: collector.rootSpan },
        })
      )
    : await clientTool.execute({ context: args, runtimeContext });
} catch (e) {
  error = e;
}

// The result is appended as a tool-role message and respondFn re-invokes
// agent.generate()/stream() with `observability` at the top level of the
// request body.
await respondFn(updatedMessages, {
  ...respondOptions,
  observability: collector ? collector.flush() : undefined,
});
```

Users opt in once at SDK construction:

```ts
import { MastraClient } from '@mastra/client-js';
import { createClientToolObservabilityCollector } from '@mastra/client-js/observability';

const client = new MastraClient({
  baseUrl,
  observability: { collectorFactory: createClientToolObservabilityCollector },
});
```

The opt-in only adds the OTEL deps to bundles that explicitly import the
subpath. Users who don't import it pay nothing and still get the
server-side `CLIENT_TOOL_CALL` parent span in their existing exporters.

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
- `observability/mastra/src/client-tool/index.test.ts`:
  - W3C inject roundtrip.
  - OTLP/JSON spans happy path: child spans land in the exporter under
    the parent.
  - OTLP/JSON logs happy path: log records land in the bus parented
    correctly.
  - Validation rejections: traceId mismatch, orphan parent span, log
    pointing at unknown spanId, oversized payload.
- `client-sdks/client-js/src/observability/collector.test.ts`:
  - `tracingPolicy=off` returns a no-op singleton.
  - Extract/inject roundtrip.
  - `flush()` returns `{ spans, logs }` with spans whose parent is the
    carrier spanId and logs whose enclosing span resolves locally.

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
   `getClientToolObservabilityIngest(): ClientToolObservabilityIngest | undefined`.
   `NoOpObservability` returns `undefined`; the real `Observability`
   class in `@mastra/observability` returns a working implementation
   that uses the OTEL libraries. Tool builder reads
   `mastra.observability.getClientToolObservabilityIngest()` and skips
   the cross-boundary flow when undefined. No new registration call site
   — purely additive to an existing interface.

3. **Subpath exports are an established pattern.**
   `@mastra/core` already declares 21 subpath exports (e.g.
   `./auth/ee`, `./observability/context-storage`, `./agent/message-list`).
   Adding `@mastra/client-js/observability` follows the same convention
   — no new package needed, no precedent to invent.

## In scope for v1

- Spans **and logs** for client-side tool execution.

## Deferred / out of scope

1. **Metrics.** Mastra metrics are significantly different from OTEL
   metrics, so cleanly mapping them is its own design problem. Skip for
   now; may never support if there is no good mapping.
2. **Fixing the pre-existing `success` attribute on `TOOL_CALL` /
   `MCP_TOOL_CALL` spans.** Pre-existing inconsistency, tracked
   separately.
3. **Direct-to-backend OTLP exporters from the browser.** Telemetry must
   flow through the Mastra server.
4. **Auto-instrumentation of `fetch` / `XMLHttpRequest` inside client
   tools.** Users who want it can register their own OTEL
   instrumentation; it will parent correctly under `CLIENT_TOOL_CALL`
   because the collector `withContext`s the execution.

