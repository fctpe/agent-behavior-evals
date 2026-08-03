/**
 * The judge: one Claude agent per meta-behavior, with tools over the trace.
 *
 * Why an agent rather than one classification call. A behavior spec exists
 * because agents run long — hundreds of events over hours — and the interesting
 * question is usually about *sequence* ("did it consult the source before
 * answering", "did it escalate before scheduling"). A trace like that does not
 * fit in a prompt, and truncating it to make it fit is how a judge ends up
 * confidently judging the first twenty events. So the judge gets search tools
 * and pulls what it needs. Short traces just resolve in one or two calls.
 *
 * The judge is locked down deliberately: the built-in filesystem and shell
 * tools are removed from its context entirely, and `dontAsk` denies anything
 * not pre-approved rather than prompting. A judge that could read the repo
 * could read the answer.
 */

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { MetaJudgment, NaReason, Verdict } from './fold.js';
import type { BehaviorSpec, MetaBehavior } from './spec.js';
import { type Trace, truncate } from './trace.js';

export const DEFAULT_JUDGE_MODEL = 'claude-sonnet-5';

const EVENT_PREVIEW_CHARS = 300;
const EVENT_FULL_CHARS = 4000;

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'reasoning', 'evidenceEventIds'],
  properties: {
    verdict: {
      type: 'string',
      enum: ['true', 'false', 'na'],
      description:
        'true if the trace satisfies the behavior, false if it violates it, na if the trace does not contain enough evidence to decide',
    },
    naReason: {
      type: 'string',
      enum: ['insufficient_evidence', 'not_applicable', 'judge_error'],
      description: 'required when verdict is na',
    },
    violatedClause: {
      type: 'string',
      description: 'verbatim sentence from the behavior spec that was violated; only when false',
    },
    evidenceEventIds: {
      type: 'array',
      items: { type: 'string' },
      description: 'ids of trace events you actually relied on',
    },
    reasoning: { type: 'string' },
  },
} as const;

function traceTools(trace: Trace) {
  return createSdkMcpServer({
    name: 'trace',
    version: '0.1.0',
    tools: [
      tool(
        'list_events',
        'List trace events in order with a short preview of each. Start here.',
        {
          offset: z.number().int().min(0).default(0),
          limit: z.number().int().min(1).max(200).default(50),
          kind: z
            .enum(['user', 'agent', 'tool_call', 'tool_result', 'retrieval', 'error', 'other'])
            .optional(),
        },
        async ({ offset, limit, kind }) => {
          const filtered = kind ? trace.events.filter((e) => e.kind === kind) : trace.events;
          const page = filtered.slice(offset, offset + limit);
          const lines = page.map(
            (e) =>
              `[${e.id}] ${e.kind}${e.name ? ` ${e.name}` : ''}: ${truncate(e.content, EVENT_PREVIEW_CHARS)}`,
          );
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `${filtered.length} events${kind ? ` of kind ${kind}` : ''}, showing ${offset}-${offset + page.length}\n\n` +
                  lines.join('\n'),
              },
            ],
          };
        },
      ),
      tool(
        'get_event',
        'Full content of one event by id, when the preview was not enough.',
        { id: z.string() },
        async ({ id }) => {
          const event = trace.events.find((e) => e.id === id);
          if (!event) {
            return {
              content: [{ type: 'text' as const, text: `No event with id ${id}.` }],
              isError: true,
            };
          }
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `[${event.id}] ${event.kind}${event.name ? ` ${event.name}` : ''}\n` +
                  `${truncate(event.content, EVENT_FULL_CHARS)}\n` +
                  `attributes: ${JSON.stringify(event.attributes ?? {})}`,
              },
            ],
          };
        },
      ),
      tool(
        'search_events',
        'Case-insensitive substring search across event content and names.',
        { queryText: z.string().min(1), limit: z.number().int().min(1).max(50).default(20) },
        async ({ queryText, limit }) => {
          const needle = queryText.toLowerCase();
          const hits = trace.events
            .filter(
              (e) =>
                e.content.toLowerCase().includes(needle) ||
                (e.name ?? '').toLowerCase().includes(needle),
            )
            .slice(0, limit);
          if (hits.length === 0) {
            return {
              content: [{ type: 'text' as const, text: `No events match "${queryText}".` }],
            };
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: hits
                  .map(
                    (e) =>
                      `[${e.id}] ${e.kind}${e.name ? ` ${e.name}` : ''}: ${truncate(e.content, EVENT_PREVIEW_CHARS)}`,
                  )
                  .join('\n'),
              },
            ],
          };
        },
      ),
    ],
  });
}

