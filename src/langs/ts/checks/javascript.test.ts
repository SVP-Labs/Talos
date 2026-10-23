import { describe, expect, it } from 'vitest';
import { javascriptFindings, javascriptSources } from './javascript.js';

describe('javascript', () => {
  const files = [
    'src/a.ts',
    'src/legacy.js',
    'scripts/build.mjs',
    'src/view.jsx',
    'eslint.config.js',
    'eslint.project.js',
    '.dependency-cruiser.cjs',
    'apps/web/vite.config.mjs',
  ];

  it('lists JavaScript sources, leaving tool configs aside', () => {
    expect(javascriptSources(files)).toEqual([
      'src/legacy.js',
      'scripts/build.mjs',
      'src/view.jsx',
    ]);
  });

  it('makes each a finding at its first line', () => {
    expect(javascriptFindings(['src/legacy.js'])).toEqual([
      {
        rule: 'ts/javascript',
        message: 'src/legacy.js is JavaScript; write it in TypeScript.',
        location: { file: 'src/legacy.js', line: 1 },
      },
    ]);
  });
});
