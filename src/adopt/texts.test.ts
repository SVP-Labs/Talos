import { describe, expect, it } from 'vitest';
import { fromScaffold, isScaffoldClaude, oldKitCallers, scaffoldLeftovers } from './scaffold.js';
import {
  ADOPT_MARKER,
  bootstrapIssueBody,
  bootstrapPullBody,
  bootstrapSubject,
  briefPath,
  dateStamp,
  slugify,
} from './texts.js';
import { judgeReadiness } from '../jobs/readiness.js';
import { affectedPaths } from '../ticket/sections.js';

const NOW = new Date('2026-10-23T09:00:00Z');

describe('briefPath', () => {
  it('keeps a file already named by date and slug', () => {
    expect(briefPath('docs/requirements', 'drafts/20261020-talos-core.md', '# T', NOW)).toBe(
      'docs/requirements/20261020-talos-core.md',
    );
  });

  it("names it from its first heading, else its file name, and today's date", () => {
    expect(briefPath('docs/requirements', 'brief.md', 'intro\n# Notebook: a pen app\n', NOW)).toBe(
      'docs/requirements/20261023-notebook-a-pen-app.md',
    );
    expect(briefPath('docs/briefs', 'C:\\Users\\s\\My Brief.MD', 'no heading', NOW)).toBe(
      'docs/briefs/20261023-my-brief.md',
    );
    expect(briefPath('docs', 'x.md', '# \n', NOW)).toBe('docs/20261023-x.md');
  });

  it('slugs and stamps', () => {
    expect(slugify('  Crème — Café!! ')).toBe('creme-cafe');
    expect(slugify('***')).toBe('brief');
    expect(slugify('word '.repeat(30)).length).toBeLessThanOrEqual(60);
    expect(dateStamp(NOW)).toBe('20261023');
  });
});

describe('the bootstrap issue', () => {
  it('passes issue readiness as a chore and names its areas', () => {
    const body = bootstrapIssueBody({
      name: 'Notebook',
      brief: 'docs/requirements/20261023-s.md',
      scaffold: true,
    });
    expect(body).toContain(ADOPT_MARKER);
    const verdict = judgeReadiness({
      body,
      labels: ['chore'],
      briefsDir: 'docs/requirements',
      briefs: new Map(),
    });
    expect(verdict).toEqual({ ready: true, problems: [] });
    expect(affectedPaths(body)).toEqual([
      'talos.yml',
      'CLAUDE.md',
      '.github/',
      'docs/requirements/20261023-s.md',
    ]);
    expect(body).toContain("Scaffold's scripts");
  });

  it('names the commit and the PR by the ticket', () => {
    expect(bootstrapSubject('S', 1, 'Notebook')).toBe('[S-1]: Bring Notebook under Talos');
    const body = bootstrapPullBody({
      name: 'S',
      brief: undefined,
      scaffold: false,
      issue: 4,
      changed: 12,
    });
    expect(body.startsWith('Closes #4\n')).toBe(true);
    for (const heading of ['## Problem', '## Discussion', '## Solution']) {
      expect(body).toContain(heading);
    }
    expect(body).toContain('Changes 12 file(s)');
  });
});

describe('Scaffold', () => {
  const files = [
    'justfile',
    'lefthook.yml',
    'project.yml',
    'scripts/ticket',
    'scripts/deploy.sh',
    '.lang/ts/lang.just',
    '.lang/ts/config/eslint.config.js',
    '.github/labels.yml',
    '.github/rulesets/main.json',
    'ENGINEERING.md',
    '.claude/hooks/session-start.sh',
    '.claude/settings.json',
    'src/a.ts',
  ];
  const texts: Record<string, string> = {
    'project.yml': 'name: x\nscaffold:\n  version: ""\n',
    'ENGINEERING.md': '# Engineering Standards & Workflow\n',
    '.claude/hooks/session-start.sh': 'clone SVP-Labs/Workflows',
    '.claude/settings.json': '{"hooks":{"SessionStart":[{"command":"session-start.sh"}]}}',
  };
  const read = (path: string): string | undefined => texts[path];

  it("finds Scaffold's files and leaves the project's own", () => {
    expect(scaffoldLeftovers(files, read)).toEqual(
      files.filter((f) => f !== 'scripts/deploy.sh' && f !== 'src/a.ts'),
    );
  });

  it('touches nothing in a repository that never came from Scaffold', () => {
    expect(fromScaffold(['justfile', 'project.yml'], () => 'name: x\n')).toBe(false);
    expect(scaffoldLeftovers(['justfile'], () => undefined)).toEqual([]);
    expect(fromScaffold(['.github/scaffold/managed'], () => undefined)).toBe(true);
  });

  it("keeps a project's own engineering notes and Claude settings", () => {
    const own = (path: string): string | undefined =>
      ({
        'project.yml': 'scaffold: {}\n',
        'ENGINEERING.md': '# Our notes',
        '.claude/settings.json': '{"permissions":{}}',
      })[path];
    expect(
      scaffoldLeftovers(['project.yml', 'ENGINEERING.md', '.claude/settings.json'], own),
    ).toEqual(['project.yml']);
    expect(
      scaffoldLeftovers(['project.yml', '.claude/settings.json'], (p) =>
        p === 'project.yml' ? 'scaffold: {}' : 'not json',
      ),
    ).toEqual(['project.yml']);
  });

  it("recognises Scaffold's CLAUDE.md and the old kit's callers", () => {
    expect(isScaffoldClaude('run `just gates` before push')).toBe(true);
    expect(isScaffoldClaude('# Our project')).toBe(false);
    expect(
      oldKitCallers([
        {
          path: '.github/workflows/gates.yml',
          text: 'uses: SVP-Labs/Workflows/.github/workflows/gates.yml@v0',
        },
        { path: '.github/workflows/ci.yml', text: 'run: make' },
        { path: '.github/workflows/notes.md', text: 'SVP-Labs/Workflows' },
      ]),
    ).toEqual(['.github/workflows/gates.yml']);
  });
});
