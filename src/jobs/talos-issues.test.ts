import { describe, expect, it } from 'vitest';
import { codeSpan, digest, fileIssue, marker, readMarker, talosIssues } from './talos-issues.js';
import { github } from '../github/api.js';
import { identities } from '../github/identities.js';
import { FakeGitHub } from '../ticket/test/fake-github.js';

const who = identities({});

describe('marker and readMarker', () => {
  it('round-trips fields, whatever they hold', () => {
    const text = marker('debt', { file: 'src/a b/c=d.ts', findings: 'abc' });
    expect(text).toBe('<!-- talos-debt/1 file=src%2Fa%20b%2Fc%3Dd.ts findings=abc -->');
    expect(readMarker(`${text}\n### Goal`, 'debt')).toEqual({
      file: 'src/a b/c=d.ts',
      findings: 'abc',
    });
    expect(readMarker(marker('sync'), 'sync')).toEqual({});
  });

  it('reads only a marker of the kind asked for, on the first line', () => {
    expect(readMarker(marker('sync'), 'debt')).toBeUndefined();
    expect(readMarker(`text\n${marker('debt')}`, 'debt')).toBeUndefined();
    expect(readMarker('talos-debt/2', 'debt')).toBeUndefined();
    expect(readMarker('<!-- talos-debt/1 -->', 'debt')).toEqual({});
    expect(readMarker('<!-- talos-debt/1', 'debt')).toBeUndefined();
    expect(readMarker('', 'debt')).toBeUndefined();
  });

  it('drops a field it cannot decode', () => {
    expect(readMarker('talos-flaky/1 test=%E0 ok=1', 'flaky')).toEqual({ ok: '1' });
  });

  it('reads the line as the status parser does: the first line, fields after the name', () => {
    expect(readMarker('talos-sync/1 files=2  \nrest', 'sync')).toEqual({ files: '2' });
    expect(readMarker('talos-sync/10 files=2', 'sync')).toBeUndefined();
    expect(readMarker('Note: talos-sync/1 files=2', 'sync')).toBeUndefined();
  });

  it('takes fields in any order, ignoring what it does not know, plainly or hidden', () => {
    const fields = { file: 'src/a.ts', findings: 'abc' };
    for (const body of [
      'talos-debt/1 findings=abc file=src%2Fa.ts',
      '<!-- talos-debt/1 later=1 file=src%2Fa.ts  odd findings=abc -->\n### Goal',
      '<!--talos-debt/1 file=src%2Fa.ts findings=abc-->',
      '\n\ntalos-debt/1 file=src%2Fa.ts findings=abc',
    ]) {
      expect(readMarker(body, 'debt'), body).toMatchObject(fields);
    }
    expect(readMarker('<!-- talos-debt/1 Kind=x -->', 'debt')).toEqual({});
  });
});

describe('digest', () => {
  it('is short and stable', () => {
    expect(digest('x')).toBe(digest('x'));
    expect(digest('x')).toMatch(/^[0-9a-f]{12}$/);
    expect(digest('x')).not.toBe(digest('y'));
  });
});

describe('codeSpan', () => {
  it('makes tool text inert: one line, no backticks, no table breaks', () => {
    expect(codeSpan('a\n  b | `c` @d')).toBe("`a b \\| 'c' @d`");
    expect(codeSpan('   ')).toBe('—');
    expect(codeSpan('x'.repeat(10), 5)).toBe('`xxxx…`');
  });
});

describe('talosIssues', () => {
  it("returns the reviewer's issues with the marker, open or closed", async () => {
    const fake = new FakeGitHub();
    fake.addIssue({
      number: 1,
      labels: ['flaky'],
      user: who.reviewer,
      body: marker('flaky', { test: 'a' }),
    });
    fake.addIssue({
      number: 2,
      labels: ['flaky'],
      user: who.reviewer,
      body: marker('flaky', { test: 'b' }),
      state: 'closed',
    });
    fake.addIssue({
      number: 3,
      labels: ['flaky'],
      user: 'SvenPGH',
      body: marker('flaky', { test: 'c' }),
    });
    fake.addIssue({ number: 4, labels: ['flaky'], user: who.reviewer, body: 'no marker' });
    fake.addIssue({
      number: 5,
      labels: ['bug'],
      user: who.reviewer,
      body: marker('flaky', { test: 'e' }),
    });
    fake.addIssue({
      number: 6,
      labels: ['flaky'],
      user: who.reviewer,
      body: marker('flaky'),
      pull_request: { url: 'x' },
    });
    const found = await talosIssues(fake.client(), { repo: 'o/r', who }, 'flaky', 'flaky');
    expect(found.map((i) => [i.number, i.fields.test])).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
  });
});

describe('fileIssue', () => {
  it('files with its labels, and adds any GitHub dropped', async () => {
    const fake = new FakeGitHub();
    const dropping: typeof fetch = (input, init) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      return fake.fetch(input, { ...init, body: body.replace(',"ai/eligible"', '') });
    };
    const gh = github(who.reviewer, { fetch: dropping });
    const n = await fileIssue(gh, 'o/r', { title: 't', body: 'b', labels: ['bug', 'ai/eligible'] });
    expect(n).toBe(1);
    expect(fake.issues.get(1)?.labels).toEqual(['bug', 'ai/eligible']);
    expect(fake.writes()).toEqual(['POST repos/o/r/issues', 'POST repos/o/r/issues/1/labels']);
  });
});
