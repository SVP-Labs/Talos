# The PHP pack

Checks for every component with `lang: php` in `talos.yml`. Each runs once per component, on
each OS it declares, with the tools the component installs in `vendor/`, run by the PHP on the
machine's `PATH` (`php vendor/bin/<tool>`, so Composer's proxies work on Windows too).

Talos checks the component's tracked `.php` files, minus `talos.yml`'s `exclude`, Blade
templates (`*.blade.php`, which are not PHP) and anything under `vendor/`. Test code is a file
under a `tests` or `test` directory, or one named `*Test.php`; everything else is shipped code.

| Check                       | Tier         | Tool                                         | Rules                                                                                                                                        |
| --------------------------- | ------------ | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `php/format`                | commit       | pint                                         | `pint/format`                                                                                                                                |
| `php/lint`                  | commit       | PHPMD, PHPStan (cognitive complexity), Talos | `phpmd/<rule>`, `phpmd/parse-error`, `phpstan/complexity.functionLike`, `phpstan/complexity.classLike`, `talos/max-depth`, `talos/max-lines` |
| `php/types`                 | commit       | PHPStan                                      | `phpstan/<identifier>`, `phpstan/ignore.unmatched`                                                                                           |
| `php/deadcode`              | commit       | PHPStan, shipmonk's dead-code detector       | `phpstan/shipmonk.dead*`, `phpstan/*.unused`, `phpstan/property.onlyRead`, `phpstan/property.onlyWritten`, `phpstan/deadCode.*`              |
| `php/tests`, `php/coverage` | commit, head | Pest and pcov (or Xdebug)                    | the shared quality rules                                                                                                                     |
| `php/typecov`               | head         | PHPStan with tomasvotruba/type-coverage      | `typecov/param`, `typecov/return`, `typecov/property`, `typecov/constant`                                                                    |
| `php/arch`                  | head         | deptrac                                      | `deptrac/test-code`, `deptrac/dev-dependency`, `deptrac/layers`, `deptrac/config`                                                            |
| `php/mutation`              | head         | Infection                                    | `mutation/survived`                                                                                                                          |
| `php/config-strength`       | head         | PHPStan, Talos                               | `config/weaker`, `config/shadowed`                                                                                                           |
| `php/toolchain`             | head         | Talos                                        | `toolchain/missing`, `toolchain/mismatch`, `toolchain/conflict`                                                                              |

PHPStan runs once per component and run: `php/types`, `php/lint` and `php/deadcode` each take
their identifiers from the same report.

## Installing

`install()` runs `composer install --no-interaction --no-progress --prefer-dist --no-ansi` in the
component's root, dev dependencies included, so only ever from `composer.lock`; a component
without one is an engine error. `composer` comes from the machine's `PATH`, as `npm` and `pnpm`
do for TypeScript. Composer runs plugins and scripts as root only with `COMPOSER_ALLOW_SUPERUSER`,
which `install()` sets: Pest and Infection need their plugins, and the gate runs the project's
code (its tests) anyway, so a root container gets what an ordinary runner gets. The project's
`composer.json` must allow those plugins (`config.allow-plugins`: `pestphp/pest-plugin`,
`infection/extension-installer`), or Composer refuses them.

Before Composer runs anything, `install()` asks the PHP on `PATH` for its release and refuses,
as an engine error, any PHP that isn't the newest release of its cycle, or whose cycle is past its
end of life, judged by the runtime pack's feeds (endoflife.date and php.net's security tags, or
the recordings `TALOS_RUNTIME_FEEDS` names). The project's tests and every tool run on that PHP,
so no check runs on a release with a known hole. Which PHP a project ships is the runtime pack's
`runtime/runtimes` check.

The gate, the caller's weekly analysis and the self-test install PHP with setup-php, pinned at
2.40.0, with `update: true`, so the runner takes the newest patch of the cycle it asks for. The
gate asks, on each run, for the cycle the PHP components of that run's own commit need
(`config.platform.php`, else `require.php`, never older than 8.4), as `talos plan` reads it; the
self-test asks for 8.4. On the day php.net ships a release, setup-php's package sources can trail
it for some hours, and the gate's PHP runs end in this engine error until they catch up.

The pinned tools need PHP 8.4 or later (Pest 5, and the Pest plugin for PHPStan).

## Configs

