import { describe, expect, it } from 'vitest';
import {
  excludedHere,
  inComponent,
  inRepo,
  isCode,
  isJavaScript,
  isTest,
  isTooling,
  rootOf,
  stripSlashes,
} from './files.js';

describe('file kinds', () => {
  it('knows code from other files', () => {
    expect(
      ['a.ts', 'a.tsx', 'a.mts', 'a.cts', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs'].every(isCode),
    ).toBe(true);
    expect(['a.json', 'a.d', 'a.md', 'ts'].some(isCode)).toBe(false);
    expect(isJavaScript('src/a.mjs')).toBe(true);
    expect(isJavaScript('src/a.mts')).toBe(false);
  });

  it('knows test code by name and by directory', () => {
    expect(isTest('src/a.test.ts')).toBe(true);
    expect(isTest('src/a.spec.tsx')).toBe(true);
    expect(isTest('test/helpers.ts')).toBe(true);
    expect(isTest('apps/web/e2e/home.ts')).toBe(true);
    expect(isTest('src/testing/engine.ts')).toBe(true);
    expect(isTest('src/latest/thing.ts')).toBe(false);
    expect(isTest('src/contest.ts')).toBe(false);
  });

  it('knows tool configs, which may stay JavaScript', () => {
    expect(isTooling('eslint.config.js')).toBe(true);
    expect(isTooling('apps/web/vite.config.mjs')).toBe(true);
    expect(isTooling('eslint.project.js')).toBe(true);
    expect(isTooling('.dependency-cruiser.cjs')).toBe(true);
    expect(isTooling('src/config.js')).toBe(false);
    expect(isTooling('src/app.js')).toBe(false);
  });
});

describe('component paths', () => {
  it('reads a component root', () => {
    expect(rootOf(undefined)).toBe('.');
    expect(rootOf({ lang: 'ts', root: 'apps/web/', os: ['linux'] })).toBe('apps/web');
    expect(stripSlashes('a//')).toBe('a');
  });

  it('moves paths between the repository and a component', () => {
    expect(inComponent('apps/web', 'apps/web/src/a.ts')).toBe('src/a.ts');
    expect(inComponent('.', 'src/a.ts')).toBe('src/a.ts');
    expect(inRepo('apps/web', 'src/a.ts')).toBe('apps/web/src/a.ts');
    expect(inRepo('.', 'src/a.ts')).toBe('src/a.ts');
  });

  it('keeps the excludes under a component, relative to it', () => {
    expect(excludedHere(['apps/web/gen/', 'vendor', 'apps/web'], 'apps/web')).toEqual(['gen']);
    expect(excludedHere(['vendor/'], '.')).toEqual(['vendor']);
  });
});
