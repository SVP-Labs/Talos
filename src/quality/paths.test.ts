import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inComponent, inRepository, overlaps } from './paths.js';

const ROOT = join('/', 'work', 'repo');

describe('inRepository', () => {
  it('makes a report path repository-relative, from the base or absolute', () => {
    expect(inRepository(ROOT, join(ROOT, 'pkg'), 'src/a.ts')).toBe('pkg/src/a.ts');
    expect(inRepository(ROOT, join(ROOT, 'pkg'), join(ROOT, 'lib', 'b.py'))).toBe('lib/b.py');
    expect(inRepository(ROOT, ROOT, './c.lua')).toBe('c.lua');
  });

  it('drops a path outside the checkout, or the checkout itself', () => {
    expect(inRepository(ROOT, ROOT, '../other/a.ts')).toBeUndefined();
    expect(inRepository(ROOT, ROOT, join('/', 'usr', 'lib', 'x.lua'))).toBeUndefined();
    expect(inRepository(ROOT, ROOT, '.')).toBeUndefined();
    expect(inRepository(ROOT, ROOT, '..')).toBeUndefined();
  });
});

describe('inComponent', () => {
  it('holds every path for the root component or none', () => {
    expect(inComponent(undefined, 'a/b.ts')).toBe(true);
    expect(inComponent({ lang: 'ts', root: '.', os: ['linux'] }, 'a/b.ts')).toBe(true);
    expect(inComponent({ lang: 'ts', root: '', os: ['linux'] }, 'a/b.ts')).toBe(true);
  });

  it('holds only paths under a nested root', () => {
    const app = { lang: 'py', root: 'apps/api', os: ['linux'] } as const;
    expect(inComponent(app, 'apps/api/main.py')).toBe(true);
    expect(inComponent(app, 'apps/apiary/main.py')).toBe(false);
    expect(inComponent({ ...app, root: 'apps/api/' }, 'apps/api/main.py')).toBe(true);
  });
});

describe('overlaps', () => {
  const web = { lang: 'ts', root: 'apps/web', os: ['linux'] } as const;

  it('matches entries inside, around or equal to the component', () => {
    expect(overlaps(web, 'apps/web/e2e')).toBe(true);
    expect(overlaps(web, 'apps')).toBe(true);
    expect(overlaps(web, 'apps/web/')).toBe(true);
    expect(overlaps(undefined, 'anything')).toBe(true);
  });

  it('leaves other components alone', () => {
    expect(overlaps(web, 'apps/api/e2e')).toBe(false);
    expect(overlaps(web, 'apps/webby')).toBe(false);
  });
});
