import { describe, expect, it } from 'vitest';
import {
  briefLinks,
  judgeReadiness,
  needsBrief,
  readinessComment,
  readinessLabels,
  requiredSections,
} from './readiness.js';
import { readMarker } from './talos-issues.js';

const TICKET = `### Goal

Do it.

### Acceptance criteria

- [ ] it is done

### Out of scope

Nothing else.

### Affected areas

- \`src/a.ts\`
`;

const BUG = `${TICKET}
### Repro

1. run it

### Expected / Actual

Works / fails.
`;

const EPIC = `### Goal

All of it.

### Brief

docs/requirements/20261023-billing.md

### Out of scope

Later.
`;

const DIR = 'docs/requirements';

function judge(body: string, labels: string[], briefs: [string, boolean][] = []): string[] {
  return [...judgeReadiness({ body, labels, briefsDir: DIR, briefs: new Map(briefs) }).problems];
}

describe('requiredSections', () => {
  it('asks a ticket for goal, criteria, scope and areas, and a bug for more', () => {
    expect(requiredSections(['feature'])).toEqual([
      'goal',
      'acceptance criteria',
      'out of scope',
      'affected areas',
    ]);
    expect(requiredSections(['bug'])).toContain('expected/actual');
    expect(requiredSections(['bug'])).toContain('repro');
  });

  it('asks an epic for its goal and scope only', () => {
    expect(requiredSections(['epic'])).toEqual(['goal', 'out of scope']);
  });

  it('judges an issue whose type is unclear as a ticket', () => {
    expect(requiredSections([])).toHaveLength(4);
    expect(requiredSections(['epic', 'chore'])).toHaveLength(4);
  });
});

describe('needsBrief', () => {
  it('is true for an epic and for a decision', () => {
    expect(needsBrief(['epic'])).toBe(true);
    expect(needsBrief(['feature', 'decision'])).toBe(true);
    expect(needsBrief(['feature'])).toBe(false);
  });
});

describe('briefLinks', () => {
  it('finds paths, Markdown links and links to GitHub', () => {
    const body = [
      'See docs/requirements/20261022-talos-core.md.',
      '[brief](docs/requirements/20261023-billing.md)',
      'https://github.com/o/r/blob/main/docs/requirements/20261001-x-y.md',
      '`./docs/requirements/20261002-ticked.md`',
      'again docs/requirements/20261022-talos-core.md',
    ].join('\n');
    expect(briefLinks(body, DIR)).toEqual([
      'docs/requirements/20261022-talos-core.md',
      'docs/requirements/20261023-billing.md',
      'docs/requirements/20261001-x-y.md',
      'docs/requirements/20261002-ticked.md',
    ]);
  });

  it('takes the folder talos.yml names, with stray slashes', () => {
    expect(briefLinks('docs/briefs/20261023-a.md', './docs/briefs/')).toEqual([
      'docs/briefs/20261023-a.md',
    ]);
  });

  it('ignores what only looks like a brief', () => {
    const body = [
      'other/docs/requirements/20261023-a.md',
      'docs/requirements/2026102-short.md',
      'docs/requirements/20261340-bad-month.md',
      'docs/requirements/20261023-UPPER.md',
      'docs/requirements/20261023-a.mdx',
      'docs/requirements/20261023-a.md.bak',
      'docs/requirements/README.md',
    ].join('\n');
    expect(briefLinks(body, DIR)).toEqual([]);
  });
});

