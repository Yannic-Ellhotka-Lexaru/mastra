import { SpanType } from '@mastra/core/observability';
import type { AnySpan, ObservabilityEvent, ObservabilityInstance } from '@mastra/core/observability';
import { describe, expect, it, vi } from 'vitest';

import { BaseObservabilityInstance } from '../instances/base';
import { createClientToolObservabilityIngest } from './ingest';
import { formatTraceparent } from './w3c';

const TRACE_ID = '11111111111111111111111111111111';
const PARENT_SPAN_ID = 'aaaaaaaaaaaaaaaa';
const CHILD_SPAN_ID = 'bbbbbbbbbbbbbbbb';
const SECOND_CHILD_SPAN_ID = 'cccccccccccccccc';

interface FakeBus {
  events: ObservabilityEvent[];
}

function createFakeInstance(): { instance: ObservabilityInstance; bus: FakeBus } {
  const bus: FakeBus = { events: [] };
  // We rely on `instanceof BaseObservabilityInstance` for the
  // ingest path to forward through. Build a minimal subclass.
  class FakeInstance extends BaseObservabilityInstance {
    constructor() {
      super({ name: 'fake', serviceName: 'test' });
    }
    override __ingestExternalEvent(event: ObservabilityEvent): void {
      bus.events.push(event);
    }
  }
  return { instance: new FakeInstance(), bus };
}

function carrier(traceId = TRACE_ID, spanId = PARENT_SPAN_ID) {
  return { traceparent: formatTraceparent(traceId, spanId, true) };
}

function spansPayload(spans: unknown[]) {
  return { resourceSpans: [{ scopeSpans: [{ spans }] }] };
}

function logsPayload(logs: unknown[]) {
  return { resourceLogs: [{ scopeLogs: [{ logRecords: logs }] }] };
}

function makeSpan(overrides: Record<string, unknown> = {}) {
  return {
    traceId: TRACE_ID,
    spanId: CHILD_SPAN_ID,
    parentSpanId: PARENT_SPAN_ID,
    name: 'child',
    startTimeUnixNano: '0',
    endTimeUnixNano: '1000000',
    attributes: [],
    status: { code: 1 },
    ...overrides,
  };
}

describe('inject', () => {
  it('produces a sampled traceparent from a parent span', () => {
    const { instance } = createFakeInstance();
    const ingest = createClientToolObservabilityIngest({ resolveInstance: () => instance });
    const span = { traceId: TRACE_ID, id: PARENT_SPAN_ID } as unknown as AnySpan;
    const ctx = ingest.inject(span);
    expect(ctx.traceparent).toBe(`00-${TRACE_ID}-${PARENT_SPAN_ID}-01`);
  });
});

