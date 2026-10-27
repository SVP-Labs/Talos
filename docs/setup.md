# Setting Talos up

The owner's steps to stand Talos up and bring every repository under it, in the order the
brief sets ([C18](requirements/20261022-talos-core.md)). Each step says what to do, what you
should see, and what to change when you don't. Terms are [the glossary's](glossary.md).

Never paste a key, token or secret into a chat or an issue; keep them in your password manager.

## 0. Before you start

- You are an owner of SVP-Labs, which is on GitHub Enterprise Cloud (C4), and `gh` is signed in
  as you with the scopes Talos's owner commands need:

  ```bash
  gh auth login
  gh auth refresh -s admin:org,repo,workflow,read:user
  ```

  `read:user` lets `talos govern` read which repositories an App's installation holds (step 1).

- Node 22.18 or later, npm 11.5.1 or later and pnpm, for running Talos from a clone and for the
  first npm publish.
- Your commit signing key asks for a touch or a prompt on every use (a security key, or an SSH
  agent that confirms each signature), and no signing key of yours sits on the VPS. Talos counts
  a PR you opened as approved by you only when every commit carries your verified signature, so
  Thea's tasks, which run under your user on the PC, must never be able to sign as you (C16).
- Until Talos publishes its first release, run it from a clone of `SVP-Labs/Talos` as it is:

  ```bash
  pnpm install && pnpm build
  alias talos='TALOS_DEV=1 node "$PWD/dist/bin/talos.js"'
  ```

  `TALOS_DEV=1` runs that copy instead of looking up a pinned release. Every command below has
  `--dry-run`, which prints the plan and changes nothing; run it first.

## 1. The three Apps

Talos works through three GitHub Apps: Thea's, which implements, and two of its own (C15).
Neither Thea's App nor the reviewer gets `workflows` or `administration`, and no App sits on a
ruleset's bypass list except `talos-release` on the `channels` branch's.

Create Talos's two under the org's **Settings → Developer settings → GitHub Apps → New GitHub
App**, each with the settings below. An App's name is unique across all of GitHub, and Talos
trusts an App by its slug: if `talos-reviewer` or `talos-release` is taken, choose another name
and set the matching variable in step 2 (`TALOS_REVIEWER_APP`, `TALOS_RELEASE_APP`) to its slug,
and Thea's `TALOS_REVIEWER_LOGIN` to the reviewer's bot login. For the same reason, never install
an App you don't own on a governed repository.

- **Homepage URL:** `https://github.com/SVP-Labs/Talos`.
- **Webhook:** untick **Active**. Both run in Actions and receive nothing.
- **Where can this GitHub App be installed?** **Only on this account.**

### `talos-reviewer`

- **Name:** `talos-reviewer`, so its bot is `talos-reviewer[bot]`.
- **Organization permissions:** Custom properties, **Read-only**. The runtime sweep and the
  privacy self-tests find the governed repositories by their `talos` property, with a token
  that reaches no repository (C30).
- **Repository permissions:**

  | Permission    | Access         |
  | ------------- | -------------- |
  | Checks        | Read and write |
  | Contents      | Read-only      |
  | Issues        | Read and write |
  | Metadata      | Read-only      |
  | Pull requests | Read and write |

- **Its key:** generate a private key; it becomes the org secret `TALOS_REVIEWER_KEY` (step 2)
  and nothing else. It never reaches Thea's hub.
- **Install** it on SVP-Labs with **Only select repositories**, choosing `SVP-Labs/Talos`.
  Each governed repository is added to it by hand, the step `talos govern` prints (below).

### `talos-release`

- **Name:** `talos-release`, so its bot is `talos-release[bot]`.
- **Organization permissions:**

  | Permission        | Access         | Why                                                   |
  | ----------------- | -------------- | ----------------------------------------------------- |
  | Administration    | Read and write | it moves the pins in the org rulesets (C17)           |
  | Custom properties | Read-only      | the central jobs find the governed repositories (C30) |

- **Repository permissions:**

  | Permission     | Access    | Why                                                     |
  | -------------- | --------- | ------------------------------------------------------- |
  | Administration | Read-only | the drift report reads each repository's settings (C29) |
  | Actions        | Read-only | promotion counts gate runs on canary repositories (C17) |
  | Metadata       | Read-only | required with any repository permission                 |

  No job holds these for every repository of the installation: each token is minted for the
  repositories it reads, which the jobs find through the custom properties and mask first.

  Contents stays off unless smoke test 1 or 5 (step 6) turns on the `channels.json` fallback;
  then it is **Read and write**, its jobs mint contents tokens for the Talos repository only, and
  `talos org init` makes it the one writer of the `channels` branch (step 5).

