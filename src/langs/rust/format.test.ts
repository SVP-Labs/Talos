import { describe, expect, it } from 'vitest';
import { parseRustfmtCheck, unformattedMessage, unparsable } from './format.js';

/** Recorded from `cargo fmt --all --check -- --color never` (rustfmt 1.9.0, Rust 1.97). */
const CHECK = `Diff in /ws/app/src/main.rs:1:
 fn main() {
-\tlet x: i32 = 1;
-\tprintln!("{}", demo_core::add(1, x));
+    let x: i32 = 1;
+    println!("{}", demo_core::add(1, x));
 }

 fn other() {
Diff in /ws/app/src/main.rs:7:
-\tlet a = 1;
-\tif a == 1 {
+    let a = 1;
+    if a == 1 {
 }
Diff in C:\\ws\\core\\src\\lib.rs:4:
 fn f() {}
+
 fn g() {}
`;

const STDERR = `error: this file contains an unclosed delimiter
 --> /ws/core/src/broken.rs:1:14
  |
1 | fn broken( {
  |          - -^

Error writing files: failed to resolve mod \`broken\`: cannot parse /ws/core/src/broken.rs
`;

describe('parseRustfmtCheck', () => {
  it('spans each file from its first to its last line rustfmt would change', () => {
    expect(parseRustfmtCheck(CHECK)).toEqual([
      { file: '/ws/app/src/main.rs', line: 2, endLine: 8 },
      { file: String.raw`C:\ws\core\src\lib.rs`, line: 4, endLine: 4 },
    ]);
  });

  it('reads nothing from a clean run', () => {
    expect(parseRustfmtCheck('')).toEqual([]);
  });
});

describe('unformattedMessage', () => {
  it('names one line or a range', () => {
    expect(unformattedMessage({ file: 'a.rs', line: 3, endLine: 3 })).toBe(
      "Line 3 isn't formatted the way rustfmt writes it.",
    );
    expect(unformattedMessage({ file: 'a.rs', line: 3, endLine: 9 })).toBe(
      "Lines 3 to 9 aren't formatted the way rustfmt writes them.",
    );
  });
});

describe('unparsable', () => {
  it('names the files rustfmt could not parse', () => {
    expect(unparsable(STDERR)).toEqual(['/ws/core/src/broken.rs']);
  });
});
