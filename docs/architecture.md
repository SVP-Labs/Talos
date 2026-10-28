# Architecture

How the Talos engine is put together, and the contracts every part keeps. The decisions it
implements are in [the brief](requirements/20261022-talos-core.md) (C1 to C34).

## Layout

```text
src/
  bin/talos.ts        the npm bin: the version launcher, then the CLI
  cli/                one file per command (main.ts dispatches, io.ts parses)
  core/               findings, fingerprints, checks, packs, comparison, run results, registry
  core/component.ts   what component checks share: the component's paths, its tools' runs
                      (tail of output, failures as engine errors), the check scaffolding
  core/pool.ts        running work a few at a time, results kept in order
  config/             talos.yml: schema and loader
  repo/               git helpers, diff parsing (ChangeSet), repository facts
  exec/               running programs with no shell; a Windows batch program through cmd.exe, every argument quoted
  engine/             prepare, run, plan, verdict, reports, local runs
  sarif/              SARIF 2.1.0 output
  quality/            the shared test, flaky, coverage, type-coverage and mutation logic
  langs/<lang>/       one pack per language: its checks, its runners, its generated configs
  checks/<area>/      language-independent packs: common, security, supply, runtime, docs, infra
  checks/process/     commit subjects
  configs/            generated-file drift, talos configs, and the shared rendering helpers
  docs/               glossary, decisions, comments, links and CLAUDE.md, for checks and jobs
  tools/              tools.lock: download, verify, cache
  github/             the API client, identities, rulesets, check and workflow runs, artifacts
                      (zip archives read in-process: no unzip or tar needed)
  version/            the launcher: which release a repository enforces, npm provenance
  jobs/               the caller workflow's jobs (talos job <event>)
  review/             talos/review and the reviewer's AI review
  ticket/             the claim protocol
  status/             talos status, findings, why and doctor
  adopt/ govern/      bringing a repository in; govern also holds the org rulesets and talos new
  central/            channels, runtime sweep, drift, privacy self-test
  testing/            helpers for tests; never built into dist
assets/               what Talos writes into repositories: the caller, the pre-push hook
                      (hooks/pre-push), forms, labels, rulesets, the CLAUDE.md block, patches
bootstrap/            find-pin.sh, launch.ts and php.sh, which workflows run before Talos is
                      installed
docs/contracts/       the JSON schemas of talos.verdict/1, talos.status/1, talos.claim/1,
                      talos.ticket/1 and talos.version/1
test-projects/        a project per check that it must fail on, and clean projects
.githooks/            Talos's own pre-push, which runs assets/hooks/pre-push with the build at
                      hand
```

Each pack under `src/langs/` and several under `src/checks/` have a README with their checks,
rules and configs.

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
  such as the test run the coverage check reads, or one Clippy or PHPStan run that lint, types
  and dead code each read their part of.
- **Sides.** `ctx.side` is `head` or `base` in a comparison, `alone` otherwise (`talos debt`).
  `ctx.changes` is always base → head, on both sides.

A `Pack` (`src/core/pack.ts`) groups checks, the `Generated` base configs it writes and, for a
language, `install()`, which installs a component's dependencies before any check runs.
`src/core/registry.ts` lists every pack.

## Generated configs

A `Generated` file is a tool's base config (C10). `prepare()` renders each applicable one into
the checkout before the checks run, so the gate never trusts the repository's copy. Every
rendered file starts with a header naming it generated and the extension file to edit; checks
that judge the project's own text skip files carrying that header. The extension file is the
project's; `talos adopt` and `talos configs` write it once and never again. Each language pack
adds a `<lang>/config-strength` check that reads the tool's effective config
(`eslint --print-config`, `tsc --showConfig`, `ruff check --show-settings`) and reports
`config/weaker` for any rule weaker than the base. Where no repository file can weaken what the
gate runs (the docs and infra packs pass their settings themselves), there is no such check.
`configs/drift` compares the committed copy with the rendering: a stale copy is a `standard`
finding, so a release that changes a base is debt (a sync chore), while a hand edit in a PR is
new.

## Running

`talos run` is one job: `prepare()`, then `runChecks()`, which writes a `RunResult` as JSON.

