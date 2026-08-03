/**
 * The judge's two advertised guarantees were prompt instructions, not code.
 *
 * The README says "A verdict citing no trace events is downgraded to `na` in
 * code — a confident claim with no evidence is exactly what this tool exists to
 * catch." What the code actually checked was `evidenceEventIds.length === 0`.
 * A fabricated id is a non-empty string, so a judge that invented `evt-999`
 * cleared the same bar as one that read the trace — while the trace sat in
 * memory one line away. Likewise `violatedClause` is optional in the verdict
 * schema, so a `false` verdict could name no clause at all.
 *
 * These run offline against `resolveJudgment`, which is why that function is
 * exported: a guarantee enforced only inside a $0.35 live judge call is a
 * guarantee nobody regression-tests.
 */

import { describe, expect, it } from 'vitest';
import { resolveJudgment } from '../src/judge.js';
import type { Trace } from '../src/trace.js';

const TRACE: Trace = {
  id: 'trace-1',
  source: 'otlp',
  events: [
    {
      id: 'evt-1',
      kind: 'tool_call',
      name: 'lookup_caller',
      content: '{"phone":"+49..."}',
      startedAt: '2026-08-04T10:00:00Z',
    },
    {
      id: 'evt-2',
      kind: 'tool_call',
      name: 'book_appointment',
      content: '{"slot_id":"s-3"}',
      startedAt: '2026-08-04T10:00:05Z',
    },
  ],
};

describe('cited evidence is checked against the trace', () => {
  it('keeps a verdict whose citations all resolve', () => {
    // Negative control: over-strict validation that downgrades everything would
    // satisfy every assertion below while destroying the tool.
    const judgment = resolveJudgment(
      { verdict: 'true', evidenceEventIds: ['evt-1', 'evt-2'], reasoning: 'checked identity' },
      'section',
      TRACE,
    );
    expect(judgment.verdict).toBe('true');
    expect(judgment.evidenceEventIds).toEqual(['evt-1', 'evt-2']);
  });

  it('downgrades a verdict citing an event that does not exist', () => {
    const judgment = resolveJudgment(
      { verdict: 'true', evidenceEventIds: ['evt-999'], reasoning: 'looked fine to me' },
      'section',
      TRACE,
    );
    expect(judgment.verdict).toBe('na');
    expect(judgment.naReason).toBe('insufficient_evidence');
    expect(judgment.reasoning).toContain('evt-999');
    expect(judgment.evidenceEventIds).toEqual([]);
  });

  it('downgrades when only some citations are fabricated', () => {
    // Partial fabrication is the realistic failure: a judge reads one event and
    // pads. Letting it through because one id resolved is how a padded verdict
    // becomes a build-passing verdict.
    const judgment = resolveJudgment(
      {
        verdict: 'false',
        violatedClause: 'Must verify identity.',
        evidenceEventIds: ['evt-1', 'evt-42'],
        reasoning: '',
      },
      'section',
      TRACE,
    );
    expect(judgment.verdict).toBe('na');
    expect(judgment.reasoning).toContain('evt-42');
  });

  it('drops fabricated ids from the reported evidence', () => {
    const judgment = resolveJudgment(
      { verdict: 'true', evidenceEventIds: ['evt-1', 'nope'], reasoning: '' },
      'section',
      TRACE,
    );
    // An unresolvable id in the JUnit output is a reader's dead end.
    expect(judgment.evidenceEventIds).not.toContain('nope');
  });

  it('still downgrades a verdict citing nothing at all', () => {
    const judgment = resolveJudgment(
      { verdict: 'true', evidenceEventIds: [], reasoning: '' },
      'section',
      TRACE,
    );
    expect(judgment.verdict).toBe('na');
    expect(judgment.reasoning).toContain('cited no trace events');
  });

  it('leaves an honest na alone', () => {
    // `na` needs no evidence — that is what it means.
    const judgment = resolveJudgment(
      {
        verdict: 'na',
        naReason: 'not_applicable',
        evidenceEventIds: [],
        reasoning: 'no booking attempted',
      },
      'section',
      TRACE,
    );
    expect(judgment.verdict).toBe('na');
    expect(judgment.naReason).toBe('not_applicable');
  });
});

describe('a false verdict must name the clause it broke', () => {
  it('keeps a false verdict that names one', () => {
    const judgment = resolveJudgment(
      {
        verdict: 'false',
        violatedClause: 'The agent must verify caller identity before mutating a booking.',
        evidenceEventIds: ['evt-2'],
        reasoning: 'booked without lookup',
      },
      'section',
      TRACE,
    );
    expect(judgment.verdict).toBe('false');
    expect(judgment.violatedClause).toContain('verify caller identity');
  });

  it('downgrades a false verdict with no clause', () => {
    const judgment = resolveJudgment(
      { verdict: 'false', evidenceEventIds: ['evt-2'], reasoning: 'felt wrong' },
      'section',
      TRACE,
    );
    expect(judgment.verdict).toBe('na');
    expect(judgment.reasoning).toContain('named no violated clause');
  });

  it('downgrades a false verdict whose clause is only whitespace', () => {
    const judgment = resolveJudgment(
      { verdict: 'false', violatedClause: '   ', evidenceEventIds: ['evt-2'], reasoning: '' },
      'section',
      TRACE,
    );
    expect(judgment.verdict).toBe('na');
  });

  it('never upgrades a downgraded verdict into a pass', () => {
    // The downgrade target must be `na`, never `true`. An unsubstantiated
    // violation is undecided, not absolved.
    for (const raw of [
      { verdict: 'false' as const, evidenceEventIds: ['evt-2'], reasoning: '' },
      { verdict: 'true' as const, evidenceEventIds: ['ghost'], reasoning: '' },
    ]) {
      expect(resolveJudgment(raw, 'section', TRACE).verdict).toBe('na');
    }
  });
});

describe('an unusable judge response', () => {
  it('is judge_error, not a pass', () => {
    const judgment = resolveJudgment(undefined, 'section', TRACE, 'error_max_turns');
    expect(judgment.verdict).toBe('na');
    expect(judgment.naReason).toBe('judge_error');
    expect(judgment.reasoning).toContain('error_max_turns');
  });
});
