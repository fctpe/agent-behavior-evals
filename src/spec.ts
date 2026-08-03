/**
 * Parsing and validation for BEHAVIOR.md, following the `.agents/behaviors/`
 * layout published by braintrustdata/agentbehavior.
 *
 * A spec is YAML frontmatter (`name`, `description`, optional `metadata`) plus a
 * Markdown body. The body convention that matters for judging: **every H2 is a
 * meta-behavior judged independently**. A spec with no H2 is a single
 * meta-behavior covering the whole body — that is the common case and it stays
 * simple.
 */

import { parse as parseYaml } from 'yaml';

export interface MetaBehavior {
  /** H2 heading, or the spec name when the body has no H2. */
  title: string;
  body: string;
}

export interface BehaviorSpec {
  name: string;
  description: string;
  metadata: Record<string, unknown>;
  body: string;
  metaBehaviors: MetaBehavior[];
  /** Directory the spec was loaded from; `references/` hangs off it. */
  dir: string;
}

export class SpecError extends Error {
  constructor(
    readonly specPath: string,
    message: string,
  ) {
    super(`${specPath}: ${message}`);
    this.name = 'SpecError';
  }
}

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function splitMetaBehaviors(body: string, fallbackTitle: string): MetaBehavior[] {
  const lines = body.split('\n');
  const sections: MetaBehavior[] = [];
  // Everything before the first H2 is the spec's primary behavior. It must be
  // its own meta-behavior: dropping it would silently discard the main body of
  // any spec that happens to add a subsection, which is exactly the kind of
  // quiet coverage loss this tool exists to catch.
  let current: MetaBehavior = { title: fallbackTitle, body: '' };
  let inFence = false;

  for (const line of lines) {
    // A '## ' inside a fenced block is code, not a heading.
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;

    const heading = inFence ? null : /^##\s+(.*\S)\s*$/.exec(line);
    if (heading?.[1]) {
      sections.push(current);
      current = { title: heading[1], body: '' };
      continue;
    }
    if (/^#\s/.test(line)) continue; // the H1 title is not content
    current.body += `${line}\n`;
  }
  sections.push(current);

  const kept = sections
    .map((s) => ({ title: s.title, body: s.body.trim() }))
    .filter((s) => s.body.length > 0);

  // A body that is nothing but headings still has to be judgeable.
  return kept.length > 0 ? kept : [{ title: fallbackTitle, body: body.trim() }];
}

export function parseSpec(source: string, specPath: string, dir: string): BehaviorSpec {
  const match = FRONTMATTER.exec(source);
  if (!match?.[1]) {
    throw new SpecError(specPath, 'missing YAML frontmatter delimited by ---');
  }

  let front: unknown;
  try {
    front = parseYaml(match[1]);
  } catch (err) {
    throw new SpecError(specPath, `frontmatter is not valid YAML: ${(err as Error).message}`);
  }
  if (typeof front !== 'object' || front === null) {
    throw new SpecError(specPath, 'frontmatter must be a mapping');
  }

  const { name, description, metadata } = front as Record<string, unknown>;

  if (typeof name !== 'string' || name.length === 0) {
    throw new SpecError(specPath, 'frontmatter needs a non-empty `name`');
  }
  if (name.length > MAX_NAME) {
    throw new SpecError(specPath, `name is ${name.length} chars, max ${MAX_NAME}`);
  }
  if (!NAME_PATTERN.test(name)) {
    throw new SpecError(specPath, `name must be lowercase and hyphen-separated, got "${name}"`);
  }
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new SpecError(specPath, 'frontmatter needs a non-empty `description`');
  }
  if (description.length > MAX_DESCRIPTION) {
    throw new SpecError(
      specPath,
      `description is ${description.length} chars, max ${MAX_DESCRIPTION}`,
    );
  }
  if (metadata !== undefined && (typeof metadata !== 'object' || metadata === null)) {
    throw new SpecError(specPath, '`metadata` must be a mapping when present');
  }

  const body = (match[2] ?? '').trim();
  if (body.length === 0) {
    throw new SpecError(specPath, 'body is empty — a spec with no body cannot be judged');
  }

  return {
    name,
    description,
    metadata: (metadata as Record<string, unknown>) ?? {},
    body,
    metaBehaviors: splitMetaBehaviors(body, name),
    dir,
  };
}