| Tool    | Base (generated) | The project's file (written once by `talos adopt`) | Why this shape                                                                                                                   |
| ------- | ---------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| PHPStan | `phpstan.neon`   | `phpstan.project.neon`, which the base includes    | the including file's settings win in NEON, so the extension can't lower a switch or limit the base sets; it adds paths and rules |
| PHPMD   | `phpmd.xml`      | `phpmd.project.xml`, a ruleset the base references | a referenced ruleset only adds rules; PHPMD 3 reads `phpmd.xml` from the working directory                                       |
| pint    | `pint.json`      | none                                               | formatting is not a project's choice; the base carries a `"//"` note and `talos.yml`'s `exclude` as `notPath`                    |
| deptrac | `deptrac.yaml`   | `deptrac.project.yaml`, run on its own             | a class in two layers is checked against both rulesets, so the universal layers and the project's can't share one config         |

All four are written into the component's root. `phpstan.neon` is the first file PHPStan looks
for, so editors read the base, with the extension, without being told.

### PHPStan

The base includes, in order, phpstan-strict-rules, tomasvotruba/cognitive-complexity,
shipmonk/dead-code-detector, Pest's PHPStan plugin and, in a Laravel application (one that
tracks `artisan` at its root), Larastan, then `phpstan.project.neon`. It sets level `max`, every
stricter-analysis switch PHPStan has (uninitialized properties, implicit mixed, benevolent
unions, possibly non-existent offsets, too-wide return types, missing `#[\Override]`, ignores
without a comment, and the rest), strict-rules' `allRules`, cognitive complexity 15 per function
(the extension's own 40 per class stays), and each transitively dead method reported on its own.
Checked exceptions stay off: TypeScript, which sets the bar, has none.

A Laravel package (no `artisan`) includes Larastan in `phpstan.project.neon` itself. The
extensions are included explicitly, so phpstan/extension-installer must not be installed:
PHPStan refuses a file included twice (`toolchain/conflict`).

The gate writes its own config into the check's scratch directory: the base's includes and
parameters with absolute paths, then:

- `paths` replaced by the directories that hold the checked files (PHPStan reports dead code
  only when it walked a directory), and `excludePaths` replaced by the PHP found there that
  Talos doesn't check;
- `ignoreErrors` emptied: a list of ignored errors is a stored baseline, which Talos doesn't
  keep. Inline `@phpstan-ignore` comments stay, as suppressions, which the suppressions check
  counts; the base makes each one carry a comment.

An internal error makes PHPStan skip its whole-project rules (dead code, type coverage), so a
report with one is an engine error. A syntax error is a `phpstan/phpstan.parse` finding.

### What counts as weaker

`php/config-strength` compares `phpstan dump-parameters` for the base alone and for the base with
`phpstan.project.neon`, and reports:

- any switch the base sets, or any of strict-rules' and shipmonk's `detect` settings, changed;
- `cognitive_complexity.function` or `.class` raised;
- an entry added to `ignoreErrors`, `excludePaths`, `universalObjectCratesClasses` or
  `dynamicConstantNames`.

It also reports each `<exclude-pattern>` in `phpmd.project.xml` (PHPMD applies it to every
rule), each `<exclude>` in the `<source>` of the `phpunit.xml` PHPUnit reads (PHPUnit applies it
to Talos's coverage too), and, as `config/shadowed`, a `phpmd.yml`, `phpmd.yaml` or `phpmd.json`
(or its dotted or `.dist` form), which PHPMD reads before `phpmd.xml`.

`dump-parameters` prints the environment among the parameters, so its output is only parsed,
never put in an error.

## Format

pint fixes copies of the checked files in the check's scratch directory with the base as Talos
renders it, `-v --format=json`; each file it changed is one `pint/format` finding, from the first
to the last line it changed, naming the fixers. The preset is Laravel's (PER-CS 2.0 with
Laravel's conventions), with `declare_strict_types`. A file pint can't parse is left to
`php/types`.

## Lint

PHPMD runs the cleancode, codesize, design, naming and unusedcode rule sets in full, but for
StaticAccess (it forbids every static call, enum cases and named constructors too), at the
standard limits: cyclomatic complexity 12, 4 parameters, 60 lines per method and 400 per class,
blank lines and comments not counted. PHPMD 3's limits are maxima. The gate passes its own copy
of the ruleset, which references `phpmd.project.xml` by absolute path, and every file through
`--input-file`. Violations the base and the extension both report are one finding. A file
PHPMD can't parse is a `phpmd/parse-error` finding, so code in syntax its parser doesn't know yet
is never left out of linting in silence.

PHPStan's cognitive complexity findings are widened to the whole function or class, so changing
any line of it touches the finding.

Talos itself measures, with PHP-Parser from the component's `vendor/` (loading only its classes,
never the project's):

- nesting: a block (`if`, `for`, `foreach`, `while`, `do`, `switch`, `try`) nested 4 deep in a
  function, `else if` and `elseif` counting as their `if`, each function and closure starting
  from 0; one `talos/max-depth` finding per outermost block too deep;
- file size: more than 400 lines of code (not blank, not only a comment) is a `talos/max-lines`
  finding from the 401st to the last line.

Test code is exempt from the size limits (`ExcessiveMethodLength`, `ExcessiveClassLength`, the
`Ncss*Count` rules and `talos/max-lines`), as in every language.

## Dead code

PHPStan's own unused-private rules and shipmonk/dead-code-detector, which finds unused methods,
constants, enum cases and properties of any visibility, framework entry points (Laravel, Symfony,
PHPUnit and the rest) recognised. Tests are analysed too, so code a test uses is used.

## Type coverage

PHPStan at level 0 over shipped code alone, with tomasvotruba/type-coverage asking for 100% of
each kind: parameters, return types, properties and typed class constants. The extension
reports each untyped declaration with its kind's totals. A kind under 99.5% makes each of its
untyped declarations a `standard` finding, so no new one lands; at or above the floor they are
`info`. The floor is per kind, which is stricter than one count over all of them.

## Architecture

deptrac runs twice. The universal rules, in a config Talos writes: shipped code may not depend on
test code (`deptrac/test-code`), nor on a class of a package only `require-dev` brings
(`deptrac/dev-dependency`): the packages in `composer.lock`'s `packages-dev`, by their PSR-4 and
PSR-0 prefixes and, for a classmap package, the namespace its classes share in Composer's
classmap. The committed `deptrac.yaml` holds the same layers without the dev-only one, which
needs the lockfile. deptrac has no rule for import cycles.

Then the project's own layers, when it tracks `deptrac.project.yaml`, run as written, each
violation a `deptrac/layers` finding. Both runs pass `--report-skipped`: a `skip_violations` list
is a stored baseline, so a skipped violation counts. Errors deptrac finds in the project's config
(a skipped violation that no longer occurs, a layer cycle) are one `deptrac/config` finding.

## Tests

The runner calls Pest with `--log-junit`, `--do-not-cache-result` and no colours; with coverage
asked for, `--coverage-clover` with each top-level directory of shipped code as a
`--coverage-filter`, pcov enabled for the component's directory (`XDEBUG_MODE=coverage` serves
Xdebug instead); otherwise `--no-coverage` with pcov off. PHPUnit applies `phpunit.xml`'s
`<source>` exclusions on top, which `php/config-strength` reports. The per-commit suite is every
`*Test.php` outside `tests.full` when `tests.full` names some; the rerun passes its files. A run
with no JUnit report, or no coverage report when one was asked for (no pcov or Xdebug), is an
engine error.

Pest writes each test's `file` as `path::test name`; the runner drops the test name, so the
report reads as PHPUnit's.

## Mutation

Infection, with a config of Talos's own (the requested files' top-level directories as sources,
its JSON log in the scratch directory, `--with-uncovered` so uncovered mutants count, pcov on for
the initial run). Infection has no Pest adapter, so it runs Pest through its PHPUnit one, by way
of a script the runner writes (`pestBridge` in `infection.ts`) that:

