import { describe, expect, it } from 'vitest';
import { pyPack } from './index.js';
import { parseConfig } from '../../config/load.js';
import { repoFacts } from '../../repo/facts.js';

const config = parseConfig('name: T\nprefix: T\ncomponents:\n  - { lang: py }\n');
const component = { lang: 'py' as const, root: '.', os: ['linux' as const] };

function applies(id: string, files: string[]): boolean | string {
  const check = pyPack.checks.find((c) => c.id === id);
  const result = check?.applies({
    facts: repoFacts(files, []),
    config,
    component,
    side: 'alone',
    tiers: ['commit', 'head'],
  });
  return result === undefined ? 'missing' : result.applies || result.reason;
}

describe('pyPack', () => {
  it('runs its checks per Python component, the fast ones per commit', () => {
    const tiers = Object.fromEntries(pyPack.checks.map((c) => [c.id, c.tier]));
    expect(tiers).toMatchObject({
      'py/format': 'commit',
      'py/lint': 'commit',
      'py/types': 'commit',
      'py/deadcode': 'commit',
      'py/arch': 'head',
      'py/config-strength': 'head',
      'py/toolchain': 'head',
    });
    expect(pyPack.checks.every((c) => c.scope === 'component' && c.langs?.includes('py'))).toBe(
      true,
    );
    expect(pyPack.generated?.map((g) => g.path)).toEqual([
      'ruff.talos.toml',
      'pyrightconfig.talos.json',
    ]);
  });

  it('applies where there is Python, and the architecture check where there is a package', () => {
    expect(applies('py/lint', ['src/app/__init__.py'])).toBe(true);
    expect(applies('py/lint', ['README.md'])).toBe('the component has no Python files');
    expect(applies('py/arch', ['src/app/__init__.py'])).toBe(true);
    expect(applies('py/arch', ['main.py'])).toMatch(/no package/);
  });
});
