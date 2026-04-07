/**
 * `@mastra/client-js/observability` — opt-in client-side telemetry for
 * client-side tools.
 *
 * Importing this subpath gives you a collector you can plug into the
 * `MastraClient` constructor:
 *
 * ```ts
 * import { MastraClient } from '@mastra/client-js';
 * import { createClientToolObservabilityCollector } from '@mastra/client-js/observability';
 *
 * const client = new MastraClient({
 *   baseUrl,
 *   observability: { collectorFactory: createClientToolObservabilityCollector },
 * });
 * ```
 *
 * The collector buffers spans and logs emitted from inside your client
 * tool's `execute` function and ships them back to the server in the
 * next request body. The server's `@mastra/observability` ingest decodes
 * them and routes them through the same exporter pipeline as
 * server-side telemetry, so they appear in whatever observability
 * backend you have configured (Langfuse, Braintrust, custom exporters,
 * etc.) without any extra wiring.
 *
 * The server-side `CLIENT_TOOL_CALL` parent span is created
 * automatically by the agent loop whether or not you opt into this
 * subpath — opting in just gets you the richer child telemetry from
 * inside your tool's execute function.
 */

export { createClientToolObservabilityCollector, getCurrentClientToolObservabilityCollector } from './collector';
export type {
  ClientToolObservabilityCollector,
  ClientToolObservabilityCollectorFactory,
  ClientToolObservabilityContext,
  ClientToolObservabilityPayload,
} from './types';
