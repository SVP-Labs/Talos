import { describe, expect, it } from 'vitest';
import {
  functionTextStart,
  mutantTarget,
  mutmutModule,
  parseMutmutResults,
  sourcePaths,
  withSourcePaths,
} from './mutation.js';

describe('mutmutModule', () => {
  it('names modules as mutmut does', () => {
    expect(mutmutModule('src/demo/risk.py')).toBe('demo.risk');
    expect(mutmutModule('src/demo/__init__.py')).toBe('demo');
    expect(mutmutModule('lib/demo/risk.py')).toBe('lib.demo.risk');
    expect(mutmutModule('tool.py')).toBe('tool');
  });
});

describe('mutantTarget', () => {
  it('reads the module, class and function a mutant changes', () => {
    expect(mutantTarget('demo.risk.x_score__mutmut_1')).toEqual({
      module: 'demo.risk',
      owner: '',
      fn: 'score',
    });
    expect(mutantTarget('m.core.xǁBoxǁ__init____mutmut_12')).toEqual({
      module: 'm.core',
      owner: 'Box',
      fn: '__init__',
    });
    expect(mutantTarget('m.core.y__mutmut_1')).toBeUndefined();
  });
});

describe('parseMutmutResults', () => {
  it('reads one mutant per line', () => {
    // Recorded from `mutmut results --all true` (mutmut 3.8.0).
    const text = [
      '    demo.calc.x_add__mutmut_1: killed',
      '    demo.calc.x_branchy__mutmut_1: no tests',
      '    m.core.xǁBoxǁgrow__mutmut_1: survived',
      'Some other line',
    ].join('\n');
    expect(parseMutmutResults(text)).toEqual([
      { name: 'demo.calc.x_add__mutmut_1', status: 'killed' },
      { name: 'demo.calc.x_branchy__mutmut_1', status: 'no tests' },
      { name: 'm.core.xǁBoxǁgrow__mutmut_1', status: 'survived' },
    ]);
  });
});

describe('functionTextStart', () => {
  it('starts at the comments right above a function, as mutmut keeps them', () => {
    const lines = [
      'class Box:',
      '    """A box."""',
      '',
      '    # about grow',
      '',
      '    # more',
      '    @staticmethod',
      '    def grow(size: int) -> int:',
    ];
    expect(functionTextStart(lines, 7)).toBe(4);
    expect(functionTextStart(['x = 1', '', 'def f():'], 3)).toBe(3);
  });
});

describe('source paths', () => {
  it('points mutmut at src, or at each file’s top directory', () => {
    expect(sourcePaths(['src/a/b.py', 'src/a/c.py'])).toEqual(['src']);
    expect(sourcePaths(['pkg/mod.py', 'tool.py'])).toEqual(['pkg', 'tool.py']);
  });

  it('adds them to the copy’s pyproject.toml unless the project configures mutmut', () => {
    expect(withSourcePaths('[project]\nname = "x"\n', ['src'])).toBe(
      '[project]\nname = "x"\n\n[tool.mutmut]\nsource_paths = [ "src" ]\n',
    );
    expect(withSourcePaths(undefined, ['pkg'])).toBe('[tool.mutmut]\nsource_paths = [ "pkg" ]\n');
    expect(withSourcePaths('[tool.mutmut]\nsource_paths = ["lib"]\n', ['src'])).toBeUndefined();
    expect(withSourcePaths('[tool', ['src'])).toBeUndefined();
  });
});
