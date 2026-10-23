import { describe, expect, it } from 'vitest';
import { startDraft } from './draft.js';
import { claudeMd, demoteTitles, kitFiles, type KitAssets } from './kit.js';
import { parseConfig } from '../config/load.js';
import { claudeBlocks, loadKitTemplate, sameKitBlock } from '../docs/claude.js';

const CONFIG = parseConfig('name: Notebook\nprefix: ABCDEF\ncomponents: [{ lang: ts }]\n');
const TEMPLATE = loadKitTemplate();

describe('CLAUDE.md', () => {
  it("puts Talos's block first and the project's own title one level down", () => {
    const text = claudeMd('# Notebook\n\nUse tabs.\n\n## Build\n', CONFIG, TEMPLATE, false);
    expect(text.startsWith('<!-- talos:begin -->\n')).toBe(true);
    expect(text.endsWith('<!-- talos:end -->\n\n## Notebook\n\nUse tabs.\n\n## Build\n')).toBe(
      true,
    );
    expect(text.match(/^# /gm)).toEqual(['# ']);
    expect(text).toContain('`ABCDEF-<N>`');
    expect(claudeMd(text, CONFIG, TEMPLATE, false)).toBe(text);
  });

  it('keeps every line of the block within 100 columns, and renders what the check renders', () => {
    const text = claudeMd(undefined, CONFIG, TEMPLATE, false);
    const kit = claudeBlocks(text).kit?.text ?? '';
    expect(kit.split('\n').filter((line) => line.length > 100)).toEqual([]);
    expect(sameKitBlock(kit, kit)).toBe(true);
    expect(text.endsWith('<!-- talos:end -->\n')).toBe(true);
  });

  it("replaces Scaffold's instructions, and only in a repository from Scaffold", () => {
    const scaffold = '# Notebook\n\nRun `just gates` before you push.\n';
    expect(claudeMd(scaffold, CONFIG, TEMPLATE, true)).not.toContain('just gates');
    expect(claudeMd(scaffold, CONFIG, TEMPLATE, false)).toContain('just gates');
  });

  it('demotes only top-level titles outside code and outside the block', () => {
    const text = [
      '<!-- talos:begin -->',
      '# Kit',
      '<!-- talos:end -->',
      '#Not a heading',
      '#',
      '   # Indented',
      '```bash',
      '# a shell comment',
      '```',
      '~~~~',
      '# still code',
      '~~~',
      '# still code, the fence is longer',
      '~~~~',
      '## Kept',
    ].join('\n');
    expect(demoteTitles(text).split('\n')).toEqual([
      '<!-- talos:begin -->',
      '# Kit',
      '<!-- talos:end -->',
      '#Not a heading',
      '##',
      '   ## Indented',
      '```bash',
      '# a shell comment',
      '```',
      '~~~~',
      '# still code',
      '~~~',
      '# still code, the fence is longer',
      '~~~~',
      '## Kept',
    ]);
  });
});

describe('kitFiles', () => {
  const assets: KitAssets = {
    issueForms: { 'bug.yml': 'name: Bug\n' },
    prTemplate: 'Closes #\n',
    dependabot: { schedule: { interval: 'weekly' }, cooldown: { 'default-days': 1 } },
    claudeKit: '# {{name}}\n',
  };

  it('writes the forms, the template in place of any other, and Dependabot without fixtures', () => {
    const texts: Record<string, string> = {
      'docs/pull_request_template.md': 'old\n',
      'test-projects/x/package.json': '{}\n',
    };
    const draft = startDraft(Object.keys(texts), (path) => texts[path]);
    kitFiles(draft, CONFIG, { ...assets, prTemplate: undefined }, false);
    expect(draft.done().delete).toEqual([]);
    kitFiles(draft, CONFIG, assets, false);
    const done = draft.done();
    expect(done.write.map((f) => f.path)).toEqual([
      'CLAUDE.md',
      '.github/ISSUE_TEMPLATE/bug.yml',
      '.github/dependabot.yml',
      '.github/pull_request_template.md',
    ]);
    expect(done.delete).toEqual([{ path: 'docs/pull_request_template.md', why: 'pr-template' }]);
    expect(draft.read('.github/dependabot.yml')).toContain(
      'exclude-paths:\n      - test-projects/**',
    );
  });
});
