import { describe, expect, it } from 'vitest';
import { startDraft } from './draft.js';
import { tsconfigSteps } from './tsconfig.js';
import { parseConfig } from '../config/load.js';

const CONFIG = parseConfig(
  'name: X\nprefix: X\ncomponents: [{ lang: ts }, { lang: ts, root: web }]\nexclude: [fixtures]\n',
);
const BASES = ['tsconfig.talos.json', 'web/tsconfig.talos.json', 'eslint.config.js'];
const BASE = '{ "compilerOptions": { "strict": true } }\n';

function steps(texts: Record<string, string>, bases: readonly string[] = BASES): string[] {
  const all: Record<string, string> = {
    'tsconfig.talos.json': BASE,
    'web/tsconfig.talos.json': BASE,
    ...texts,
  };
  const draft = startDraft(Object.keys(all), (path) => all[path]);
  tsconfigSteps(draft, CONFIG, bases);
  return draft.done().next;
}

const step = (file: string, base: string): string =>
  `make ${file} extend ${base} (or extend a tsconfig that does): the base holds the flags the gate checks with, and adoption never rewrites your tsconfig`;

describe("a project's tsconfig.json", () => {
  it('is left as it is, with a step, when it does not extend the base', () => {
    expect(steps({ 'tsconfig.json': '{ "compilerOptions": { "strict": false } }\n' })).toEqual([
      step('tsconfig.json', './tsconfig.talos.json'),
    ]);
    expect(steps({ 'tsconfig.json': '{ "extends": "tsconfig.talos.json" }\n' })).toEqual([
      step('tsconfig.json', './tsconfig.talos.json'),
    ]);
    expect(steps({ 'tsconfig.json': 'not json' })).toEqual([
      step('tsconfig.json', './tsconfig.talos.json'),
    ]);
  });

  it('extends the base directly, in a list, or through configs it extends', () => {
    const texts = {
      'tsconfig.json': '// comment\n{ "extends": "./tsconfig.talos.json", }\n',
      'web/tsconfig.json':
        '{ "extends": ["@tsconfig/node22/tsconfig.json", "./tsconfig.talos"] }\n',
      'web/app/tsconfig.json': '{ "extends": "../tsconfig.json" }\n',
      'web/lib/tsconfig.json': '{ "extends": "./tsconfig.base" }\n',
      'web/lib/tsconfig.base.json': '{ "extends": "../tsconfig.talos.json" }\n',
    };
    expect(steps(texts)).toEqual([]);
  });

  it('names the base of the component the file is in', () => {
    expect(steps({ 'web/app/tsconfig.json': '{}\n' })).toEqual([
      step('web/app/tsconfig.json', '../tsconfig.talos.json'),
    ]);
  });

  it('stops at a loop, a path outside the repository and a deep chain', () => {
    const texts = {
      'tsconfig.json': '{ "extends": "./a.json" }\n',
      'a.json': '{ "extends": "./tsconfig.json" }\n',
      'web/tsconfig.json': '{ "extends": "../../tsconfig.talos.json" }\n',
    };
    expect(steps(texts)).toEqual([
      step('tsconfig.json', './tsconfig.talos.json'),
      step('web/tsconfig.json', './tsconfig.talos.json'),
    ]);
    const chain = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`c${i}.json`, `{ "extends": "./c${i + 1}.json" }\n`]),
    );
    const deep = {
      ...chain,
      'c12.json': '{ "extends": "./tsconfig.talos.json" }\n',
      'tsconfig.json': '{ "extends": "./c0.json" }\n',
    };
    expect(steps(deep)).toEqual([step('tsconfig.json', './tsconfig.talos.json')]);
  });

  it('is not asked of excluded code, or when no base was rendered', () => {
    expect(steps({ 'fixtures/tsconfig.json': '{}\n' })).toEqual([]);
    expect(steps({ 'tsconfig.json': '{}\n' }, ['eslint.config.js'])).toEqual([]);
  });
});
