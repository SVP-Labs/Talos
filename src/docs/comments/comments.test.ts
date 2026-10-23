import { describe, expect, it } from 'vitest';
import { commentProblems, commentsIn } from './index.js';

const texts = (file: string, source: string): string[] =>
  commentsIn(file, source).map((comment) => comment.text);

describe('commentsIn', () => {
  it('reads TypeScript comments, not strings, templates or regular expressions', () => {
    const source = [
      "const a = '// no'; // one",
      'const b = `/* no ${x /* two */} ${"// no"}`;',
      'const c = /\\/\\/ no [/]/g.test(d) / 2; /** three',
      ' * four */',
      'const e = f / g; // five',
    ].join('\n');
    expect(commentsIn('a.ts', source)).toEqual([
      { line: 1, text: 'one', doc: false, block: false },
      { line: 2, text: 'two', doc: false, block: true },
      { line: 3, text: 'three', doc: true, block: true },
      { line: 4, text: 'four', doc: true, block: true },
      { line: 5, text: 'five', doc: false, block: false },
    ]);
  });

  it('reads Rust doc comments, nested blocks, raw strings, chars and lifetimes', () => {
    const source = [
      "fn f<'a>(x: &'a str) -> char { '\"' } /// doc",
      'let s = r#"// no "quote" "#; /* outer /* inner */ still */',
      'let t = "// no\\" // still no"; //! inner doc',
    ].join('\n');
    expect(commentsIn('a.rs', source).map((c) => [c.text, c.doc])).toEqual([
      ['doc', true],
      ['outer /* inner */ still', false],
      ['inner doc', true],
    ]);
  });

  it('reads PHP inside its tags only, past here-documents and attributes', () => {
    const source = [
      '<p># not php</p>',
      '<?php',
      '#[Attribute] // one',
      '$a = <<<EOT',
      '# not a comment',
      'EOT;',
      "echo 'it''s # no'; # two ?> <b>// html</b> <?php // three",
    ].join('\n');
    expect(texts('a.php', source)).toEqual(['one', 'two', 'three']);
  });

  it('reads Python comments and docstrings, not other strings', () => {
    const source = [
      '"""Module doc."""',
      'x = "# no"  # one',
      "y = '''",
      '# no',
      "'''",
      'def f():',
      '    r"""Doc of f."""',
    ].join('\n');
    expect(commentsIn('a.py', source).map((c) => [c.text, c.doc])).toEqual([
      ['Module doc.', true],
      ['one', false],
      ['Doc of f.', true],
    ]);
  });

  it('reads Lua line, doc and long comments, not long strings', () => {
    const source = ['local s = [[ -- no ]] -- one', '--- doc', '--[==[ two', ']] three ]==]'].join(
      '\n',
    );
    expect(commentsIn('a.lua', source).map((c) => [c.text, c.doc, c.block])).toEqual([
      ['one', false, false],
      ['doc', true, false],
      ['two', false, true],
      [']] three', false, true],
    ]);
  });

  it('reads shell comments, not shebangs, $#, quotes or here-documents', () => {
    const source = [
      '#!/usr/bin/env bash',
      'echo "$# ${#x} # no" # one',
      "cat <<'EOF' # two",
      '# not a comment',
      'EOF',
      'a=b#c',
    ].join('\n');
    expect(texts('a.sh', source)).toEqual(['one', 'two']);
  });

  it('reads PowerShell comments and help blocks, not here-strings', () => {
    const source = [
      '<#',
      '.SYNOPSIS',
      'Help.',
      '#>',
      '$a = @"',
      '# no',
      '"@',
      "'it''s # no' # one",
    ].join('\n');
    expect(commentsIn('a.ps1', source).map((c) => [c.text, c.doc])).toEqual([
      ['', true],
      ['.SYNOPSIS', true],
      ['Help.', true],
      ['', true],
      ['one', false],
    ]);
  });

  it('knows no comments in a file of another language', () => {
    expect(commentsIn('a.go', '// one')).toEqual([]);
  });
});

describe('commentProblems', () => {
  const ctx = { decisions: new Set(['C8', 'D45', 'V8', 'H1', 'D100']) };
  const rules = (file: string, source: string): [string, number][] =>
    commentProblems(file, source, ctx).map((p) => [p.rule, p.line]);

  it('finds work markers', () => {
    expect(
      rules('a.ts', '// TODO: x\n// fixme(me) y\n// the todo list\n// Hack: z\n// a hack'),
    ).toEqual([
      ['comments/todo', 1],
      ['comments/todo', 2],
      ['comments/todo', 4],
    ]);
  });

  it('finds issues, tickets and decisions, not standards, URLs or quoted code', () => {
    const source = [
      '// Fixed for #12 and T-170.',
      '// UTF-8, ISO-8601, SHA-256, CVE-2026-1, RFC-7231 and #0 are not references.',
      '// See https://github.com/o/r/issues/12 and nodejs/node#123, upstream.',
      '// Matches `[T-12]: subject` and `C8`.',
      '// As decided (C8, D45), and in (Talos C20) and (I1 to I7).',
      '// The C8 rule; the V8 engine; an H1 heading; codes (E501, C901); SHA256.',
      '/** Ruled by D100. */',
    ].join('\n');
    const found = commentProblems('a.ts', source, ctx).filter(
      (p) => p.rule === 'comments/reference',
    );
    expect(found.map((p) => [p.line, p.message])).toEqual([
      [1, expect.stringContaining('cites T-170, #12;') as unknown],
      [5, expect.stringContaining('cites C8, D45, C20, I1, I7;') as unknown],
      [6, expect.stringContaining('cites C8;') as unknown],
      [7, expect.stringContaining('cites D100;') as unknown],
    ]);
  });

  it('finds history, not the present', () => {
    const source = [
      '# Changed on 2026-10-13 to batch.',
      '# This was previously a list.',
      '# Added by Sven.',
      '# It used to be slower; formerly sync.',
      '# Updated in place when the claim moves.',
      '# A fixed 2.5 s delay; a key used to call the API.',
      '# Removed from the queue once claimed.',
    ].join('\n');
    expect(rules('a.py', source).filter(([rule]) => rule === 'comments/history')).toEqual([
      ['comments/history', 1],
      ['comments/history', 2],
      ['comments/history', 3],
      ['comments/history', 4],
    ]);
  });

  it('finds commented-out code where no linter does, one run at a time', () => {
    const rust = '// let x = compute(1);\n// x.apply();\n// plain words here.\n/// let y = 2;';
    expect(commentProblems('a.rs', rust, ctx)).toEqual([
      {
        rule: 'comments/code',
        line: 1,
        endLine: 2,
        message: 'This comment holds code; delete it, since git keeps what was there.',
      },
    ]);
    expect(rules('a.lua', '-- local x = 1\n-- describes the value')).toEqual([
      ['comments/code', 1],
    ]);
    expect(rules('a.sh', '# FOO=bar\n# set the flag')).toEqual([['comments/code', 1]]);
    expect(rules('a.ps1', '# Write-Host "x"\n# writes the host')).toEqual([['comments/code', 1]]);
    expect(rules('a.php', '<?php\n// $a = f();\n// the value')).toEqual([['comments/code', 2]]);
    expect(rules('a.ts', '// const x = 1;')).toEqual([]);
  });
});
