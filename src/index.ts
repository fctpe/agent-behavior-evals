import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fold } from './fold.js';
import { compareToBaseline, parseBaseline, type SpecResult, toBaseline } from './gate.js';
import { DEFAULT_JUDGE_MODEL, judgeSpec } from './judge.js';
import { renderConsole, renderJUnit, type SpecOutcome } from './report.js';
import { type BehaviorSpec, parseSpec, SpecError } from './spec.js';
import { mergeTraces, readTrace, type Trace, TraceError } from './trace.js';

const USAGE = `behaveval — judge recorded agent traces against behavior specs

  behaveval validate <specs-dir>
      Parse and structurally validate every BEHAVIOR.md. No model calls, no key.

  behaveval judge --specs <dir> --trace <file...> [options]
      --baseline <file>   compare against a committed baseline and gate on regressions
      --update-baseline   rewrite the baseline from this run instead of gating
      --junit <file>      write a JUnit XML report
      --model <name>      judge model (default ${DEFAULT_JUDGE_MODEL})

Exit codes: 0 pass · 1 a behavior was violated or regressed · 2 usage or spec error.
`;

function loadSpecs(dir: string): BehaviorSpec[] {
  const root = resolve(dir);
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    throw new SpecError(root, 'specs directory does not exist');
  }

  const specs: BehaviorSpec[] = [];
  for (const entry of entries.sort()) {
    const specDir = join(root, entry);
    if (!statSync(specDir).isDirectory()) continue;
    const specPath = join(specDir, 'BEHAVIOR.md');
    let source: string;
    try {
      source = readFileSync(specPath, 'utf8');
    } catch {
      continue;
    }
    const spec = parseSpec(source, specPath, specDir);
    if (spec.name !== entry) {
      throw new SpecError(specPath, `name "${spec.name}" does not match directory "${entry}"`);
    }
    specs.push(spec);
  }
  return specs;
}

function loadTraces(paths: string[]): Trace[] {
  return paths.map((p) => {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    return readTrace(raw, basename(p));
  });
}

async function cmdValidate(dir: string): Promise<number> {
  const specs = loadSpecs(dir);
  if (specs.length === 0) {
    console.error(`No BEHAVIOR.md found under ${resolve(dir)}`);
    return 2;
  }
  for (const spec of specs) {
    const sections = spec.metaBehaviors.length;
    console.error(`ok  ${spec.name}  (${sections} ${sections === 1 ? 'section' : 'sections'})`);
  }
  console.error(`\n${specs.length} specs valid`);
  return 0;
}

async function cmdJudge(args: {
  specs: string;
  traces: string[];
  baseline?: string;
  updateBaseline: boolean;
  junit?: string;
  model?: string;
}): Promise<number> {
  const specs = loadSpecs(args.specs);
  if (specs.length === 0) {
    console.error(`No BEHAVIOR.md found under ${resolve(args.specs)}`);
    return 2;
  }
  const trace = mergeTraces(loadTraces(args.traces), (message) => console.error(message));
  // Fail closed on a file the adapters found nothing in — a mistyped path, an
  // artifact that never got written, a shape neither reader recognizes. Judging
  // it costs nothing and reports every behavior `na`, which exits 0 and, under
  // a baseline, reads as an improvement. A green run over a trace that was
  // never read is precisely what this tool exists to catch.
  if (trace.events.length === 0) {
    console.error(
      `No events read from ${args.traces.join(', ')} — expected OTLP/JSON (resourceSpans) or a LiveKit event list.`,
    );
    return 2;
  }

  // Read before judging, not after. Every input this run depends on is now
  // checked while the run is still free — a mistyped --baseline path used to
  // surface after the whole trace had been judged, at ~$0.35 a go.
  const baseline =
    args.baseline && !args.updateBaseline
      ? parseBaseline(JSON.parse(readFileSync(args.baseline, 'utf8')), args.baseline)
      : null;

  const outcomes: SpecOutcome[] = [];
  for (const spec of specs) {
    const startedAt = Date.now();
    const { judgments, costUsd } = await judgeSpec(spec, trace, { model: args.model });
    outcomes.push({
      spec: spec.name,
      description: spec.description,
      folded: fold(judgments),
      costUsd,
      durationMs: Date.now() - startedAt,
    });
  }

  const results: SpecResult[] = outcomes.map((o) => ({
    spec: o.spec,
    verdict: o.folded.verdict,
    // Carried so the gate can catch coverage erosion under an unchanged verdict.
    counts: o.folded.counts,
  }));

  const gate = baseline ? compareToBaseline(results, baseline) : null;

  console.error(renderConsole(outcomes, gate));

  // Written on every path that judged something, including --update-baseline:
  // the report of the run a baseline came from is the one worth keeping, and a
  // flag that is silently ignored in one mode is worse than one that is absent.
  if (args.junit) {
    writeFileSync(args.junit, renderJUnit(outcomes));
    console.error(`wrote ${args.junit}`);
  }

  if (args.updateBaseline && args.baseline) {
    writeFileSync(args.baseline, `${JSON.stringify(toBaseline(results), null, 2)}\n`);
    console.error(`wrote baseline ${args.baseline}`);
    return 0;
  }

  // A violated behavior fails whether or not a baseline is in play. `na` does
  // not fail on its own — it is reported as skipped — but it fails the gate if
  // the behavior used to pass, which is handled in compareToBaseline.
  if (outcomes.some((o) => o.folded.verdict === 'false')) return 1;
  if (gate && !gate.passed) return 1;
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === '--help' || command === '-h') {
    console.error(USAGE);
    return command ? 0 : 2;
  }

  try {
    if (command === 'validate') {
      const dir = rest[0];
      if (!dir) {
        console.error(USAGE);
        return 2;
      }
      return await cmdValidate(dir);
    }

    if (command === 'judge') {
      const { values } = parseArgs({
        args: rest,
        options: {
          specs: { type: 'string' },
          trace: { type: 'string', multiple: true },
          baseline: { type: 'string' },
          'update-baseline': { type: 'boolean', default: false },
          junit: { type: 'string' },
          model: { type: 'string' },
        },
      });
      if (!values.specs || !values.trace?.length) {
        console.error(USAGE);
        return 2;
      }
      if (values['update-baseline'] && !values.baseline) {
        console.error('--update-baseline needs --baseline <file>');
        return 2;
      }
      return await cmdJudge({
        specs: values.specs,
        traces: values.trace,
        baseline: values.baseline,
        updateBaseline: values['update-baseline'] ?? false,
        junit: values.junit,
        model: values.model,
      });
    }

    console.error(`Unknown command "${command}"\n\n${USAGE}`);
    return 2;
  } catch (err) {
    if (err instanceof SpecError) {
      console.error(`spec error: ${err.message}`);
      return 2;
    }
    // Exit 2, not 1. A trace the reader cannot cite against is a bad input, and
    // reporting it as a behavior violation would put a failure on the agent
    // that belongs to the artifact.
    if (err instanceof TraceError) {
      console.error(`trace error: ${err.message}`);
      return 2;
    }
    console.error(`${(err as Error).message}`);
    return 2;
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
