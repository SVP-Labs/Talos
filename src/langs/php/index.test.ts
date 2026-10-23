import { describe, expect, it } from 'vitest';
import { phpPack } from './index.js';
import { parseConfig } from '../../config/load.js';
import { repoFacts } from '../../repo/facts.js';

const config = parseConfig('name: T\nprefix: T\ncomponents:\n  - { lang: php }\n');
const component = { lang: 'php' as const, root: '.', os: ['linux' as const] };

function applies(id: string, files: string[]): boolean | string {
  const check = phpPack.checks.find((c) => c.id === id);
  const result = check?.applies({
    facts: repoFacts(files, []),
    config,
    component,
    side: 'alone',
    tiers: ['commit', 'head'],
  });
  return result === undefined ? 'missing' : result.applies || result.reason;
}

describe('phpPack', () => {
  it('runs its checks per PHP component, the fast ones per commit', () => {
    const tiers = Object.fromEntries(phpPack.checks.map((c) => [c.id, c.tier]));
    expect(tiers).toMatchObject({
      'php/format': 'commit',
      'php/lint': 'commit',
      'php/types': 'commit',
      'php/deadcode': 'commit',
      'php/typecov': 'head',
      'php/arch': 'head',
      'php/config-strength': 'head',
      'php/toolchain': 'head',
    });
    expect(phpPack.checks.every((c) => c.scope === 'component' && c.langs?.includes('php'))).toBe(
      true,
    );
    expect(phpPack.lang).toBe('php');
    expect(phpPack.devTools?.manager).toBe('composer');
  });

  it('applies where there is PHP, type coverage and architecture where some of it ships', () => {
    expect(applies('php/lint', ['src/A.php'])).toBe(true);
    expect(applies('php/lint', ['README.md'])).toBe('the component has no PHP files');
    expect(applies('php/typecov', ['tests/ATest.php'])).toBe(
      'the component ships no PHP, only tests',
    );
    expect(applies('php/arch', ['src/A.php'])).toBe(true);
    expect(applies('php/toolchain', ['src/A.php'])).toBe('the component has no composer.json');
    expect(applies('php/toolchain', ['composer.json'])).toBe(true);
  });
});
