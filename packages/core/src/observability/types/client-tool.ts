/**
 * Client-side tool observability interfaces.
 *
 * Tools defined via `@mastra/client-js`'s `clientTools` feature execute
 * in the client environment (browser, edge, Node), not on the server.
 * The CLIENT_TOOL_CALL span lives on the server so trace shape survives
 * client crashes, but child spans/logs from inside the client tool's
 * execute function are forwarded back to the server as OTLP/JSON and
 * fed into the existing observability bus.
 *
 * `@mastra/core` defines only the interfaces here. The implementation
 * (W3C trace context propagation, OTLP/JSON decoding, OTEL libraries)
 * lives in `@mastra/observability`.
 */

import type { AnySpan } from './tracing';

/**
 * Carrier shipped from server to client over the tool-call chunk.
 *
 * Holds W3C Trace Context (`traceparent`, `tracestate`) and W3C Baggage
 * so the client SDK can attach child spans/logs to the right parent and
 * honor sampling decisions made server-side.
 */
export interface ClientToolObservabilityContext {
  /** W3C traceparent header value, e.g. `00-{traceId}-{spanId}-{flags}` */
  traceparent: string;
  /** W3C tracestate header value */
  tracestate?: string;
  /** W3C baggage header value, used to carry sampling decisions and runIds */
  baggage?: string;
}

/**
 * OTLP/JSON payload returned from client to server attached to the
 * tool result.
 *
 * Both fields are typed as `unknown` at the core boundary; the
 * implementation in `@mastra/observability` validates the actual
 * OTLP/JSON shape (`ResourceSpans` for `spans`, `ResourceLogs` for
 * `logs`) before forwarding to the observability bus.
 */
export interface ClientToolObservabilityPayload {
  /** OTLP/JSON encoded ResourceSpans */
  spans?: unknown;
  /** OTLP/JSON encoded ResourceLogs */
  logs?: unknown;
}

/**
 * Server-side ingest interface for client tool observability data.
 *
 * Provided by `@mastra/observability`. The agent calls `inject` when
 * emitting a client tool invocation (request 1) to populate the chunk
 * with a W3C trace context carrier, and calls `ingest` on the next
 * request (request 2, the one that brings back the tool result) to
 * feed the client's buffered spans/logs into the observability bus.
 *
 * Note that `ingest` is called from a **different agent run** than
 * `inject` was: client-side tool execution spans two HTTP requests, so
 * by the time the OTLP payload arrives, the original `CLIENT_TOOL_CALL`
 * span has already ended. That is why `ingest` takes a
 * `ClientToolObservabilityContext` (the carrier the client echoed back)
 * rather than a live `AnySpan` — the carrier is the only thing that
 * survives across the two requests.
 *
 * Implementations must validate that:
 *  - every span/log `traceId` matches the traceparent in
 *    `parentContext`
 *  - every span's `parentSpanId` resolves to the span identified by
 *    `parentContext` or to another span present in the same payload
 *    (no orphans, no cross-trace injection)
 *  - every log record's `spanId` resolves to a span in the payload or
 *    to the span identified by `parentContext`
 *  - hard caps on span/log counts and total payload size are enforced
 */
export interface ClientToolObservabilityIngest {
  /**
   * Inject the parent span's W3C context into a carrier for transport
   * to the client. Called from request 1 when the agent emits a
   * client-side tool call.
   */
  inject(parentSpan: AnySpan): ClientToolObservabilityContext;

  /**
   * Validate and ingest an OTLP/JSON payload returned by the client,
   * parented under the span identified by `parentContext`. Called from
   * request 2 when the agent receives the tool result from the client.
   *
   * Implementations should silently drop invalid payloads (logging a
   * warning) rather than throwing, so a misbehaving client tool cannot
   * break the agent run.
   */
  ingest(payload: ClientToolObservabilityPayload, parentContext: ClientToolObservabilityContext): void;
}
