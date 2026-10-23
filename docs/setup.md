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
  gh auth refresh -s admin:org,repo,workflow
  ```

- Node 22.14 or later, npm 11.5.1 or later and pnpm, for running Talos from a clone and for the
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
App**, each with:

- **Homepage URL:** `https://github.com/SVP-Labs/Talos`.
- **Webhook:** untick **Active**. Both run in Actions and receive nothing.
- **Where can this GitHub App be installed?** **Only on this account.**

### `talos-reviewer`

- **Name:** `talos-reviewer`, so its bot is `talos-reviewer[bot]`.
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
  `talos govern` adds each governed repository to the installation.

### `talos-release`

- **Name:** `talos-release`, so its bot is `talos-release[bot]`.
- **Organization permissions:** Administration, **Read and write** (it moves the pins in the org
  rulesets, C17).
- **Repository permissions:**

  | Permission     | Access    | Why                                                     |
  | -------------- | --------- | ------------------------------------------------------- |
  | Administration | Read-only | the drift report reads each repository's settings (C29) |
  | Actions        | Read-only | promotion counts gate runs on canary repositories (C17) |
  | Metadata       | Read-only | required                                                |

  Contents stays off unless the first smoke test (step 6) turns on the `channels.json` fallback;
  then it is **Read and write**, and its jobs mint contents tokens for the Talos repository only.

- **Its key:** generate a private key; it becomes the `release` environment's secret
  `TALOS_RELEASE_KEY` (step 3) and nothing else.
- **Install** it on SVP-Labs with **Only select repositories**, choosing `SVP-Labs/Talos`;
  `talos govern` adds each governed repository.

### Thea's App

