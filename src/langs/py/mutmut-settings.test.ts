import { describe, expect, it } from 'vitest';
import { mutmutSettings, outsideSourcePaths, weakerMutmut } from './mutmut-settings.js';

describe('mutmutSettings', () => {
  it("reads pyproject.toml's [tool.mutmut] first, as mutmut does", () => {
    const pyproject = '[project]\nname = "x"\n\n[tool.mutmut]\ndo_not_mutate = ["src/a.py"]\n';
    const cfg = '[mutmut]\nonly_mutate = src/b.py\n';
    expect(mutmutSettings(pyproject, cfg)).toEqual({
      file: 'pyproject.toml',
      table: '[tool.mutmut]',
      values: { do_not_mutate: ['src/a.py'] },
    });
  });

  it("falls back to setup.cfg's [mutmut], keys lower-cased and values continued", () => {
    const cfg = [
      '[metadata]',
      'name = x',
      '',
      '[mutmut]',
      '# what to leave out',
      'Do_Not_Mutate =',
      '    src/a.py',
      '    src/b.py',
      'timeout_multiplier: 2',
      '',
      '[other]',
      'only_mutate = src/c.py',
    ].join('\n');
    expect(mutmutSettings('[project]\nname = "x"\n', cfg)).toEqual({
      file: 'setup.cfg',
      table: '[mutmut]',
      values: { do_not_mutate: '\nsrc/a.py\nsrc/b.py', timeout_multiplier: '2' },
    });
    expect(mutmutSettings(undefined, cfg)?.file).toBe('setup.cfg');
  });

  it('reads nothing where mutmut would read nothing, or fail', () => {
    expect(mutmutSettings(undefined, undefined)).toBeUndefined();
    expect(mutmutSettings('[project]\nname = "x"\n', '[metadata]\nname = x\n')).toBeUndefined();
    expect(mutmutSettings('[tool.mutmut', '[mutmut]\nonly_mutate = a.py\n')).toBeUndefined();
    expect(mutmutSettings('[tool]\nmutmut = "x"\n', undefined)).toBeUndefined();
  });
});

describe('weakerMutmut', () => {
  it('reports every setting that never runs a mutant or counts one as killed', () => {
    const found = weakerMutmut({
      only_mutate: ['src/a.py'],
      do_not_mutate: ['src/b.py'],
      do_not_mutate_patterns: ['logger'],
      mutate_only_covered_lines: true,
      type_check_command: ['mypy', 'src'],
      timeout_multiplier: 2,
      timeout_constant: 0.5,
    });
    expect(found.map((w) => w.setting)).toEqual([
      'only_mutate',
      'do_not_mutate',
      'do_not_mutate_patterns',
      'mutate_only_covered_lines',
      'type_check_command',
      'timeout_multiplier',
      'timeout_constant',
    ]);
  });

  it("reads setup.cfg's text as mutmut converts it", () => {
    const found = weakerMutmut({
      do_not_mutate: '\nsrc/b.py',
      mutate_only_covered_lines: 'True',
      timeout_multiplier: '14.5',
      timeout_constant: '1',
    });
    expect(found.map((w) => w.setting)).toEqual([
      'do_not_mutate',
      'mutate_only_covered_lines',
      'timeout_multiplier',
    ]);
  });

  it('passes what changes no verdict, or only tightens one', () => {
    expect(
      weakerMutmut({
        also_copy: ['data/'],
        debug: true,
        do_not_mutate: [],
        only_mutate: '',
        mutate_only_covered_lines: 'false',
        pytest_add_cli_args_test_selection: ['tests/unit'],
        max_stack_depth: 3,
        timeout_multiplier: 30,
        timeout_constant: '2.5',
        type_check_command: [],
      }),
    ).toEqual([]);
  });
});

describe('outsideSourcePaths', () => {
  const targets = ['src/app/a.py', 'src/app/b.py', 'tools/c.py'];

  it('names the targets no source path holds, from source_paths or the older paths_to_mutate', () => {
    expect(outsideSourcePaths({ source_paths: ['src/app/'] }, targets, targets)).toEqual([
      'tools/c.py',
    ]);
    expect(outsideSourcePaths({ paths_to_mutate: './src\ntools/c.py' }, targets, targets)).toEqual(
      [],
    );
    expect(outsideSourcePaths({ source_paths: ['src/app/a.py'] }, targets, targets)).toEqual([
      'src/app/b.py',
      'tools/c.py',
    ]);
  });

  it("follows mutmut's guess when no path is set: lib, else src, else nothing to judge", () => {
    expect(outsideSourcePaths({}, targets, targets)).toEqual(['tools/c.py']);
    expect(outsideSourcePaths({}, targets, [...targets, 'lib/x.py'])).toEqual(targets);
    expect(outsideSourcePaths({}, ['tools/c.py'], ['tools/c.py'])).toEqual([]);
  });
});
