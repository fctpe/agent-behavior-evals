import { describe, expect, it } from 'vitest';
import { compareToBaseline, toBaseline } from '../src/gate.js';

const baseline = { behaviors: { alpha: 'true', beta: 'na' } } as const;

describe('compareToBaseline', () => {
  it('passes when nothing moved', () => {
    const report = compareToBaseline(
      [
        { spec: 'alpha', verdict: 'true' },
        { spec: 'beta', verdict: 'na' },
      ],
      baseline,
    );
    expect(report.passed).toBe(true);
    expect(report.entries.every((e) => e.change === 'unchanged')).toBe(true);
  });

  it('fails when a passing behavior starts violating', () => {
    const report = compareToBaseline(
      [
        { spec: 'alpha', verdict: 'false' },
        { spec: 'beta', verdict: 'na' },
      ],
      baseline,
    );
    expect(report.passed).toBe(false);
    expect(report.entries.find((e) => e.spec === 'alpha')?.change).toBe('regressed');
  });

  it('fails when a passing behavior becomes undecidable', () => {
    // Losing evidence is a regression: a behavior nobody can check any more is
    // a behavior nobody is checking.
    const report = compareToBaseline(
      [
        { spec: 'alpha', verdict: 'na' },
        { spec: 'beta', verdict: 'na' },
      ],
      baseline,
    );
    expect(report.passed).toBe(false);
    expect(report.entries.find((e) => e.spec === 'alpha')?.change).toBe('regressed');
  });

  it('does not fail on an improvement, but reports it', () => {
    const report = compareToBaseline(
      [
        { spec: 'alpha', verdict: 'true' },
        { spec: 'beta', verdict: 'true' },
      ],
      baseline,
    );
    expect(report.passed).toBe(true);
    expect(report.entries.find((e) => e.spec === 'beta')?.change).toBe('improved');
  });

  it('fails when a baselined behavior was not judged at all', () => {
    // The usual cause is a spec deleted or renamed. Passing silently would let
    // coverage shrink to nothing while the gate stayed green.
    const report = compareToBaseline([{ spec: 'alpha', verdict: 'true' }], baseline);
    expect(report.passed).toBe(false);
    expect(report.entries.find((e) => e.spec === 'beta')?.change).toBe('missing');
  });

  it('records a new behavior without failing on it', () => {
    const report = compareToBaseline(
      [
        { spec: 'alpha', verdict: 'true' },
        { spec: 'beta', verdict: 'na' },
        { spec: 'gamma', verdict: 'false' },
      ],
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
    const written = toBaseline([
      { spec: 'zeta', verdict: 'true' },
      { spec: 'alpha', verdict: 'na' },
    ]);
    expect(Object.keys(written.behaviors)).toEqual(['alpha', 'zeta']);
  });
});
