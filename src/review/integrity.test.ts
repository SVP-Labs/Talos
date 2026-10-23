import { describe, expect, it } from 'vitest';
import { fileChange, patternsFor, testIntegrity } from './integrity.js';
import type { PullFile } from './types.js';

function patch(removed: readonly string[], added: readonly string[]): string {
  const header = `@@ -1,${removed.length + 1} +1,${added.length + 1} @@`;
  return [header, ' context', ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join(
    '\n',
  );
}

function file(
  path: string,
  removed: readonly string[],
  added: readonly string[],
  status = 'modified',
): PullFile {
  return {
    path,
    status,
    previousPath: undefined,
    changes: removed.length + added.length,
    patch: patch(removed, added),
  };
}

describe('testIntegrity', () => {
  it('passes a change that keeps every test', () => {
    const result = testIntegrity([
      file('src/a.ts', ['const a = 1;'], ['const a = 2;']),
      file('src/a.test.ts', ['  expect(a).toBe(1);'], ['  expect(a).toBe(2);']),
    ]);
    expect(result).toEqual({
      flagged: false,
      reasons: [],
      counts: { casesAdded: 0, casesRemoved: 0, skipsAdded: 0, assertsAdded: 1, assertsRemoved: 1 },
    });
  });

  it('flags a deleted test file, and one renamed to a path that is no test', () => {
    const deleted = { ...file('tests/test_a.py', ['def test_a():'], [], 'removed') };
    const renamed: PullFile = {
      ...file('src/a.ts', [], []),
      status: 'renamed',
      previousPath: 'src/a.test.ts',
    };
    const result = testIntegrity([deleted, renamed]);
    expect(result.reasons).toContain('deletes test files: tests/test_a.py, src/a.test.ts');
    expect(result.flagged).toBe(true);
  });

  it('keeps a test file renamed to another test path', () => {
    const renamed: PullFile = {
      ...file('src/b.test.ts', [], []),
      status: 'renamed',
      previousPath: 'src/a.test.ts',
    };
    expect(testIntegrity([renamed]).flagged).toBe(false);
  });

  it('flags a PR with no diff for a changed file, but not a binary one', () => {
    const large: PullFile = {
      path: 'src/big.ts',
      status: 'modified',
      previousPath: undefined,
      changes: 9000,
      patch: undefined,
    };
    const binary: PullFile = {
      path: 'logo.png',
      status: 'added',
      previousPath: undefined,
      changes: 0,
      patch: undefined,
    };
    expect(testIntegrity([large]).reasons).toEqual(['no diff to read for src/big.ts']);
    expect(testIntegrity([binary]).flagged).toBe(false);
  });

  it('flags a file list GitHub cut short', () => {
    expect(testIntegrity([], false).reasons).toEqual([
      'GitHub listed only part of the changed files',
    ]);
  });

  it('lists three paths and counts the rest', () => {
    const files = ['a', 'b', 'c', 'd'].map((n) => file(`tests/${n}.py`, ['x'], [], 'removed'));
    expect(testIntegrity(files).reasons).toEqual([
      'deletes test files: tests/a.py, tests/b.py, tests/c.py and 1 more',
    ]);
  });

  it('allows moving cases and assertions between test files', () => {
    const result = testIntegrity([
      file('src/a.test.ts', ["it('works', () => {", '  expect(a()).toBe(1);'], []),
      file('src/b.test.ts', [], ["it('works', () => {", '  expect(a()).toBe(1);']),
    ]);
    expect(result.flagged).toBe(false);
  });

  it('ignores assertions and test-like lines in shipped code', () => {
    const result = testIntegrity([file('src/a.py', ['    assert x > 0', 'def test_mode():'], [])]);
    expect(result.flagged).toBe(false);
  });

  it('ignores languages it reads no tests in', () => {
    expect(testIntegrity([file('tests/a.java', ['assertEquals(1, a);'], [])]).flagged).toBe(false);
  });
});

type Case = {
  readonly lang: string;
  readonly path: string;
  readonly testCase: string;
  readonly skip: string;
  readonly assertion: string;
};

const LANGUAGES: readonly Case[] = [
  {
    lang: 'TypeScript',
    path: 'src/a.test.ts',
    testCase: "it('adds', () => {",
    skip: "it.skip('adds', () => {",
    assertion: '  expect(add(1, 2)).toBe(3);',
  },
  {
    lang: 'TypeScript (test)',
    path: 'src/__tests__/a.ts',
    testCase: "test('adds', () => {",
    skip: "describe.only('add', () => {",
    assertion: '  assert.equal(add(1, 2), 3);',
  },
  {
    lang: 'JavaScript',
    path: 'test/a.spec.js',
    testCase: "it.each([1])('adds %d', (n) => {",
    skip: "xit('adds', () => {",
    assertion: '  a.should.equal(1);',
  },
  {
    lang: 'Python',
    path: 'tests/test_add.py',
    testCase: 'def test_add():',
    skip: '@pytest.mark.skip(reason="later")',
    assertion: '    assert add(1, 2) == 3',
  },
  {
    lang: 'Python (unittest)',
    path: 'tests/test_add.py',
    testCase: '    async def test_add(self):',
    skip: '        self.skipTest("later")',
    assertion: '        self.assertEqual(add(1, 2), 3)',
  },
  {
    lang: 'PHP',
    path: 'tests/Unit/AddTest.php',
    testCase: '    public function testAdds(): void',
    skip: '        $this->markTestSkipped();',
    assertion: '        $this->assertSame(3, add(1, 2));',
  },
  {
    lang: 'PHP (Pest)',
    path: 'tests/Feature/AddTest.php',
    testCase: "test('adds', function () {",
    skip: '})->skip();',
    assertion: '    expect(add(1, 2))->toBe(3);',
  },
  {
    lang: 'Lua',
    path: 'spec/add_spec.lua',
    testCase: '  it("adds", function()',
    skip: '  pending("later")',
    assertion: '    assert.are.equal(3, add(1, 2))',
  },
  {
    lang: 'Rust',
    path: 'tests/add.rs',
    testCase: '#[test]',
    skip: '#[ignore]',
    assertion: '    assert_eq!(add(1, 2), 3);',
  },
  {
    lang: 'Go',
    path: 'add_test.go',
    testCase: 'func TestAdd(t *testing.T) {',
    skip: '\tt.Skip("later")',
    assertion: '\t\tt.Errorf("got %d", got)',
  },
];

describe.each(LANGUAGES)('$lang', ({ path, testCase, skip, assertion }) => {
  it('flags a removed test case', () => {
    const result = testIntegrity([file(path, [testCase], [])]);
    expect(result.counts.casesRemoved).toBe(1);
    expect(result.reasons).toContain('removes 1 test cases and adds 0');
  });

  it('accepts a test case replaced by another', () => {
    expect(testIntegrity([file(path, [testCase], [testCase])]).counts).toMatchObject({
      casesAdded: 1,
      casesRemoved: 1,
    });
  });

  it('flags an added skip marker', () => {
    const result = testIntegrity([file(path, [], [skip])]);
    expect(result.counts.skipsAdded).toBe(1);
    expect(result.reasons).toContain('adds 1 skip markers');
  });

  it('flags a removed assertion, and accepts one replaced', () => {
    expect(testIntegrity([file(path, [assertion], [])]).reasons).toContain(
      'removes 1 assertions and adds 0',
    );
    expect(testIntegrity([file(path, [assertion], [assertion])]).flagged).toBe(false);
  });

  it('accepts an added test with its assertion', () => {
    expect(testIntegrity([file(path, [], [testCase, assertion])]).flagged).toBe(false);
  });
});

describe('Rust tests beside the code', () => {
  it('counts test cases and ignore markers in source files', () => {
    expect(testIntegrity([file('src/lib.rs', ['#[test]'], [])]).counts.casesRemoved).toBe(1);
    expect(testIntegrity([file('src/lib.rs', [], ['#[ignore]'])]).counts.skipsAdded).toBe(1);
  });

  it('leaves runtime assertions in source files alone', () => {
    expect(testIntegrity([file('src/lib.rs', ['    assert!(x > 0);'], [])]).flagged).toBe(false);
  });
});

describe('the test-looking lines that are not tests', () => {
  it.each([
    ['src/a.test.ts', "const it = 'x';"],
    ['tests/test_a.py', 'def helper_test():'],
    ['add_test.go', 'func helper(t *testing.T) {'],
  ])('%s: %s', (path, line) => {
    expect(testIntegrity([file(path, [line], [])]).counts.casesRemoved).toBe(0);
  });
});

describe('patternsFor', () => {
  it('chooses by extension, any case', () => {
    expect(patternsFor('a.TS')).toBe(patternsFor('b.ts'));
    expect(patternsFor('Makefile')).toBeUndefined();
    expect(patternsFor('a.java')).toBeUndefined();
  });
});

describe('fileChange', () => {
  it("reads a file's patch as parseDiff sees it", () => {
    const change = fileChange(file('src/a.ts', ['old'], ['new', 'newer'], 'added'));
    expect(change).toMatchObject({
      path: 'src/a.ts',
      status: 'added',
      addedText: ['new', 'newer'],
      removedText: ['old'],
    });
    expect(change?.added).toEqual([{ start: 1, end: 3 }]);
  });
});
