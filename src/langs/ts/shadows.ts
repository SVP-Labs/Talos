import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { DEPCRUISE_BASE } from './configs/depcruise.js';
import { KNIP_BASE } from './configs/knip.js';
import { PRETTIER_CONFIG } from './configs/prettier.js';
import { STRYKER_BASE } from './configs/stryker.js';
import { componentFiles, inComponent, inRepo, rootOf } from './files.js';
import type { CheckContext } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';

/**
 * Config files a tool would read before (or instead of) the base Talos renders, so an editor
 * or a plain run of the tool would use other settings than the gate.
 */
const SHADOWS: Readonly<Record<string, readonly string[]>> = {
  [PRETTIER_CONFIG]: [
    '.prettierrc',
    '.prettierrc.json',
    '.prettierrc.yml',
    '.prettierrc.yaml',
    '.prettierrc.json5',
    '.prettierrc.js',
    '.prettierrc.mjs',
    '.prettierrc.cjs',
    '.prettierrc.ts',
    '.prettierrc.toml',
    'prettier.config.mjs',
    'prettier.config.cjs',
    'prettier.config.ts',
  ],
  [KNIP_BASE]: [
    'knip.json',
    'knip.jsonc',
    '.knip.json',
    '.knip.jsonc',
    'knip.ts',
    'knip.js',
    'knip.config.ts',
  ],
  [DEPCRUISE_BASE]: [
    '.dependency-cruiser.js',
    '.dependency-cruiser.mjs',
    '.dependency-cruiser.json',
  ],
  [STRYKER_BASE]: [
    'stryker.conf.js',
    'stryker.conf.mjs',
    'stryker.conf.cjs',
    'stryker.conf.json',
    'stryker.config.js',
    'stryker.config.cjs',
    'stryker.config.json',
    '.stryker.conf.js',
    '.stryker.conf.mjs',
    '.stryker.conf.json',
  ],
};

/** Shadowing files among the component's own (component-relative paths). */
export function shadowing(files: readonly string[]): { file: string; base: string }[] {
  const present = new Set(files);
  return Object.entries(SHADOWS).flatMap(([base, names]) =>
    names.filter((name) => present.has(name)).map((file) => ({ file, base })),
  );
}

const manifest = z.looseObject({ prettier: z.unknown().optional() });

export async function shadowingFindings(ctx: CheckContext): Promise<Finding[]> {
  const root = rootOf(ctx.component);
  const files = componentFiles(ctx).map((file) => inComponent(root, file));
  const found: Finding[] = shadowing(files).map(({ file, base }) => ({
    rule: 'config/shadowed',
    message: `${inRepo(root, file)} would be read instead of ${base}, which Talos renders; delete it.`,
    key: `shadowed ${inRepo(root, file)}`,
    location: { file: inRepo(root, file), line: 1 },
  }));
  const text = await readFile(join(ctx.root, inRepo(root, 'package.json')), 'utf8').catch(
    () => '{}',
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = {};
  }
  const keyed = manifest.safeParse(parsed);
  if (keyed.success && keyed.data.prettier !== undefined) {
    found.push({
      rule: 'config/shadowed',
      message: `package.json's "prettier" key would be read instead of ${PRETTIER_CONFIG}; remove it.`,
      key: `shadowed ${inRepo(root, 'package.json')}#prettier`,
      location: { file: inRepo(root, 'package.json'), line: 1 },
    });
  }
  return found;
}
