import { format } from 'prettier';
import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { prettyJson } from './json-text.js';
import { holdsADay, holdUvADay, migratePyproject } from './python.js';

const RUFF_INITIAL = '# Additions.\nextend = "ruff.talos.toml"\n';
const PYRIGHT_INITIAL = '// Additions.\n{\n  "extends": "./pyrightconfig.talos.json"\n}\n';
const NONE = { ruff: false, pyright: false };

/** A pyproject.toml shaped like LoreLock's. */
const LORE_LOCK = `[project]
name = "game"

[tool.black]
line-length = 88

[tool.ruff]
line-length = 88
extend-exclude = [
    "app",
    # Dormant by decision.
    "engine/travel_manager.py",
]

[tool.ruff.lint]
# Style and complexity.
select = ["E", "C901"]
ignore = ["D203"]

[tool.ruff.lint.pylint]
max-args = 8

[tool.ruff.lint.per-file-ignores]
"tests/**/*.py" = ["D"]

[tool.mypy]
strict = true
files = ["ai"]

[[tool.mypy.overrides]]
module = ["openai.*"]
ignore_missing_imports = true

# --- Architecture boundaries --------
[tool.importlinter]
root_packages = ["ai"]
`;

describe('migratePyproject', () => {
  it("moves [tool.ruff] into ruff.toml, keeping the base's lists, and drops mypy", () => {
    const migration = migratePyproject(LORE_LOCK, NONE);
    expect(migration.manual).toBeUndefined();
    expect(migration.text).toBe(
      '[project]\nname = "game"\n\n[tool.black]\nline-length = 88\n\n' +
        '# --- Architecture boundaries --------\n[tool.importlinter]\nroot_packages = ["ai"]\n',
    );
    const ruff = migration.seeds.get('ruff.toml')?.(RUFF_INITIAL) ?? '';
    expect(ruff).toContain('extend = "ruff.talos.toml"\n\nline-length = 88\nextend-exclude = [');
    expect(ruff).toContain('    # Dormant by decision.\n');
    expect(ruff).toContain('[lint]\n# Style and complexity.\nextend-select = ["E", "C901"]');
    expect(ruff).toContain('[lint.extend-per-file-ignores]\n"tests/**/*.py" = ["D"]');
    expect(parse(ruff)).toEqual({
      extend: 'ruff.talos.toml',
      'line-length': 88,
      'extend-exclude': ['app', 'engine/travel_manager.py'],
      lint: {
        'extend-select': ['E', 'C901'],
        ignore: ['D203'],
        pylint: { 'max-args': 8 },
        'extend-per-file-ignores': { 'tests/**/*.py': ['D'] },
      },
    });
  });

  it('renames the lists set at the top of [tool.ruff] too', () => {
    const text =
      '[tool.ruff]\nselect = ["E"]\nexclude = ["x"]\nper-file-ignores = { "a.py" = ["D"] }\n' +
      'lint.select = ["F"]\n';
    const migration = migratePyproject(text, NONE);
    expect(parse(migration.seeds.get('ruff.toml')?.(RUFF_INITIAL) ?? '')).toEqual({
      extend: 'ruff.talos.toml',
      'extend-select': ['E'],
      'extend-exclude': ['x'],
      'extend-per-file-ignores': { 'a.py': ['D'] },
      lint: { 'extend-select': ['F'] },
    });
    expect(migration.text).toBe('');
  });

  it('moves basedpyright settings over pyright ones into pyrightconfig.json', () => {
    const text =
      '[tool.pyright]\ntypeCheckingMode = "basic"\ninclude = ["src"]\n\n' +
      '[tool.basedpyright]\ntypeCheckingMode = "all"\n';
    const migration = migratePyproject(text, NONE);
    expect(migration.text).toBe('');
    expect(migration.seeds.get('pyrightconfig.json')?.(PYRIGHT_INITIAL)).toBe(
      '// Additions.\n{\n  "extends": "./pyrightconfig.talos.json",\n' +
        '  "typeCheckingMode": "all",\n  "include": ["src"]\n}\n',
    );
  });

  it('leaves tables the existing files already shadow, and a file with nothing to move', () => {
    const migration = migratePyproject(LORE_LOCK, { ruff: true, pyright: true });
    expect(migration.seeds.size).toBe(0);
    expect(migration.text).toContain('[tool.ruff]');
    expect(migration.text).not.toContain('[tool.mypy]');
    expect(migratePyproject('[project]\nname = "x"\n', NONE)).toEqual({ seeds: new Map() });
  });

  it('leaves to a person what it cannot move as text', () => {
    expect(migratePyproject('[tool.ruff\n', NONE).manual).toMatch(/not valid TOML/);
    expect(migratePyproject('[tool.ruff]\nextend = "base.toml"\n', NONE).manual).toMatch(
      /extends another file/,
    );
    expect(migratePyproject('[tool.basedpyright]\nextends = "x.json"\n', NONE).manual).toMatch(
      /extend a file/,
    );
    expect(migratePyproject('[tool]\nruff.line-length = 88\n', NONE).manual).toMatch(/unusually/);
    expect(
      migratePyproject('[tool.ruff]\nselect = ["E"]\nextend-select = ["F"]\n', NONE).manual,
    ).toMatch(/unusually/);
  });
});

describe('uv', () => {
  it('holds uv to releases a day old, keeping a longer span', () => {
    expect(holdUvADay('[project]\nname = "x"\n').text).toBe(
      '[project]\nname = "x"\n\n[tool.uv]\nexclude-newer = "1 day"\n',
    );
    expect(holdUvADay('[tool.uv]\npackage = false\n').text).toBe(
      '[tool.uv]\nexclude-newer = "1 day"\npackage = false\n',
    );
    expect(holdUvADay('[tool.uv]\nexclude-newer = "2026-01-01T00:00:00Z"\n').text).toBe(
      '[tool.uv]\nexclude-newer = "1 day"\n',
    );
    expect(holdUvADay('[tool.uv]\nexclude-newer = "1 week"\n')).toEqual({});
    expect(holdUvADay('nope = [').manual).toMatch(/not valid TOML/);
    expect(holdUvADay('[tool]\nuv.package = false\n').manual).toMatch(/safely/);
  });

  it('reads friendly and ISO 8601 spans', () => {
    expect(holdsADay('1 day')).toBe(true);
    expect(holdsADay('24 hours')).toBe(true);
    expect(holdsADay('2 weeks')).toBe(true);
    expect(holdsADay('P1D')).toBe(true);
    expect(holdsADay('pt12h')).toBe(false);
    expect(holdsADay('12 hours')).toBe(false);
    expect(holdsADay(3)).toBe(false);
  });
});

describe('prettyJson', () => {
  it('lays JSON out as Prettier does', async () => {
    const long = Array.from({ length: 12 }, (_, i) => `item-number-${String(i)}`);
    const value = { a: [], b: {}, c: ['x', 1, null], d: [{ e: true }], long, n: { m: 'x' } };
    const text = prettyJson(value);
    expect(text).toBe(await format(text, { parser: 'json', printWidth: 100 }));
    expect(JSON.parse(text)).toEqual(value);
  });
});
