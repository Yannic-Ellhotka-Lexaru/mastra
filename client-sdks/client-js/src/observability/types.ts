/**
 * Public types for the @mastra/client-js/observability subpath.
 *
 * This subpath is opt-in: users who want telemetry from inside their
 * client-side tool execute functions import from
 * `@mastra/client-js/observability`. Users who don't import the subpath
 * still get the server-side `CLIENT_TOOL_CALL` parent span automatically
 * (it's created by the agent loop when emitting the tool-call chunk).
 */

import type { ClientToolObservabilityContext, ClientToolObservabilityPayload } from '@mastra/core/observability';

export type { ClientToolObservabilityContext, ClientToolObservabilityPayload };

/**
 * Per-call collector returned by `createClientToolObservabilityCollector`.
 *
 * Lifetime: one collector per client-tool invocation. The collector is
 * created when the SDK sees a `tool-call` chunk that carries an
 * `observability` carrier from the server, used to wrap the user's
 * `execute` function, and then `flush()`-ed once to produce the
 * payload that ships back in the next request body.
 */
export interface ClientToolObservabilityCollector {
  /**
   * The W3C carrier this collector is parented under. The same value
   * is echoed back in the request body's `observability.parentContext`
   * field so the server can use it for cross-request trace inheritance.
   */
  readonly parentContext: ClientToolObservabilityContext;

  /**
   * Wrap an async operation in a child span.
   *
   * The span becomes a child of the deferred CLIENT_TOOL_CALL span
   * identified by `parentContext`. Span lifecycle is automatic: the
   * span starts when the wrapper is called, ends when the inner
   * function settles (success or rejection), and records error info on
   * rejection.
   */
  span<T>(name: string, fn: () => Promise<T> | T, attributes?: Record<string, unknown>): Promise<T>;

  /**
   * Record a structured log entry against the current innermost span
   * (or against the parent CLIENT_TOOL_CALL span if no inner span is
   * active).
   */
  log(level: 'debug' | 'info' | 'warn' | 'error' | 'fatal', message: string, data?: Record<string, unknown>): void;

  /**
   * Run a function with this collector as the innermost active context.
   *
   * Used internally by `@mastra/client-js` to wrap the user's
   * `clientTool.execute` call so that nested `span()` calls inside the
   * tool's body parent correctly. Users typically don't need to call
   * this directly; they call `span()` and `log()` instead.
   */
  withContext<T>(fn: () => Promise<T> | T): Promise<T>;

  /**
   * Drain all buffered spans and logs into an OTLP/JSON payload ready
   * to ship in the next agent request body. Calling `flush()` more
   * than once is allowed but only the first call returns data.
   */
  flush(): ClientToolObservabilityPayload;
}

/**
 * Factory signature for collectors. Accepts the W3C carrier the server
 * sent in the `tool-call` chunk and returns a collector keyed to that
 * parent context.
 *
 * The base `@mastra/client-js` package accepts a collector factory via
 * `ClientOptions.observability.collectorFactory`. When unset, the SDK
 * falls back to no client-side telemetry (but still echoes the
 * `parentContext` back so the server can do cross-request trace
 * inheritance).
 */
export type ClientToolObservabilityCollectorFactory = (
  parentContext: ClientToolObservabilityContext,
) => ClientToolObservabilityCollector;
