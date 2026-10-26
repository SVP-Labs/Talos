import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { functionEnds } from './spans.js';
import { exec } from '../../exec/exec.js';
import { tempRepo } from '../../testing/engine.js';

const SOURCE = `export function decl(x: number): number {
  if (x > 1) return 1;
  return 0;
}

export const arrow = (x: number): { a: number } => {
  const inner = (y: number): number => y + 1;
  return { a: inner(x) };
};

export class K {
  method(x: number): number {
    return x;
  }
}
`;

describe('functionEnds', () => {
  it("finds the end of the function each ESLint position names, with the project's TypeScript", async () => {
    const dir = await tempRepo({ 'src/cx.ts': SOURCE });
    const file = join(dir, 'src', 'cx.ts');
    // Positions as ESLint's complexity rule reports them: the keyword, the arrow, the name.
    const ends = await functionEnds({ root: process.cwd(), exec }, [
      { file, line: 1, column: 8 },
      { file, line: 6, column: 51 },
      { file, line: 7, column: 37 },
      { file, line: 12, column: 3 },
      { file, line: 11, column: 1 },
      { file: join(dir, 'missing.ts'), line: 1, column: 1 },
    ]);
    expect(ends).toEqual([4, 9, 7, 14, null, null]);
  });

  it('asks nothing when there is nothing to widen', async () => {
    expect(await functionEnds({ root: process.cwd(), exec }, [])).toEqual([]);
  });
});