`prepare()` renders the generated files, starts the services `talos.yml` declares (Linux only;
each one's address reaches the checks as `TALOS_SERVICE_<NAME>_HOST` and `_PORT`), installs each
component through its pack's `install()`, and runs the `setup` script. A component whose install
fails is an engine error for that component's checks alone; the rest of the run goes on.
`runChecks()` runs the checks two at a time.

The gate is `.github/workflows/gate.yml` in the Talos repository, the path the channel rulesets
name; it holds no secret and never cancels a run. Each job that runs Talos checks out the Talos
repository at the pin and runs `bootstrap/launch.ts`, which installs and verifies that release
(below):

1. `pin` finds the pin with the inlined `bootstrap/find-pin.sh`, using the workflow token to
   list the repository's rulesets.
2. `plan` (`talos plan`) reads the event and decides the runs: base and head with both tiers,
   every other commit with the commit tier, on every OS the components declare (draft PRs: base
   and head only). Each run in the matrix carries what it sets up, read from `talos.yml` and
   `composer.json` at its own commit: `langs`, its components' languages on its OS, and `php`,
   the newest minor its PHP components ask for (`config.platform.php`, else `require.php`, never
   older than 8.4), empty when none runs on its OS. A commit with no `talos.yml`, such as the
   base of the PR that adopts Talos, is planned and run with the head's (`--config-from`), so a
   repository coming under the kit is green on day one; a commit whose `talos.yml` can't be read
   sets nothing up. A head whose `talos.yml` this release can't read stops `talos plan` with exit
   2, which the gate counts as an engine error on purpose: a release that refuses a `talos.yml`
   the previous one accepted must not promote, and `talos.yml` is a protected path,
   so only its owner can break a canary that way.
3. `run` is one job per run, in a matrix, each on a checkout of its commit (`talos run`), with
   PHP, pcov and Composer set up where its `php` names a minor. On a PR, the base run's
   result is cached, keyed by the release, OS, tiers, base commit, head tree and day, so a new
   push or leaving draft doesn't run it again; the merge queue never uses the cache.
4. `verdict (talos <version>)` (`talos verdict`) judges each commit against its parent (commit
   tier) and head against base (head tier), adds the commit-subject findings, and writes
   `talos.sarif`, `verdict.json` (`talos.verdict/1`), annotations and the job summary. It
   uploads both files as the artifact `talos-verdict`, even when red. `talos verdict` exits 0
   (green), 1 (findings) or 2 (engine error).
   A merge commit gets a `commit/merge` finding in place of its subject's, and no comparison of
   its own. A commit whose parent is outside the range gets none either: only a merge of `main`
   puts one there, and against the base it would carry `main`'s changes reversed. The head is
   still compared with the base, their merge base, which stays exact.
5. `engine (talos <version>)` fails when the verdict exited anything but 0 or 1, including when
   it never ran: a missing result never passes as clean. The channels job counts gate runs and
   engine errors under a release by these two jobs' names.

`talos check` does the same locally: the working tree as it stands (deleted files gone, new
files git doesn't ignore in) against the base branch, or with `--commits` every commit against
its parent. Every run judges with the change from the base to the working tree, as the gate's
judge with the PR's range. Base runs happen in git worktrees under `.talos/` and are cached in
`.talos/cache` by commit, tiers, OS, release (under `TALOS_DEV`, a digest of the build), the
checks `--only` names, the change and the day, which together decide a run's findings; every
finding goes to `.talos/check/talos.sarif`. Whatever creates `.talos/` (these
and `talos debt`) goes through `src/repo/talos-dir.ts`, which writes `.talos/.gitignore` holding
`*`, so git lists none of it in any repository Talos judges; a `.gitignore` already there is kept
as it is.

## Which release runs

C3's lookup, in `src/version/`, mirrored for workflows by `bootstrap/find-pin.sh` and
`bootstrap/launch.ts` (a test keeps them in step). The launcher imports nothing but Node's
built-ins and uses only TypeScript that erases, so Node 22.18 or later runs the file as it is,
stripping its types, with no install step before it:

- **The pin.** By default Talos lists the repository's rulesets, the org's included, skips
  disabled ones, and takes the `workflows` rule that runs the Talos repository's gate; exactly
  one must match. With `TALOS_LOOKUP=channels` it reads the repository's `talos` property and
  that channel's commit from `channels.json` on Talos's `channels` branch instead.
- **The version** is `package.json`'s at the pinned commit.
- **Verification.** The launcher installs `@svp-labs/talos@<version>` with npm (no install
  scripts) into its cache, has `npm audit signatures` check it, and refuses it unless its SLSA
  provenance names `SVP-Labs/Talos`, the pinned commit and the installed tarball. npm runs with a
  cache of the install's own, and an audit that finds invalid signatures and nothing else runs
  once more: on a cold cache npm's concurrent checks can read sigstore's trusted root while
  another writes it, and a signature that is really bad fails both times. The package
  ships `npm-shrinkwrap.json`, which `talos shrinkwrap` writes in the release job from a hoisted
  install of `pnpm-lock.yaml`'s production tree and checks against it, so npm installs exactly
  the dependencies the release was built and tested with, the lockfile's overrides and release
  age included, inside the attested tarball. A verified
  release is kept under `<cache>/engine/<version>-<sha12>/`; the cache is `TALOS_CACHE`, or the
  user cache (`~/.cache/talos`, `~/Library/Caches/talos`, `%LOCALAPPDATA%\talos\cache`).
- **Which commands.** `check`, `run`, `plan`, `verdict`, `debt`, `configs`, `adopt`, `ticket`
  and `job` run at the enforced release; the rest run as they are. `talos doctor` explains a pin
  that can't be found or a release that doesn't match.
- **The environment.** `TALOS_VERSION` and `TALOS_SHA` name the release and skip the lookup,
  never the verification: Thea's hub hands them to tasks, which hold no credentials. The
  launcher sets `TALOS_LAUNCHED` for the release it starts, so that one runs as it is; Thea's
  daemon sets it too once it has verified a release itself. `TALOS_DEV=1` runs the copy at hand
  without any of this, for working on Talos.

## Quality protocol

Tests, flaky tests, coverage and mutation work the same in every language
(`src/quality/protocol.ts`). A language pack provides a `TestRunner` that runs its test tool
for a `TestRequest` (`suite: commit | all`, `coverage`, optional `files` for the rerun) and
says where the JUnit and coverage reports are. `src/quality/` turns that into checks:

- `<lang>/tests` (commit tier): the suite outside `tests.full`. A failing test reruns once,
  only its files when every failing test names one, else the whole suite. Failed then passed,
  or passed then failed on the rerun, is `tests/flaky` (`info`); failed twice, or failed then
  missing, is `tests/failed`. A run that exits non-zero with no failing test is an engine error.
- `<lang>/coverage` (head tier): every test, with coverage; coverage is the union of the run
  and its rerun. Each uncovered executable line is a `coverage/uncovered` finding (`lost`); on
  the head side, changed executable lines under 90% covered are one `coverage/changed-lines`
  finding (`always`). A test is never reported twice: when both tiers run and no `tests.full`
  entry covers the component, the two checks share one run of the whole suite and coverage
  reports no test findings; otherwise coverage reports only the verdicts `<lang>/tests` didn't.
- `<lang>/mutation` (head tier): the `mutation` paths a change touches, or every declared path
  in a run with nothing to compare, through the pack's `MutationRunner`; each surviving mutant
  is a `mutation/survived` finding. The weekly report declares every component's root, so it
  mutates the whole codebase. Lua has no mature tool and skips it.

Type coverage stays in the TypeScript and PHP packs, against one floor of 99.5%: below it each
untyped identifier is a `standard` finding, at or above it `info`. TypeScript measures each
`tsconfig.json`'s shipped code (`typecov/untyped`); PHP's tool counts per kind, so the floor
applies to parameters, returns, properties and constants each (`typecov/<kind>`).

## The caller's jobs

`talos job <event> --phase analyze|act` is everything the caller does (C25), routed in
`src/jobs/dispatch.ts`:

- **analyze** runs only on the schedule or a dispatch, on the default branch's checkout, with
  no secret and with PHP set up as the gate does: the weekly debt run, then the mutation report
  of the whole codebase in an engine run of its own, since mutating every root renders other
  generated files than the debt run judges. It leaves `debt.json` (`talos.debt/1`) and
  `mutation.json` (`talos.mutation/1`) for act.
- **act** holds the reviewer's token and never runs repository code: issue readiness on
  `issues`; `talos/review` and the AI review on `pull_request_target`, `merge_group` and
  trusted `pull_request_review`; on the schedule, label sync, the stale-claim sweep and flaky
  tests daily, and on Mondays (UTC) the debt issues and the sync chore. A dispatch runs every
  scheduled job. It reads `debt.json` as data. The caller runs the phase in two jobs, so each
  holds only the tokens it uses: `act` on events, with a workflow token that reads the rulesets
  and no more, and `scheduled`, after analyze, with the workflow token that deletes idle ticket
  branches and reads the gate's artifacts, and no model. Flaky tests come only from the gate's
  own runs in the merge queue, whose code review has passed.

Both print one `talos.job/1` line and exit 1 when any job failed.

## Adoption

`talos adopt` (`src/adopt/`) decides everything it does to a repository in one pure function,
`adoptPlan`, over the tracked tree: each step reads what the steps before it planned, only files
whose content changes are written, and a second run plans nothing. Its `talos.adopt/1` output
lists each write and deletion with its `why`, and `next`, what whoever commits must do first;
with any next step, adoption stops before committing. It writes:

- `talos.yml`: from the manifests when there is none, completed when it holds only what
  `talos new` recorded, kept otherwise; `CLAUDE.md`'s block, the issue forms, the PR template,
  Dependabot's settings and the brief;
- every generated base, and each extension file once, filled with the project's own settings
  where they move: `[tool.ruff]` and `[tool.basedpyright]` (or `[tool.pyright]`) leave
  `pyproject.toml` for `ruff.toml` and `pyrightconfig.json`, and `[tool.mypy]` goes; an
  `osv-scanner.toml`'s exceptions move to `talos.yml`'s `supply_chain.exceptions` and its licence
  ignores to `licences`, and a `.gitleaks.toml`'s own rules to `.gitleaks.project.toml`;
- each language's setup: the dev tools at Talos's versions; LF line endings in `.gitattributes`
  for TypeScript and Lua, and `.lua/` in `.gitignore`; pnpm's supply-chain guards in
  `pnpm-workspace.yaml`, with the patch Stryker's Vitest runner needs where a component pins it;
  `[tool.uv] exclude-newer` of a day; Composer's plugins, PHP 8.4 or later and no
  `phpstan/extension-installer`; Rust's lint levels in the manifests' lint tables, and
  `rust-toolchain.toml` with the components the checks use, pinned to Talos's release unless the
  project pins an exact one already;
- the pre-push hook, `.githooks/pre-push` from `assets/hooks/pre-push`, executable in git too,
  and a root `package.json`'s `prepare` script that sets `core.hooksPath`, when it has none. A
  hook manager the project uses (pre-commit, lefthook, husky, simple-git-hooks, overcommit) is
  never replaced: a next step asks it to run the hook.

It deletes what Scaffold left, the files that would shadow a TypeScript base, and the
`osv-scanner.toml` files whose entries it moved into `talos.yml`. It never rewrites a project's
`tsconfig.json`: one that doesn't extend the generated base is a next step. It refuses a ticket
prefix another repository of the organisation uses, read from each one's `talos.yml` (or
Scaffold's `project.yml`), whenever its token can list them; `prefixChecked` says whether it
could.

## Output for agents

Everything an agent runs has a `--json` form that prints capped JSON (C33): at most 20 items per
list with a total, messages clipped to 200 characters, never a tool's raw output. Each document
names its contract in `schema`, and a change to one follows [X1](../DECISIONS.md):

```text
talos.verdict/1   talos check --json; the gate's verdict.json; talos findings --repo --pr
talos.status/1    talos status --json: an array, one object per repository
talos.claim/1     talos ticket claim | next | release
talos.ticket/1    talos ticket status
talos.version/1   talos version --enforced --json
talos.why/1       talos why <path> --json
talos.doctor/1    talos doctor --json
talos.debt/1      talos debt --json (capped) or --out (complete); analyze's debt.json
talos.mutation/1  analyze's mutation.json
talos.job/1       talos job <event>
talos.central/1   talos central <channels|sweep|drift|privacy|pick>
talos.adopt/1     talos adopt --json; also talos.govern/1, talos.new/1, talos.org/1
```

- `talos findings` prints the newest `talos-verdict` artifact of a gate run on the PR's head,
  taken only from a run of the gate's own workflow file, with `head` and `run` added, or the
  artifact of the gate's newer run on one of the PR's merge groups (`mode: merge-group`), which
  is why the queue dropped it; with none, `{ schema, status: "unknown", repo, pr, head }`, and
  that with `error` when the verdict the run left can't be read. It exits 1 when red and 0 for
  every other answer.
- `talos status` exits 1 when a repository couldn't be read; that element is
  `{ schema, repo, error }`. Thea's hub adds `cards` to each element; Talos never sets it.
- `talos.claim/1` is the claimed ticket's fields at the top level, or `error`: `claimed` (exit
  3, with `by`), `none` and `max-claims` (exit 4), `refused` (exit 1, with `reason`). A release
  prints `released: true`; `next` adds `swept`, the claims it released first.

[agents.md](agents.md) shows the ones an agent reads, with examples.
[docs/contracts/](contracts/README.md) holds the JSON schemas of `talos.verdict/1`,
`talos.status/1`, `talos.claim/1`, `talos.ticket/1` and `talos.version/1`, which tests keep equal
to the code, and the flags and exit codes of the commands that print them.

### Marker lines

A body's first line in the grammar `talos-<kind>/<n> key=value…` is a contract too. It counts
only when the App that writes it wrote it; from anyone else it is text.

```text
talos-review/1     visible   every reviewer review: verdict=, round=, findings=
talos-security/1   visible   the runtime sweep's issues: kind=runtime runtime=<r> version=<v>
                             fixed=<f|unknown> priority=p0
talos-debt/1       hidden    weekly debt issues: file=, kind=dead-code|other, count=, findings=
talos-flaky/1      hidden    flaky-test issues: test=, file=
talos-sync/1       hidden    the sync chore: files=
talos-readiness/1  hidden    the readiness comment: ready=yes|no, problems=
talos-drift/1      hidden    drift issues: key=
```

A hidden line sits inside an HTML comment, since people read these issues, and its values are
URL-encoded. Every reader goes through `markerFields` (`src/status/markers.ts`), which reads the
grammar `docs/contracts/README.md` publishes: both forms, fields in any order, unknown ones
ignored; each reader then requires the fields it needs.

## Security rules every part keeps

- A job holding a secret or an App token never runs repository code: the caller reads PRs
  through the API only, and code that must run (the weekly debt run) runs in a job without
  secrets whose results a second job reads.
- Text from GitHub (issue bodies, comments, diffs) is data. It reaches a model only in the
  reviewer's prompt, fenced, and the model's answer is parsed as a verdict, never executed.
- The central jobs in this public repository print counts only (C30): repository names pass
  through no expression, are masked before anything is printed, and errors from git and the API
  are replaced by a generic line. They find repositories through the organisation's custom
  property listing (`GET /orgs/{org}/properties/values`, the `talos` property naming a channel),
  with a token that holds organisation permissions only, and read a repository only with a
  token minted for it alone once its name is masked: no token reaches every repository of an
  App's installation. The privacy job proves each App can see the canary the same way, with a
  token minted for the canary, found by its digest.

## Test projects

Every check has at least one project it must fail on, and every language a clean project it
must pass (C5): `test-projects/<pack>/<case>/` holds the project's files, its `talos.yml`, and
`expect.json`:

```json
{ "checks": ["ts/lint"], "rules": ["eslint/complexity"], "os": ["linux", "windows"] }
```

`"clean": true` instead of `rules` means no finding at all. `talos self-test test-projects`
copies each case into a fresh git repository, runs its checks, and fails on a missing rule, an
unexpected finding in a clean project, or an engine error. It reads the runtime feeds recorded
in `test-projects/runtime/feeds/` (`TALOS_RUNTIME_FEEDS`), so its expectations don't move when a
vendor ships a release. CI runs it on every OS a case lists, with the PR's own engine, so a
broken engine never judges itself.
