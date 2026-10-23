import { describe, expect, it } from 'vitest';
import { renderConfigs } from './files.js';
import { parseConfig } from '../config/load.js';
import type { ApplyContext } from '../core/check.js';
import type { Pack } from '../core/pack.js';
import { repoFacts } from '../repo/facts.js';

const pack: Pack = {
  name: 'fake',
  checks: [],
  generated: [
    {
      path: 'base.cfg',
      scope: 'component',
      langs: ['ts'],
      applies: () => true,
      render: (ctx) => `root ${ctx.component?.root ?? ''} at ${ctx.version}\n`,
      extension: {
        path: 'base.project.cfg',
        initial: (ctx) => `for ${ctx.component?.root ?? ''}\n`,
      },
    },
    {
      path: 'repo.cfg',
      scope: 'repo',
      applies: (ctx) => ctx.facts.has('**/*.md'),
      render: () => 'repo\n',
    },
  ],
};

function context(yaml: string, files: string[]): ApplyContext {
  const config = parseConfig(`name: T\nprefix: T\n${yaml}`);
  return { config, facts: repoFacts(files, config.exclude), side: 'alone', tiers: ['head'] };
}

describe('renderConfigs', () => {
  it('renders each applicable file under its component, with its extension file', () => {
    const ctx = context('components:\n  - { lang: ts }\n  - { lang: ts, root: web }\n', []);
    expect(renderConfigs([pack], ctx, '3.0.0')).toEqual([
      {
        path: 'base.cfg',
        content: 'root . at 3.0.0\n',
        extension: { path: 'base.project.cfg', content: 'for .\n' },
      },
      {
        path: 'web/base.cfg',
        content: 'root web at 3.0.0\n',
        extension: { path: 'web/base.project.cfg', content: 'for web\n' },
      },
    ]);
  });

  it('leaves out what does not apply', () => {
    expect(renderConfigs([pack], context('', ['README.md']), '1.0.0')).toEqual([
      { path: 'repo.cfg', content: 'repo\n' },
    ]);
    expect(renderConfigs([pack], context('', []), '1.0.0')).toEqual([]);
  });
});
