import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { batches, installedPackage, nodeTool, parseJson, upwards } from './node.js';
import { EngineError } from '../../core/check.js';
import { tempRepo } from '../../testing/engine.js';

describe('upwards', () => {
  it('walks from a directory up to the repository root', () => {
    expect(upwards(join('/r', 'a', 'b'), '/r')).toEqual([
      join('/r', 'a', 'b'),
      join('/r', 'a'),
      '/r',
    ]);
    expect(upwards('/r', '/r')).toEqual(['/r']);
  });
});

describe('the component’s own tools', () => {
  it('finds a package hoisted to the workspace root and its program', async () => {
    const root = await tempRepo({
      'node_modules/eslint/package.json': JSON.stringify({
        version: '10.13.0',
        bin: { eslint: './bin/eslint.js' },
      }),
      'node_modules/size-limit/package.json': JSON.stringify({ version: '14.1.0', bin: 'bin.js' }),
      'apps/web/package.json': '{}',
    });
    const ctx = {
      root,
      component: { lang: 'ts' as const, root: 'apps/web', os: ['linux' as const] },
    };
    expect((await installedPackage(ctx, 'eslint'))?.version).toBe('10.13.0');
    expect((await nodeTool(ctx, 'eslint', 'eslint')).script).toBe(
      join(root, 'node_modules', 'eslint', 'bin', 'eslint.js'),
    );
    expect((await nodeTool(ctx, 'size-limit', 'size-limit')).script).toBe(
      join(root, 'node_modules', 'size-limit', 'bin.js'),
    );
  });

  it('names the fix when a tool is missing', async () => {
    const root = await tempRepo({ 'package.json': '{}' });
    await expect(nodeTool({ root }, 'knip', 'knip')).rejects.toThrow(EngineError);
    await expect(nodeTool({ root }, 'knip', 'knip')).rejects.toThrow(/devDependencies/);
  });
});

describe('batches', () => {
  it('splits long argument lists and keeps short ones whole', () => {
    expect(batches(['a', 'b', 'c'])).toEqual([['a', 'b', 'c']]);
    expect(batches(['aaaa', 'bbbb', 'cccc'], 10)).toEqual([['aaaa', 'bbbb'], ['cccc']]);
    expect(batches([])).toEqual([]);
  });
});

describe('parseJson', () => {
  it('turns unreadable output into an engine error', () => {
    expect(parseJson('x', '{"a":1}')).toEqual({ a: 1 });
    expect(() => parseJson('knip', 'Error: boom')).toThrow(EngineError);
  });
});
