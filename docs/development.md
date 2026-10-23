# Working on Talos

Talos holds itself to the standard it enforces: [ENGINEERING.md](../ENGINEERING.md) applies here
like anywhere, and its own `talos.yml` governs it. How the engine is put together, and the
contracts every part keeps, is [architecture.md](architecture.md). This page is what is different
about working on the kit itself.

## Setting up

- Node 22.12 or later and pnpm (the version `packageManager` names), then `pnpm install`.
- `pnpm build` compiles to `dist/`; `pnpm talos <command>` runs that build.
- `TALOS_DEV=1` runs the copy you built as it is. Without it, the commands that act on a
  repository first look up the release the repository enforces and run that instead, which is
  what you want everywhere but here.

## Checking a change

```bash
pnpm check
```

runs Talos's own tools: format, lint, types, dead code, duplication, type coverage (99.5% of
shipped code), architecture, Markdown, spelling, and the unit tests with coverage. Each also runs
alone (`pnpm lint`, `pnpm typecheck`, `pnpm test`, and the rest in `package.json`);
`pnpm vitest run src/<dir>` runs one directory's tests.

Before you push, `talos check --json` says what the gate will say, at the release canary runs.
`pnpm mutation` mutates the critical paths `talos.yml` lists; the gate mutates them on every PR
that touches them.

Talos-specific rules, beyond the standard:

- Tests never reach GitHub. `src/github/api.ts` takes `options.fetch`: every API path is tested
  against a fake fetch, with response shapes recorded from GitHub's documentation. No test, and
  no local run, calls a write method on the real API.
- Every response and payload Talos relies on is validated with zod, never cast.
- A decision is a pure function with exhaustive unit tests; the API calls around it stay thin.
- A check never prints. It asks its tool for machine-readable output, parses it in a pure
  function tested over recorded output, and throws `EngineError` when it can't read it.
- Every command an agent or a workflow runs prints compact JSON with `--json` (C33); a change to
  a contract follows [X1](../DECISIONS.md).
- No job that holds a token runs repository code, and text from GitHub is data
  ([architecture.md](architecture.md), security rules).

## Test projects and the self-test

Every check has at least one project it must fail on, and every language a clean project it
must pass (C5). A case is a directory `test-projects/<pack>/<case>/` with the project's files,
its `talos.yml`, and `expect.json`:

```json
{ "checks": ["ts/lint"], "rules": ["eslint/complexity"], "os": ["linux", "windows"] }
```

`"clean": true` instead of `rules` means no finding at all.

```bash
pnpm build && pnpm self-test
node dist/bin/talos.js self-test test-projects --only ts/
```

copies each case into a fresh git repository, runs its checks, and fails on a missing rule, an
unexpected finding in a clean project, or an engine error. A new check lands with its failing
case, on every operating system it supports; a new rule of an existing check adds its rule to a
case. Never edit `expect.json` to make a run pass.

## The two gating layers

Talos's PRs are gated twice, so a broken engine never judges itself (C5):

1. **Like any governed repository:** Talos is on canary, so the gate at canary's pin and
   `talos/review` judge every PR. Every PR here needs the owner's approval, whoever wrote it and
   whatever it closes (C16).
2. **Its own engine:** a plain workflow in this repository builds the PR's engine and runs the
   self-test with it, on every operating system the test projects list. It is how a change to a
   check is proved before any release carries it.

The central jobs in this repository (the runtime sweep, the drift report, promotion and
rollback) run where anyone can read their logs, so they keep C30: matrices carry indices only,
each job looks its repository up inside a script and masks the name before printing anything,
errors from git and the API are replaced by a generic line, and only counts are printed. The
privacy self-test fails CI when the canary repository's name shows in any run's log.

## Cutting a release

A release is a `vX.Y.Z` tag on a commit of `main`, which only the owner can create (C17).

1. **Bump the version** in `package.json` through a ticket and PR like any other change. It
   lands through the merge queue with the owner's approval.
2. **The owner tags** the merged commit, signed, with the version `package.json` names there:

   ```bash
   git switch main && git pull
   git tag -s v0.4.2 -m v0.4.2 && git push origin v0.4.2
   ```

   A pin's version is read from `package.json` at its commit, so the tag and the file must agree.

3. **The release workflow** runs on the tag, builds, and publishes `@svp-labs/talos@0.4.2` through
   npm's trusted publishing, with provenance naming that commit (C26). No token is stored.
4. **The channels job** runs on `main`, on its schedule or when dispatched, as `talos-release`. It
   takes the newest `v*` tag and moves canary's pin to it only if the tagged commit is an
   ancestor of `main`. Talos and Thea now run the release.
5. **Promotion** moves stable's and evaluate's pins seven days after canary got the release,
   provided canary repositories saw at least five gate runs under it, none ended in an engine
   error, and no `regression` issue is open on this repository. A release that carries a
   security fix doesn't wait: the owner dispatches the promotion workflow, which moves the pins
   after one clean canary run.

A `regression` issue opened or labelled by the owner, Thea or a Talos App moves canary's pin
straight back to the previous release, and holds promotion until it is closed.

What a release brings to governed repositories:

- a new rule: its existing violations are on every base commit already, so they join the debt
  list instead of turning PRs red (C9);
- a changed generated base: each repository's copy now lags, which becomes a sync chore (C10);
- a changed contract or event: Thea's hub, her `persona.ts` and her `changes.ts` take it before
  canary does ([agents.md](agents.md), section 12).