describe('judgeReadiness', () => {
  it('passes a complete ticket', () => {
    expect(
      judgeReadiness({ body: TICKET, labels: ['feature'], briefsDir: DIR, briefs: new Map() }),
    ).toEqual({ ready: true, problems: [] });
    expect(judge(BUG, ['bug'])).toEqual([]);
  });

  it('asks for exactly one type label', () => {
    expect(judge(TICKET, [])).toEqual([
      expect.stringMatching(/exactly one type label .*it has none$/),
    ]);
    expect(judge(TICKET, ['bug', 'chore'])[0]).toMatch(/it has bug, chore$/);
  });

  it('names each missing or empty section', () => {
    const body = '### Goal\n\n_No response_\n\n### Acceptance criteria\n\n- [ ] x\n';
    expect(judge(body, ['chore'])).toEqual([
      'something under `## Goal`',
      'a `## Out of scope` section',
      'a `## Affected areas` section',
    ]);
  });

  it('asks a bug for its repro and expected behaviour', () => {
    expect(judge(TICKET, ['bug'])).toEqual([
      'a `## Repro` section',
      'a `## Expected / Actual` section',
    ]);
  });

  it('holds acceptance criteria to one to five checkboxes', () => {
    const none = TICKET.replace('- [ ] it is done', 'it is done');
    expect(judge(none, ['feature'])).toEqual([
      'at least one `- [ ]` checkbox under Acceptance criteria',
    ]);
    const six = TICKET.replace(
      '- [ ] it is done',
      Array.from({ length: 6 }, (_, i) => `- [ ] c${i}`).join('\n'),
    );
    expect(judge(six, ['feature'])).toEqual([
      'at most 5 acceptance criteria, not 6: split the issue',
    ]);
    const five = TICKET.replace(
      '- [ ] it is done',
      Array.from({ length: 5 }, (_, i) => `- [x] c${i}`).join('\n'),
    );
    expect(judge(five, ['feature'])).toEqual([]);
  });

  it('asks an epic and a decision for a brief that exists', () => {
    expect(judge(EPIC, ['epic'], [['docs/requirements/20261023-billing.md', true]])).toEqual([]);
    expect(judge(EPIC, ['epic'], [['docs/requirements/20261023-billing.md', false]])).toEqual([
      "its brief `docs/requirements/20261023-billing.md` on the default branch: it isn't there",
    ]);
    expect(judge(TICKET, ['feature', 'decision'])).toEqual([
      expect.stringMatching(/^a link to its brief, `docs\/requirements\/<YYYYMMDD>-<slug>\.md`/),
    ]);
  });

  it('asks nothing of the brief when the issue needs none', () => {
    expect(judge(TICKET, ['feature'], [['docs/requirements/20261023-gone.md', false]])).toEqual([]);
  });
});

describe('readinessLabels', () => {
  it('marks a failing issue needs-spec and takes it out of the queue', () => {
    expect(readinessLabels(false, ['bug', 'status/ready'])).toEqual({
      add: ['needs-spec'],
      remove: ['status/ready'],
    });
    expect(readinessLabels(false, ['bug', 'needs-spec'])).toEqual({ add: [], remove: [] });
  });

  it('makes a passing issue ready and clears needs-spec', () => {
    expect(readinessLabels(true, ['bug', 'needs-spec'])).toEqual({
      add: ['status/ready'],
      remove: ['needs-spec'],
    });
    expect(readinessLabels(true, ['bug', 'status/ready'])).toEqual({ add: [], remove: [] });
  });

  it('leaves a claimed issue claimed', () => {
    expect(readinessLabels(true, ['bug', 'status/in-progress', 'needs-spec'])).toEqual({
      add: [],
      remove: ['needs-spec'],
    });
  });

  it('never makes an epic ready to claim', () => {
    expect(readinessLabels(true, ['epic', 'status/ready', 'needs-spec'])).toEqual({
      add: [],
      remove: ['needs-spec', 'status/ready'],
    });
    expect(readinessLabels(true, ['epic'])).toEqual({ add: [], remove: [] });
  });
});

describe('readinessComment', () => {
  it('lists the problems under its marker', () => {
    const text = readinessComment(['a `## Goal` section', 'something']);
    expect(readMarker(text, 'readiness')).toEqual({ ready: 'no', problems: '2' });
    expect(text).toContain('- a `## Goal` section\n- something\n');
    expect(text).toContain('Not ready yet');
  });

  it('says ready once nothing is missing', () => {
    const text = readinessComment([]);
    expect(readMarker(text, 'readiness')).toEqual({ ready: 'yes', problems: '0' });
    expect(text).toContain('**Ready.**');
  });
});
