/**
 * Folding meta-behavior judgments into one verdict.
 *
 * This is deliberately **code, not model**. Asking the judge for an overall
 * verdict alongside the per-section ones invites it to average, to be
 * charitable, or to quietly upgrade "I could not tell" into "fine". The model
 * decides one question at a time; the arithmetic is not its job.
 *
 * The rules, in order:
 *   - any meta-behavior `false`  -> `false`  (one violation is a violation)
 *   - every meta-behavior `na`   -> `na`     (nothing was decidable)
 *   - otherwise                  -> `true`
 *
 * Note the asymmetry: a single `false` outweighs any number of `true`s, but a
 * single `true` is enough to lift a spec out of `na`. That is intentional — a
 * spec where one section was checkable and passed is not "undecidable".
 */

export type Verdict = 'true' | 'false' | 'na';

/** Why a judgment was undecidable. Typed so `na` can never be a shrug. */
export type NaReason = 'insufficient_evidence' | 'not_applicable' | 'judge_error';

export interface MetaJudgment {
  title: string;
  verdict: Verdict;
  /** Required when the verdict is `na`. */
  naReason?: NaReason;
  /** Verbatim clause from the spec that the trace violated. Only for `false`. */
  violatedClause?: string;
  /** Trace event ids the judge relied on. Empty is legitimate only for `na`. */
  evidenceEventIds: string[];
  reasoning: string;
}

export interface FoldedVerdict {
  verdict: Verdict;
  naReason?: NaReason;
  judgments: MetaJudgment[];
  counts: { true: number; false: number; na: number };
}

export function fold(judgments: MetaJudgment[]): FoldedVerdict {
  const counts = { true: 0, false: 0, na: 0 };
  for (const j of judgments) counts[j.verdict]++;

  if (judgments.length === 0) {
    return {
      verdict: 'na',
      naReason: 'insufficient_evidence',
      judgments,
      counts,
    };
  }

  if (counts.false > 0) {
    return { verdict: 'false', judgments, counts };
  }

  if (counts.na === judgments.length) {
    // Surface the most serious reason present: a judge that errored is a
    // different problem from a trace that simply had nothing to say.
    const reasons = new Set(judgments.map((j) => j.naReason ?? 'insufficient_evidence'));
    const naReason: NaReason = reasons.has('judge_error')
      ? 'judge_error'
      : reasons.has('insufficient_evidence')
        ? 'insufficient_evidence'
        : 'not_applicable';
    return { verdict: 'na', naReason, judgments, counts };
  }

  return { verdict: 'true', judgments, counts };
}
