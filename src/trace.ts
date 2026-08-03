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

/** Trim a value for display without hiding that it was trimmed. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}… [${value.length - max} more chars]`;
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
          id: String(span.spanId ?? span.span_id ?? `span-${events.length}`),
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
  events.sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
  return { id: traceId, source: 'otlp', events };
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
      id: String(row.id ?? `evt-${i}`),
      kind,
      name: item.name ? String(item.name) : undefined,
      content: asText(item.text_content ?? item.arguments ?? item.output ?? row.text ?? ''),
      startedAt: row.ts ? String(row.ts) : undefined,
      attributes: { type },
    };
  });
  return { id: traceId, source: 'livekit', events };
}

/** Dispatch on shape rather than making the caller declare it. */
export function readTrace(raw: unknown, traceId: string): Trace {
  const obj = raw as Record<string, unknown> | null;
  if (obj && (obj.resourceSpans || obj.resource_spans)) return fromOtlpJson(raw, traceId);
  return fromLiveKitEvents(raw, traceId);
}
