import { describe, expect, it } from 'vitest';
import { fromLiveKitEvents, fromOtlpJson, readTrace, truncate } from '../src/trace.js';

describe('truncate', () => {
  it('leaves short values alone', () => {
    expect(truncate('short', 10)).toBe('short');
  });

  it('says how much it dropped rather than trailing off silently', () => {
    expect(truncate('abcdefghij', 4)).toBe('abcd… [6 more chars]');
  });
});

describe('fromLiveKitEvents', () => {
  const events = [
    { id: 'e1', item: { role: 'user', text_content: 'cancel my appointment' } },
    { id: 'e2', type: 'function_call', item: { name: 'cancel_appointment', arguments: '{}' } },
    { id: 'e3', type: 'function_call_output', item: { output: 'Cancelled.' } },
    { id: 'e4', item: { role: 'assistant', text_content: 'Done.' } },
  ];

  it('maps roles and call types onto kinds', () => {
    const trace = fromLiveKitEvents(events, 't');
    expect(trace.events.map((e) => e.kind)).toEqual(['user', 'tool_call', 'tool_result', 'agent']);
  });

  it('keeps the tool name so specs can reason about which tool ran', () => {
    const trace = fromLiveKitEvents(events, 't');
    expect(trace.events[1]?.name).toBe('cancel_appointment');
  });

  it('accepts a wrapped {events:[...]} payload', () => {
    expect(fromLiveKitEvents({ events }, 't').events).toHaveLength(4);
  });

  it('falls back to positional ids only when none are present', () => {
    const trace = fromLiveKitEvents([{ item: { role: 'user' } }], 't');
    expect(trace.events[0]?.id).toBe('evt-0');
  });
});

describe('fromOtlpJson', () => {
  const otlp = {
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                spanId: 'b',
                name: 'search_corpus',
                startTimeUnixNano: '200',
                attributes: [{ key: 'gen_ai.tool.name', value: { stringValue: 'search_corpus' } }],
              },
              {
                spanId: 'a',
                name: 'chat',
                startTimeUnixNano: '100',
                attributes: [{ key: 'gen_ai.operation.name', value: { stringValue: 'chat' } }],
              },
            ],
          },
        ],
      },
    ],
  };

  it('orders spans by start time, because OTLP does not guarantee order', () => {
    const trace = fromOtlpJson(otlp, 't');
    expect(trace.events.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('reads gen_ai attributes into kinds', () => {
    const trace = fromOtlpJson(otlp, 't');
    expect(trace.events.map((e) => e.kind)).toEqual(['agent', 'tool_call']);
  });

  it('tolerates spans with no attributes at all', () => {
    const trace = fromOtlpJson(
      { resourceSpans: [{ scopeSpans: [{ spans: [{ spanId: 'x', name: 'plain' }] }] }] },
      't',
    );
    expect(trace.events[0]?.kind).toBe('other');
  });
});

describe('readTrace', () => {
  it('detects OTLP by shape', () => {
    expect(readTrace({ resourceSpans: [] }, 't').source).toBe('otlp');
  });

  it('falls back to the LiveKit reader', () => {
    expect(readTrace([], 't').source).toBe('livekit');
  });
});
