import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSpec, SpecError } from '../src/spec.js';

const MINIMAL = `---
name: example-behavior
description: Does the thing.
---

# Example

**Intent:** the thing gets done.
`;

function parse(source: string) {
  return parseSpec(source, '/specs/example-behavior/BEHAVIOR.md', '/specs/example-behavior');
}

describe('parseSpec', () => {
  it('parses frontmatter and body', () => {
    const spec = parse(MINIMAL);
    expect(spec.name).toBe('example-behavior');
    expect(spec.description).toBe('Does the thing.');
    expect(spec.metadata).toEqual({});
  });

  it('treats a body with no H2 as one meta-behavior', () => {
    const spec = parse(MINIMAL);
    expect(spec.metaBehaviors).toHaveLength(1);
    expect(spec.metaBehaviors[0]?.title).toBe('example-behavior');
  });

  it('splits every H2 into its own meta-behavior', () => {
    const spec = parse(`${MINIMAL}
## First rule

Do this.

## Second rule

Do that.
`);
    expect(spec.metaBehaviors.map((m) => m.title)).toEqual([
      'example-behavior',
      'First rule',
      'Second rule',
    ]);
  });

  it('keeps the text before the first H2 instead of dropping it', () => {
    // Regression: an earlier version discarded the preamble entirely, so adding
    // one subsection silently deleted a spec's main body from every judgment.
    const spec = parse(`${MINIMAL}
## A subsection

Something else.
`);
    const primary = spec.metaBehaviors[0];
    expect(primary?.title).toBe('example-behavior');
    expect(primary?.body).toContain('the thing gets done');
  });

  it('does not treat the H1 title as body content', () => {
    const spec = parse(MINIMAL);
    expect(spec.metaBehaviors[0]?.body).not.toContain('# Example');
  });

  it('does not treat a ## inside a fenced block as a heading', () => {
    const spec = parse(`${MINIMAL}
## Real heading

\`\`\`markdown
## Not a heading
\`\`\`
`);
    expect(spec.metaBehaviors.map((m) => m.title)).toEqual(['example-behavior', 'Real heading']);
  });

  it.each([
    ['no frontmatter', '# Just a body'],
    ['empty name', '---\nname: ""\ndescription: x\n---\n\nbody'],
    ['uppercase name', '---\nname: Example\ndescription: x\n---\n\nbody'],
    ['underscored name', '---\nname: example_behavior\ndescription: x\n---\n\nbody'],
    ['missing description', '---\nname: example-behavior\n---\n\nbody'],
    ['blank description', '---\nname: example-behavior\ndescription: "  "\n---\n\nbody'],
    ['empty body', '---\nname: example-behavior\ndescription: x\n---\n'],
  ])('rejects %s', (_label, source) => {
    expect(() => parse(source)).toThrow(SpecError);
  });

  it('rejects an over-long name', () => {
    const long = 'a'.repeat(65);
    expect(() => parse(`---\nname: ${long}\ndescription: x\n---\n\nbody`)).toThrow(/max 64/);
  });

  it('parses the specs committed in this repo', () => {
    for (const name of ['grounded-citation-or-refuse', 'no-mutation-without-caller-identity']) {
      const dir = join(process.cwd(), '.agents', 'behaviors', name);
      const spec = parseSpec(readFileSync(join(dir, 'BEHAVIOR.md'), 'utf8'), dir, dir);
      expect(spec.name).toBe(name);
      expect(spec.metaBehaviors.length).toBeGreaterThan(0);
    }
  });
});