- **Its key:** generate a private key; it becomes the `release` environment's secret
  `TALOS_RELEASE_KEY` (step 3) and nothing else.
- **Install** it on SVP-Labs with **Only select repositories**, choosing `SVP-Labs/Talos`. Each
  governed repository is added to it by hand, the step `talos govern` prints (below).

### Thea's App

Her SVP-Labs App keeps the permissions of her G1
([her setup](https://github.com/SVP-Labs/Thea/blob/main/docs/setup/github.md)), which include
what C15's table gives her: contents, pull requests and issues read and write; checks, commit
statuses and actions read. Two things go beyond that table, and both stay:

- **Alert reads:** Dependabot alerts, code scanning alerts and secret scanning alerts, read.
  Her events for a new advisory or a leaked secret come from them (C20, C28).
- **Subscribe to events:** tick **Check run**, so the gate's and `talos/review`'s results reach
  her as events.
- **Install** it on `SVP-Labs/Talos` too: her hub reads each release's `package.json` there.

Its key stays in her hub's settings and nowhere else.

### Adding a repository to an installation

An installation set to **Only select repositories** gets each governed repository by hand.
GitHub refuses `gh`'s token the call that adds one (`403`, "You do not have permission to modify
this app", even for an org owner), and lists an installation's repositories only to a token with
the `read:user` scope. So `talos govern` never fails on it: where it can't read the installation,
or GitHub refuses the addition, it prints a manual step (`!`) with the way there, which you take
for each App it names:

**Org Settings → GitHub Apps → `<App>` → Configure → Repository access**, add the repository,
**Save**.

With `read:user`, the next `talos govern` reads the installation and shows the App `ok`.

## 2. Org secrets and variables

Under the org's **Settings → Secrets and variables → Actions**, with **Repository access: All
repositories**, since every governed repository's caller reads them:

| Secret                    | What                                                                        |
| ------------------------- | --------------------------------------------------------------------------- |
| `TALOS_REVIEWER_KEY`      | `talos-reviewer`'s private key, the whole `.pem` file                       |
| `CLAUDE_CODE_OAUTH_TOKEN` | The reviewer's model; `claude setup-token` makes one. Kept from the old kit |

Every one of these variables is required:

| Variable                | Value                                                          |
| ----------------------- | -------------------------------------------------------------- |
| `TALOS_OWNER`           | `SvenPGH`: the one login whose approval `talos/review` accepts |
| `TALOS_THEA_APP`        | Thea's App's slug, its bot login without `[bot]`               |
| `TALOS_REVIEWER_APP`    | `talos-reviewer`                                               |
| `TALOS_RELEASE_APP`     | `talos-release`                                                |
| `TALOS_REVIEWER_APP_ID` | `talos-reviewer`'s App ID, from its settings page              |

And two are optional:

| Variable             | Set it when                                                  |
| -------------------- | ------------------------------------------------------------ |
| `TALOS_LOOKUP`       | a smoke test says so (step 6), to `channels`                 |
| `TALOS_REVIEW_MODEL` | the reviewer should use a model other than `claude-opus-5-5` |

Only the caller's act phase reads `TALOS_REVIEW_MODEL`.

An unset variable reaches a workflow as an empty string, which Talos reads as unset. Talos's code
falls back to SVP-Labs's own identities, but the workflows repeat none of them, so an unset
identity fails closed there: without `TALOS_OWNER` the channels job refuses the owner's urgent
promotion, and without `TALOS_THEA_APP` or `TALOS_RELEASE_APP` a review or comment by that App
starts no `act` job, so a `talos-approve` review by Thea wouldn't rerun `talos/review`. The
organisation is no variable: the workflows pass `github.repository_owner` as `TALOS_ORG`.

Set every identity variable, even where its value is the default name: Talos trusts comments and
reviews by those logins, so a variable left unset falls back to a name that only means SVP-Labs's
App if SVP-Labs owns it.

`TALOS_REVIEWER_KEY` with **All repositories** can be read by any workflow on any branch of any
repository in the org. To narrow it, choose **Selected repositories** and add each repository as
`talos govern` brings it in; a governed repository missing from the list can't run its caller.

Then, under **Settings → Actions → General**, keep **Workflow permissions** at **Read repository
contents and packages permissions**: every Talos workflow asks for exactly what it needs.

## 3. The Talos repository

`SVP-Labs/Talos` is public, so every repository can run its gate (C1).

- **The `release` environment:** **Settings → Environments → New environment** `release`. Under
  **Deployment branches and tags**, choose **Selected branches and tags** and add the branch
  `main` only: tag-triggered runs are refused, which is what keeps a tag push from moving a pin
  (C17). Add no required reviewers, since the scheduled jobs run unattended. Give it the secret
  `TALOS_RELEASE_KEY` (`talos-release`'s `.pem`) and the variable `TALOS_RELEASE_APP_ID` (its App
  ID).
- **The privacy canary** comes in step 6, once the pins exist: the scratch repository the smoke
  tests use stays governed for good, and Talos knows it only by a hash of its name.

## 4. npm

The engine ships as `@svp-labs/talos`, published by Talos's release workflow through npm's
trusted publishing, so no npm token is stored anywhere (C26).

1. On npmjs.com, with two-factor authentication on your account, create the organisation
   `svp-labs` (free for public packages).
2. npm adds a trusted publisher only to a package that exists, so publish a placeholder once by
   hand from an empty directory:

   ```bash
   npm init -y --scope=@svp-labs && npm pkg set name=@svp-labs/talos version=0.0.0
   npm publish --access public
   npm deprecate @svp-labs/talos@0.0.0 "placeholder: Talos releases start at 0.1.0"
   ```

   It carries no provenance, so Talos's launcher would refuse it, and no pin ever names it.

3. Add the trusted publisher, on the package's **Settings → Trusted publishing → GitHub
   Actions**, or with npm 11.15 or later:

   ```bash
   npm trust github @svp-labs/talos --repo SVP-Labs/Talos --file release.yml --allow-publish
   ```

   Organisation `SVP-Labs`, repository `Talos`, workflow `release.yml`, no environment: the
   publish job runs on the tag, which the `release` environment refuses. Allow `npm publish`.
   npm drops a publisher that hasn't published within two days, so do this right before step 5.

4. Under the package's **Settings → Publishing access**, choose **Require two-factor
   authentication and disallow tokens**.

## 5. The first release and the pins

1. Merge the branch Talos was built on into `main` with one **squash merge**, while the
   repository still lets you (`talos govern`, step 7, leaves only rebase merges). Its history
   holds work-in-progress commits that wouldn't pass Talos's own rules one by one; the squashed
   tree is the one that does. Give the commit a subject Talos accepts, at most 72 characters with
   the `(#N)` GitHub appends, such as
   `[TL-1]: Build Talos, the kit that governs SVP-Labs repositories`, and a short body in place
   of the list of commits GitHub proposes.
2. `package.json` on `main` says `0.1.0`. Tag that commit, signed, and push the tag:

   ```bash
   git switch main && git pull
   git tag -s v0.1.0 -m v0.1.0 && git push origin v0.1.0
   ```

3. The release workflow publishes `@svp-labs/talos@0.1.0`, with an `npm-shrinkwrap.json` built
   from the lockfile, so every install runs the dependency tree the release was tested with.
   Check that it carries provenance for that commit:

   ```bash
   npm view @svp-labs/talos@0.1.0 version dist.attestations.provenance.predicateType
   ```

4. Set up the organisation, seeding every pin with that commit:

   ```bash
   talos org init --seed "$(git rev-parse 'v0.1.0^{commit}')" --dry-run
   talos org init --seed "$(git rev-parse 'v0.1.0^{commit}')"
   talos org pins
   ```

   `org init` defines the two custom properties (`talos`, a single select of `evaluate`,
   `canary` and `stable`; `talos-agents`, true or false), creates the three channel rulesets
   (`talos-evaluate` in Evaluate mode, `talos-canary` and `talos-stable` active), each requiring
   the gate at the seeded commit and `talos/review` from the reviewer, and on the Talos
   repository the tag ruleset (only you create, move or delete `v*` tags) and
   `talos-self-test`, which requires the self-test workflow's `check` and `self-test <os>` jobs
   on `main`, in the merge queue too, so a PR whose own engine fails its test projects never
   lands. `org pins` shows all three channels at `v0.1.0`. From now on only Talos's release jobs
   move the pins.

   The `channels` branch's ruleset, `talos-channels` (only `talos-release` writes the branch),
   belongs to the `channels.json` fallback alone. `org init` reads the org variable
   `TALOS_LOOKUP` and creates it only when that says `channels`; otherwise it reports the ruleset
   as not needed. If smoke test 1 or 5 turns the fallback on, run `talos org init` again once
   `talos-release` has Contents write, and it adds the ruleset. A step that fails doesn't stop the
   others: `org init` reports each with GitHub's reason and exits 1, so a rerun finishes the rest.

## 6. The scratch repository and six smoke tests

Things GitHub's documentation doesn't settle get tested on a scratch repository before Thea
comes in: the six C18 names, the last three of which Talos's code relies on. Run test 2 last: its
`Dockerfile` is a security finding, which turns every later gate run on the repository red.

**Create it** as yourself, private, with a unique, random name, such as `talos-scratch-` and
eight random letters, and a prefix no other repository uses:

```bash
talos new talos-scratch-<random> --prefix SCR --agents off --dry-run
talos new talos-scratch-<random> --prefix SCR --agents off
```

`new` creates the repository with a seed `talos.yml` (its name and prefix) and governs it at
`evaluate`. It prints the steps GitHub's API can't take: restricting issue creation to
collaborators (**Settings → General → Features → Issues**), and adding the repository to each
App's installation ([step 1](#adding-a-repository-to-an-installation)). Do them by hand;
`talos govern SVP-Labs/<scratch>` then shows every other step `ok`.

**It is also the privacy canary** (C30), and stays governed for good, so the central jobs always
have it in their matrix. Each central workflow's last job reads every log of its run and fails
it if a private repository's name shows anywhere, and fails it too if the canary isn't among the
repositories it watched. That job finds the canary among the organisation's private
repositories by its digest, masks its name, then mints a token limited to it from each App the
workflow runs as (`talos-release` for the channels job, `talos-reviewer` for the sweep, both for
the drift report): a token that reaches the canary alone proves the App can name it. Both Apps
must therefore stay installed on it, as on every governed repository, whose per-repository
tokens the sweep and the drift report mint too. Talos never learns the canary's name, since a
variable's value is printed in the step's `env` block in a public log. Give the Talos
repository the **variable** `TALOS_PRIVACY_CANARY_SHA256` instead, the SHA-256 of the
lower-cased `owner/name`:

```bash
printf %s SVP-Labs/talos-scratch-<random> | tr A-Z a-z | sha256sum | cut -d' ' -f1
```

The variable is required: without it no run can prove it watched the canary, so the privacy job
of every central workflow (the channels job, the runtime sweep and the drift report) fails.

### 1. Rulesets in Evaluate mode are listed

C3's version lookup reads them through `rulesets?includes_parents=true`.

- **Do:**

  ```bash
  gh api "repos/SVP-Labs/<scratch>/rulesets?includes_parents=true" \
    --jq '.[] | [.name, .enforcement, .source_type] | @tsv'
  ```

  and, in a clone of the scratch repository, `talos doctor --json`.

- **Expect:** a line `talos-evaluate  evaluate  Organization`, and `doctor` naming the pin and
  version `0.1.0`.
- **If it isn't listed:** switch every lookup to `channels.json`. Set the org variable
  `TALOS_LOOKUP=channels`; give `talos-release` **Contents: Read and write** (step 1), so its jobs
  write the pins to `channels.json` on the Talos repository's `channels` branch whenever they move
  one; then run `talos org init` again, which now creates the `talos-channels` ruleset so only
  `talos-release` writes that branch (step 5.4); and tell Thea's hub, whose lookup has a seam for
  it but doesn't read the file yet (her U2). The drift report then checks the file against the
  rulesets.

### 2. Apps can still open issues and PRs

C6 limits creation to collaborators. Thea's App, `talos-reviewer` and Dependabot must still get
through.

- **Do:** with issue and PR creation restricted on the scratch repository,
  - ask Thea to open an issue there, and a draft PR from a task;
  - commit a `Dockerfile` with `FROM php:8.4.26-fpm` (older than php2shell's fix, 8.4.27) and
    run the runtime sweep from the Talos repository's **Actions** tab (`runtime-sweep`, **Run
    workflow**);
  - commit `.github/dependabot.yml` with a `github-actions` update and a workflow that uses
    `actions/checkout@v3`, then **Insights → Dependency graph → Dependabot → Check for
    updates**.
- **Expect:** Thea's issue and PR, by her App's bot; Dependabot's PR bumping `actions/checkout`;
  and a `security` issue by `talos-reviewer[bot]` whose first line is

  ```text
  talos-security/1 kind=runtime runtime=php version=8.4.26 fixed=8.4.27 priority=p0
  ```

- **If any is refused:** no repository can keep the restriction. Lift it on the scratch
  repository by hand, and open a `decision` issue on Talos to drop it from `talos govern` and the
  drift report. C6's trust rule and C17's trusted-`regression` rule then carry the protection
  alone.

### 3. The owner's bypass reaches the merge queue

At `evaluate`, the code-owner ruleset gives you a bypass; the merge-queue ruleset has none.

- **Do:** as yourself, file issue #1, push a branch `SCR-1` with two signed commits, each
  `[SCR-1]: …` and each adding a line to `README.md`, open a PR from it that closes #1, and
  choose **Merge when ready** (taking the bypass the page offers).
- **Expect:** the PR joins the merge queue without anyone's approval, and the queue merges it
  onto `main`.
- **If it is refused:** while a repository is at `evaluate`, both rules belong in one ruleset, so
  your bypass covers the queue too; that costs nothing in a phase where nothing is enforced, and
  ends at `--channel`. Open an issue on Talos to change `talos govern` that way.

### 4. A ruleset's required workflow runs on `merge_group`

The gate judges the queue's commits (C3, C14) only if GitHub starts it there.

- **Do:** watch the PR of test 3 while it is in the queue, under **Actions** and **Settings →
  Rules → Insights**.
- **Expect:** a `talos` run for the event `merge_group`, with the jobs `verdict (talos 0.1.0)`
  and `engine (talos 0.1.0)` and a `talos-verdict` artifact.
- **If there is none:** stop, and open a `decision` issue on Talos before Thea comes in: the
  queue would land commits the gate never judged.

### 5. The gate's own token can list the rulesets

The gate finds its pin by listing the repository's rulesets with its `GITHUB_TOKEN`, which holds
`contents: read` and nothing else; the scratch repository is private, the hard case.

- **Do:** open the `pin` job of any gate run on the scratch repository.
- **Expect:** its **Find the enforced Talos release** step succeeds, and the later jobs carry
  the version in their names.
- **If it fails** (`cannot list the repository's rulesets`): set the org variable
  `TALOS_LOOKUP=channels`, give `talos-release` contents write and rerun `talos org init`, as in
  test 1.

### 6. The queue leaves `main` on the commits it tested

`talos status` reads whether `main` is green from the gate's run on `main`'s head commit (C31),
which only works if the queue pushes exactly the commits its `merge_group` run tested.

- **Do:** after test 3 has merged,

  ```bash
  git -C <clone of the scratch repository> pull
  git -C <clone of the scratch repository> log --format=%H -n 2
  talos status --repo SVP-Labs/<scratch> --json
  ```

- **Expect:** `main`'s two newest commits are the two the `merge_group` run judged (its `run`
  jobs carry each commit's SHA in their names), and `main.gate` is `green`, not `unknown`.
- **If they differ:** open an issue on Talos: `talos status` must then read `main`'s state from
  the `merge_group` run by another key than the commit.

Remove the test files from the scratch repository afterwards, and close what the tests opened.
Keep the repository.

## 7. Talos governs itself

```bash
talos govern SVP-Labs/Talos --agents on
```

It commits the caller and `CODEOWNERS` (`* @SvenPGH`) to `main` before any ruleset exists, creates
the merge-queue ruleset and, while Talos is at `evaluate`, the code-owner ruleset, and sets the
properties. The three installations hold Talos already (step 1), which `talos govern` shows `ok`
with the `read:user` scope; without it, it lists each App as a manual step to check
([step 1](#adding-a-repository-to-an-installation)). Talos already holds its own `talos.yml`,
generated configs and `CLAUDE.md`, so it needs no `talos adopt`.

Open a PR and watch the gate run under **Settings → Rules → Insights** without blocking anything,
and `talos/review` appear on it. Talos's own self-test workflow runs the PR's engine against the
test projects on every operating system they list (C5). Once both are green:

```bash
talos govern SVP-Labs/Talos --channel canary
```

From here every Talos PR needs your approval on GitHub, whoever wrote it (C16), and the release
jobs promote each new release by themselves (C17; [development](development.md) says how a
release is cut).

## 8. Thea

**Her hub first** (C18 step 2). Before her repository comes in, her hub gains, in her own
repository and under her own briefs, everything Talos expects of her
([Thea and Talos](https://github.com/SVP-Labs/Thea/blob/main/docs/requirements/20261023-thea-talos.md)):

- pushes that land on a `<P>-<N>` branch she holds the claim for;
- claiming through a hub tool, and the hub handing each task the enforced release;
- `talos check --json` before each push, and on every squashed commit at ready;
- approval cards as `talos-approve` COMMENT reviews, the card being the only code path that
  submits a review, and every other GitHub-writing tool refusing that marker;
- auto-merge armed when a PR is marked ready, the queue's own daily budget, `talos_status`, and
  the events Talos adds, each named in her `persona.ts` and announced once in `changes.ts`.

Without these, the next step stalls.

**Then her repository** (C18 step 3):

```bash
talos govern SVP-Labs/Thea --agents on
```

Thea runs `talos adopt` as a task; its bootstrap PR touches `talos.yml` and `.github/`, so you
approve it on GitHub. In it, every row of her `docs/development/checks.md` maps to a Talos check;
`ci.yml` and `mutation.yml` go, and `desktop.yml` keeps only the installer build and release.
Her decision citations in code comments become findings on the debt list.

Two things in her repository need you or a ticket of their own:

- **Her Rust pin.** `apps/desktop/rust-toolchain.toml` pins Rust `1.97.0`, whose cycle reached
  its end of life on 2026-08-20, so `runtime/eol` reports it. Adoption adds the components the
  checks use but keeps a channel the project already pins exactly; move it to the release
  Talos pins (`1.99.1`, the one adoption writes where there is no pin).
- **Her pushes skip the pre-push hook.** Her `prepare` script points `core.hooksPath` at
  `.githooks`, where adoption writes Talos's `pre-push`, but her daemon runs every git command
  that carries a token with hooks off, so code a task left in the worktree can never read the
  push token. The fast tier has already run by then: the daemon runs `talos check --json` in the
  task's worktree before every push, and the gate runs the same checks. Your own clones of her
  repository run the hook as any other.

Her daemon runs `talos check` in the task's own environment, which needs the network the gate's
runners have ([below](#the-gates-runners)): Semgrep fetches its rule sets, and without them
every `talos check` ends in an engine error. Once green:

```bash
talos govern SVP-Labs/Thea --channel canary
```

Activating the ruleset also protects her `main`, which until now required nothing.

## 9. The transfers

LoreLock, Stillstift, the CoE5 Toolbox and the CoE5 ModValidator move from your account to
SVP-Labs (C2); archived repositories stay. For each, **Settings → Danger Zone → Transfer**, then
re-point everything that named the old place (C18 step 4):

- Coolify's GitHub source, for anything it deploys from the repository;
- GitHub Pages: the custom domain, and the DNS record if it named your account;
- webhooks and secrets the repository or its deploys rely on;
- the remotes of clones on your desktop, with `git remote set-url origin <the new URL>`;
- Thea's clones under `~/.thea/repos/<owner>/<name>`: move each to
  `~/.thea/repos/SVP-Labs/<name>`, or delete it and let her next task clone it again.

Each repository's ticket prefix must be unique in the org (C23). `talos new` checks it, and so
does `talos adopt`, against the `talos.yml` (or Scaffold's `project.yml`) on every unarchived
repository's default branch. Adoption checks only when its token can list the org's
repositories, and its JSON says whether it did (`prefixChecked`); when it couldn't, pick a
prefix no other repository uses yourself. The Toolbox can't keep Scaffold's `T`, which is
Thea's.

When the last one has moved, uninstall Thea's SvenPGH App and delete it, and make sure her hub's
`GITHUB_LOGIN` is set: only her SVP-Labs App remains (her U15).

## 10. LoreLock

```bash
talos govern SVP-Labs/LoreLock --agents on
```

Thea runs `talos adopt`: Python at the root and the JavaScript frontend in its subfolder as two
components, `exclude: [app]`, and its two custom checks, `check_docs.py` and
`check_value_graph.py`, which gain `--json` while their baseline files are deleted (C19). The move
also takes black to ruff format, mypy to basedpyright, the local-only gates to CI, and drops the
grandfathered `ignore_imports` entry (C21). LoreLock runs its hooks through pre-commit, which
adoption never replaces: a next step asks for a `pre-push` entry there that runs Talos's
`.githooks/pre-push`. Once green:

```bash
talos govern SVP-Labs/LoreLock --channel stable
```

## 11. The rest

The remaining repositories, the small ones and those generated from Scaffold, one at a time:
`talos govern`, then `talos adopt`, then `--channel stable` once green. For a repository generated
from Scaffold, adoption deletes what Scaffold put there: its callers, `scripts/`, `justfile`,
`.lang/` and `lefthook.yml` (C18 step 5).

What adoption can't do itself, it lists as next steps, and it then stops before committing:
a lock file to refresh, a hook manager to wire to Talos's hook, a `tsconfig.json` to make extend
the generated base. The pre-push hook runs once a clone's `core.hooksPath` is `.githooks`. In a
repository with a root `package.json`, its `prepare` script sets that on install; in one
without, every clone runs `git config core.hooksPath .githooks` once.

## 12. Archiving Scaffold and Workflows

Once nothing calls the old kit any more (C18 step 6):

```bash
gh search code 'SVP-Labs/Workflows@' --owner SVP-Labs --json repository --jq '.[].repository.nameWithOwner'
```

prints nothing. Then archive `SVP-Labs/Scaffold` and `SVP-Labs/Workflows`, delete the org secrets
only they used (`REPO_ADMIN_TOKEN`, `SCAFFOLD_SYNC_TOKEN`), and revoke the personal access tokens
behind them. `CLAUDE_CODE_OAUTH_TOKEN` stays: the reviewer uses it.

## The gate's runners

The gate runs on GitHub's hosted runners (`ubuntu-latest`, and `windows-latest` or
`macos-latest` for a component that lists those systems). Beyond the Node and PHP it sets up,
they have what it assumes: git, curl, tar, unzip, jq, yq, `gh`, `pwsh`, a C compiler (Lua is
built from source), rustup, Docker on Linux for declared services, and an open network. Every
outside tool comes from `tools.lock`, checked by its sha256, and each language's own tools from
the project's lockfile.

PHP is the one runtime the gate sets up per project, and each run of its matrix sets up what its
own commit asks for, so base and head may differ: on a system a PHP component of that commit
lists, the newest minor any such component's `composer.json` asks for (`config.platform.php`,
else `require.php`), never older than 8.4, with pcov and Composer. setup-php (pinned at 2.40.0)
runs with `update: true`, so the runner takes that minor's newest release. The PHP pack refuses,
as an engine error, a PHP that isn't the newest release of its cycle, or whose cycle is past its
end of life, judged by the runtime feeds. On the day php.net ships a release, setup-php's package
sources can trail it for some hours, and the gate stops with that engine error in every
repository with a PHP component until they catch up.

A runner whose network is restricted (a self-hosted one, or behind a proxy) must reach:

- the registries projects install from and Talos checks releases against:
  `registry.npmjs.org`, `pypi.org` and `files.pythonhosted.org`, `repo.packagist.org`,
  `index.crates.io` and `static.crates.io`, `luarocks.org`, `luarocks.github.io` and
  `www.lua.org`;
- `github.com`, `objects.githubusercontent.com`, `raw.githubusercontent.com`,
  `codeload.github.com` and `cdn.powershellgallery.com`, for `tools.lock`'s downloads, uv's
  Pythons and the sources some rocks and Composer packages come from;
- `api.osv.dev` and `api.deps.dev`, for advisories and licences;
- `endoflife.date`, `www.php.net` and `nodejs.org`, for the runtime feeds;
- `semgrep.dev`, for Semgrep's rule sets.

Behind a proxy, set `NODE_USE_ENV_PROXY=1` beside `HTTPS_PROXY`: Node's `fetch` ignores the proxy
without it.

## Afterwards

- A new project starts as a conversation with Thea, then `talos new <Name> --prefix <P>` as
  yourself, which creates the repository and governs it at `evaluate`; Thea runs `talos adopt`
  (C23).
- A release that carries a security fix: dispatch the promotion workflow from the Talos
  repository's **Actions** tab; it promotes after one clean canary run (C17).
- A release that broke something: open an issue labelled `regression` on the Talos repository;
  canary's pin moves back at once, and promotion waits until it is closed.
- `talos org pins` shows each channel's release; `talos status --org` shows every governed
  repository.
