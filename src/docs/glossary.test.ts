import { describe, expect, it } from 'vitest';
import {
  avoidedInCode,
  avoidedWords,
  codeWords,
  glossaryWords,
  parseGlossary,
} from './glossary.js';

const glossary = [
  '# Glossary',
  '',
  '**Merge queue**',
  "GitHub's queue that lands pull requests.",
  'Avoid: line-up, landing strip.',
  '',
  '**Debt list**',
  'What is left on main.',
].join('\n');

describe('parseGlossary', () => {
  it('reads terms and the words they replace', () => {
    expect(parseGlossary(glossary)).toEqual([
      { term: 'Merge queue', line: 3, avoid: ['line-up', 'landing strip'] },
      { term: 'Debt list', line: 7, avoid: [] },
    ]);
  });

  it("gives every term's words to the spelling dictionary", () => {
    expect(glossaryWords(parseGlossary(glossary))).toEqual(['Debt', 'list', 'Merge', 'queue']);
  });
});

describe('avoided words', () => {
  const entries = parseGlossary(glossary);

  it('matches whole words and phrases, whatever their case', () => {
    expect(avoidedWords(entries, 'The Landing Strip and the line-up, not a line-ups.')).toEqual([
      { word: 'line-up', instead: 'Merge queue', index: 26 },
      { word: 'landing strip', instead: 'Merge queue', index: 4 },
    ]);
  });

  it('reads identifiers as words, and reports where in the line', () => {
    expect(codeWords('aLandingStrip_x')).toEqual({
      text: 'a Landing Strip x',
      offsets: [0, 1, 1, 2, 3, 4, 5, 6, 7, 8, 8, 9, 10, 11, 12, 13, 14],
    });
    expect(avoidedInCode(entries, 'const toLandingStrip = LANDING_STRIP;')).toEqual([
      { word: 'landing strip', instead: 'Merge queue', index: 8 },
      { word: 'landing strip', instead: 'Merge queue', index: 23 },
    ]);
    expect(avoidedInCode(entries, 'const landingStrips = 1;')).toEqual([]);
  });
});
