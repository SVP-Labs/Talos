# The Python pack

Checks for every component with `lang: py` in `talos.yml`. Each runs once per component, on
each OS it declares, with the tools installed in the component's own `.venv`.

| Check                     | Tier         | Tool                    | Rules                                                                                |
| ------------------------- | ------------ | ----------------------- | ------------------------------------------------------------------------------------ |
| `py/format`               | commit       | ruff format             | `ruff/format`                                                                        |
| `py/lint`                 | commit       | ruff, complexipy, Talos | `ruff/<code>`, `complexipy/CC001`, `talos/max-lines`, `talos/max-lines-per-function` |
| `py/types`                | commit       | basedpyright            | `basedpyright/<rule>`                                                                |
| `py/deadcode`             | commit       | vulture                 | `vulture/<code>` (V101 to V107, V201)                                                |
| `py/tests`, `py/coverage` | commit, head | pytest, coverage.py     | the shared quality rules                                                             |
| `py/mutation`             | head         | mutmut                  | `mutation/survived`                                                                  |
| `py/arch`                 | head         | import-linter           | `import-linter/<contract type>`, `import-linter/config`                              |
| `py/config-strength`      | head         | ruff, Talos             | `config/weaker`                                                                      |
| `py/toolchain`            | head         | Talos                   | `toolchain/missing`, `toolchain/mismatch`                                            |

There is no type-coverage check: basedpyright's `all` mode rejects `Any`, so Python code is
100% typed by construction.

## Installing

`install()` works in the component's root and creates `.venv` there:

- with a `uv.lock`: `uv sync --frozen --all-groups`, so the dev tools come too;
- otherwise with `requirements*.txt`: `uv venv --allow-existing .venv`, then
  `uv pip install --require-hashes` with every such file. uv refuses a requirement without a
  hash.
- With neither, the component can't be installed: an engine error.

`uv` itself comes from `tools.lock`.

## Configs

The project's file extends the generated base, because ruff and basedpyright only support that
direction. Both bases are written into the component's root.

| Tool         | Base (generated)           | The project's file (written once by `talos adopt`)                   |
| ------------ | -------------------------- | -------------------------------------------------------------------- |
| ruff         | `ruff.talos.toml`          | `ruff.toml`, starting `extend = "ruff.talos.toml"`                   |
| basedpyright | `pyrightconfig.talos.json` | `pyrightconfig.json`, with `"extends": "./pyrightconfig.talos.json"` |

The checks use the file the tool itself would read: `.ruff.toml`, `ruff.toml`, then a
`pyproject.toml` with `[tool.ruff]`; `pyrightconfig.json`, then a `pyproject.toml` with
`[tool.basedpyright]` or `[tool.pyright]`. A project with none of them gets the base. ruff runs
with `--config` on that file, so a nested config can't loosen a subdirectory, and with
`--no-fix`.

Since the tools read those files first, `talos adopt` moves a component's `[tool.ruff]` and
`[tool.basedpyright]` (or `[tool.pyright]`) out of `pyproject.toml` into the extension files it
writes, where they would otherwise go unread, and drops `[tool.mypy]`: basedpyright replaces
mypy. Settings that can't move as text are a next step. Unless the component installs from
`requirements*.txt` files without a `uv.lock`, it also sets `[tool.uv] exclude-newer = "1 day"`,
so uv resolves only releases at least a day old, and asks for a `uv lock`; a span of a day or
more stays as it is.

The ruff base selects every stable rule and the preview rule `PLR1702` (nesting), leaving out
only the rules that fight the formatter and `CPY001`. Docstrings follow the Google convention.
Limits: complexity 12, 4 arguments (positional or not), 15 branches, 10 returns, 60 statements,
nesting 3; line length is ruff format's default. Tests (`tests/` and `test/` directories,
`test_*.py`, `*_test.py`, `conftest.py`) may assert, compare with literals, take fixtures and
boolean parameters, go without docstrings and run long. A project that adds its own per-file
ignores must use `extend-per-file-ignores`: `per-file-ignores` replaces the base's.

