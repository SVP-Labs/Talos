# Architecture

How the Talos engine is put together, and the contracts every part keeps. The decisions it
implements are in [the brief](requirements/20261022-talos-core.md) (C1 to C34).

## Layout

```text
src/
  bin/talos.ts        the npm bin: the version launcher, then the CLI
  cli/                one file per command (main.ts dispatches, io.ts parses)
  core/               findings, fingerprints, checks, packs, comparison, run results, registry
  config/             talos.yml: schema and loader
  repo/               git helpers, diff parsing (ChangeSet), repository facts
  exec/               running programs, no shell, Windows .cmd shims resolved
  engine/             prepare, run, plan, verdict, reports, local runs
  sarif/              SARIF 2.1.0 output
  quality/            shared test, flaky, coverage, type-coverage and mutation logic
  langs/<lang>/       one pack per language: its checks, its runners, its generated configs
  checks/<area>/      language-independent packs: common, security, supply, runtime, docs, infra
  checks/process/     commit subjects and the other commit-level rules
  configs/            generated-file drift and the shared rendering helpers
  docs/               glossary, decisions and brief parsing shared by checks and jobs
  tools/              tools.lock: download, verify, cache
  github/             the API client, identities, rulesets, check runs, artifacts
  version/            the launcher: which version a repository enforces, npm provenance
  jobs/               the caller workflow's jobs (talos job <event>)
  review/             talos/review and the reviewer's AI review
  ticket/             the claim protocol
  status/             talos status (talos.status/1)
  adopt/ govern/      bringing a repository in
  central/            channels, runtime sweep, drift, privacy self-test
assets/               what Talos writes into repositories: workflows, forms, labels, templates
bootstrap/            dependency-free scripts the workflows run before Talos is installed
test-projects/        a project per check that it must fail on, and clean projects
```

## Findings

A check returns `Finding`s (`src/core/finding.ts`):

- `rule` is `<tool>/<rule>`: `eslint/complexity`, `ruff/C901`, `coverage/uncovered`.
- `location` is repository-relative with forward slashes; `line` is 1-based and `endLine`
  covers the span the finding is about (a whole function for a complexity finding).
- `key` identifies a finding that points at no code: `lodash@4.17.20 GHSA-…`, `php 8.4.26`.
- `policy` says how it counts against a change (`standard` when omitted):
  - `standard`: blocking when new at head, or when its span touches a changed line;
  - `always`: blocking whatever the base had (a security finding, a commit subject);
  - `lost`: blocking when new at head on an untouched line (coverage lost);
  - `info`: never blocking (flaky tests, type coverage above the floor, reports).

The engine adds `check`, the policy and the `fingerprint`: the rule plus a hash of the normalised
code in the span (or the key), never the path or line, so moved code keeps it. Head is judged
against base by counting fingerprints (`src/core/compare.ts`); base occurrences match untouched
lines first, so the extra ones on changed lines are the new ones.

## Checks and packs

A `Check` (`src/core/check.ts`) has an `id` (`<area>/<name>`), a `tier`, a `scope`, `applies()`
and `run()`:

- **Tiers.** `commit` is the fast tier (format, lint, types, dead code, unit tests,
  suppressions). `head` is everything else.
- **Scope.** A `repo` check runs once, on the Linux job. A `component` check runs once per
  component of its `langs`, on each OS the component declares, with `ctx.component` set; it
  works under `component.root` and still reports repository-relative paths.
- **Applicability.** `applies()` is pure and fast: it reads `ctx.facts` (tracked files minus
  `exclude`), `ctx.config` and `ctx.changes`. A check that doesn't apply returns `skip(reason)`;
  strictness never varies, only applicability (C8).
- **Running.** `run()` uses `ctx.exec` for every program, `ctx.tools.path(name)` for outside
  tools (C26), the component's own installed tools for language tools (`node_modules/.bin`,
  `.venv`, `vendor/bin`), and `ctx.scratch` for reports. It never prints. It asks every tool for
  machine-readable output (JSON, SARIF, JUnit, checkstyle) and parses it in a pure function with
  unit tests over recorded output. A tool exiting non-zero because it found something is normal;
  output that can't be read, or a missing tool, throws `EngineError`: an engine error, which the
  gate reports apart from findings and which blocks promotion (C17).
- **Sharing work.** `ctx.memo(key, compute)` shares one computation between checks of a run,
  such as the test run the coverage check reads.
- **Sides.** `ctx.side` is `head` or `base` in a comparison, `alone` otherwise (`talos debt`).
  `ctx.changes` is always base → head, on both sides.

