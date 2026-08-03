import { describe, expect, it } from 'vitest';
import { fold, type MetaJudgment } from '../src/fold.js';

function judgment(overrides: Partial<MetaJudgment>): MetaJudgment {
  return {
    title: 'section',
    verdict: 'true',
    evidenceEventIds: ['evt-1'],
    reasoning: '',
    ...overrides,
  };
}

describe('fold', () => {
  it('passes when every section passes', () => {
    const result = fold([judgment({}), judgment({})]);
    expect(result.verdict).toBe('true');
    expect(result.counts).toEqual({ true: 2, false: 0, na: 0 });
  });

  it('one violation outweighs any number of passes', () => {
    const result = fold([
      judgment({}),
      judgment({}),
      judgment({ verdict: 'false', violatedClause: 'must refuse' }),
    ]);
    expect(result.verdict).toBe('false');
  });

  it('a violation outweighs undecidable sections too', () => {
    const result = fold([
      judgment({ verdict: 'na', naReason: 'insufficient_evidence' }),
      judgment({ verdict: 'false' }),
    ]);
    expect(result.verdict).toBe('false');
  });

  it('is na only when nothing at all was decidable', () => {
    const result = fold([
      judgment({ verdict: 'na', naReason: 'not_applicable' }),
      judgment({ verdict: 'na', naReason: 'not_applicable' }),
    ]);
    expect(result.verdict).toBe('na');
    expect(result.naReason).toBe('not_applicable');
  });

  it('one decidable passing section lifts a spec out of na', () => {
    const result = fold([judgment({ verdict: 'na', naReason: 'not_applicable' }), judgment({})]);
    expect(result.verdict).toBe('true');
  });

  it('surfaces judge_error over softer na reasons', () => {
    const result = fold([
      judgment({ verdict: 'na', naReason: 'not_applicable' }),
      judgment({ verdict: 'na', naReason: 'judge_error' }),
    ]);
    expect(result.naReason).toBe('judge_error');
  });

  it('no judgments at all is na, never a pass', () => {
    const result = fold([]);
    expect(result.verdict).toBe('na');
    expect(result.naReason).toBe('insufficient_evidence');
  });
});
