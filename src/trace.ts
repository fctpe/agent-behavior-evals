/**
 * One normalized trace shape, with thin adapters onto it.
 *
 * The point of normalizing is that a behavior spec should not care whether the
 * agent it judges was a LangGraph run, a LiveKit session, or anything that
 * emits OpenTelemetry. Adapters stay deliberately thin: they map fields, they
 * do not interpret. Anything clever belongs in the judge, where it is visible.
 */

export interface TraceEvent {
  /** Stable within a trace. The judge cites these, so they must not be indices. */
  id: string;
  /** Coarse kind, used for cheap filtering before the judge sees anything. */
  kind: 'user' | 'agent' | 'tool_call' | 'tool_result' | 'retrieval' | 'error' | 'other';
  name?: string;
  content: string;
  startedAt?: string;
  attributes?: Record<string, unknown>;
}

export interface Trace {
  id: string;
  source: string;
  events: TraceEvent[];
}

/** Raised when a trace cannot support the citations the judge is asked for. */
export class TraceError extends Error {
  constructor(
    readonly traceId: string,
    message: string,
  ) {
    super(`${traceId}: ${message}`);
    this.name = 'TraceError';
  }
}

/** Trim a value for display without hiding that it was trimmed. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}… [${value.length - max} more chars]`;
}

/**
 * Order two timestamps that may be unix nanoseconds, unix seconds, or ISO
 * strings. String comparison alone was wrong for the numeric cases: `"9"` sorts
 * after `"10"`, so a span at 9e17ns landed after one at 1.0e18ns whenever the
 * digit counts differed.
 */