A `Pack` (`src/core/pack.ts`) groups checks, the `Generated` base configs it writes and, for a
language, `install()`, which installs a component's dependencies before any check runs.
`src/core/registry.ts` lists every pack.

## Generated configs

A `Generated` file is a tool's base config (C10). `prepare()` renders each applicable one into
the checkout before the checks run, so the gate never trusts the repository's copy. Every
rendered file starts with a header naming it generated and the extension file to edit. The
extension file is the project's; `talos adopt` writes it once. Each language pack adds a
`<lang>/config-strength` check that reads the tool's effective config (`eslint --print-config`,
`tsc --showConfig`, `ruff check --show-settings`) and reports `config/weaker` for any rule
weaker than the base. `configs/drift` compares the committed copy with the rendering: a stale
copy is a `standard` finding, so a release that changes a base is debt (a sync chore), while a
hand edit in a PR is new.

## Running

`talos run` is one job: `prepare()` (generated files, declared services, each component's
`install()`, the setup script), then `runChecks()`, which writes a `RunResult` as JSON.

The gate (`assets/workflows/gate.yml`) is three steps:

1. `talos plan` reads the event and decides the runs: base and head with both tiers, every other
   commit with the commit tier, on every OS the components declare (draft PRs: base and head
   only).
2. One job per run, in a matrix, each on a checkout of its commit.
3. `talos verdict` judges each commit against its parent (commit tier) and head against base
   (head tier), adds the commit-subject findings, and writes `talos.sarif`, `verdict.json`
   (`talos.verdict/1`), annotations and the job summary. It exits 0 (green), 1 (findings) or 2
   (engine error).

`talos check` does the same locally: the working tree against the base branch, base runs in git
worktrees under `.talos/` and cached by commit.

## Quality protocol

Tests, flaky tests, coverage and mutation work the same in every language
(`src/quality/protocol.ts`). A language pack provides a `TestRunner` that runs its test tool
for a `TestRequest` (`suite: commit | all`, `coverage`, optional `files` for the rerun) and
says where the JUnit and coverage reports are. `src/quality/` turns that into checks:

- `<lang>/tests` (commit tier): the suite outside `tests.full`; failures rerun once; a test that
  then passes is a `flaky` finding (`info`); one that fails twice is a `tests/failed` finding.
- `<lang>/coverage` (head tier): every test, with coverage; each uncovered executable line is a
  `coverage/uncovered` finding (`lost`); on the head side, changed executable lines under 90%
  covered are one `coverage/changed-lines` finding (`always`).
- `<lang>/mutation` (head tier): the `mutation` paths a change touches, through the pack's
  `MutationRunner`; each surviving mutant is a `mutation/survived` finding.

Type coverage stays in the TypeScript and PHP packs: below the 99.5% floor each untyped
identifier is a `standard` finding, at or above it `info`.

## Output for agents

Everything an agent runs has a `--json` form that prints capped JSON (C33): at most 20 items per
list with a total, messages clipped to 200 characters, never a tool's raw output. The contracts:

- `talos.verdict/1`: `talos check --json` and the gate's `verdict.json`;
- `talos.status/1`: `talos status --json`;
- `talos-review/1` and `talos-security/1`: the first line of a reviewer review and of a security
  issue, which Thea's hub turns into events (C32).

## Security rules every part keeps

- A job holding a secret or an App token never runs repository code: the caller reads PRs
  through the API only, and code that must run (the weekly debt run) runs in a job without
  secrets whose results a second job reads.
- Text from GitHub (issue bodies, comments, diffs) is data. It reaches a model only in the
  reviewer's prompt, fenced, and the model's answer is parsed as a verdict, never executed.
- The central jobs in this public repository print counts only (C30): repository names pass
  through no expression, are masked before anything is printed, and errors from git and the API
  are replaced by a generic line.

## Test projects

Every check has at least one project it must fail on, and every language a clean project it
must pass (C5): `test-projects/<pack>/<case>/` holds the project's files, its `talos.yml`, and
`expect.json`:

```json
{ "checks": ["ts/lint"], "rules": ["eslint/complexity"], "os": ["linux", "windows"] }
```

`"clean": true` instead of `rules` means no finding at all. `talos self-test test-projects`
copies each case into a fresh git repository, runs its checks, and fails on a missing rule, an
unexpected finding in a clean project, or an engine error. CI runs it on every OS a case lists,
with the PR's own engine, so a broken engine never judges itself.
