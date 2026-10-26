import { describe, expect, it } from 'vitest';
import { parseRuffSettings, weakerRuff } from './ruff-settings.js';

// Excerpts of `ruff check --show-settings` from ruff 0.17.2, the lines kept as printed.
const BASE = [
  'Resolved settings for: "/repo/a.py"',
  'Settings path: "/repo/ruff.talos.toml"',
  '',
  '# General Settings',
  'cache_dir = "/repo/.ruff_cache"',
  'fix = false',
  '',
  '# Linter Settings',
  'linter.exclude = []',
  'linter.rules.enabled = [',
  '\tcomplex-structure (C901),',
  '\tunused-import (F401),',
  '\ttoo-many-nested-blocks (PLR1702),',
  ']',
  'linter.rules.should_fix = [',
  '\tunused-import (F401),',
  ']',
  'linter.per_file_ignores = {',
  '\tabsolute_matcher = "/repo/**/tests/**"',
  'basename_matcher = "**/tests/**"',
  'negated = false',
  'data = [',
  '\tassert (S101),',
  '\tmagic-value-comparison (PLR2004),',
  ']',
  '',
  '}',
  'linter.dummy_variable_rgx = ^(_+|(_+[\\p{XID_Continue}]*[\\p{XID_Continue}--_]+?))$',
  'linter.external = []',
  'linter.line_length = 88',
  'linter.task_tags = [',
  '\tTODO,',
  '\tFIXME,',
  '\tXXX,',
  ']',
  'linter.flake8_annotations.allow_star_arg_any = false',
  'linter.flake8_bandit.check_typed_exception = false',
  'linter.flake8_tidy_imports.banned_api = {}',
  'linter.mccabe.max_complexity = 12',
  'linter.pycodestyle.max_doc_length = none',
  'linter.pyflakes.allowed_unused_imports = []',
  'linter.pylint.max_args = 4',
  '',
  '# Formatter Settings',
  'formatter.line_width = 88',
  'formatter.quote_style = double',
].join('\n');

const LOOSE = BASE.replace('\tcomplex-structure (C901),\n', '')
  .replace(
    '\tmagic-value-comparison (PLR2004),\n',
    '\tmagic-value-comparison (PLR2004),\n\tprint (T201),\n',
  )
  .replace('linter.mccabe.max_complexity = 12', 'linter.mccabe.max_complexity = 20')
  .replace('linter.external = []', 'linter.external = [\n\tV101,\n]')
  .replace('\tXXX,\n', '')
  .replace('allow_star_arg_any = false', 'allow_star_arg_any = true')
  .replace('formatter.quote_style = double', 'formatter.quote_style = single')
  .replace(
    '}\nlinter.dummy',
    '\tabsolute_matcher = "/repo/scripts/*.py"\nbasename_matcher = "scripts/*.py"\n' +
      'negated = false\ndata = [\n\tprint (T201),\n]\n\n}\nlinter.dummy',
  );

const TIGHT = BASE.replace('linter.mccabe.max_complexity = 12', 'linter.mccabe.max_complexity = 8')
  .replace('max_doc_length = none', 'max_doc_length = 88')
  .replace('check_typed_exception = false', 'check_typed_exception = true')
  .replace('banned_api = {}', 'banned_api = {\n\tos.system = use subprocess,\n}')
  .replace('linter.task_tags = [\n', 'linter.task_tags = [\n\tHACK,\n')
  .replace('\tunused-import (F401),\n\ttoo', '\tunused-import (F401),\n\tprint (T201),\n\ttoo');

describe('parseRuffSettings', () => {
  it('reads scalars, lists, enabled rules and per-file ignores', () => {
    const settings = parseRuffSettings(BASE);
    expect([...settings.enabled]).toEqual([
      ['C901', 'complex-structure'],
      ['F401', 'unused-import'],
      ['PLR1702', 'too-many-nested-blocks'],
    ]);
    expect([...settings.perFileIgnores]).toEqual([['**/tests/**', ['S101', 'PLR2004']]]);
    expect(settings.values.get('linter.mccabe.max_complexity')).toBe('12');
    expect(settings.values.get('linter.task_tags')).toEqual(['\tTODO,', '\tFIXME,', '\tXXX,']);
    expect(settings.values.get('linter.external')).toBe('[]');
  });
});

describe('weakerRuff', () => {
  it('finds nothing when the project is the base', () => {
    expect(weakerRuff(parseRuffSettings(BASE), parseRuffSettings(BASE))).toEqual([]);
  });

  it('lets a project tighten anything', () => {
    expect(weakerRuff(parseRuffSettings(BASE), parseRuffSettings(TIGHT))).toEqual([]);
  });

  it('names every setting a project loosens', () => {
    const found = weakerRuff(parseRuffSettings(BASE), parseRuffSettings(LOOSE));
    expect(found.map((w) => w.setting)).toEqual([
      'rule C901',
      'per-file-ignores **/tests/**',
      'per-file-ignores scripts/*.py',
      'linter.external',
      'linter.task_tags',
      'linter.flake8_annotations.allow_star_arg_any',
      'linter.mccabe.max_complexity',
      'formatter.quote_style',
    ]);
    expect(found[0]?.message).toBe('turns off complex-structure (C901)');
    expect(found[1]?.message).toBe('ignores T201 in **/tests/**');
    expect(found[4]?.message).toBe('removes XXX from linter.task_tags');
    expect(found[6]?.message).toBe('raises linter.mccabe.max_complexity from 12 to 20');
  });
});
