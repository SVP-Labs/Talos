import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import {
  pyrightBase,
  pyrightConfigFile,
  ruffBase,
  ruffConfigFile,
  TEST_GLOBS,
  TEST_IGNORES,
} from './configs.js';
import { readPyrightFile } from './pyright-config.js';
import { parseConfig } from '../../config/load.js';
import { GENERATED_MARKER } from '../../configs/header.js';
import { repoFacts } from '../../repo/facts.js';
import { tempRepo } from '../../testing/engine.js';

const config = parseConfig('name: T\nprefix: T\ncomponents:\n  - { lang: py }\n');
const component = { lang: 'py' as const, root: '.', os: ['linux' as const] };
const render = { config, facts: repoFacts(['a.py'], []), component, version: '1.2.3' };

describe('ruff base', () => {
  it('selects every rule but the formatter’s, at the standard’s limits', () => {
    const text = ruffBase.render(render);
    expect(text.split('\n')[0]).toBe(
      `# ${GENERATED_MARKER} 1.2.3. Do not edit: extend it in ruff.toml, which may only tighten it.`,
    );
    expect(parse(text)).toMatchObject({
      lint: {
        select: ['ALL', 'PLR1702'],
        preview: true,
        'explicit-preview-rules': true,
        mccabe: { 'max-complexity': 12 },
        pylint: {
          'max-args': 4,
          'max-positional-args': 4,
          'max-branches': 15,
          'max-returns': 10,
          'max-statements': 60,
          'max-nested-blocks': 3,
        },
        pydocstyle: { convention: 'google' },
      },
    });
    const ignores = parse(text).lint;
    expect(JSON.stringify(ignores)).toContain('"COM812"');
    expect(JSON.stringify(ignores)).toContain('"CPY001"');
    expect(TEST_GLOBS.every((glob) => text.includes(`"${glob}" = `))).toBe(true);
    expect(TEST_IGNORES).toContain('S101');
  });

  it('applies to components with Python and starts the project’s file extending it', () => {
    expect(ruffBase.applies({ ...render, side: 'alone', tiers: ['commit'] })).toBe(true);
    const none = { ...render, facts: repoFacts(['a.ts'], []), side: 'alone' as const, tiers: [] };
    expect(ruffBase.applies(none)).toBe(false);
    expect(parse(ruffBase.extension?.initial(render) ?? '')).toEqual({ extend: 'ruff.talos.toml' });
  });
});

describe('basedpyright base', () => {
  it('turns every rule on, with the component’s virtual environment', () => {
    const text = pyrightBase.render(render);
    expect(text.startsWith(`// ${GENERATED_MARKER} 1.2.3.`)).toBe(true);
    expect(readPyrightFile('pyrightconfig.talos.json', text)).toEqual({
      typeCheckingMode: 'all',
      venvPath: '.',
      venv: '.venv',
    });
    const initial = pyrightBase.extension?.initial(render) ?? '';
    expect(readPyrightFile('pyrightconfig.json', initial)).toEqual({
      extends: './pyrightconfig.talos.json',
    });
  });
});

describe('config discovery', () => {
  const at = (root: string): { root: string; component: typeof component } => ({
    root,
    component,
  });

  it('finds the file each tool would read, in the tool’s own order', async () => {
    const both = await tempRepo({
      'ruff.toml': '',
      '.ruff.toml': '',
      'pyrightconfig.json': '{}',
      'pyproject.toml': '[tool.ruff]\n[tool.basedpyright]\n',
    });
    expect(await ruffConfigFile(at(both))).toBe('.ruff.toml');
    expect(await pyrightConfigFile(at(both))).toBe('pyrightconfig.json');
    const pyproject = await tempRepo({ 'pyproject.toml': '[tool.ruff]\n[tool.pyright]\n' });
    expect(await ruffConfigFile(at(pyproject))).toBe('pyproject.toml');
    expect(await pyrightConfigFile(at(pyproject))).toBe('pyproject.toml');
  });

  it('falls back to the base when the project has no config', async () => {
    const bare = await tempRepo({ 'pyproject.toml': '[project]\nname = "x"\n' });
    expect(await ruffConfigFile(at(bare))).toBe('ruff.talos.toml');
    expect(await pyrightConfigFile(at(bare))).toBe('pyrightconfig.talos.json');
    const broken = await tempRepo({ 'pyproject.toml': '[tool' });
    expect(await ruffConfigFile(at(broken))).toBe('ruff.talos.toml');
  });
});
