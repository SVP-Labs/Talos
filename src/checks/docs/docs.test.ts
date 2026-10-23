import { describe, expect, it } from 'vitest';
import { docsPack } from './index.js';
import { parseConfig } from '../../config/load.js';
import type { Reported } from '../../core/finding.js';
import { kitBlock, loadKitTemplate } from '../../docs/claude.js';
import { runChecks } from '../../engine/run.js';
import { MINIMAL_CONFIG, tempRepo, testEngine, testPlan } from '../../testing/engine.js';

const config = parseConfig(MINIMAL_CONFIG);
const kit = kitBlock(loadKitTemplate(), config);
const unknown = ['zq', 'xv', 'kw'].join('');
const term = ['Fr', 'ob', 'ni', 'ca', 'tor'].join('');
const projectWord = ['qu', 'ux', 'ify'].join('');

async function run(
  check: string,
  files: Readonly<Record<string, string>>,
): Promise<{ status: string; reason?: string; findings: readonly Reported[] }> {
  const root = await tempRepo({ 'talos.yml': MINIMAL_CONFIG, ...files });
  const result = await runChecks(testEngine([docsPack]), {
    ...testPlan(root, ['talos.yml', ...Object.keys(files)], config),
    only: [check],
  });
  const outcome = result.outcomes[0];
  if (outcome === undefined) throw new Error(`${check} did not run`);
  return outcome;
}

const where = (findings: readonly Reported[]): [string, string, number][] =>
  findings.map((f) => [f.rule, f.location?.file ?? f.key ?? '', f.location?.line ?? 0]);

describe('docs/decisions', () => {
  it('reports duplicates, unresolved references and one-way reversals', async () => {
    const outcome = await run('docs/decisions', {
      'DECISIONS.md': '# Decisions\n\n## X1 · One\n\nReverses: X2\n\n## X2 · Two\n',
      'docs/requirements/b.md': '# B\n\n### X1 · Again\n',
      'README.md': 'See X9.\n',
    });
    expect(where(outcome.findings)).toEqual([
      ['decisions/duplicate-id', 'docs/requirements/b.md', 3],
      ['decisions/unresolved-reference', 'README.md', 1],
      ['decisions/one-way-reversal', 'DECISIONS.md', 5],
    ]);
  });

  it('skips a repository with no decisions', async () => {
    expect(await run('docs/decisions', { 'README.md': '# R\n' })).toMatchObject({
      status: 'skipped',
    });
  });
});

describe('docs/glossary', () => {
  it('finds avoided words in docs and code, not in the glossary or in code spans', async () => {
    const glossary = '# Glossary\n\n**Merge queue**\nThe queue.\nAvoid: landing strip\n';
    const outcome = await run('docs/glossary', {
      'docs/glossary.md': glossary,
      'README.md': 'Use the landing strip, not `landing strip`.\n',
      'src/a.ts': 'export const landingStrip = 1;\n',
    });
    expect(where(outcome.findings)).toEqual([
      ['glossary/avoid', 'README.md', 1],
      ['glossary/avoid', 'src/a.ts', 1],
    ]);
    expect(outcome.findings[0]?.message).toBe(
      '"landing strip" is a word the glossary avoids: write "Merge queue" instead.',
    );
  });
});

describe('docs/references', () => {
  it('reports links to missing files and headings', async () => {
    const outcome = await run('docs/references', {
      'README.md': '# Read me\n\n[ok](docs/a.md#usage) [gone](docs/b.md) [bad](docs/a.md#nope)\n',
      'docs/a.md':
        '# A\n\n## Usage\n\n[up](../README.md#read-me) [self](#a) [line](../src/x.ts#L3)\n',
      'src/x.ts': 'export {};\n',
    });
    expect(outcome.findings.map((f) => f.message)).toEqual([
      'The link to docs/b.md names no file in the repository.',
      'The link to docs/a.md#nope names no heading in docs/a.md.',
    ]);
  });
});

describe('docs/comments', () => {
  it('reports what comments may not say, citing the repository decisions', async () => {
    const outcome = await run('docs/comments', {
      'DECISIONS.md': '# D\n\n## X1 · One\n',
      'src/a.ts': '// TODO: later\nexport const a = 1; // as X1 says\n',
      'scripts/b.sh': '#!/bin/sh\n# Added by Sven on a whim.\n',
    });
    expect(where(outcome.findings)).toEqual([
      ['comments/todo', 'src/a.ts', 1],
      ['comments/reference', 'src/a.ts', 2],
      ['comments/history', 'scripts/b.sh', 2],
    ]);
  });
});

describe('docs/claude-md', () => {
  it('passes the block this release renders and a short project block', async () => {
    const outcome = await run('docs/claude-md', {
      'CLAUDE.md': `${kit}\n\n## Ours\n\nUse tabs.\n`,
    });
    expect(outcome).toMatchObject({ status: 'passed' });
  });

  it('reports a hand-edited block and a project block over the cap', async () => {
    const own = Array.from({ length: 61 }, (_, index) => `- rule ${String(index)}`).join('\n');
    const outcome = await run('docs/claude-md', {
      'CLAUDE.md': `${kit.replace('Claim before', 'Claim after')}\n\n${own}\n`,
      'apps/x/CLAUDE.md': `${own}\n`,
    });
    const span = kit.split('\n').length;
    expect(
      outcome.findings.map((f) => [
        f.rule,
        f.location?.file,
        f.location?.line,
        f.location?.endLine,
      ]),
    ).toEqual([
      ['claude/stale-block', 'CLAUDE.md', 1, span],
      ['claude/too-long', 'CLAUDE.md', span + 2, span + 62],
      ['claude/too-long', 'apps/x/CLAUDE.md', 1, 61],
    ]);
  });

  it('reports a missing CLAUDE.md and a missing block', async () => {
    expect(where((await run('docs/claude-md', {})).findings)).toEqual([
      ['claude/stale-block', 'CLAUDE.md', 0],
    ]);
    expect(where((await run('docs/claude-md', { 'CLAUDE.md': '# Mine\n' })).findings)).toEqual([
      ['claude/stale-block', 'CLAUDE.md', 1],
    ]);
  });
});

describe('docs/markdown', () => {
  it("reports markdownlint's findings with the base rules", async () => {
    const outcome = await run('docs/markdown', {
      'README.md': '# One\n\n# Two\n',
      '.markdownlint.json': '{ "default": false }',
    });
    expect(where(outcome.findings)).toEqual([['markdownlint/MD025', 'README.md', 3]]);
  });
});

describe('docs/spelling', () => {
  it('knows glossary terms and project words, and skips generated text', async () => {
    const outcome = await run('docs/spelling', {
      'docs/glossary.md': `# Glossary\n\n**${term}**\nA term.\n`,
      '.cspell/words.txt': `${projectWord}\n`,
      'README.md': `# Read me\n\nThe ${term.toLowerCase()} and ${projectWord}, but ${unknown}.\n`,
      'CLAUDE.md': `${kit}\n`,
      'eslint.config.js': `// Generated by Talos 1.0.0. Do not edit.\n// ${unknown}\n`,
    });
    expect(where(outcome.findings)).toEqual([['cspell/unknown-word', 'README.md', 3]]);
    expect(outcome.findings[0]?.location?.column).toBe(34);
  }, 60_000);
});

describe('docsPack', () => {
  it('writes the markdownlint and cspell bases', () => {
    expect(docsPack.generated?.map((g) => [g.path, g.extension?.path])).toEqual([
      ['.markdownlint-cli2.jsonc', undefined],
      ['cspell.config.yaml', '.cspell/words.txt'],
    ]);
  });
});
