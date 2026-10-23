# The Lua pack

Checks for every component with `lang: lua` in `talos.yml`. Each runs once per component, on
each OS it declares, with Lua 5.4 and the rocks installed in the component's own `.lua` tree.

| Check                       | Tier         | Tool                | Rules                                                                                                                                                                          |
| --------------------------- | ------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lua/format`                | commit       | StyLua              | `stylua/format`                                                                                                                                                                |
| `lua/lint`                  | commit       | luacheck, Talos     | `luacheck/W<code>`, `luacheck/E011`, `luacheck/config`, `talos/max-lines`, `talos/max-lines-per-function`, `talos/max-params`, `talos/max-depth`, `talos/cognitive-complexity` |
| `lua/types`                 | commit       | lua-language-server | `luals/<diagnostic>`                                                                                                                                                           |
| `lua/deadcode`              | commit       | luacheck            | `luacheck/W<code>` for the unused-code codes                                                                                                                                   |
| `lua/tests`, `lua/coverage` | commit, head | busted, luacov      | the shared quality rules                                                                                                                                                       |
| `lua/config-strength`       | head         | luacheck, Talos     | `config/weaker`                                                                                                                                                                |
| `lua/toolchain`             | head         | LuaRocks            | `toolchain/missing`, `toolchain/mismatch`                                                                                                                                      |
| `lua/mutation`              | head         | none                | always skipped: no mature mutation tool for Lua                                                                                                                                |

There is no type coverage and no architecture check: Lua has no tool for either.

## Installing

`install()` builds the tree in `.lua` in the component's root, which `talos adopt` adds to the
repository's `.gitignore` as `.lua/`:

1. hererocks builds Lua 5.4.9 and LuaRocks 3.13.0 into it, without readline. hererocks is a
   single Python script that `tools.lock` pins by checksum; `uv run --no-project --no-config`
   runs it, so a `pyproject.toml` or `uv.toml` in the repository plays no part. hererocks checks
   the Lua and LuaRocks downloads against checksums of its own.
2. The dev tools come from Talos's lockfile: `install()` writes a rockspec depending on them
   and LuaRocks's `luarocks.lock` beside it, listing every rock they bring, and runs
   `luarocks --tree .lua make --deps-only` there. LuaRocks installs a locked rock without
   resolving its dependencies, so nothing outside the lockfile comes in.
3. With a rockspec in the component's root, its dependencies come from the `luarocks.lock`
   beside it, the same way. A rockspec without one is an engine error: Talos installs
   dependencies only from a lockfile (`luarocks make --pin --deps-only` writes it). More than
   one rockspec in the root is an engine error too. `test_dependencies` aren't installed: the
   tests run with Talos's busted, luassert and luacov.

The project's dependencies come last, so a project that wants another version of a dev tool
gets it, and `lua/toolchain` reports the difference.

hererocks and the rocks with C code (LuaFileSystem, luasystem, lua-term, cluacov) need a C
compiler: `cc` on Linux and macOS; on Windows, MSVC (hererocks finds it with `vswhere`) or
MinGW-w64 `gcc` on `PATH` when `cl` isn't. GitHub's Windows runners have both. On Windows the
rocks' commands are `.bat` files, which run through `cmd.exe`, so the checks pass files to
them in batches that fit its command line.

`stylua` and `lua-language-server` come from `tools.lock`.

## Configs

| Tool                | Base (generated, in the component's root) | The project's file                                      |
| ------------------- | ----------------------------------------- | ------------------------------------------------------- |
| StyLua              | `stylua.toml`                             | none: formatting is not a project's choice              |
| luacheck            | `.luacheckrc`                             | `luacheck_project.lua`, which `talos adopt` writes once |
| lua-language-server | `.luarc.json`                             | none: LuaLS reads no second file                        |

**StyLua** keeps its defaults, written out so neither `.editorconfig` nor a later StyLua moves
them, except that it indents with four spaces: Lua 5.4 syntax, 120 columns, Unix line endings,
double quotes where possible, call parentheses always, no collapsed statements, requires not
sorted. The check passes `--config-path stylua.toml --no-editorconfig`, so a nested
`stylua.toml` changes only what an editor shows.

**luacheck**'s base sets `std = "lua54"`, the line length of code and comments to 120
(StyLua's width; a line ending inside a string has no limit, as ESLint ignores strings) and
cyclomatic complexity to 12, and turns off the whitespace and indentation warnings StyLua
fixes (611, 612, 614, 621). It ends by requiring `luacheck_project` relative to itself and
returning what that module returns, which luacheck lets override what the base set. The project
file is a Lua module returning a table of luacheck options, such as
`return { read_globals = { "love" } }`. A missing file is fine; one that fails to load is a
`luacheck/config` finding.

**lua-language-server** runs with every diagnostic group on for every file, down to hints,
`no-unknown` and the documentation diagnostics included. Code style is StyLua's and spelling
cspell's, so that group is off. So that one tool does each job, the diagnostics luacheck already
reports are off too: unused code, globals, shadowing, unbalanced assignments, empty blocks,
unreachable code and count-down loops, and StyLua's trailing spaces. Number-to-integer casts and
weak union and nil checks are off; table shapes are checked. The installed tree is a library,
so the rocks' types resolve without being diagnosed, and the definitions of busted and luassert
come from LuaLS's own third-party library. A project declares its host's globals in `---@meta`
files.

### What counts as weaker

`lua/config-strength` loads `.luacheckrc` with luacheck's own loader, from the component's
root, so it sees exactly what luacheck uses, and checks the top level and every `files`
pattern. It reports:

- a `std` whose base isn't `lua54`, `min` or `none`, or that adds another Lua's standard
  (`lua51` to `lua53c`, `lua54c`, `luajit`, `ngx_lua`, `max`, `_G`), or a std table; adding the
  host's globals (`+busted`, `+love`, a project std) is fine;
- the line length of code or comments, or the cyclomatic complexity, raised or turned off;
- `global`, `unused`, `redefined`, `unused_args`, `unused_secondaries` or `self` set to false,
  and `allow_defined`, `allow_defined_top` or `compat` set to true;
- an `ignore` pattern the base doesn't have, any `only`, an `exclude_files` entry the base
  doesn't have (luacheck skips such files even when they're named), and any `include_files`.

Inline `-- luacheck:` comments and `---@diagnostic` comments are suppressions, which the
suppressions check counts.

## Lint beyond luacheck

luacheck has no limit but the cyclomatic one, so Talos measures the rest with a script that runs
luacheck's own parser in the component's tree: lines of code per file (400) and per function
(60), counted as ESLint counts them, without blank lines and comments, tests exempt; parameters
(4, an implicit `self` and `...` not counted); nesting of `if`, `while`, `repeat` and `for` (3,
in the main chunk too); and cognitive complexity (15). Cognitive complexity follows SonarSource's
rules: each `if`, loop and `goto` adds one plus its nesting, each `elseif` and `else` one, and
each run of `and` or of `or` one; each function is measured on its own. A finding about a
function spans the whole function, and luacheck's complexity warning (W561) is widened to it
too, so changing any line of the function touches the finding.

## Dead code

luacheck runs once per component for both checks. `lua/deadcode` takes the unused-code codes
(131, 211 to 213, 231 to 233, 241, 311 to 314, 331, 511, 521) and `lua/lint` takes the rest, so
a finding appears once. A variable named with a leading underscore is luacheck's way to say it
is unused on purpose.

## Tests

The runner calls busted with an empty settings file of Talos's (so a project's `.busted` can't
filter tests out), on every `*_spec.lua` file: the per-commit suite without `tests.full`, a
rerun on the files it's given. busted writes JUnit into a file with `-o junit -Xoutput`, since
tests may print. busted names a test's class after its file as `dir.file_spec_lua:line`, which
can't be read back on its own, so the runner matches it against the files it ran and adds a
`file` attribute (relative to the component's root) to each test case.

With coverage, busted runs under luacov with Talos's settings, all batches into one statistics
file. luacov's statistics hold only hit counts per line: a line with none may be code that never
ran or a comment. So the runner reports LCOV (format `lcov`), written by a script that asks
luacov's reporter which lines can run (with cluacov, from the compiled code) and lists every
source file, tests and `luacheck_project.lua` aside, whether a test loaded it or not.

## Mutation

`lua/mutation` always skips, with the reason "no mature mutation tool for Lua", so the run
shows that the job is not available rather than that it passed.

## Dev tools

`lua/toolchain` compares the tree with Talos's pins: busted 2.3.0-1, cluacov 1.0.0-1,
luacheck 1.2.0-1 and luacov 0.17.0-1. A pinned rock that's missing, or another version of one
(which a project's rockspec brings), is a finding.
