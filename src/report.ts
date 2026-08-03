/**
 * Human output and JUnit XML.
 *
 * JUnit because it is what CI already knows how to render, and a behavior
 * verdict maps onto it cleanly: `false` is a failure, `na` is skipped, `true`
 * passes. That mapping is the honest one — `na` must not be reported as green,
 * because "we could not tell" is not "it worked".
 */

import type { FoldedVerdict } from './fold.js';
import type { GateReport } from './gate.js';

export interface SpecOutcome {
  spec: string;
  description: string;
  folded: FoldedVerdict;
  costUsd: number;
  durationMs: number;
}

const MARK: Record<string, string> = { true: 'PASS', false: 'FAIL', na: ' NA ' };

export function renderConsole(outcomes: SpecOutcome[], gate: GateReport | null): string {
  const lines: string[] = [];
  const width = Math.max(20, ...outcomes.map((o) => o.spec.length));

  lines.push('');
  for (const o of outcomes) {
    const counts = o.folded.counts;
    lines.push(
      `${MARK[o.folded.verdict]}  ${o.spec.padEnd(width)}  ` +
        `${counts.true}/${counts.true + counts.false + counts.na} sections` +
        (o.folded.naReason ? `  (${o.folded.naReason})` : ''),
    );
    for (const j of o.folded.judgments) {
      if (j.verdict === 'true') continue;
      lines.push(`      ${j.verdict === 'false' ? 'x' : '?'} ${j.title}: ${j.reasoning}`);
      if (j.violatedClause) lines.push(`        violated: "${j.violatedClause}"`);
      if (j.evidenceEventIds.length > 0) {
        lines.push(`        events: ${j.evidenceEventIds.join(', ')}`);
      }
    }
  }

  const cost = outcomes.reduce((sum, o) => sum + o.costUsd, 0);
  lines.push('');
  lines.push(`${outcomes.length} behaviors judged · $${cost.toFixed(4)}`);

  if (gate) {
    const notable = gate.entries.filter((e) => e.change !== 'unchanged');
    if (notable.length > 0) {
      lines.push('');
      for (const e of notable) {
        // An `eroded` line whose verdicts read "true -> true" is baffling
        // without the counts; they are the entire reason it failed.
        const coverage = e.coverage
          ? ` (evidence: ${e.coverage.baseline} -> ${e.coverage.current} of ${e.coverage.total} sections decided)`
          : '';
        lines.push(
          `  ${e.change.padEnd(10)} ${e.spec}: ${e.baseline ?? '-'} -> ${e.current ?? '-'}${coverage}`,
        );
      }
    }
    lines.push('');
    lines.push(gate.passed ? 'gate passed' : 'gate FAILED');
  }

  return lines.join('\n');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderJUnit(outcomes: SpecOutcome[]): string {
  const failures = outcomes.filter((o) => o.folded.verdict === 'false').length;
  const skipped = outcomes.filter((o) => o.folded.verdict === 'na').length;
  const time = outcomes.reduce((sum, o) => sum + o.durationMs, 0) / 1000;

  const cases = outcomes.map((o) => {
    const name = escapeXml(o.spec);
    const seconds = (o.durationMs / 1000).toFixed(3);
    const open = `    <testcase classname="agentbehavior" name="${name}" time="${seconds}">`;

    if (o.folded.verdict === 'false') {
      const broken = o.folded.judgments.filter((j) => j.verdict === 'false');
      const detail = broken
        .map(
          (j) =>
            `${j.title}: ${j.reasoning}` +
            (j.violatedClause ? `\nviolated: "${j.violatedClause}"` : '') +
            (j.evidenceEventIds.length ? `\nevents: ${j.evidenceEventIds.join(', ')}` : ''),
        )
        .join('\n\n');
      return `${open}\n      <failure message="${escapeXml(broken[0]?.title ?? 'behavior violated')}">${escapeXml(detail)}</failure>\n    </testcase>`;
    }
    if (o.folded.verdict === 'na') {
      return `${open}\n      <skipped message="${escapeXml(o.folded.naReason ?? 'undecidable')}"/>\n    </testcase>`;
    }
    return `${open}</testcase>`;
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuites>',
    `  <testsuite name="agent-behavior-evals" tests="${outcomes.length}" failures="${failures}" skipped="${skipped}" time="${time.toFixed(3)}">`,
    ...cases,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
}
