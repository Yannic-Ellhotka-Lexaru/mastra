---
'@mastra/core': minor
'@mastra/client-js': patch
'@mastra/observability': patch
'@mastra/server': patch
---

Add CLIENT_TOOL_CALL span type and ClientToolObservabilityIngest interface for tracing client-side tool execution. The agent loop now creates a deferred CLIENT_TOOL_CALL child span when emitting tool calls that will be executed in the client SDK, attaches a W3C trace context carrier to the tool-call chunk, and ends the span immediately. Adds optional getClientToolObservabilityIngest() accessor on ObservabilityEntrypoint and an observability field on ToolCallPayload and agentExecutionBodySchema. Refs mastra-ai/mastra#10889
