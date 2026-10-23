import { phpmd } from './phpmd.js';
import { phpstanRun } from './phpstan.js';
import type { Bound } from './run.js';
import { shapeFindings, shapes, type Span, widen } from './shape.js';
import type { Finding } from '../../core/finding.js';

/**
 * php/lint: PHPMD, PHPStan's cognitive complexity widened to the function or class it measures
 * (so changing any line of it touches the finding), and the nesting and file-size limits.
 */
export async function lint(ctx: Bound): Promise<Finding[]> {
  const [md, stan, shaped] = await Promise.all([phpmd(ctx), phpstanRun(ctx), shapes(ctx)]);
  const spans = new Map<string, readonly Span[]>(
    shaped.flatMap((shape) => ('spans' in shape ? [[shape.file, shape.spans]] : [])),
  );
  const complexity = stan.lint.map((finding) =>
    widen(finding, spans.get(finding.location?.file ?? '') ?? []),
  );
  return [...md, ...complexity, ...shapeFindings(shaped)];
}

/** php/types: PHPStan at level max with strict-rules, Pest's plugin and, in Laravel, Larastan. */
export async function types(ctx: Bound): Promise<Finding[]> {
  return (await phpstanRun(ctx)).types;
}

/** php/deadcode: PHPStan's own unused-code rules and shipmonk's dead-code detector. */
export async function deadCode(ctx: Bound): Promise<Finding[]> {
  return (await phpstanRun(ctx)).deadcode;
}
