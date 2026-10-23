import { describe, expect, it } from 'vitest';
import { subjectFindings, ticketOf } from './commits.js';
import { parseGlossary } from '../../docs/glossary.js';

const glossary = parseGlossary('**Ticket**\nAn issue.\nAvoid: task, job.\n');
const commit = (subject: string, authorEmail = 'a@b.c') => ({
  sha: 'abcdef1234567',
  subject,
  authorEmail,
});

describe('commit subjects', () => {
  it('accept the ticket form', () => {
    expect(subjectFindings(commit('[T-12]: Add the claim'), 'T', 12, glossary)).toEqual([]);
  });

  it('refuse other forms, other tickets and long subjects', () => {
    expect(subjectFindings(commit('Add the claim'), 'T', 12, glossary)[0]?.rule).toBe(
      'commit/subject',
    );
    expect(subjectFindings(commit('[T-13]: Add the claim'), 'T', 12, glossary)[0]?.rule).toBe(
      'commit/ticket',
    );
    const long = `[T-12]: ${'x'.repeat(70)}`;
    expect(subjectFindings(commit(long), 'T', 12, glossary).map((f) => f.rule)).toEqual([
      'commit/length',
    ]);
  });

  it('read the prefix as written, and want text after the colon', () => {
    expect(subjectFindings(commit('[A+-12]: Add the claim'), 'A+', 12, glossary)).toEqual([]);
    const rules = (subject: string) =>
      subjectFindings(commit(subject), 'A+', 12, glossary).map((f) => f.rule);
    expect(rules('[AA-12]: Add the claim')).toEqual(['commit/subject']);
    expect(rules('[A+-12]:Add the claim')).toEqual(['commit/subject']);
    expect(rules('[A+-12]: ')).toEqual(['commit/subject']);
    expect(rules('[A+-x]: Add the claim')).toEqual(['commit/subject']);
  });

  it("refuse the glossary's avoided words", () => {
    const [hit] = subjectFindings(commit('[T-12]: Close the task'), 'T', 12, glossary);
    expect(hit?.message).toContain('"Ticket"');
  });

  it("exempt Dependabot's commits from the ticket rules", () => {
    const bot = commit('Bump x from 1 to 2', '49699333+dependabot[bot]@users.noreply.github.com');
    expect(subjectFindings(bot, 'T', undefined, glossary)).toEqual([]);
  });

  it('read the ticket from a ticket branch only', () => {
    expect(ticketOf('T-12', 'T')).toBe(12);
    expect(ticketOf('feature/x', 'T')).toBeUndefined();
    expect(ticketOf(undefined, 'T')).toBeUndefined();
    expect(ticketOf('T-12x', 'T')).toBeUndefined();
    expect(ticketOf('XT-12', 'T')).toBeUndefined();
    expect(ticketOf('T-', 'T')).toBeUndefined();
  });

  it('read a prefix with pattern characters as written', () => {
    expect(ticketOf('A.B-3', 'A.B')).toBe(3);
    expect(ticketOf('AxB-3', 'A.B')).toBeUndefined();
    expect(ticketOf('T-3', 'T|X')).toBeUndefined();
  });
});
