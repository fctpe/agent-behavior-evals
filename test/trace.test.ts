import { describe, expect, it } from 'vitest';
import {
  fromLiveKitEvents,
  fromOtlpJson,
  mergeTraces,
  readTrace,
  TraceError,
  truncate,
} from '../src/trace.js';

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
    // Namespaced by trace, not a bare `evt-0`: the fallback is positional, so
    // every export that lacks ids produces the same sequence, and two of them
    // merged used to be several distinct events sharing one id.
    expect(trace.events[0]?.id).toBe('t#evt-0');
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

/**
 * Every event id has to identify exactly one event, because the judge cites ids
 * as evidence and `get_event` resolves a citation with `find` — first match
 * wins. A duplicate meant a verdict could quote one event and point at another,
 * with nothing reporting the substitution. Ambiguous evidence reads as
 * supported evidence, which is worse than none.
 */
describe('event ids identify one event each', () => {
  it('refuses a LiveKit export with a repeated id', () => {
    expect(() =>
      fromLiveKitEvents(
        [
          { id: 'a', item: { role: 'user', text_content: 'cancel it' } },
          { id: 'a', item: { role: 'assistant', text_content: 'which appointment?' } },
        ],
        't',
      ),
    ).toThrow(TraceError);
  });

  it('refuses an OTLP export with a repeated span id', () => {
    const span = (name: string) => ({ spanId: 'dup', name, startTimeUnixNano: '1' });
    expect(() =>
      fromOtlpJson({ resourceSpans: [{ scopeSpans: [{ spans: [span('a'), span('b')] }] }] }, 't'),
    ).toThrow(TraceError);
  });

  // Control. Without this, the two assertions above would still pass if the
  // reader had started throwing on every trace, which would be a far worse bug
  // than the one they exist to catch.
  it('accepts distinct ids', () => {
    const trace = fromLiveKitEvents(
      [
        { id: 'a', item: { role: 'user', text_content: 'cancel it' } },
        { id: 'b', item: { role: 'assistant', text_content: 'which appointment?' } },
      ],
      't',
    );
    expect(trace.events.map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('mergeTraces', () => {
  const stamped = (id: string, ts: string) => ({ id, item: { role: 'user' }, ts });

  it('interleaves by timestamp rather than by argument order', () => {
    const late = fromLiveKitEvents([stamped('x', '300')], 'late.json');
    const early = fromLiveKitEvents([stamped('y', '100')], 'early.json');
    // Passed late-first on purpose: flatMap would have kept that order.
    const merged = mergeTraces([late, early]);
    expect(merged.events.map((e) => e.id)).toEqual(['early.json#y', 'late.json#x']);
  });

  it('orders numeric timestamps numerically, not lexically', () => {
    // '9' sorts after '10' as a string. Nanosecond stamps differ in digit count
    // across a second boundary, so this is the ordinary case, not a corner one.
    const later = fromLiveKitEvents([stamped('later', '10')], 'b.json');
    const sooner = fromLiveKitEvents([stamped('sooner', '9')], 'a.json');
    const merged = mergeTraces([later, sooner]);
    expect(merged.events.map((e) => e.id)).toEqual(['a.json#sooner', 'b.json#later']);
  });

  it('keeps ids apart when two exports use the same one', () => {
    const a = fromLiveKitEvents([stamped('evt-1', '1')], 'a.json');
    const b = fromLiveKitEvents([stamped('evt-1', '2')], 'b.json');
    const merged = mergeTraces([a, b]);
    expect(merged.events.map((e) => e.id)).toEqual(['a.json#evt-1', 'b.json#evt-1']);
  });

  it('refuses a merge that is only partly timestamped', () => {
    const withTs = fromLiveKitEvents([stamped('x', '1')], 'a.json');
    const without = fromLiveKitEvents([{ id: 'y', item: { role: 'user' } }], 'b.json');
    expect(() => mergeTraces([withTs, without])).toThrow(/partly ordered/);
  });

  it('warns rather than silently claiming a timeline when nothing is timestamped', () => {
    const a = fromLiveKitEvents([{ id: 'x', item: { role: 'user' } }], 'a.json');
    const b = fromLiveKitEvents([{ id: 'y', item: { role: 'user' } }], 'b.json');
    const warnings: string[] = [];
    const merged = mergeTraces([a, b], (m) => warnings.push(m));
    expect(merged.events.map((e) => e.id)).toEqual(['a.json#x', 'b.json#y']);
    expect(warnings.join('\n')).toMatch(/order the traces were passed in/);
  });

  it('leaves a single trace exactly as it was read', () => {
    const only = fromLiveKitEvents([{ id: 'x', item: { role: 'user' } }], 'a.json');
    expect(mergeTraces([only])).toBe(only);
  });
});
