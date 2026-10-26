import { describe, expect, it } from 'vitest';
import { startDraft } from './draft.js';
import { languageSteps, withIgnored, withLf } from './languages.js';
import { parseConfig } from '../config/load.js';
import type { Pack } from '../core/pack.js';

describe('line files', () => {
  it('checks text out with LF first, so the project’s own lines still win', () => {
    expect(withLf(undefined)).toMatch(/^# .*\n\* text=auto eol=lf\n$/);
    expect(withLf('*.bat text eol=crlf\n')).toMatch(
      /\* text=auto eol=lf\n\*\.bat text eol=crlf\n$/,
    );
    expect(withLf('*   text=auto   eol=lf\n')).toBeUndefined();
  });

  it('ignores a folder once, however it was written', () => {
    expect(withIgnored(undefined, '.lua')).toBe('.lua/\n');
    expect(withIgnored('dist/', '.lua')).toBe('dist/\n.lua/\n');
    for (const line of ['.lua', '/.lua/', '**/.lua/', '.lua/*', '.lua/**']) {
      expect(withIgnored(`${line}\n`, '.lua')).toBeUndefined();
    }
    expect(withIgnored('.luarc.json\n', '.lua')).toBe('.luarc.json\n.lua/\n');
  });
});

describe('languageSteps', () => {
  const ts: Pack = { name: 'ts', lang: 'ts', checks: [] };

  it('deletes the files that would shadow a TypeScript base, in that component only', () => {
    const texts: Record<string, string> = {
      'web/.prettierrc': '{}',
      'web/knip.json': '{}',
      'web/.dependency-cruiser.js': '',
      'web/package.json': '{}',
      'other/.prettierrc': '{}',
    };
    const config = parseConfig('name: X\nprefix: X\ncomponents: [{ lang: ts, root: web }]\n');
    const draft = startDraft(Object.keys(texts), (path) => texts[path]);
    languageSteps(draft, config, [ts], { runnerPatch: undefined });
    expect(draft.done().delete).toEqual([
      { path: 'web/.prettierrc', why: 'shadowed' },
      { path: 'web/knip.json', why: 'shadowed' },
      { path: 'web/.dependency-cruiser.js', why: 'shadowed' },
    ]);
  });

  it('ignores the Lua tree and keeps LF for StyLua', () => {
    const config = parseConfig('name: X\nprefix: X\ncomponents: [{ lang: lua }]\n');
    const draft = startDraft(['main.lua'], () => undefined);
    languageSteps(draft, config, [], { runnerPatch: undefined });
    expect(draft.done().write.map((f) => `${f.why} ${f.path}`)).toEqual([
      'ignore .gitignore',
      'line-endings .gitattributes',
    ]);
  });

  it("moves a Python component's tables only when it has Python to check", () => {
    const pyproject = '[project]\nname = "x"\n\n[tool.mypy]\nstrict = true\n';
    const config = parseConfig('name: X\nprefix: X\ncomponents: [{ lang: py }]\n');
    const empty = startDraft(['pyproject.toml'], () => pyproject);
    languageSteps(empty, config, [], { runnerPatch: undefined });
    expect(empty.read('pyproject.toml')).toContain('[tool.mypy]');
    const texts: Record<string, string> = { 'pyproject.toml': pyproject, 'a.py': '' };
    const draft = startDraft(Object.keys(texts), (path) => texts[path]);
    languageSteps(draft, config, [], { runnerPatch: undefined });
    expect(draft.read('pyproject.toml')).toBe(
      '[project]\nname = "x"\n\n[tool.uv]\nexclude-newer = "1 day"\n',
    );
    expect(draft.done().next).toEqual(['in .: uv lock']);
  });

  it('says what it could not do by hand', () => {
    const config = parseConfig('name: X\nprefix: X\ncomponents: [{ lang: py }]\n');
    const texts: Record<string, string> = {
      'pyproject.toml': '[tool.ruff]\nextend = "x"\n',
      'a.py': '',
    };
    const draft = startDraft(Object.keys(texts), (path) => texts[path]);
    const seeds = languageSteps(draft, config, [], { runnerPatch: undefined });
    expect(seeds.size).toBe(0);
    expect(draft.done().next).toEqual([
      "in .: move pyproject.toml's tool settings by hand: its [tool.ruff] extends another file",
      'in .: uv lock',
    ]);
    const broken = startDraft(['pyproject.toml', 'a.py'], (path) => (path === 'a.py' ? '' : '['));
    languageSteps(broken, config, [], { runnerPatch: undefined });
    expect(broken.done().next).toEqual([
      "in .: move pyproject.toml's tool settings by hand: pyproject.toml is not valid TOML",
      'in .: set [tool.uv] exclude-newer by hand: pyproject.toml is not valid TOML',
    ]);
  });
});