The basedpyright base sets `typeCheckingMode` to `all` and points at `.venv`. The gate also
passes the component's interpreter and a baseline file that doesn't exist, so a
`.basedpyright/baseline.json` hides nothing.

### What counts as weaker

`py/config-strength` compares ruff's effective settings for the project's file with those of a
freshly rendered base, both from `ruff check --show-settings`, and reports:

- a rule the base enables that the project doesn't;
- a per-file ignore the base doesn't have for that pattern;
- a `max_*` limit, `line_length` or `line_width` raised;
- an addition to a list that allows something (`allowed_*`, `ignore_*`, `extend_allowed_*`,
  `exempt_*`, `runtime_evaluated_*`, `builtins`, `external`);
- a removal from a list a rule looks for (`task_tags`, `banned_*`,
  `raises_require_match_for`, `hardcoded_tmp_directory`);
- a switch that silences a rule turned on (`allow_*`, `ignore_*`, `suppress_*`,
  `mypy_init_return`), a changed `dummy_variable_rgx`, or a changed formatter style.

basedpyright prints no effective config, so the check follows the `extends` chain itself and
reports a `typeCheckingMode` other than `all`, a rule set to anything but `error` (also inside
`executionEnvironments`), a strictness switch turned off, `enableTypeIgnoreComments`, and a
non-empty `ignore` or `allowedUntypedLibraries`. basedpyright also honours file-level comments
over every config file, so a `# pyright:` comment that sets a mode other than `all` or a rule
below an error is reported on its line.

The mutation runner takes the project's mutmut settings as they are, from `pyproject.toml`'s
`[tool.mutmut]`, else `setup.cfg`'s `[mutmut]`, as mutmut reads them, so the check also reports
each setting there that never runs a mutant or counts one as killed without a test failing:
`only_mutate`, `do_not_mutate` and `do_not_mutate_patterns` that name anything,
`mutate_only_covered_lines` turned on, a `type_check_command` (a mutant it rejects counts as
killed), and a `timeout_multiplier` below mutmut's 15 or a `timeout_constant` below its 1 (a
mutant that times out counts as killed). It reports a file under `talos.yml`'s mutation paths
that the source paths leave out (`source_paths`, else `paths_to_mutate`, else mutmut's guess,
`lib` or `src`), since mutmut never copies it to mutate. Files to copy, pytest's arguments and
which tests run change no mutant's fate, or only make one harder to kill.

## Lint beyond ruff

ruff has no cognitive complexity and no file or function length, which the standard limits for
every language. complexipy measures cognitive complexity (at most 15); it runs in the check's
scratch directory on absolute paths, so a project's `complexipy.toml` can't raise the limit, and
with its snapshot ignored. Talos counts lines itself, as ESLint does without blank lines and
comments, and without docstrings: at most 60 per function (decorators to last line) and 400 per
file, test code exempt. Function spans come from Python's own parser, through a script run with
the component's interpreter in isolated mode.

ruff reports complexity, branch, return, statement and argument counts on a function's name; the
check widens them to the whole function, so changing any line of it touches the finding.

## Dead code

vulture runs over every tracked `.py` file, tests included, at confidence 0, with Talos's own
empty settings file. From `[tool.vulture]` in `pyproject.toml` it takes only `ignore_names` and
`ignore_decorators`: the names a framework uses dynamically.

## Architecture

The project's contracts live in `[tool.importlinter]` in `pyproject.toml`, in import-linter's
own syntax. Talos adds, in a configuration of its own:

- no import cycles between the modules of each package (`acyclic_siblings`);
- shipped packages import no test package (`tests` or `test` with an `__init__.py`);
- shipped packages import no dev-only dependency: one only the dependency groups of `uv.lock`
  reach, by the import names the installed distributions provide.

