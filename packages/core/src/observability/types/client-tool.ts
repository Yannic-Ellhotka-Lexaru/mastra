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
 * Provided by `@mastra/observability`. The tool builder/agent calls
 * `inject` when emitting a client tool invocation to populate the chunk
 * with W3C trace context, and calls `ingest` when the matching tool
 * result returns to feed any attached spans/logs back into the
 * observability bus.
 *
 * Implementations must validate that:
 *  - every span/log `traceId` matches `parentSpan.traceId`
 *  - every span's `parentSpanId` resolves to `parentSpan.spanId` or to
 *    another span present in the same payload (no orphans, no
 *    cross-trace injection)
 *  - every log record's `spanId` resolves to a span in the payload or
 *    to `parentSpan.spanId`
 *  - hard caps on span/log counts and total payload size are enforced
 */
export interface ClientToolObservabilityIngest {
  /**
   * Inject the parent span's W3C context (and any other observability
   * hints) into a carrier for transport to the client.
   */
  inject(parentSpan: AnySpan): ClientToolObservabilityContext;

  /**
   * Validate and ingest an OTLP/JSON payload returned by the client,
   * parented under `parentSpan`. Implementations should silently drop
   * invalid payloads (logging a warning) rather than throwing, so a
   * misbehaving client tool cannot break the agent run.
   */
  ingest(payload: ClientToolObservabilityPayload, parentSpan: AnySpan): void;
}
