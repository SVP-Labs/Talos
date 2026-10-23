import { describe, expect, it } from 'vitest';
import { scanRust } from './scan.js';
import { deepBlocks, isTestAttribute, shapeOf } from './structure.js';

const texts = (source: string): string[] => scanRust(source).map((t) => t.text);

describe('scanRust', () => {
  it('skips comments, nested block comments included', () => {
    expect(texts('a // b\n/* c /* d */ e */ f /// g\n')).toEqual(['a', 'f']);
  });

  it('reads strings, raw strings, byte strings and C strings whole', () => {
    const source = String.raw`x = "a \" { b"; y = r#"no "} here"#; z = b"{"; w = c"}"; v = br"{";`;
    expect(texts(source).filter((t) => t === '{' || t === '}')).toEqual([]);
  });

  it('tells character literals from lifetimes and labels', () => {
    const tokens = scanRust(
      String.raw`fn f<'a>(x: &'a str) { let c = '{'; let e = '\''; 'outer: loop {} }`,
    );
    expect(tokens.filter((t) => t.kind === 'lifetime').map((t) => t.text)).toEqual([
      "'a",
      "'a",
      "'outer",
    ]);
    expect(tokens.filter((t) => t.kind === 'literal').map((t) => t.text)).toEqual([
      "'{'",
      String.raw`'\''`,
    ]);
  });

  it('reads raw identifiers as identifiers and keeps multi-line strings on their lines', () => {
    const tokens = scanRust('let r#type = 1;\nlet s = "one\ntwo";\n');
    expect(tokens.find((t) => t.text === 'type')?.kind).toBe('ident');
    expect(tokens.find((t) => t.text.startsWith('"'))).toMatchObject({ line: 2, endLine: 3 });
  });
});

describe('isTestAttribute', () => {
  const inner = (attribute: string): boolean => isTestAttribute(scanRust(attribute));

  it('knows test attributes and cfg(test)', () => {
    expect(inner('test')).toBe(true);
    expect(inner('tokio::test(flavor = "multi_thread")')).toBe(true);
    expect(inner('rstest')).toBe(true);
    expect(inner('cfg(test)')).toBe(true);
    expect(inner('cfg(all(test, unix))')).toBe(true);
  });

  it('leaves everything else alone', () => {
    expect(inner('cfg(not(test))')).toBe(false);
    expect(inner('cfg_attr(test, derive(Debug))')).toBe(false);
    expect(inner('derive(Debug)')).toBe(false);
    expect(inner('should_panic')).toBe(false);
  });
});

describe('shapeOf', () => {
  it('finds test items, test module declarations and lines of code', () => {
    const source = [
      '//! A module.',
      'pub fn add(a: i32) -> i32 {',
      '    a + 1',
      '}',
      '',
      '#[cfg(test)]',
      'mod helpers;',
      '',
      '#[cfg(test)]',
      'mod tests {',
      '    #[test]',
      '    fn adds() {',
      '        assert_eq!(super::add(1), 2);',
      '    }',
      '}',
      '',
    ].join('\n');
    const shape = shapeOf(source);
    expect(shape.tests).toEqual([
      { start: 6, end: 7 },
      { start: 9, end: 15 },
    ]);
    expect(shape.testModules).toEqual(['helpers']);
    expect(shape.wholeFileTest).toBe(false);
    expect([...shape.codeLines]).toEqual([2, 3, 4, 6, 7, 9, 10, 11, 12, 13, 14, 15]);
  });

  it('marks a file that opens with #![cfg(test)] as test code', () => {
    expect(
      shapeOf('//! Helpers.\n#![allow(dead_code)]\n#![cfg(test)]\nfn f() {}\n').wholeFileTest,
    ).toBe(true);
    expect(shapeOf('fn f() {}\nmod x {\n#![cfg(test)]\n}\n').wholeFileTest).toBe(false);
  });
});

describe('deepBlocks', () => {
  const deep = (source: string): { start: number; end: number }[] => deepBlocks(scanRust(source));

  it('allows three levels inside a function, method or test module', () => {
    const three =
      'for x in a {\n if x > 0 {\n match x {\n 1 => { if y { z(); } }\n _ => {}\n }\n }\n }';
    expect(deep(`fn f() {\n${three}\n}`)).toEqual([{ start: 5, end: 5 }]);
    const ok = 'for x in a {\n if x > 0 {\n while y {\n z();\n }\n }\n }';
    expect(deep(`impl S {\n fn f(&self) {\n${ok}\n}\n}`)).toEqual([]);
    expect(deep(`#[cfg(test)]\nmod tests {\n fn f() {\n${ok}\n}\n}`)).toEqual([]);
  });

  it('reports the block one level too deep, from its keyword to its brace', () => {
    const source =
      'fn f() {\n for x in a {\n if b {\n loop {\n while c\n && d {\n e();\n }\n }\n }\n }\n}';
    expect(deep(source)).toEqual([{ start: 5, end: 8 }]);
  });

  it('counts else at its if’s level and an else-if chain as one', () => {
    const source =
      'fn f() {\n if a {\n} else if b {\n if c {\n if d {\n}\n}\n} else {\n if e {\n}\n}\n}';
    expect(deep(source)).toEqual([]);
  });

  it('starts again inside closures and nested functions', () => {
    const closure =
      'fn f() {\n for x in a {\n if b {\n xs.iter().for_each(|y| {\n if c { if d { if e {} } }\n });\n }\n }\n}';
    expect(deep(closure)).toEqual([]);
    const nested =
      'fn f() {\n if a {\n if b {\n fn g() {\n if c { if d { if e {} } }\n }\n }\n }\n}';
    expect(deep(nested)).toEqual([]);
  });

  it('keeps a closure in a condition from ending the condition', () => {
    const source =
      'fn f() {\n if a {\n if b {\n if xs.iter().any(|x| { x > 0 }) {\n if c {}\n }\n }\n }\n}';
    expect(deep(source)).toEqual([{ start: 5, end: 5 }]);
  });

  it('ignores struct literals, impl headers with for, and higher-ranked bounds', () => {
    const source =
      "impl<T> Tr for S<T> where T: for<'a> Fn(&'a str) {\n fn f() -> S { S { a: 1 } }\n}\n" +
      'fn g() { if a { let s = S { b: 2 }; if s.b { if c {} } } }';
    expect(deep(source)).toEqual([]);
  });
});