function compareStamps(a: string | undefined, b: string | undefined): number {
  const left = Number(a);
  const right = Number(b);
  if (Number.isFinite(left) && Number.isFinite(right)) {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return (a ?? '').localeCompare(b ?? '');
}

/**
 * Every event id must be unique within a trace, because the judge cites them
 * and `get_event` resolves a citation with `find` — first match wins. Two
 * events sharing an id meant a verdict could quote one and point at the other,
 * with nothing anywhere reporting the substitution. Ambiguous evidence is worse
 * than absent evidence: it reads as a supported claim.
 */
function assertUniqueIds(trace: Trace): Trace {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const event of trace.events) {
    if (seen.has(event.id)) duplicates.add(event.id);
    seen.add(event.id);
  }
  if (duplicates.size > 0) {
    throw new TraceError(
      trace.id,
      `duplicate event ids (${[...duplicates].sort().join(', ')}). The judge cites ids as ` +
        'evidence, so they have to identify one event each.',
    );
  }
  return trace;
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

// --- OpenTelemetry -------------------------------------------------------
// Accepts the OTLP/JSON export shape produced by the OTel work in the sibling
// repos. GenAI semantic-convention attributes (gen_ai.*) are still Development
// status upstream, so the reader tolerates their absence rather than assuming
// a shape that is not yet stable.

interface OtlpAttribute {
  key: string;
  value?: Record<string, unknown>;
}

function flattenOtlpAttributes(attrs: OtlpAttribute[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const attr of attrs ?? []) {
    const v = attr.value ?? {};
    out[attr.key] =
      v.stringValue ?? v.intValue ?? v.boolValue ?? v.doubleValue ?? v.arrayValue ?? null;
  }
  return out;
}

function otlpKind(spanName: string, attrs: Record<string, unknown>): TraceEvent['kind'] {
  if (attrs['gen_ai.tool.name']) return 'tool_call';
  const op = String(attrs['gen_ai.operation.name'] ?? '');
  if (op === 'chat' || op === 'generate_content') return 'agent';
  if (/retriev|search|embed/i.test(spanName)) return 'retrieval';
  return 'other';
}

export function fromOtlpJson(raw: unknown, traceId: string): Trace {
  const events: TraceEvent[] = [];
  const resourceSpans =
    (raw as { resourceSpans?: unknown[] })?.resourceSpans ??
    (raw as { resource_spans?: unknown[] })?.resource_spans ??
    [];

  for (const rs of resourceSpans as Record<string, unknown>[]) {
    const scopeSpans = (rs.scopeSpans ?? rs.scope_spans ?? []) as Record<string, unknown>[];
    for (const ss of scopeSpans) {
      for (const span of (ss.spans ?? []) as Record<string, unknown>[]) {
        const attributes = flattenOtlpAttributes(span.attributes as OtlpAttribute[]);
        const name = String(span.name ?? 'span');
        events.push({
          // The synthesized fallback is namespaced by trace. `span-0` in two
          // files merged together used to be two different events with one id.
          id: String(span.spanId ?? span.span_id ?? `${traceId}#span-${events.length}`),
          kind: otlpKind(name, attributes),
          name,
          content: asText(attributes['gen_ai.tool.arguments'] ?? attributes.body ?? name),
          startedAt: span.startTimeUnixNano ? String(span.startTimeUnixNano) : undefined,
          attributes,
        });
      }
    }
  }

  // OTLP does not guarantee span order; the judge reasons about sequence.
  events.sort((a, b) => compareStamps(a.startedAt, b.startedAt));
  return assertUniqueIds({ id: traceId, source: 'otlp', events });
}

// --- LiveKit eval events -------------------------------------------------
// The shape voice-desk-agent's harness records: a flat list of session events
// where function calls carry an `item.name`.

export function fromLiveKitEvents(raw: unknown, traceId: string): Trace {
  const rows = Array.isArray(raw) ? raw : ((raw as { events?: unknown[] })?.events ?? []);
  const events: TraceEvent[] = (rows as Record<string, unknown>[]).map((row, i) => {
    const item = (row.item ?? {}) as Record<string, unknown>;
    const type = String(row.type ?? '');
    const role = String(item.role ?? '');

    let kind: TraceEvent['kind'] = 'other';
    if (type.includes('function_call_output')) kind = 'tool_result';
    else if (type.includes('function_call')) kind = 'tool_call';
    else if (role === 'user') kind = 'user';
    else if (role === 'assistant') kind = 'agent';

    return {
      // Namespaced fallback, same reason as the OTLP one: two LiveKit exports
      // both start at `evt-0`.
      id: String(row.id ?? `${traceId}#evt-${i}`),
      kind,
      name: item.name ? String(item.name) : undefined,
      content: asText(item.text_content ?? item.arguments ?? item.output ?? row.text ?? ''),
      startedAt: row.ts ? String(row.ts) : undefined,
      attributes: { type },
    };
  });
  return assertUniqueIds({ id: traceId, source: 'livekit', events });
}

/**
 * Merge several traces into one timeline.
 *
 * Two things were wrong with concatenating them. Ids are namespaced now,
 * because two exports can legitimately carry the same span or event id and the
 * judge would then cite one and be shown the other. And order is established
 * rather than inherited: `flatMap` produced whatever sequence the files were
 * listed in, so a verdict like "cancelled before verifying identity" could rest
 * entirely on the order of the `--trace` flags.
 *
 * When every event is timestamped they are interleaved properly. When none are,
 * argument order is all there is; that is allowed, but the caller is told, so a
 * sequence-dependent verdict is not read as measured. A mix of the two is
 * refused outright — it looks ordered and is not, which is the worst of the
 * three.
 */
export function mergeTraces(traces: Trace[], warn: (message: string) => void = () => {}): Trace {
  const present = traces.filter((t): t is Trace => Boolean(t));
  if (present.length === 1 && present[0]) return present[0];

  const id = present.map((t) => t.id).join('+');
  const events = present.flatMap((trace) =>
    trace.events.map((event) => ({ ...event, id: `${trace.id}#${event.id}` })),
  );

  const stamped = events.filter((e) => e.startedAt !== undefined).length;
  if (stamped === events.length && events.length > 0) {
    events.sort((a, b) => compareStamps(a.startedAt, b.startedAt));
  } else if (stamped > 0) {
    throw new TraceError(
      id,
      `${stamped} of ${events.length} events are timestamped. A partly ordered merge cannot be ` +
        'interleaved and must not be presented as a timeline — export timestamps, or judge the ' +
        'traces one at a time.',
    );
  } else {
    warn(
      `${id}: no event timestamps, so the merged order is the order the traces were passed in. ` +
        'Any verdict that turns on sequence is only as good as that ordering.',
    );
  }

  return assertUniqueIds({
    id,
    source: [...new Set(present.map((t) => t.source))].join('+'),
    events,
  });
}

/** Dispatch on shape rather than making the caller declare it. */
export function readTrace(raw: unknown, traceId: string): Trace {
  const obj = raw as Record<string, unknown> | null;
  if (obj && (obj.resourceSpans || obj.resource_spans)) return fromOtlpJson(raw, traceId);
  return fromLiveKitEvents(raw, traceId);
}
