import { describe, expect, it } from 'vitest';
import { derivePrefix, isSeed, renderTalosYml, scalar } from './talos-yml.js';
import { parseConfig } from '../config/load.js';

describe('renderTalosYml', () => {
  it('writes a talos.yml that Talos reads back as drafted', () => {
    const text = renderTalosYml({
      name: 'Thea',
      prefix: 'T',
      components: [
        { lang: 'ts', root: '.', os: ['linux'] },
        { lang: 'rust', root: 'apps/desktop', os: ['linux', 'windows'] },
      ],
      exclude: ['vendor', '**/*.min.js', 'odd dir'],
      docs: { glossary: 'docs/glossary.md', briefs: 'docs/requirements' },
    });
    expect(text).toContain('  - { lang: ts, root: . }\n');
    expect(text).toContain('  - { lang: rust, root: apps/desktop, os: [linux, windows] }\n');
    const config = parseConfig(text);
    expect(config).toMatchObject({
      name: 'Thea',
      prefix: 'T',
      components: [
        { lang: 'ts', root: '.', os: ['linux'] },
        { lang: 'rust', root: 'apps/desktop', os: ['linux', 'windows'] },
      ],
      exclude: ['vendor', '**/*.min.js', 'odd dir'],
      supply_chain: { allow: {}, exceptions: {} },
    });
  });

  it('writes an empty component list when it found none', () => {
    const text = renderTalosYml({
      name: 'Notes: 2026',
      prefix: 'N',
      components: [],
      exclude: [],
      docs: { glossary: 'GLOSSARY.md', briefs: 'docs/requirements' },
    });
    expect(text).toContain('components: []');
    expect(parseConfig(text).name).toBe('Notes: 2026');
  });
});

describe('scalar', () => {
  it('quotes anything a flow collection could misread', () => {
    expect(scalar('apps/web')).toBe('apps/web');
    expect(scalar('*.js')).toBe('"*.js"');
    expect(scalar('a, b')).toBe('"a, b"');
  });
});

describe('derivePrefix', () => {
  it("takes the initials of the name's words", () => {
    expect(derivePrefix('LoreLock')).toBe('LL');
    expect(derivePrefix('Thea')).toBe('T');
    expect(derivePrefix('coe5-mod-validator')).toBe('CMV');
    expect(derivePrefix('one two three four five six seven')).toHaveLength(6);
    expect(derivePrefix('42')).toBe('P');
  });
});

describe('isSeed', () => {
  it('recognises the name-and-prefix file talos new writes, and nothing else', () => {
    expect(isSeed('name: X\nprefix: X\n')).toBe(true);
    expect(isSeed('name: X\nprefix: X\ncomponents: []\n')).toBe(false);
    expect(isSeed('- a\n')).toBe(false);
    expect(isSeed('just text')).toBe(false);
    expect(isSeed(': : :')).toBe(false);
  });
});
