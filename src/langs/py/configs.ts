import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { pythonFiles } from './paths.js';
import { generatedHeader } from '../../configs/header.js';
import type { ApplyContext } from '../../core/check.js';
import { componentDir, fileExists, type Place } from '../../core/component.js';
import type { Generated } from '../../core/pack.js';

export const RUFF_BASE = 'ruff.talos.toml';
const RUFF_PROJECT = 'ruff.toml';
export const PYRIGHT_BASE = 'pyrightconfig.talos.json';
const PYRIGHT_PROJECT = 'pyrightconfig.json';

const FORMATTER_CONFLICTS =
  'W191 E111 E114 E117 D206 D300 Q000 Q001 Q002 Q003 COM812 COM819 ISC002';

/** Tests assert, compare with literals, take fixtures and parameters as arguments, run long. */
export const TEST_IGNORES = [
  'S101',
  'PLR2004',
  'INP001',
  'D1',
  'PLR0913',
  'PLR0915',
  'PLR0917',
  'FBT001',
];

export const TEST_GLOBS = [
  '**/tests/**',
  '**/test/**',
  '**/test_*.py',
  '**/*_test.py',
  '**/conftest.py',
];

function list(items: readonly string[]): string {
  return `[${items.map((item) => JSON.stringify(item)).join(', ')}]`;
}

function renderRuff(version: string): string {
  const tests = TEST_GLOBS.map((glob) => `${JSON.stringify(glob)} = ${list(TEST_IGNORES)}`);
  return [
    generatedHeader('#', version, RUFF_PROJECT).trimEnd(),
    '',
    '[lint]',
    '# Every stable rule, and the preview rule that limits nesting.',
    'select = ["ALL", "PLR1702"]',
    'preview = true',
    'explicit-preview-rules = true',
    'ignore = [',
    '  # These fight ruff format, which owns layout.',
    `  ${FORMATTER_CONFLICTS.split(' ')
      .map((code) => JSON.stringify(code))
      .join(', ')},`,
    '  # A repository states its licence once, in its LICENSE file.',
    '  "CPY001",',
    ']',
    '',
    '[lint.pydocstyle]',
    'convention = "google"',
    '',
    '[lint.mccabe]',
    'max-complexity = 12',
    '',
    '[lint.pylint]',
    'max-args = 4',
    'max-positional-args = 4',
    'max-branches = 15',
    'max-returns = 10',
    'max-statements = 60',
    'max-nested-blocks = 3',
    '',
    '[lint.per-file-ignores]',
    ...tests,
    '',
  ].join('\n');
}

function renderPyright(version: string): string {
  return [
    generatedHeader('//', version, PYRIGHT_PROJECT).trimEnd(),
    '{',
    '  "typeCheckingMode": "all",',
    '  "venvPath": ".",',
    '  "venv": ".venv"',
    '}',
    '',
  ].join('\n');
}

const hasPython = (ctx: ApplyContext): boolean => pythonFiles(ctx).length > 0;

export const ruffBase: Generated = {
  path: RUFF_BASE,
  scope: 'component',
  langs: ['py'],
  applies: hasPython,
  render: (ctx) => renderRuff(ctx.version),
  extension: {
    path: RUFF_PROJECT,
    initial: () =>
      `# This project's additions to ${RUFF_BASE}, which may only tighten it.\n` +
      `extend = "${RUFF_BASE}"\n`,
  },
};

export const pyrightBase: Generated = {
  path: PYRIGHT_BASE,
  scope: 'component',
  langs: ['py'],
  applies: hasPython,
  render: (ctx) => renderPyright(ctx.version),
  extension: {
    path: PYRIGHT_PROJECT,
    initial: () =>
      `// This project's additions to ${PYRIGHT_BASE}, which may only tighten them.\n` +
      `{\n  "extends": "./${PYRIGHT_BASE}"\n}\n`,
  },
};

/** The base files rendered with no version, for checks that compare against them. */
export const baseRuffText = (): string => renderRuff('');

const table = z.record(z.string(), z.unknown());

/** The `[tool]` table of the component's `pyproject.toml`; empty when it has none. */
export async function pyprojectTool(dir: string): Promise<Readonly<Record<string, unknown>>> {
  const path = join(dir, 'pyproject.toml');
  if (!(await fileExists(path))) return {};
  try {
    const parsed = table.safeParse(parseToml(await readFile(path, 'utf8')).tool);
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/**
 * The file ruff itself would read in the component's root (`.ruff.toml`, `ruff.toml`, then a
 * `pyproject.toml` with `[tool.ruff]`), or the base when the project has none of them.
 */
export async function ruffConfigFile(place: Pick<Place, 'root' | 'component'>): Promise<string> {
  const dir = componentDir(place);
  for (const name of ['.ruff.toml', RUFF_PROJECT]) {
    if (await fileExists(join(dir, name))) return name;
  }
  return 'ruff' in (await pyprojectTool(dir)) ? 'pyproject.toml' : RUFF_BASE;
}

/** The file basedpyright would read: `pyrightconfig.json`, a pyproject.toml section, the base. */
export async function pyrightConfigFile(place: Pick<Place, 'root' | 'component'>): Promise<string> {
  const dir = componentDir(place);
  if (await fileExists(join(dir, PYRIGHT_PROJECT))) return PYRIGHT_PROJECT;
  const tool = await pyprojectTool(dir);
  return 'basedpyright' in tool || 'pyright' in tool ? 'pyproject.toml' : PYRIGHT_BASE;
}
