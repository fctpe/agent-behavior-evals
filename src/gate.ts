/**
 * Regression gating against a committed baseline.
 *
 * The baseline records the verdict each behavior held when it was last
 * accepted. A run is a regression when a behavior gets *worse*, and the order
 * that matters is `true` > `na` > `false`: losing evidence is not as bad as
 * being caught violating the spec, but it is still worse than passing, because
 * a behavior that silently stopped being exercised is a behavior nobody is
 * checking any more.
 *
 * Improvements never fail the build, but they are reported — an unrecorded
 * improvement is how a baseline quietly drifts out of date.
 */

import type { Verdict } from './fold.js';

const RANK: Record<Verdict, number> = { false: 0, na: 1, true: 2 };

export interface Baseline {
  /** spec name -> the verdict it is expected to hold. */
  behaviors: Record<string, Verdict>;
}

export interface SpecResult {
  spec: string;
  verdict: Verdict;
}

export type Change = 'regressed' | 'improved' | 'unchanged' | 'new' | 'missing';

export interface GateEntry {
  spec: string;
  baseline: Verdict | null;
  current: Verdict | null;
  change: Change;
}

export interface GateReport {
  entries: GateEntry[];
  passed: boolean;
}

export function compareToBaseline(results: SpecResult[], baseline: Baseline): GateReport {
  const entries: GateEntry[] = [];
  const seen = new Set<string>();

  for (const result of results) {
    seen.add(result.spec);
    const expected = baseline.behaviors[result.spec];
    if (expected === undefined) {
      // A new behavior cannot regress, but it must be recorded before the next
      // run can tell whether it moved.
      entries.push({
        spec: result.spec,
        baseline: null,
        current: result.verdict,
        change: 'new',
      });
      continue;
    }
    const delta = RANK[result.verdict] - RANK[expected];
    entries.push({
      spec: result.spec,
      baseline: expected,
      current: result.verdict,
      change: delta < 0 ? 'regressed' : delta > 0 ? 'improved' : 'unchanged',
    });
  }

  // A behavior in the baseline that this run did not judge at all. Treated as a
  // failure: the usual cause is a spec being deleted or renamed, and letting
  // that pass silently means coverage can shrink to nothing while the gate
  // stays green.
  for (const [spec, expected] of Object.entries(baseline.behaviors)) {
    if (!seen.has(spec)) {
      entries.push({ spec, baseline: expected, current: null, change: 'missing' });
    }
  }

  const passed = !entries.some((e) => e.change === 'regressed' || e.change === 'missing');
  return { entries, passed };
}

export function toBaseline(results: SpecResult[]): Baseline {
  const behaviors: Record<string, Verdict> = {};
  for (const r of [...results].sort((a, b) => a.spec.localeCompare(b.spec))) {
    behaviors[r.spec] = r.verdict;
  }
  return { behaviors };
}
