import { describe, expect, it } from 'vitest';
import { rewriteLcov } from './lcov.js';

/** Recorded from cargo-llvm-cov 0.9.1 (`--lcov`), function names trimmed. */
const LCOV = `SF:/ws/app/src/main.rs
FN:1,main
FNDA:0,main
FNF:1
FNH:0
DA:1,0
DA:2,0
LF:2
LH:0
end_of_record
SF:/ws/core/src/quiet.rs
FN:5,is_quiet
FNDA:2,is_quiet
FNF:1
FNH:1
DA:5,2
DA:6,2
DA:7,0
DA:14,1
DA:15,1
BRDA:6,0,0,1
BRDA:15,0,0,1
BRF:2
BRH:2
LF:5
LH:4
end_of_record
SF:/home/me/.cargo/registry/src/itoa/lib.rs
DA:1,1
end_of_record
`;

describe('rewriteLcov', () => {
  it('keeps the component’s files, relative, without their test lines', () => {
    const place = (file: string): string | undefined =>
      file.startsWith('/ws/core/') ? file.slice('/ws/'.length) : undefined;
    const tests = (): ((line: number) => boolean) => (line) => line >= 10;
    expect(rewriteLcov(LCOV, place, tests)).toBe(
      [
        'SF:core/src/quiet.rs',
        'FN:5,is_quiet',
        'FNDA:2,is_quiet',
        'FNF:1',
        'FNH:1',
        'DA:5,2',
        'DA:6,2',
        'DA:7,0',
        'BRDA:6,0,0,1',
        'BRF:1',
        'BRH:1',
        'LF:3',
        'LH:2',
        'end_of_record',
        '',
      ].join('\n'),
    );
  });

  it('writes an empty report when nothing is left', () => {
    expect(
      rewriteLcov(
        LCOV,
        () => undefined,
        () => () => false,
      ),
    ).toBe('');
  });
});
