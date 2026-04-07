---
'@mastra/client-js': patch
'@mastra/observability': patch
'@mastra/server': patch
'@mastra/core': patch
---

Wire client tool observability ingest into the agent stream and generate handlers: when a request body carries observability.payload (the OTLP/JSON spans+logs the client buffered while running a deferred tool), forward it through mastra.observability.getClientToolObservabilityIngest()?.ingest(...) before the new agent run starts. Refs mastra-ai/mastra#10889
