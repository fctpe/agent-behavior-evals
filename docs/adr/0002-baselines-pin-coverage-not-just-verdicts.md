# ADR-0002: Baselines pin coverage, and evidence guarantees are code rather than prompt text

**Status:** accepted · 2026-08-04

## Context

Two independent ways a green gate can mean nothing surfaced while the gate itself
was passing.

**1. A verdict-only baseline hides erosion.** Folding is `false` if any section
failed, `na` only if *every* section was `na`, and `true` otherwise. A spec with
six `##` sections that decays to one `true` and five `na` therefore still folds to
`true`. Pinning the verdict alone makes that indistinguishable from six passes:
five sixths of the evidence can evaporate — a renamed event type, an exporter
dropping spans, a judge that stops finding what it needs — while the gate reports
`unchanged`.

That was not hypothetical. The committed baseline was in the older verdict-only
shape until a keyed run on 2026-08-04 regenerated it, so the check described in
the README was switched off in the only file that ships. Every gate test built
its own baseline in-memory, so all of them passed over the committed one.

**2. Two evidence guarantees lived in the prompt, not in code.** The judge was
asked to cite trace event ids and, on a `false`, to quote the clause it broke.
`resolveJudgment` checked only that the id list was non-empty, which any
fabricated string satisfies — a judge that invented `evt-999` cleared the same
bar as one that read the trace, with the real events sitting in memory one line
away. And `violatedClause` is optional in the verdict schema, so a violation
could be reported without saying of what: unreviewable, and indistinguishable
from a judge deciding on vibes. Both survived because a guarantee that only runs
inside a paid live judge call is a guarantee nobody regression-tests.

## Decision

1. **Each baseline entry records how many sections returned a decisive verdict**,
   alongside the verdict. Losing coverage is its own outcome, `eroded`, which
   fails the build and prints `evidence: 6 -> 1 of 6 sections decided` — an
   `eroded` line reading `true -> true` is otherwise baffling.
2. **Verdict-only baselines still load**, carry no counts, and are *reported* as
   unchecked for erosion until a run rewrites them. Treating a missing count as
   zero would make every subsequent run look like growth.
3. **Cited event ids are resolved against the trace** in `resolveJudgment`.
   Citing an id that is not in the trace downgrades the verdict to `na`, and
   fabricated ids are stripped from the report rather than left as dead
   references in the JUnit output.
4. **A `false` verdict must name the clause it broke**, or it downgrades to `na`.
5. **Both downgrade to `na`, never to a pass and never to a fail.** An
   unsubstantiated verdict is an undecided one; turning it into `false` would let
   a sloppy judge fail someone's build.
6. **`resolveJudgment` is exported and pure**, so
   `test/judge-evidence.test.ts` attacks it offline with fabricated ids and
   clause-less violations.

## Consequences

- A test now reads the *committed* baseline itself, asserts it carries counts,
  and replays it one decided section short to confirm the gate answers `eroded`.
  That assertion only holds because the counts are there, so the file and the
  check cannot drift apart again.
- The counts in the committed baseline came from a real keyed run, not from a
  keyboard. Writing them by hand would be inventing eval data.
- Rules 3–6 are enforceable offline and free, which is the whole point: the
  guarantees no longer depend on the judge being well behaved on the day.
