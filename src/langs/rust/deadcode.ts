import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compiled, toFinding } from './compile.js';
import { DEAD_CODE } from './lint.js';
import { dependencyLine, parseMachete, type Unused } from './machete.js';
import { componentDir, inComponent, isInside, relativeTo } from './paths.js';
import { type Bound, failed, runIn } from './run.js';
import type { Finding } from '../../core/finding.js';

/**
 * cargo-machete over the component. `--with-metadata` names each dependency's library the way
 * Cargo does, so a renamed library isn't reported; it can't touch Cargo.lock, which `install()`
 * has already checked is current.
 */
async function machete(ctx: Bound): Promise<Unused[]> {
  const tool = await ctx.tools.path('cargo-machete');
  const result = await runIn(ctx, tool, ['--with-metadata', '--skip-target-dir', '.']);
  if (result.code > 1) throw failed('cargo-machete', result);
  const unused = parseMachete(result.stdout);
  if (result.code === 1 && unused.length === 0) throw failed('cargo-machete', result);
  return unused;
}

async function unusedFinding(ctx: Bound, unused: Unused): Promise<Finding | undefined> {
  const dir = componentDir(ctx);
  const file = relativeTo(ctx.root, dir, unused.manifest);
  if (!isInside(file) || !ctx.facts.files.includes(file)) return undefined;
  const text = await readFile(join(ctx.root, file), 'utf8').catch(() => '');
  return {
    rule: 'cargo-machete/unused-dependency',
    message: `${unused.crate} depends on ${unused.dependency}, which its code never uses.`,
    location: { file, line: dependencyLine(text, unused.dependency) },
    docs: 'https://github.com/bnjbvr/cargo-machete',
  };
}

/**
 * Code nothing uses, from the same compiler run as rust/lint (so it is reported once), and
 * dependencies nothing uses, from cargo-machete.
 */
export async function deadCode(ctx: Bound): Promise<Finding[]> {
  const diagnostics = (await compiled(ctx)).filter(
    (d) => d.level === 'warning' && d.code === DEAD_CODE,
  );
  const unused = await Promise.all((await machete(ctx)).map((u) => unusedFinding(ctx, u)));
  const own = unused.filter(
    (f): f is Finding =>
      f?.location !== undefined && inComponent(ctx.component.root, f.location.file) !== undefined,
  );
  return [...diagnostics.map(toFinding), ...own];
}