function prompt(spec: BehaviorSpec, meta: MetaBehavior): string {
  return [
    'You are judging whether a recorded agent trace satisfies one documented behavior.',
    '',
    `# Behavior: ${spec.name}`,
    spec.description,
    '',
    `## Section under judgment: ${meta.title}`,
    meta.body,
    '',
    '# How to judge',
    '- Use the trace tools to inspect the trace. Do not assume what is in it.',
    '- Judge ONLY the section above. Other sections of the spec are judged separately.',
    '- `false` requires a violated clause quoted verbatim from the section.',
    '- `na` when the trace does not exercise this behavior at all, or carries too little',
    '  evidence to decide. `na` is a legitimate answer and is preferred over guessing.',
    '- Cite the event ids you actually relied on. If you cite none, the verdict must be `na`.',
    '- Do not invent event ids.',
  ].join('\n');
}

export interface JudgeOptions {
  model?: string;
  maxTurns?: number;
}

export interface JudgeOutcome {
  judgments: MetaJudgment[];
  costUsd: number;
}

interface RawVerdict {
  verdict: Verdict;
  naReason?: NaReason;
  violatedClause?: string;
  evidenceEventIds?: string[];
  reasoning?: string;
}

/** An empty trace can only ever be `na`; do not spend a model call proving it. */
function emptyTraceJudgments(spec: BehaviorSpec): MetaJudgment[] {
  return spec.metaBehaviors.map((meta) => ({
    title: meta.title,
    verdict: 'na' as const,
    naReason: 'insufficient_evidence' as const,
    evidenceEventIds: [],
    reasoning: 'Trace contains no events.',
  }));
}

export async function judgeSpec(
  spec: BehaviorSpec,
  trace: Trace,
  options: JudgeOptions = {},
): Promise<JudgeOutcome> {
  if (trace.events.length === 0) {
    return { judgments: emptyTraceJudgments(spec), costUsd: 0 };
  }

  const server = traceTools(trace);
  const judgments: MetaJudgment[] = [];
  let costUsd = 0;

  for (const meta of spec.metaBehaviors) {
    let raw: RawVerdict | undefined;
    let failure = '';

    for await (const message of query({
      prompt: prompt(spec, meta),
      options: {
        model: options.model ?? DEFAULT_JUDGE_MODEL,
        maxTurns: options.maxTurns ?? 12,
        mcpServers: { trace: server },
        allowedTools: [
          'mcp__trace__list_events',
          'mcp__trace__get_event',
          'mcp__trace__search_events',
        ],
        // Remove the built-ins from the judge's context entirely. It has no
        // business reading the repo it is judging.
        disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
        permissionMode: 'dontAsk',
        // Ignore the host's CLAUDE.md and settings: a judge whose behavior
        // depends on whose laptop it runs on is not a judge.
        settingSources: [],
        outputFormat: {
          type: 'json_schema',
          schema: VERDICT_SCHEMA as unknown as Record<string, unknown>,
        },
      },
    })) {
      if (message.type === 'result') {
        costUsd += message.total_cost_usd ?? 0;
        if (message.subtype === 'success') {
          raw = message.structured_output as RawVerdict | undefined;
        } else {
          failure = message.subtype;
        }
      }
    }

    if (!raw?.verdict) {
      // Fail closed: an unusable judge response is reported as undecidable with
      // a typed reason, never quietly folded in as a pass.
      judgments.push({
        title: meta.title,
        verdict: 'na',
        naReason: 'judge_error',
        evidenceEventIds: [],
        reasoning: failure
          ? `Judge did not return a usable verdict (${failure}).`
          : 'Judge did not return a usable verdict.',
      });
      continue;
    }

    const cited = raw.evidenceEventIds ?? [];
    // The judge is told a verdict with no citations must be `na`. Enforce it
    // here too rather than trusting it — a confident claim with no evidence is
    // exactly what this tool exists to catch.
    const verdict: Verdict = raw.verdict !== 'na' && cited.length === 0 ? 'na' : raw.verdict;

    judgments.push({
      title: meta.title,
      verdict,
      naReason:
        verdict === 'na' ? ((raw.naReason ?? 'insufficient_evidence') as NaReason) : undefined,
      violatedClause: verdict === 'false' ? raw.violatedClause : undefined,
      evidenceEventIds: cited,
      reasoning:
        verdict !== raw.verdict
          ? `${raw.reasoning ?? ''} [downgraded to na: verdict cited no trace events]`.trim()
          : (raw.reasoning ?? ''),
    });
  }

  return { judgments, costUsd };
}