- answers `--version` with the installed PHPUnit's, which Infection reads to write its config;
- runs Pest and prints PHPUnit's `OK (` after a passing run, which Infection looks for: without
  it, every mutant would count as killed;
- makes the JUnit report's paths absolute, and adds each test file's class under the `P\` name
  Pest gives it in coverage, which Infection looks up.

The report is Infection's JSON log, format `infection` in the quality protocol, its paths
absolute.

## Dev tools

`talos adopt` pins these in `require-dev`, and `php/toolchain` compares them with
`vendor/composer/installed.json`: deptrac/deptrac 4.7.2, infection/infection 0.35.8,
laravel/pint 1.32.1, pestphp/pest 5.3.3, pestphp/pest-plugin-phpstan 5.2.2, phpmd/phpmd 3.0.0,
phpstan/phpstan 2.3.1, phpstan/phpstan-strict-rules 2.1.0, shipmonk/dead-code-detector 1.4.2,
tomasvotruba/cognitive-complexity 1.3.0 and tomasvotruba/type-coverage 2.5.1, and
larastan/larastan 3.13.1 in a project that requires `laravel/framework` (Larastan requires the
framework). PHP-Parser, which the nesting and size checks use, comes with them.

It also allows Pest's and Infection's Composer plugins under `config.allow-plugins`, removes
`phpstan/extension-installer` (from the requirements and the allowed plugins), and sets
`require.php` to `^8.4` where there is none or it lets in an older PHP; a constraint it can't
read stays as it is.
