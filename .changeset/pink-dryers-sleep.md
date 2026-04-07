---
'@mastra/client-js': minor
'@mastra/observability': patch
'@mastra/server': patch
'@mastra/core': patch
---

Add @mastra/client-js/observability subpath export with createClientToolObservabilityCollector and getCurrentClientToolObservabilityCollector. The collector buffers spans and structured logs emitted from inside client-side tool execute functions and ships them back to the server as OTLP/JSON in the next request body. The base SDK echoes the W3C carrier the server sent on a prior turn back in the next request so cross-request trace inheritance works even without the subpath. Refs mastra-ai/mastra#10889
