/**
 * Client-side tool observability for @mastra/observability.
 *
 * Implements the ClientToolObservabilityIngest interface from
 * @mastra/core to bridge OTLP/JSON spans and logs returned by client
 * tools (via the @mastra/client-js/observability collector) into the
 * Mastra observability bus.
 */

export { createClientToolObservabilityIngest, DEFAULT_LIMITS } from './ingest';
export type { ClientToolIngestLimits, CreateClientToolIngestOptions } from './ingest';
export {
  decodeResourceLogs,
  decodeResourceSpans,
  buildExportedLog,
  buildExportedSpan,
  otlpSeverityToLogLevel,
} from './otlp';
export type { DecodedOtlpLog, DecodedOtlpSpan } from './otlp';
export { formatBaggage, formatTraceparent, parseBaggage, parseTraceparent } from './w3c';
export type { TraceparentParts } from './w3c';