describe('ingest validation', () => {
  it('rejects payloads with mismatched traceIds', () => {
    const { instance, bus } = createFakeInstance();
    const ingest = createClientToolObservabilityIngest({ resolveInstance: () => instance });
    ingest.ingest({ spans: spansPayload([makeSpan({ traceId: '99999999999999999999999999999999' })]) }, carrier());
    expect(bus.events).toHaveLength(0);
  });

  it('rejects payloads with orphan parent spanIds', () => {
    const { instance, bus } = createFakeInstance();
    const ingest = createClientToolObservabilityIngest({ resolveInstance: () => instance });
    ingest.ingest({ spans: spansPayload([makeSpan({ parentSpanId: 'deadbeefdeadbeef' })]) }, carrier());
    expect(bus.events).toHaveLength(0);
  });

  it('rejects spans missing parentSpanId entirely', () => {
    const { instance, bus } = createFakeInstance();
    const ingest = createClientToolObservabilityIngest({ resolveInstance: () => instance });
    ingest.ingest({ spans: spansPayload([makeSpan({ parentSpanId: undefined })]) }, carrier());
    expect(bus.events).toHaveLength(0);
  });

  it('rejects payloads exceeding span count limit', () => {
    const { instance, bus } = createFakeInstance();
    const ingest = createClientToolObservabilityIngest({
      resolveInstance: () => instance,
      limits: { maxSpans: 1 },
    });
    ingest.ingest(
      {
        spans: spansPayload([makeSpan(), makeSpan({ spanId: SECOND_CHILD_SPAN_ID })]),
      },
      carrier(),
    );
    expect(bus.events).toHaveLength(0);
  });

  it('rejects payloads exceeding byte limit', () => {
    const { instance, bus } = createFakeInstance();
    const ingest = createClientToolObservabilityIngest({
      resolveInstance: () => instance,
      limits: { maxPayloadBytes: 10 },
    });
    ingest.ingest({ spans: spansPayload([makeSpan()]) }, carrier());
    expect(bus.events).toHaveLength(0);
  });

  it('drops payloads when no instance is registered', () => {
    const ingest = createClientToolObservabilityIngest({ resolveInstance: () => undefined });
    // Should not throw.
    ingest.ingest({ spans: spansPayload([makeSpan()]) }, carrier());
  });

  it('drops payloads with malformed parentContext', () => {
    const { instance, bus } = createFakeInstance();
    const ingest = createClientToolObservabilityIngest({ resolveInstance: () => instance });
    ingest.ingest({ spans: spansPayload([makeSpan()]) }, { traceparent: 'garbage' });
    expect(bus.events).toHaveLength(0);
  });
});

describe('ingest happy path', () => {
  it('forwards a single child span as start + end events', () => {
    const { instance, bus } = createFakeInstance();
    const ingest = createClientToolObservabilityIngest({ resolveInstance: () => instance });
    ingest.ingest({ spans: spansPayload([makeSpan()]) }, carrier());
    expect(bus.events).toHaveLength(2);
    expect(bus.events[0]).toMatchObject({ type: 'span_started' });
    expect(bus.events[1]).toMatchObject({ type: 'span_ended' });
    const exported = (bus.events[0] as { exportedSpan: { id: string; parentSpanId: string; type: SpanType } })
      .exportedSpan;
    expect(exported.id).toBe(CHILD_SPAN_ID);
    expect(exported.parentSpanId).toBe(PARENT_SPAN_ID);
    expect(exported.type).toBe(SpanType.GENERIC);
  });

  it('forwards multi-level span trees when parents resolve internally', () => {
    const { instance, bus } = createFakeInstance();
    const ingest = createClientToolObservabilityIngest({ resolveInstance: () => instance });
    ingest.ingest(
      {
        spans: spansPayload([
          makeSpan(),
          makeSpan({ spanId: SECOND_CHILD_SPAN_ID, parentSpanId: CHILD_SPAN_ID, name: 'grandchild' }),
        ]),
      },
      carrier(),
    );
    // 2 spans -> start + end each = 4 events
    expect(bus.events).toHaveLength(4);
  });

  it('forwards log records as log events', () => {
    const { instance, bus } = createFakeInstance();
    const ingest = createClientToolObservabilityIngest({ resolveInstance: () => instance });
    ingest.ingest(
      {
        logs: logsPayload([
          {
            traceId: TRACE_ID,
            spanId: PARENT_SPAN_ID,
            timeUnixNano: '0',
            severityText: 'INFO',
            body: { stringValue: 'hello' },
          },
        ]),
      },
      carrier(),
    );
    expect(bus.events).toHaveLength(1);
    expect(bus.events[0]).toMatchObject({ type: 'log' });
  });

  it('logs warnings via the provided logger when validation fails', () => {
    const { instance } = createFakeInstance();
    const warn = vi.fn();
    const ingest = createClientToolObservabilityIngest({
      resolveInstance: () => instance,
      logger: { warn } as never,
    });
    ingest.ingest({ spans: spansPayload([makeSpan({ traceId: 'ffffffffffffffffffffffffffffffff' })]) }, carrier());
    expect(warn).toHaveBeenCalled();
  });
});