Shipped packages are the `__init__.py` packages under `src/`, or at the root in a flat layout.
import-linter has no machine-readable output, so its report is read as text. A broken chain is
located at the importing line; a cycle is keyed by its package and import. A project
configuration import-linter can't read is an `import-linter/config` finding.

## Tests

The runner calls pytest with the component's interpreter (`python -m pytest`), under
`coverage run` when coverage is asked for, with `--strict-markers`, strict xfail, no cache,
`--rootdir=.` and xunit1 JUnit, which carries each test's `file`. pytest writes a test's `line`
attribute 0-based. The per-commit suite leaves out `tests.full` with `--ignore`; a rerun passes
the files as arguments. Coverage uses Talos's own settings, so the project's can't exclude
code: every non-test file under the component's root, `if TYPE_CHECKING:` blocks and overload
stubs left out, written as LCOV with paths relative to the component's root. A run that
collects no data yields an empty LCOV file.

## Mutation

mutmut 3 runs in a copy of the component (without `.venv`), so its `mutants/` directory never meets
a concurrent test run, on the mutants of the requested files only. When the project configures
mutmut itself, the runner leaves its settings as they are, and `py/config-strength` judges them;
otherwise it sets `source_paths` to the requested files' top directories. mutmut forks, so it runs
on Linux and macOS; on Windows the runner raises an engine error. mutmut can report each mutant's
fate (`mutmut results`) and its diff (`mutmut show`), but never where in the file the change is, so
the runner writes a report of its own: format `mutmut` in the quality protocol, read by
`parseMutmutReport` in `mutmut-report.ts`.

### Mutation report

A JSON object, written to the check's scratch directory. `Report.base` is the component's root.

```json
{
  "format": "talos-mutmut/1",
  "mutants": [
    {
      "name": "lenient.limits.x_over__mutmut_1",
      "file": "src/lenient/limits.py",
      "status": "survived",
      "functionLine": 4,
      "diff": "--- src/lenient/limits.py\n+++ src/lenient/limits.py\n@@ -1,3 +1,3 @@\n def over(level: int, limit: int) -> bool:\n     \"\"\"Say whether a level is over a limit.\"\"\"\n-    return level > limit\n+    return level >= limit\n"
    }
  ]
}
```

- `format`: always `talos-mutmut/1`.
- `mutants`: every mutant of the requested files, in mutmut's order.
- `name`: mutmut's name for the mutant, which `mutmut show` and `mutmut apply` take.
- `file`: the mutated file, relative to `Report.base`, with forward slashes.
- `status`: mutmut's word: `killed`, `caught by type check`, `survived`, `no tests`,
  `timeout`, `suspicious`, `segfault`, `skipped`, `not checked` or
  `check was interrupted by user`.
- `functionLine`: the 1-based line in `file` where mutmut's text of the function starts (the
  comments directly above it, else its first decorator, else its `def`); 0 when not found.
- `diff`: `mutmut show`'s unified diff of the function, whose hunk line numbers count from the
  function's text; empty for a killed mutant.

`parseMutmutReport` returns `{ file, line, mutator, original, replacement, status }` for each
mutant: `line` is `functionLine` plus the first changed line's place in the function, minus
one; `original` and `replacement` are that line before and after, trimmed; `mutator` is the
mutant's name. Statuses become Talos's: `killed` (also caught by type check), `survived`,
`no-coverage` (no tests), `timeout` (also suspicious), `ignored` (skipped, not checked,
interrupted) and `error` (a segfault, or a word mutmut adds later). `survived` and
`no-coverage` are surviving mutants.

## Dev tools

`talos adopt` pins these in the project's dev dependencies, and `py/toolchain` compares them with
what `.venv` has installed: basedpyright 1.40.2, complexipy 8.1.0, coverage 7.17.0,
import-linter 2.15, mutmut 3.8.0, pytest 9.1.1, ruff 0.17.2 and vulture 2.16. coverage 7.17
needs Python 3.11 or later.
