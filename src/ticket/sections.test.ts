import { describe, expect, it } from 'vitest';
import { affectedPaths, checkboxCount, hasContent, sectionKey, sections } from './sections.js';

const FORM_BODY = `### Goal

Make the thing work.

### Expected / Actual

It should; it doesn't.

### Acceptance criteria

- [ ] one
- [x] two

### Out of scope

_No response_

### Affected areas

- \`src/a.ts\`
- the docs
* \`src/b.ts\`
- \`src/a.ts\`
`;

describe('sectionKey', () => {
  it('ignores case, a trailing colon and spacing around a slash', () => {
    expect(sectionKey('Expected / Actual')).toBe('expected/actual');
    expect(sectionKey(' expected/actual: ')).toBe('expected/actual');
    expect(sectionKey('Acceptance   Criteria')).toBe('acceptance criteria');
  });
});

describe('sections', () => {
  it('reads the sections an issue form writes', () => {
    const found = sections(FORM_BODY);
    expect(found.get('goal')).toBe('Make the thing work.');
    expect(found.get('expected/actual')).toBe("It should; it doesn't.");
    expect(found.get('out of scope')).toBe('_No response_');
    expect([...found.keys()]).toEqual([
      'goal',
      'expected/actual',
      'acceptance criteria',
      'out of scope',
      'affected areas',
    ]);
  });

  it('reads ## headings and keeps the first of two', () => {
    const found = sections('intro\n## Goal\nfirst\n## goal:\nsecond\n#Not a heading\n');
    expect(found.get('goal')).toBe('first');
  });

  it('finds nothing in a body without headings', () => {
    expect(sections('just text').size).toBe(0);
    expect(sections('').size).toBe(0);
  });

  it('reads Windows line endings', () => {
    expect(sections('## Goal\r\nyes\r\n').get('goal')).toBe('yes');
  });
});

describe('hasContent', () => {
  it("treats a missing section, blank text and the forms' empty answer as empty", () => {
    expect(hasContent(undefined)).toBe(false);
    expect(hasContent('  \n ')).toBe(false);
    expect(hasContent('_No response_')).toBe(false);
    expect(hasContent('something')).toBe(true);
  });
});

describe('checkboxCount', () => {
  it('counts checked and unchecked items that say something', () => {
    expect(checkboxCount('- [ ] a\n- [x] b\n* [X] c\n+ [ ] d\n  - [ ] nested')).toBe(5);
  });

  it('does not count an empty checkbox or a plain item', () => {
    expect(checkboxCount('- [ ]\n- [ ] \n- item\n[ ] bare')).toBe(0);
  });
});

describe('affectedPaths', () => {
  it('lists each path named in a code span, once', () => {
    expect(affectedPaths(FORM_BODY)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('is empty without the section, or when items name no path', () => {
    expect(affectedPaths('## Goal\nx')).toEqual([]);
    expect(affectedPaths('## Affected areas\n- the hub\n- `two words`')).toEqual([]);
  });
});
