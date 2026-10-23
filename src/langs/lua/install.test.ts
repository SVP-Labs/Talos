import { describe, expect, it } from 'vitest';
import { LUA_VERSION, LUAROCKS_VERSION } from './devtools.js';
import { hererocksArgs, rockspecs } from './install.js';

describe('install', () => {
  it('finds the rockspecs in a directory', () => {
    expect(rockspecs(['b-1.0-1.rockspec', 'README.md', 'a-scm-1.rockspec'])).toEqual([
      'a-scm-1.rockspec',
      'b-1.0-1.rockspec',
    ]);
  });

  it('runs hererocks through uv, outside any project and its settings', () => {
    expect(hererocksArgs('/cache/hererocks.py', '/work/.lua')).toEqual([
      'run',
      '--no-project',
      '--no-config',
      '/cache/hererocks.py',
      '/work/.lua',
      '--lua',
      LUA_VERSION,
      '--luarocks',
      LUAROCKS_VERSION,
      '--no-readline',
    ]);
  });
});
