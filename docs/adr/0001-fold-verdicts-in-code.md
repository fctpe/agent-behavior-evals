# ADR-0001: Fold meta-behavior verdicts in code, not in the model

**Status:** accepted · 2026-08-03

## Context

A behavior spec can carry several `##` sections, each a separate claim about how the agent
should act. Something has to turn per-section judgments into one verdict for the spec.

The obvious shortcut is to ask the judge for both: score each section *and* give an overall
verdict. It is one call instead of an aggregation step, and the model has all the context.

## Decision

The model decides one section at a time and nothing else. The aggregation lives in
`src/fold.ts` as pure code:

- any section `false` → `false`
- every section `na` → `na`, carrying the most serious reason present
- otherwise → `true`

A verdict that cites no trace events is downgraded to `na` in code, regardless of what the
model said.

## Consequences

A model asked for an overall verdict averages. It weighs three passes against one violation
and lands somewhere reasonable-sounding, and it treats "I could not tell" as close enough to
"fine" — which is the exact failure this tool exists to catch. Arithmetic is not a judgment
call, so it should not be delegated to something that can be persuaded.

The cost is one model call per section rather than per spec, which is the largest single
driver of what a run costs. That is accepted: a cheaper verdict nobody can trust is not
cheaper.

The `na` rules are deliberately asymmetric — one `false` outweighs any number of passes, but
one `true` lifts a spec out of `na`. A spec where one section was checkable and passed is
not "undecidable", and reporting it as such would train the reader to ignore `na`.