Her SVP-Labs App keeps the permissions of her G1
([her setup](https://github.com/SVP-Labs/Thea/blob/main/docs/setup/github.md)), which include
everything Talos needs of her: contents, pull requests and issues read and write; checks,
commit statuses and actions read. Add to it:

- **Subscribe to events:** tick **Check run**, so the gate and `talos/review` reach her.
- **Install** it on `SVP-Labs/Talos` too: her hub reads each release's `package.json` there.

Its key stays in her hub's settings and nowhere else.

## 2. Org secrets and variables

Under the org's **Settings → Secrets and variables → Actions**, with **Repository access: All
repositories**, since every governed repository's caller reads them:

| Secret                    | What                                                                        |
| ------------------------- | --------------------------------------------------------------------------- |
| `TALOS_REVIEWER_KEY`      | `talos-reviewer`'s private key, the whole `.pem` file                       |
| `CLAUDE_CODE_OAUTH_TOKEN` | The reviewer's model; `claude setup-token` makes one. Kept from the old kit |

| Variable                | Value                                                          |
| ----------------------- | -------------------------------------------------------------- |
| `TALOS_OWNER`           | `SvenPGH`: the one login whose approval `talos/review` accepts |
| `TALOS_THEA_APP`        | Thea's App's slug, its bot login without `[bot]`               |
| `TALOS_REVIEWER_APP`    | `talos-reviewer`                                               |
| `TALOS_RELEASE_APP`     | `talos-release`                                                |
| `TALOS_REVIEWER_APP_ID` | `talos-reviewer`'s App ID, from its settings page              |

Optional: `TALOS_REVIEW_MODEL` picks the reviewer's model; Opus unless set. `TALOS_LOOKUP` stays
unset unless the first smoke test fails (step 6).

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
- **The privacy canary:** create a private repository with a unique, random name, such as
  `talos-scratch-` and eight random letters. It stays governed for good, so the central jobs
  always have it in their matrix, and Talos's CI fails if its name ever shows in a run's log
  (C30). Give its name to Talos as the repository **variable** `TALOS_PRIVACY_CANARY`, not a
  secret: GitHub masks secrets in logs, which would hide the very leak the test looks for. The
  smoke tests below use the same repository.

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

1. `package.json` on `main` says `0.1.0`. Tag that commit, signed, and push the tag:

   ```bash
   git switch main && git pull
   git tag -s v0.1.0 -m v0.1.0 && git push origin v0.1.0
   ```

2. The release workflow publishes `@svp-labs/talos@0.1.0`. Check that it carries provenance for
   that commit:

   ```bash
   npm view @svp-labs/talos@0.1.0 version dist.attestations.provenance.predicateType
   ```

3. Set up the organisation, seeding every pin with that commit:

   ```bash
   talos org init --seed "$(git rev-parse 'v0.1.0^{commit}')" --dry-run
   talos org init --seed "$(git rev-parse 'v0.1.0^{commit}')"
   talos org pins
   ```

   `org init` defines the two custom properties (`talos`, a single select of `evaluate`,
   `canary` and `stable`; `talos-agents`, true or false), creates the three channel rulesets
   (`talos-evaluate` in Evaluate mode, `talos-canary` and `talos-stable` active), each requiring
   the gate at the seeded commit and `talos/review` from the reviewer, and on the Talos
   repository the tag ruleset (only you create, move or delete `v*` tags) and the `channels`
   branch's ruleset (only `talos-release` writes it). `org pins` shows all three channels at
   `v0.1.0`. From now on only Talos's release jobs move the pins.

## 6. Three smoke tests

Three things GitHub's documentation doesn't settle get tested on the scratch repository before
Thea comes in (C18). Govern it first:

```bash
talos govern SVP-Labs/<scratch> --agents off
```

`govern` prints the steps GitHub's API can't take, such as restricting issue creation to
collaborators (**Settings → General → Features → Issues**). Do them by hand; a rerun then shows
every other step `ok`.

### Rulesets in Evaluate mode are listed

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
  one; and tell Thea's hub, whose lookup has a seam for it but doesn't read the file yet (her
  U2). The drift report then checks the file against the rulesets.

### Apps can still open issues and PRs

C6 limits creation to collaborators. Thea's App, `talos-reviewer` and Dependabot must still get
through.

- **Do:** with issue and PR creation restricted on the scratch repository,
  - ask Thea to open an issue there, and a draft PR from a task;
  - commit a `Dockerfile` with `FROM php:8.4.26-fpm` (older than php2shell's fix, 8.4.27) and
    run the runtime sweep from the Talos repository's **Actions** tab;
  - commit `.github/dependabot.yml` with a `github-actions` update and a workflow that uses
    `actions/checkout@v3`, then **Insights → Dependency graph → Dependabot → Check for
    updates**.
- **Expect:** Thea's issue and PR, by her App's bot; a `security` issue by `talos-reviewer[bot]`
  whose first line is `talos-security/1 kind=runtime priority=p0`; and Dependabot's PR bumping
  `actions/checkout`.
- **If any is refused:** no repository can keep the restriction. Lift it on the scratch
  repository by hand, and open a `decision` issue on Talos to drop it from `talos govern` and the
  drift report. C6's trust rule and C17's trusted-`regression` rule then carry the protection
  alone.

### The owner's bypass reaches the merge queue

At `evaluate`, the code-owner ruleset gives you a bypass; the merge-queue ruleset has none.

- **Do:** as yourself, push a branch with a signed commit to the scratch repository, open a PR,
  and choose **Merge when ready** (taking the bypass the page offers).
- **Expect:** the PR joins the merge queue without anyone's approval, a `merge_group` gate run
  starts, and the queue merges it onto `main`.
- **If it is refused:** while a repository is at `evaluate`, both rules belong in one ruleset, so
  your bypass covers the queue too; that costs nothing in a phase where nothing is enforced, and
  ends at `--channel`. Open an issue on Talos to change `talos govern` that way.

Remove the test files from the scratch repository afterwards, and close what the tests opened.

## 7. Talos governs itself

```bash
talos govern SVP-Labs/Talos --agents on
```

It commits the caller and `CODEOWNERS` (`* @SvenPGH`) to `main` before any ruleset exists, creates
the merge-queue ruleset and, while Talos is at `evaluate`, the code-owner ruleset, sets the
properties and adds Talos to the three installations. Talos already holds its own `talos.yml`,
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
Her decision citations in code comments become findings on the debt list. Once green:

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

Each repository's ticket prefix must be unique in the org (C23). `talos new` checks it; for a
repository that comes in through `talos adopt`, pick one no governed repository's `talos.yml`
uses. The Toolbox can't keep Scaffold's `T`, which is Thea's.

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
grandfathered `ignore_imports` entry (C21). Once green:

```bash
talos govern SVP-Labs/LoreLock --channel stable
```

## 11. The rest

The remaining repositories, the small ones and those generated from Scaffold, one at a time:
`talos govern`, then `talos adopt`, then `--channel stable` once green. For a repository generated
from Scaffold, adoption deletes what Scaffold put there: its callers, `scripts/`, `justfile`,
`.lang/` and `lefthook.yml` (C18 step 5).

## 12. Archiving Scaffold and Workflows

Once nothing calls the old kit any more (C18 step 6):

```bash
gh search code 'SVP-Labs/Workflows@' --owner SVP-Labs --json repository --jq '.[].repository.nameWithOwner'
```

prints nothing. Then archive `SVP-Labs/Scaffold` and `SVP-Labs/Workflows`, delete the org secrets
only they used (`REPO_ADMIN_TOKEN`, `SCAFFOLD_SYNC_TOKEN`), and revoke the personal access tokens
behind them. `CLAUDE_CODE_OAUTH_TOKEN` stays: the reviewer uses it.

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
