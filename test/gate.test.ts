import { describe, expect, it } from 'vitest';
import { compareToBaseline, parseBaseline, type SpecResult, toBaseline } from '../src/gate.js';

/** Coverage defaults to one decided section, which is what these
 * verdict-focused cases have always implicitly assumed. */
function result(
  spec: string,
  verdict: SpecResult['verdict'],
  counts: Partial<SpecResult['counts']> = {},
): SpecResult {
  const base = verdict === 'na' ? { true: 0, false: 0, na: 1 } : { true: 1, false: 0, na: 0 };
  return { spec, verdict, counts: { ...base, ...counts } };
}

const baseline = { behaviors: { alpha: 'true', beta: 'na' } } as const;

describe('compareToBaseline', () => {
  it('passes when nothing moved', () => {
    const report = compareToBaseline([result('alpha', 'true'), result('beta', 'na')], baseline);
    expect(report.passed).toBe(true);
    expect(report.entries.every((e) => e.change === 'unchanged')).toBe(true);
  });

  it('fails when a passing behavior starts violating', () => {
    const report = compareToBaseline([result('alpha', 'false'), result('beta', 'na')], baseline);
    expect(report.passed).toBe(false);
    expect(report.entries.find((e) => e.spec === 'alpha')?.change).toBe('regressed');
  });

  it('fails when a passing behavior becomes undecidable', () => {
    // Losing evidence is a regression: a behavior nobody can check any more is
    // a behavior nobody is checking.
    const report = compareToBaseline([result('alpha', 'na'), result('beta', 'na')], baseline);
    expect(report.passed).toBe(false);
    expect(report.entries.find((e) => e.spec === 'alpha')?.change).toBe('regressed');
  });

  it('does not fail on an improvement, but reports it', () => {
    const report = compareToBaseline([result('alpha', 'true'), result('beta', 'true')], baseline);
    expect(report.passed).toBe(true);
    expect(report.entries.find((e) => e.spec === 'beta')?.change).toBe('improved');
  });

  it('fails when a baselined behavior was not judged at all', () => {
    // The usual cause is a spec deleted or renamed. Passing silently would let
    // coverage shrink to nothing while the gate stayed green.
    const report = compareToBaseline([result('alpha', 'true')], baseline);
    expect(report.passed).toBe(false);
    expect(report.entries.find((e) => e.spec === 'beta')?.change).toBe('missing');
  });

  it('records a new behavior without failing on it', () => {
    const report = compareToBaseline(
      [result('alpha', 'true'), result('beta', 'na'), result('gamma', 'false')],
      baseline,
    );
    expect(report.entries.find((e) => e.spec === 'gamma')?.change).toBe('new');
    // A brand-new violating behavior does not *regress*, but the run still
    // fails — that is enforced by the caller on the raw verdict, not here.
    expect(report.passed).toBe(true);
  });
});

describe('toBaseline', () => {
  it('sorts keys so a rewritten baseline diffs cleanly', () => {
    const written = toBaseline([result('zeta', 'true'), result('alpha', 'na')]);
    expect(Object.keys(written.behaviors)).toEqual(['alpha', 'zeta']);
  });
});

describe('coverage erosion under an unchanged verdict', () => {
  /**
   * The hole this closes: `fold` returns `true` when nothing failed and at
   * least one section passed. A spec with six sections that decays to one
   * `true` and five `na` therefore folds to `true`, identical to the run where
   * all six passed. With only the verdict pinned, five sixths of the evidence
   * could disappear and the gate reported "unchanged".
   */
  const covered = {
    behaviors: { alpha: { verdict: 'true', decisive: 6, total: 6 } },
  } as const;

  it('fails when sections stop being decided even though the verdict holds', () => {
    const report = compareToBaseline(
      [result('alpha', 'true', { true: 1, false: 0, na: 5 })],
      covered,
    );
    expect(report.passed).toBe(false);
    const entry = report.entries.find((e) => e.spec === 'alpha');
    expect(entry?.change).toBe('eroded');
    expect(entry?.baseline).toBe('true');
    expect(entry?.current).toBe('true');
    expect(entry?.coverage).toEqual({ baseline: 6, current: 1, total: 6 });
  });

  it('passes when coverage is intact', () => {
    // Negative control: an erosion check that fails on healthy runs is a check
    // that gets deleted the first week.
    const report = compareToBaseline(
      [result('alpha', 'true', { true: 6, false: 0, na: 0 })],
      covered,
    );
    expect(report.passed).toBe(true);
    expect(report.entries[0]?.change).toBe('unchanged');
  });

  it('passes when coverage grows', () => {
    const report = compareToBaseline(
      [result('alpha', 'true', { true: 8, false: 0, na: 0 })],
      covered,
    );
    expect(report.passed).toBe(true);
  });

  it('counts a false section as decided — erosion is about evidence, not passing', () => {
    // 4 true + 2 false is 6 decided, so coverage is intact; the verdict drop to
    // `false` is what fails, and it must be reported as `regressed`, not
    // `eroded`, or the message sends you looking for a broken exporter.
    const report = compareToBaseline(
      [result('alpha', 'false', { true: 4, false: 2, na: 0 })],
      covered,
    );
    expect(report.passed).toBe(false);
    expect(report.entries[0]?.change).toBe('regressed');
  });

  it('still loads a verdict-only baseline and simply cannot check erosion', () => {
    // Back-compat: an old baseline has no counts. Inventing a zero would make
    // every run look like growth, which is worse than not checking.
    const report = compareToBaseline([result('alpha', 'true', { true: 1, false: 0, na: 5 })], {
      behaviors: { alpha: 'true' },
    });
    expect(report.passed).toBe(true);
    expect(report.entries[0]?.change).toBe('unchanged');
  });

  it('writes coverage into a new baseline', () => {
    const written = toBaseline([result('alpha', 'true', { true: 3, false: 1, na: 2 })]);
    expect(written.behaviors.alpha).toEqual({ verdict: 'true', decisive: 4, total: 6 });
  });
});

describe('parseBaseline', () => {
  /**
   * Every check in this file is arithmetic, and arithmetic on a value that is
   * not there produces `NaN` rather than an error: an unrankable verdict makes
   * both `delta < 0` and `delta > 0` false, so the spec is reported
   * `unchanged` and the gate silently stops gating it.
   */
  it('rejects a verdict the gate cannot rank', () => {
    expect(() => parseBaseline({ behaviors: { alpha: 'pass' } }, 'b.json')).toThrow(/expected/);
  });

  it('rejects a baseline with no behaviors mapping', () => {
    expect(() => parseBaseline({}, 'b.json')).toThrow(/behaviors/);
    expect(() => parseBaseline([], 'b.json')).toThrow(/behaviors/);
  });

  it('rejects counts that are not numbers', () => {
    // Same silent no-op, one level down: `current < "many"` is false, so
    // erosion never fires.
    expect(() =>
      parseBaseline(
        { behaviors: { alpha: { verdict: 'true', decisive: 'many', total: 6 } } },
        'b.json',
      ),
    ).toThrow(/decisive/);
  });

  it('accepts both the verdict-only and the coverage shape', () => {
    const parsed = parseBaseline(
      { behaviors: { alpha: 'true', beta: { verdict: 'na', decisive: 0, total: 2 } } },
      'b.json',
    );
    expect(parsed.behaviors.alpha).toBe('true');
    expect(parsed.behaviors.beta).toEqual({ verdict: 'na', decisive: 0, total: 2 });
  });
});
