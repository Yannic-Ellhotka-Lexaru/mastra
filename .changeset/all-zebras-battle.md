---
'@mastra/observability': minor
'@mastra/client-js': patch
'@mastra/server': patch
'@mastra/core': patch
---

Implement ClientToolObservabilityIngest from @mastra/core: hand-rolled W3C traceparent/baggage parsers, hand-rolled OTLP/JSON walker for ResourceSpans and ResourceLogs, and an ingest module that validates traceId match and parent link resolution before forwarding decoded spans/logs into the observability bus. BaseObservabilityInstance gains a public \_\_ingestExternalEvent hook. Observability gains getClientToolObservabilityIngest(). Refs mastra-ai/mastra#10889
