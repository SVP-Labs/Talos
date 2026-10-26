import { format } from 'prettier';
import { describe, expect, it } from 'vitest';
import { renderFlatJson } from './json.js';
import { PRETTIER_OPTIONS } from '../langs/ts/configs/prettier.js';

async function prettier(text: string): Promise<string> {
  return format(text, { ...PRETTIER_OPTIONS, parser: 'json' });
}

describe('renderFlatJson', () => {
  it('writes scalars and short lists on one line each', () => {
    expect(renderFlatJson({ '//': 'note', min: 5, on: true, list: ['a', 'b'] })).toBe(
      '{\n  "//": "note",\n  "min": 5,\n  "on": true,\n  "list": ["a", "b"]\n}\n',
    );
  });

  it('breaks a list that does not fit into one item a line', () => {
    const items = Array.from({ length: 12 }, (_, index) => `item-number-${index}`);
    const text = renderFlatJson({ items });
    expect(text.split('\n')[1]).toBe('  "items": [');
    expect(text).toContain('    "item-number-11"\n  ]\n}');
  });

  it('matches what Prettier writes, at and around the line width', async () => {
    for (let length = 70; length <= 100; length += 1) {
      const items = ['x'.repeat(length - 30), 'yy'];
      const last = renderFlatJson({ first: 1, items });
      const middle = renderFlatJson({ items, after: 'z', empty: [] });
      expect(await prettier(last)).toBe(last);
      expect(await prettier(middle)).toBe(middle);
    }
  });
});
