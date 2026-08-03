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

/**
 * What a baseline pins for one spec.
 *
 * `decisive` is the count of meta-behaviors that returned an actual verdict
 * (`true` or `false`) rather than `na`, and it exists because the folded
 * verdict alone hides coverage loss. `fold` returns `true` when no section
 * failed and at least one passed, so a spec with six sections that decays to
 * one `true` and five `na` folds to `true` — identical, in a verdict-only
 * baseline, to the run where all six passed. Five sixths of the evidence can
 * evaporate (a renamed event type, a trace exporter dropping spans, a judge
 * that stopped finding what it needs) and the gate stays green while reporting
 * "unchanged".
 *
 * Pinning the count makes that visible without making `na` fatal on its own.
 */
export interface BaselineEntry {
  verdict: Verdict;
  decisive: number;
  total: number;
}

export interface Baseline {
  /** spec name -> pinned verdict, or the full entry with coverage. */
  behaviors: Record<string, Verdict | BaselineEntry>;
}

export interface SpecResult {
  spec: string;
  verdict: Verdict;
  counts: { true: number; false: number; na: number };
}

export type Change = 'regressed' | 'eroded' | 'improved' | 'unchanged' | 'new' | 'missing';

export interface GateEntry {
  spec: string;
  baseline: Verdict | null;
  current: Verdict | null;
  change: Change;
  /** Set on `eroded`: how much decisive coverage was lost. */
  coverage?: { baseline: number; current: number; total: number };
}

/** Verdict-only baselines (the format before coverage was pinned) still load;
 * they simply carry no coverage to compare, so erosion goes unchecked for that
 * spec until the baseline is rewritten. Reported as such rather than silently
 * treated as zero, which would make every run look like an improvement. */
function normalize(entry: Verdict | BaselineEntry): BaselineEntry | { verdict: Verdict } {
  return typeof entry === 'string' ? { verdict: entry } : entry;
}

function decisiveCount(result: SpecResult): number {
  return result.counts.true + result.counts.false;
}

export interface GateReport {
  entries: GateEntry[];
  passed: boolean;
}

/**
 * A baseline is hand-edited and committed, so it is not trusted input.
 *
 * Every comparison below is arithmetic on `RANK` and on the pinned counts. An
 * unrecognized verdict indexes `RANK` as `undefined`, so the delta is `NaN`,
 * every comparison against it is false, and the spec is reported `unchanged` —
 * the gate becomes a no-op for that behavior and says nothing. A baseline typo
 * turning the gate off silently is the exact failure this file exists to
 * prevent, so the shape is checked before it is used.
 */
export function parseBaseline(raw: unknown, path: string): Baseline {
  const behaviors = (raw as { behaviors?: unknown } | null)?.behaviors;
  if (typeof behaviors !== 'object' || behaviors === null || Array.isArray(behaviors)) {
    throw new Error(`${path}: baseline needs a "behaviors" object mapping spec name to verdict`);
  }

  for (const [spec, entry] of Object.entries(behaviors as Record<string, unknown>)) {
    const pinned = (
      typeof entry === 'string' ? { verdict: entry } : entry
    ) as Partial<BaselineEntry> | null;
    if (typeof pinned?.verdict !== 'string' || !(pinned.verdict in RANK)) {
      throw new Error(
        `${path}: baseline entry "${spec}" has verdict ${JSON.stringify(pinned?.verdict)}, expected "true", "false" or "na"`,
      );
    }
    // Counts are optional — a verdict-only entry is the older shape — but a
    // present one that is not a number compares as NaN, which reads as "no
    // erosion" and disables the coverage half of the gate just as quietly.
    if (typeof entry === 'object') {
      for (const field of ['decisive', 'total'] as const) {
        if (!Number.isFinite(pinned[field])) {
          throw new Error(
            `${path}: baseline entry "${spec}" has ${field} ${JSON.stringify(pinned[field])}, expected a number`,
          );
        }
      }
    }
  }

  return { behaviors: behaviors as Baseline['behaviors'] };
}

export function compareToBaseline(results: SpecResult[], baseline: Baseline): GateReport {
  const entries: GateEntry[] = [];
  const seen = new Set<string>();

  for (const result of results) {
    seen.add(result.spec);
    const raw = baseline.behaviors[result.spec];
    if (raw === undefined) {
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
    const expected = normalize(raw);
    const delta = RANK[result.verdict] - RANK[expected.verdict];
    if (delta < 0) {
      entries.push({
        spec: result.spec,
        baseline: expected.verdict,
        current: result.verdict,
        change: 'regressed',
      });
      continue;
    }

    // Coverage is checked even when the verdict held — that is the whole point.
    // Only when the baseline recorded it: an older verdict-only baseline has
    // nothing to compare against, and inventing a zero would read as growth.
    const current = decisiveCount(result);
    if ('decisive' in expected && current < expected.decisive) {
      entries.push({
        spec: result.spec,
        baseline: expected.verdict,
        current: result.verdict,
        change: 'eroded',
        coverage: {
          baseline: expected.decisive,
          current,
          total: result.counts.true + result.counts.false + result.counts.na,
        },
      });
      continue;
    }

    entries.push({
      spec: result.spec,
      baseline: expected.verdict,
      current: result.verdict,
      change: delta > 0 ? 'improved' : 'unchanged',
    });
  }

  // A behavior in the baseline that this run did not judge at all. Treated as a
  // failure: the usual cause is a spec being deleted or renamed, and letting
  // that pass silently means coverage can shrink to nothing while the gate
  // stays green.
  for (const [spec, expected] of Object.entries(baseline.behaviors)) {
    if (!seen.has(spec)) {
      entries.push({
        spec,
        baseline: normalize(expected).verdict,
        current: null,
        change: 'missing',
      });
    }
  }

  const passed = !entries.some(
    (e) => e.change === 'regressed' || e.change === 'missing' || e.change === 'eroded',
  );
  return { entries, passed };
}

export function toBaseline(results: SpecResult[]): Baseline {
  const behaviors: Record<string, BaselineEntry> = {};
  for (const r of [...results].sort((a, b) => a.spec.localeCompare(b.spec))) {
    behaviors[r.spec] = {
      verdict: r.verdict,
      decisive: decisiveCount(r),
      total: r.counts.true + r.counts.false + r.counts.na,
    };
  }
  return { behaviors };
}
