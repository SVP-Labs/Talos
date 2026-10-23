# Talos: one kit for every SVP-Labs project

**Status:** decided
**Date:** 2026-10-22, decided 2026-10-23 · **Issue:** none yet (the kit repo doesn't exist).

## Requirement

One public repository replaces SVP-Labs/Scaffold and SVP-Labs/Workflows. It holds the
engineering standard, the check engine, each language's tool configs, the issue and PR
conventions, the agent loop and the Claude instructions every project uses. It works in any
language, sits lightly on small projects, and holds every governed repository to the strictness
of Thea and LoreLock.

What prompted it:

- Scaffold reaches only repositories generated from it; neither Thea nor LoreLock is.
- Private reusable workflows can't serve repositories of another owner, or public ones.
- Thea's `main` has no protection, so its checks don't actually gate a merge.
- Two kits release separately, and projects pin a moving `@v0`, so CI changes without a PR.

## Decisions

### C1 · One public kit in SVP-Labs

**Decision:** `SVP-Labs/Talos`, public. It governs public and private repositories alike. It
is built as a new repository: Scaffold and Workflows are mined for their rules (the claim
protocol, issue forms, labels, test integrity, the language configs, raised to Thea's
strictness), not for their code, and are then archived (C18). ENGINEERING.md is written new for
Talos and lives only there; each project's generated CLAUDE.md block links to it.

**Rejected:**

- a private kit: GitHub delivers nothing from a private repository into a public one (a
  ruleset's workflow can't come from a more private repository than its targets, and a public
  repository can call only public workflows);
- a private source publishing a generated public mirror: a second repository and a publishing
  pipeline, and everything public repositories run ends up public anyway.

### C2 · Every governed repository lives in SVP-Labs

**Decision:** LoreLock, Stillstift, the CoE5 Toolbox and the CoE5 ModValidator transfer to the
org. Archived repositories stay where they are.

**Rejected:** governing repositories on a personal account (org rulesets don't reach them).

### C3 · The gate is an org ruleset, not a file in the project

**Decision:** an org ruleset ("Require workflows to pass before merging") runs the kit's gate
workflow, pinned to a commit SHA, on every repository whose custom property `talos` is set.
The property's value picks one of three rulesets: `evaluate` (Evaluate mode, stable's pin; C18),
`canary` and `stable`. An upgrade moves a pin.

**Finding the version.** Locally, and in C25's caller, `talos` reads the repository's
rulesets, including the org's (`GET repos/{repo}/rulesets?includes_parents=true`, then each
ruleset). It skips disabled ones and takes the `workflows` rule that points at the Talos
repository. The branch-rules endpoint can't be used for this: it returns only active rules, so
an `evaluate` repository would get no version at all. Exactly one Talos ruleset must match a
repository; `talos doctor` reports otherwise. Pins only ever point at release-tag commits
(C17), so the version follows from the SHA: `talos` reads `package.json` at that commit in the
public Talos repository, runs `@svp-labs/talos@<that version>`, and refuses the package unless
its npm provenance names that same commit (C26). Local runs and CI therefore always run the
same engine.

**What the gate may decide.** The gate workflow triggers on `pull_request` and `merge_group`:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  merge_group:
```

`ready_for_review` is not among `pull_request`'s default types, and Thea squashes and
force-pushes while a PR is still a draft (C20), so without it marking a PR ready would trigger
nothing and the per-commit tier (C8) would first run in the queue. The gate never sets
`cancel-in-progress`, and needs no secrets. It runs the PR's code (its tests, and its
JavaScript tool configs, C10 and C21), so it only produces findings. Nothing that depends on
which files changed, on who approved, or on test integrity is decided there; C16's conditions
are computed in C25's review job, which never executes PR code. On `merge_group`, the gate runs
the fast tier on every commit of the group, not only its tip, because the queue pushes exactly
those commits to `main` (C8).

**Rejected:**

- a thin caller workflow in each repository pinned to a moving tag (today's model: CI changes
  without a PR, and the agent can edit it);
- a copy of the engine in each repository plus a tamper check (only needed while the gate
  lives in the repository);
- scaffold-sync PRs (a personal access token with write access to every repository).

### C4 · CI is required, everywhere

**Decision:** GitHub Actions is the gate. Pre-push runs the fast tier for quick feedback.
Enterprise Cloud's 50k minutes cover private repositories; public ones run free on GitHub's
standard runners.

**Rejected:** local-only gates (LoreLock today: `--no-verify` skips them, and agents have no gate).

### C5 · The engine is TypeScript

**Decision:** jscpd, markdownlint and cspell already require Node, and Node runs natively on
Windows. Every check ships with a test project it must fail on, for each language and OS.
Talos is gated in two layers: its PRs are judged by the canary release like any governed
repository's, and a plain workflow in the Talos repository runs the PR's own engine against the
test projects. A broken engine therefore never judges itself.

**Rejected:** bash (the Windows workarounds keep growing, and the SARIF, ratchet and
fingerprint logic is beyond it).

### C6 · One rulebook regardless of visibility

**Decision:** every governed repository restricts issue and PR creation to collaborators
(GitHub's repository settings for pull requests, February 2026, and issues, June 2026).
Strangers can still read a public repository and comment on its existing issues and PRs; agents
treat such comments as data, as Thea's G9 already does, and act only on issues written by an
owner, member or collaborator. On a private repository the rule never bites.

**Rejected:**

- today's behaviour, where any new issue runs issue-readiness and a badly formed one starts the
  triage agent on the author's text with the org's Claude token (on a public repository that
  lets a stranger spend the usage and steer what the bot posts);
- org-wide interaction limits to stop strangers commenting too (they expire after six months at
  most and must be renewed, and comments can neither label, nor start an agent, nor reach Thea
  unfenced).

### C7 · Documentation roles

**Decision:**

- **Briefs** (`docs/requirements/<date>-<slug>.md`): required for an epic and for any issue that
  sets or changes a decision. Issue-readiness checks the link.
- **Decisions:** a feature's decisions live in its brief, cross-cutting ones in `DECISIONS.md`.
  A reversal adds a new entry and marks the old one, linked both ways. IDs are unique and
  every reference must resolve.
- **Glossary:** one file, path configurable. Terms listed under `Avoid:` fail in code, docs
  and commit subjects; glossary terms feed the spelling dictionary.
- **History:** the PR body's Problem / Discussion / Solution section, checked non-empty.
  `talos why <path>` finds it. There is no CHANGELOG.
- **Code comments:** state only invariants, constraints from outside and non-obvious reasons,
  plus API docblocks. No references (issue, ticket or decision IDs), no history, no
  narration, no TODO.
- **CLAUDE.md:** instructions only: a generated kit block and a capped project block. Architecture
  goes in `docs/`.
- **Anything with a lifecycle** (roadmap, known issues, todos) is an issue.

**Rejected:**

- issues as the only design record (both strict repositories broke this rule);
- `DECISIONS.md` edited in place (loses why something was reversed);
- `CHANGELOG.md` with a row per issue (one shared file, so parallel PRs conflict on rebase);
- `WHY(<P>-N)` citations in code.

### C8 · The check model

**Decision:**

- **Strictness never varies; applicability does.** A check runs when the repository has
  what it checks (a Dockerfile, shell scripts, a lockfile) or when the project declares it
  (architecture layers, mutation paths, size budgets, an e2e command). There is no profile.
- **Every commit in a PR that is ready for review** runs the fast tier: format, lint, types,
  dead code, unit tests, suppressions and the commit subject, and the merge queue runs it
  again on every commit of its group (C3), not only the tip. Merges are rebase-only, so every
  commit on `main` stays green for bisect. A draft PR runs the fast tier on its latest commit
  only, so work-in-progress commits don't fail it; they are squashed before the PR leaves
  draft (C20).
- **The PR's head** runs the rest: integration and e2e tests, coverage, type coverage,
  architecture, duplication, secrets, dependencies and licences, Semgrep, Markdown, spelling,
  the shell, PowerShell, Dockerfile and workflow linters, size budgets, doc references,
  decisions, glossary, and generated-file drift. A project with no declared test tiers runs its
  whole suite in the fast tier.
- **Coverage:** a line covered at the PR's base commit and uncovered at head is a finding
  (C9); on top of that, a PR's changed lines must be at least 90% covered. A line that was never
  covered isn't a finding on its own, so the 10% of new lines that are awkward to reach (rare
  error paths) may stay untested without a suppression.
- **Mutation:** declared critical paths are mutated on every PR that touches them, and every
  surviving mutant is a finding; the whole codebase runs weekly as a report. A language with no
  mature tool (Lua) is marked N/A, explicitly.
- **Type coverage:** each package's shipped code stays at or above 99.5% typed, with `any`, `as`
  casts and `!` counting as untyped and tests free to assert. It is a fixed floor, as Thea has
  it today, not a comparison with the base commit. A package below the floor (checkJs-typed
  JavaScript, or a repository just brought in) treats each untyped identifier as a finding
  compared with the base commit (C9): no new ones land, the existing ones join the debt list,
  and once the package reaches 99.5% the plain floor takes over. So a repository is still green
  on day one, and deleting code never fails a PR. In Python, basedpyright rejects `Any`
  outright, so it is 100% by construction (C12).
- **Flaky tests:** a test that fails and then passes on one immediate rerun leaves the gate
  green, becomes a `flaky` finding, and gets an issue filed to fix it. A test that fails twice
  is a failure.
- **One toolchain per language** (C12): one tool per job, at its strictest settings; Thea's
  TypeScript configuration sets the bar the other languages match job for job. Bringing a
  repository in migrates it (LoreLock: black to ruff format, mypy to basedpyright).
- **Thresholds:** the strictest of Scaffold, Thea and LoreLock for each metric: nesting 3,
  cyclomatic complexity 12, cognitive complexity 15, 4 parameters, 15 branches, 10 returns,
  60 lines per function, 400 per file (tests exempt from the size limits), duplication at 50
  tokens or 5 lines. Line length is each language's formatter default.
- **One findings format:** every check reports SARIF, which baselines, ratchets, PR annotations
  and the agent's fix loop all read.

**Rejected:**

- `profile: full | lean` (small projects aren't hurt by strictness, only by checks that don't
  apply to them);
- running everything on every commit (a 10-commit PR would run Postgres and Playwright ten
  times);
- running checks on the final commit only (a broken commit in the middle of a PR can land);
- a fixed total-coverage floor (existing repositories need a baseline anyway);
- mutating all changed code on every PR (slow, and mutants that change nothing make per-file
  floors flaky);
- every uncovered changed line as a finding (new code would need 100% coverage, and the 90%
  rule would never apply);
- every new untyped identifier as a finding above the floor (new code would need 100% typing;
  the owner kept Thea's 99.5% floor, and the rule applies only below it);
- below the floor, refusing any PR that lowers the package's percentage (deleting well-typed
  code lowers it slightly and would turn that PR red);
- a lighter standard for declared `lab/` paths (exploratory code pays the full price, but every
  line meets one standard, and nothing can slip into shipped code through a lab path);
- running the every-commit check on draft PRs too (a task's work-in-progress commits would fail
  it on every push);
- each project choosing its own tools ("at least as strict" can't be checked mechanically).

### C9 · Baselines are computed from the base commit, and shrink three ways

**Decision:** the gate runs the same checks, at the same enforced Talos version, on the PR's
base commit, and fails only on findings that are new at head. Lost coverage (a line covered at
the base commit and not at head) and surviving mutants are findings too (C8), so no
percentage is compared with the base commit and none needs a tolerance for noise; deleting
well-tested code can't turn a PR red. Type coverage is a fixed floor instead (C8). In the per-commit
tier, each commit is compared with its parent. A finding's fingerprint is its rule plus a hash
of the normalised code, never its path or line, so code that moves keeps its fingerprint. The
same fingerprint can occur more than once, so the gate compares counts: copying a violating
line adds one. A repository coming under the kit is therefore green on day one, with no
baseline file. After that:

- nothing new lands;
- a pre-existing finding on a line a PR changes must be fixed in that PR;
- a weekly job files agent-eligible issues for a batch of the rest, from `talos debt` (the
  findings on `main`).

A kit release that adds a rule needs no special rollout: the rule's existing violations are
already on the base commit, so they join the debt list instead of turning PRs red.

**The exception is security.** A `runtime/security` finding (C28) and a high or critical
dependency advisory are never compared with the base commit. They appear without any code
changing, so they would otherwise only ever be debt. Instead they fail every PR in the
repository until the fix lands, which is the PR that removes them, or until an expiring
exception covers them (C27).

**Rejected:**

- stored baseline and floor files (every PR that fixes debt or raises coverage edits the same
  file, which is the conflict that ruled out a CHANGELOG, and new rules would each need a
  rollout plan);
- comparing coverage, mutation and type-coverage percentages with the base commit (deleting
  well-tested code lowers them, and noise needs a tolerance);
- the ratchet alone (debt can sit forever);
- fixing everything before adopting (LoreLock's move to basedpyright and Thea's citation sweep
  would hold them out for weeks).

**Cost:** one extra run per tier per PR. The base run goes in parallel with head, and the
per-commit tier runs N+1 times rather than 2N.

### C10 · Tool configs: a generated base, a project extension, tighten only

**Decision:** the kit writes each tool's base config into the repository, marked generated,
for editors to read. Each base imports a project-owned extension file. The gate never trusts
the copy in the repository: it renders the base itself at the enforced version and applies
the extension, so a stale copy means an editor shows older rules, which gets an issue rather
than a red build. A check reads each tool's effective config (`eslint --print-config`,
`tsc --showConfig`, `ruff check --show-settings`, and the like) and fails on any rule weaker
than the kit's. Some extension files are JavaScript the gate executes, so that check can't be
trusted on its own; what holds is that any change to an extension file needs the owner, which
C25's review job decides without running PR code (C16).

**Rejected:**

- every addition through `talos.yml` (`talos.yml` would need a schema for every tool's options);
- configs that exist only at run time (editors would show no lint or type settings).

### C11 · The agent loop is opt-in; everything else is mandatory

**Decision:** every governed repository gets the gate, the issue forms, the labels and the
ticket rules: commits start `[P-N]`, the branch is the ticket, and the PR closes `#N`. Agents
(Thea implementing, C20; the reviewer's AI review, C15) work a repository only when its
`talos-agents` custom property is on; the reviewer still publishes `talos/review` in every
governed repository.

Dependabot's PRs are exempt from the ticket rules, since its commits carry no `[P-N]` and its
branches aren't tickets; every other check applies. The exemption is for Dependabot alone, by
its account, not for bots in general. Its PRs touch manifests and lockfiles, so they still need
the owner (C16). `talos adopt` writes Dependabot's `cooldown` to one day, matching C27's minimum
release age; security updates aren't held by the cooldown, matching C27's fast lane.

**Rejected:**

- the agent loop always on;
- the ticket rules optional for small repositories.

### C12 · The language matrix

**Decision:**

```text
job        ts (js via checkJs)          py                        php                            lua             rust
format     prettier                     ruff format               pint (PER-CS 2.0 + Laravel)    stylua          rustfmt
lint       eslint strict-type-checked   ruff                      phpmd + phpstan rules          luacheck        clippy pedantic, -D warnings
           + sonarjs + unicorn subset
types      tsc strict + Thea's extras   basedpyright, all rules   phpstan max + strict-rules     LuaLS --check   rustc
                                                                  (+ larastan on Laravel)
type cov   type-coverage ≥ 99.5%        100% (basedpyright        type-coverage (phpstan ext)    n/a             n/a
                                        rejects Any)
dead code  knip                         vulture                   phpstan unused-code rules      luacheck        dead_code denied + cargo-machete
tests      vitest + v8                  pytest + coverage.py      pest + pcov                    busted + luacov cargo test + llvm-cov
arch       dependency-cruiser           import-linter             deptrac                        n/a             n/a
mutation   stryker                      mutmut                    infection                      n/a             cargo-mutants
```

New `.js` files fail; existing JavaScript is type-checked through `checkJs` until it's
migrated. The checks that apply to any language, wherever relevant:

- secrets and dependencies: gitleaks, and osv-scanner with one org-wide licence allowlist (a
  project adding a licence gives a reason);
- code and docs: semgrep, jscpd, markdownlint, cspell;
- scripts and infrastructure: shellcheck, PSScriptAnalyzer, hadolint, actionlint + zizmor;
- when the project declares them: size-limit, and Playwright + axe.

**Rejected:**

- pyright strict + ruff ANN401 (bans explicit `Any` only in annotations, and gives Python no
  type-coverage measure);
- PHPUnit as the runner (Pest runs on PHPUnit, so existing PHPUnit test classes run unchanged
  under it, and it is Laravel's default).

### C13 · Thea works the queue

**Decision:** in a repository with agents switched on, Thea's own rhythm (her H decisions)
claims the next `ai/eligible` ticket, by priority and then age, until `agents.max_claims`
tickets are claimed at once (`talos.yml`, default 2). Labelling an issue `ai/go`, or asking her,
starts one directly. Queue tickets draw on a daily Talos budget of their own (default 5,
counted by her hub like H5's cap), so a busy debt week doesn't crowd out the rest of her
initiative. Her K6 limit of two tasks running at once still applies.

**Rejected:**

- an hourly Actions job claiming for an Actions agent (a second runtime beside Thea, C20);
- starting work only by hand (the issues C9's weekly job files would wait for someone to pick
  them up);
- queue work counting against H5's cap (debt would burn down at most five tickets a day, minus
  everything else she starts).

### C14 · PRs land through the merge queue

**Decision:** an approved PR joins the merge queue. GitHub rebases it onto the latest `main`,
runs the gate on the result (`merge_group`), and merges in order with the rebase method. GitHub
offers the merge-queue rule only in repository rulesets, not org ones, so `talos govern` (C29)
creates a repository ruleset that requires the queue on `main`, with the rebase method. The
weekly drift report flags one that is missing or has been changed. Thea arms auto-merge when
she marks a PR ready, after the squash (C20): GitHub refuses auto-merge on a draft. The merge
still waits for the gate and `talos/review` (C16).

**Rejected:** the up-to-date-branch rule (every merge forces every other open PR to rebase and
rerun the whole gate).

### C15 · Two identities: Thea implements, a Talos App reviews

**Decision:**

```text
Thea's App (her G1)     contents: write · pull-requests: write · issues: write · checks, statuses, actions: read
talos-reviewer[bot]     contents: read  · pull-requests: write · issues: write · checks: write
                        organization custom properties: read (governed repositories, C28, C30)
talos-release[bot]      organization administration: write (moving pins, C17)
                        organization custom properties: read (finding repositories, C30)
                        administration: read, every governed repository (drift, C29)
                        actions: read, canary repositories (counting gate runs, C17)
                        contents: write, Talos only, and only with the channels.json fallback (C18)
```

Neither Thea's App nor the reviewer has `workflows` or `administration` permission, and
neither sits on any ruleset's bypass list. `talos-release` has no `workflows` permission and
sits on no bypass list except the `channels` branch's ruleset (C18); its key is an environment
secret restricted to Talos's `main` (C17).
The reviewer runs in Actions and is installed on every governed repository; each job creates a
fresh token with `actions/create-github-app-token`, limited to its own repository and valid
for an hour, and its private key is an org secret that never reaches Thea's hub. Where agents
are switched on, it reviews and submits a real APPROVE or REQUEST_CHANGES; everywhere, it
publishes `talos/review` (C16) as a check run, which the ruleset requires from that App alone.
It also runs on `merge_group` and posts its verdict on the queue's merge commit, since a
required check must report there too or the merge queue stalls. Events from an App start
workflows, so Thea's push
starts the gate and the reviewer's review reaches Thea as an event; the two-round limit still
stops loops. This reverses ENGINEERING §2.4's "no GitHub App, no PAT".

**Rejected:**

- `GITHUB_TOKEN` (events it causes start no workflows, so an agent's push never starts the
  gate; the reviewer is the PR's author, so the verdict is a parsed comment; and every workflow
  in the repository shares the identity, so any of them can post that comment);
- a fresh Thea session as the reviewer (her hub would hold the reviewer's key, so a manipulated
  Thea could approve her own work);
- a `talos-implementer` App in Actions (a second runtime beside Thea, C20);
- a bot user with a personal access token (a paid Enterprise seat, and a long-lived token tied
  to a user).

### C16 · A human approves every PR except debt and chore work

**Decision:** `talos/review` passes only when the reviewer has approved (in a repository with
agents switched on; elsewhere this condition is skipped) and either the owner approved after
the PR's last push, or every one of these holds:

- the PR closes a `chore`, `debt/dead-code` or `debt/other` issue;
- that issue's type label was set by a person or by Talos's own weekly debt job (which runs as
  `talos-reviewer`), so an agent relabelling a feature as a chore gains nothing;
- the diff touches only the files the issue names: for a debt issue, the files its findings are
  in plus their tests; for a sync chore, the generated copies;
- the diff touches none of `.github/**`, `CODEOWNERS`, `talos.yml`, the tool-config extension
  files, dependency manifests and lockfiles, Dockerfiles and runtime version files (C28),
  `DECISIONS.md`, `docs/requirements/**`, the glossary or `CLAUDE.md`;
- test integrity flagged nothing (no deleted tests, removed assertions or added skips);
- the diff touches none of the `protected` paths the project lists in `talos.yml` (for Thea:
  her risk rules and her gate, as her D8 already requires);
- the repository isn't Talos itself, whose every PR needs the owner, because a "chore" there
  could loosen a check and be promoted to every repository within a week (C17).

The auto-merge Thea armed when she marked the PR ready then takes it into the merge queue
(C14). The
reviewer can't arm auto-merge itself: that needs `contents: write`, which it deliberately lacks
(C15). Arming it early is harmless, because nothing merges until `talos/review` passes. All of
these conditions are computed by C25's review job from the diff and the API, never by running
the PR's code. The ruleset
carries no approval count of its own, because a ruleset can't vary required reviews by label;
the check carries the rule.

**The owner's approval can come three ways:**

- **on GitHub**, as a code owner's APPROVE;
- **by authorship**: a PR the owner opened counts as approved by them, since GitHub doesn't let
  an author approve their own PR, when every one of its commits has a verified signature with
  the owner as both author and committer (GitHub's `verification.verified`, and the owner's
  login on `author` and `committer`). Author and committer names alone prove nothing: anyone
  pushing can write the owner's name into a commit, and Thea's G4 is a convention, not a
  check. This holds only while Thea's tasks can't sign as the owner. On the PC her tasks run
  under the owner's user, so the owner's signing key must ask for a touch or a prompt on every
  use (a security key, or an SSH agent that confirms each signature), and no signing key of
  the owner's may sit on the VPS;
- **through Thea**, when the owner taps "Approve" on her card. GitHub rejects an APPROVE from a
  PR's author, Apps included, and Thea's App opens nearly every PR she works on, so her hub
  (deterministic code: her session never holds the App key, D46) submits a review with event
  `COMMENT`, which authors may submit, pinned to the head SHA the card names (her A1a):

  ```bash
  gh api "repos/$REPO/pulls/$PR/reviews" -X POST \
    -f event=COMMENT -f commit_id="$HEAD_SHA" \
    -f body="talos-approve $CARD_ID $HEAD_SHA"
  ```

  `talos/review` counts it as the owner's approval only if it was submitted by Thea's App (on a
  public repository anyone can leave a COMMENT review, so the text alone proves nothing), after
  the PR's last push, on that head SHA, and with a card id. Any push after the okay voids it.
  The trust is the same as an APPROVE would carry: either way, the hub holds Thea's key. That
  holds only while the card is the one code path in the hub that submits reviews: every other
  tool of Thea's that writes to GitHub (comments, replies, issue text) refuses any text
  containing `talos-approve`, so a manipulated Thea can't approve through them.

Thea's approval never counts on a PR that touches a `protected` path, or in the Talos
repository. There, the owner approves on GitHub themselves (or authored the PR), so the
guardian's own rules and the gate that judges her can't be approved by proxy.

**Accepted risk:** Talos trusts the hub to approve only after the owner's card. Whoever controls
the VPS, and with it Thea's App key, can approve and merge in any governed repository outside
those exclusions, and Coolify deploys `main`. Accepted by the owner on 2026-10-22: the VPS is
theirs alone, and an attacker holding it would already hold Thea's hub, everything Coolify
deploys from it, and any machine whose daemon is connected at the time.

**Rejected:**

- a human approval on every PR (the weekly burn-down would queue behind one person);
- no human gate at all;
- device-signed approvals, where each paired device signs `{repo, PR, head SHA, time}` and Talos
  verifies the signature, so a compromised VPS could relay the owner's okay but never forge
  it (needs signing support in Thea's desktop, phone and browser apps);
- Thea's approval counting everywhere (it would reach her own risk rules and the gate);
- debt and chore PRs reaching any file outside the guard list (only an AI reviewer would read
  application code that changed without the owner).

### C17 · Releases ride two channels and promote themselves

**Decision:** releases are `vX.Y.Z` tags on `SVP-Labs/Talos`. The `talos-canary` and
`talos-stable` org rulesets each pin one tag's commit (`talos-evaluate` follows stable's);
repositories choose a channel through their `talos` property. Canary is Talos itself and Thea.

**Who can mint a release.** A repository ruleset on Talos restricts creating, moving and
deleting `refs/tags/v*` to the owner; Thea's App can write contents, so without it she could tag
any commit, including one that never passed review. Pins move only from jobs that run on
`main`: scheduled and manually dispatched jobs, and the `regression` rollback, which is an
`issues`-event job (issue events also run on the default branch, so the `main`-only release
environment accepts them). They never move from a tag push: a tag-triggered job runs on
`refs/tags/…`, which that environment rejects. Each run takes the
newest `v*` tag and moves canary's pin to it only if the tagged commit is an ancestor of `main`,
so a release is always code that passed the gate and the owner's review. The tag ruleset and
the ancestry check guard independently.

**Promotion.** A scheduled job moves stable's pin to a release seven days after it reached
canary, and `talos-evaluate`'s pin with it, provided all of these hold:

- no gate run on a canary repository ended in an engine error under that release (findings
  are normal; an engine error is a Talos bug);
- at least five gate runs happened on canary repositories under it (if not, the release waits:
  a quiet week proves nothing);
- no issue labelled `regression` is open on the Talos repository.

Opening a `regression` issue on the Talos repository also moves canary's pin straight back to
the previous release. Without that, a release that broke the gate would block the very PR
that fixes it, since Talos and Thea both run on canary. Only a `regression` issue opened or
labelled by the owner, Thea or a Talos App counts, for rollback and for blocking promotion
alike; C6 already keeps strangers from opening issues, and this keeps the rule safe if that
setting is ever loosened.

**Urgent releases.** A release that carries a security fix (a tool or runtime Talos pins, as
with php2shell in PHP itself) doesn't wait the seven days: the owner dispatches the promotion
job, which moves stable's and evaluate's pins as soon as canary has had one clean gate run
under it. Only the
owner can dispatch it; Thea's App has no `actions: write`.

Moving a pin needs org-administration rights, so the jobs run as a third App, `talos-release`,
whose key is an environment secret restricted to the Talos repository's `main`.

**Rejected:**

- manual promotion (one more thing to remember for every release);
- moving canary's pin from a tag-push trigger (the `main`-only environment rejects it, and
  allowing tags there would leave the tag ruleset as the only guard);
- no fast lane for security releases (stable repositories would run a vulnerable runtime for a
  week).

### C18 · Thea comes in first; Evaluate before Active

**Decision:** a repository always comes in with `talos: evaluate`, set by `talos govern` (C29),
whose ruleset runs in Evaluate mode: the gate runs and its results show on the Rule Insights
dashboard without blocking anything. Nothing enforces `talos/review` in that phase either, and
Thea arms auto-merge on every PR she marks ready (C14), so while a repository is at
`evaluate`, a second repository ruleset that `govern` writes requires the owner's approval. It
is a code-owner rule,
with `CODEOWNERS` naming only the owner (`* @SvenPGH`), because reports disagree on whether an
App's APPROVE counts toward a plain approval count; if `talos-reviewer`'s did, Thea's PRs would
auto-merge on a bot's word. A code owner can't be an App, so only the owner counts:

```json
{
  "type": "pull_request",
  "parameters": {
    "required_approving_review_count": 1,
    "require_code_owner_review": true,
    "dismiss_stale_reviews_on_push": true,
    "require_last_push_approval": true,
    "required_review_thread_resolution": false
  }
}
```

`OrganizationAdmin` has a bypass with `bypass_mode: "pull_request"` on that second ruleset
only, so the owner's own PRs merge without a self-approval, while the merge-queue ruleset (C14)
has no bypass at all and the owner's PRs still go through the queue. In this phase Thea's PRs
need the owner's
approval on GitHub; a card can't stand in for it, since only `talos/review` reads `talos-approve`
reviews and nothing enforces `talos/review` yet. Once the repository is green,
`talos govern --channel` moves its property to `canary` or `stable`, whose rulesets are Active,
and deletes the code-owner ruleset with its bypass, since `talos/review` now carries the gate
(C16). (A
ruleset is in Evaluate or Active mode as a whole, so per-repository switching needs its own
ruleset.) Adoption labels the repository's existing open issues `legacy`, so issue readiness
leaves the old backlog alone until someone rewrites an issue in the ticket format. The order:

1. Create the Talos repository, the three Apps and the rulesets. The first release tag seeds
   all three rulesets' pins (`talos-evaluate`, `talos-canary` and `talos-stable`) at once;
   after that, C17's jobs move them. Talos governs itself first; its test projects prove every
   check catches a seeded violation, for each language and OS. Three assumptions the docs don't
   confirm get a smoke test on a scratch repository before Thea comes in:
   - **`rulesets?includes_parents=true` lists org rulesets in Evaluate mode.** C3's version
     lookup depends on it. If it doesn't, `talos-release` also writes each channel's pinned
     SHA to a public `channels.json` on a dedicated `channels` branch of Talos, whenever it
     moves a pin. That branch is kept off `main`'s rulesets (they require the merge queue and
     the gate, which a pin move can't pass) and gets a ruleset of its own instead, blocking
     creation, update and deletion, with `talos-release` as its only bypass actor. Otherwise
     Thea's App, which can write contents on Talos, could point a channel at an older, genuine
     release: the provenance check would pass, and C25's caller would run `talos/review` at
     that version, with the reviewer's key, until the drift report noticed. Lookups then read
     the repository's `talos` property and that file, and the drift report checks the file
     against the rulesets.
   - **Apps can still open issues and PRs once creation is limited to collaborators.** C6
     depends on it for three Apps: Thea's, `talos-reviewer`, which files the security and debt
     issues in every governed repository whether agents are on or not (C28, C9), and
     Dependabot, whose PRs C11 relies on; if it were shut out, security updates would stop
     without any error. GitHub's changelog defines collaborators as users with write access and
     doesn't mention Apps. If Apps are excluded, no repository can keep the restriction, so C6
     drops it everywhere, and C6's trust rule and C17's trusted-`regression` rule carry the
     protection alone.
   - **An owner bypass on the code-owner ruleset lets the owner's own PR enter the merge
     queue,** whose ruleset has no bypass (C18). If it doesn't, the two rules share one
     ruleset while the repository is at `evaluate`, so the owner's bypass covers the queue
     too; that costs nothing in a phase where nothing is enforced, and ends at `--channel`.

   _Added 2026-10-23:_ three more assumptions, which Talos's code relies on, get a smoke test on
   the same scratch repository. [Setting Talos up](../setup.md), step 6, runs all six and says
   what to do when one fails:
   - **A ruleset's required workflow runs on `merge_group`,** so the gate judges the queue's
     commits (C3, C14).
   - **The gate's own `GITHUB_TOKEN`, with `contents: read` alone, can list a private
     repository's rulesets,** which C3's lookup reads inside the gate.
   - **The merge queue leaves `main` on exactly the commits its `merge_group` run tested,** so
     the gate's conclusion on `main`'s head commit says whether `main` is green (C31).

2. Thea's hub, in her own repository and before she comes in, gains everything Talos expects
   of her:
   - her pushes land freely on a `<P>-<N>` branch she holds the claim for (until now only
     `thea/…` branches did, so every push would wait for the owner);
   - claiming a ticket through a hub tool, and the hub handing each task the enforced Talos
     version, since tasks hold no GitHub credentials (C20);
   - `talos check --json` before each push, and on every squashed commit at ready (C20);
   - approval cards as `talos-approve` COMMENT reviews, with the card as the only code path
     that submits reviews and every other GitHub-writing tool refusing that marker (C16);
   - arming auto-merge when a PR is marked ready (C14), the queue's own daily budget (C13), and
     the new
     events (C20).

   Without these, the next step stalls.

3. Thea: every row of `docs/development/checks.md` maps to a Talos check. `ci.yml` and
   `mutation.yml` go; `desktop.yml` keeps only the installer build and release. The ~1,270
   decision citations in comments become findings in the debt list. Activating the ruleset also
   protects `main`, which today requires nothing.
4. Transfer the personal repositories into SVP-Labs, then bring in LoreLock (Python, a JS
   frontend in a subfolder, its two custom checks; black to ruff format, mypy to basedpyright,
   local-only gates to CI). A transfer moves more than the repository: Coolify's GitHub source
   for anything it deploys from one, Pages domains, webhooks and secrets, the remotes of clones
   on the desktop, and Thea's clones under `~/.thea/repos/<owner>/<name>` all need re-pointing.
5. The remaining repositories, the small ones and those generated from Scaffold. For the latter,
   adoption deletes the files Scaffold put there: the callers, `scripts/`, `justfile`, `.lang/`
   and `lefthook.yml`.
6. Archive Scaffold and Workflows once nothing calls `SVP-Labs/Workflows@v0` any more.

**Rejected:**

- a small repository first (cheaper bugs, but it proves little about strictness);
- every repository at once (findings to chase everywhere at the same time);
- building in phases, with Thea on a minimal gate first (repositories would come in sooner, but
  parts would be rebuilt as later phases arrive; Talos is built in full before Thea comes in).

### C19 · Custom checks report findings as JSON

**Decision:** a project check declared in `talos.yml` (`checks.<id>: { run, scope }`) prints
one JSON object per finding, `{rule, file, line, message}`. Talos fingerprints the findings and
compares them with the base commit like any other check (C9). LoreLock's `check_docs.py` and
`check_value_graph.py` gain a `--json` flag, and their baseline files are deleted.

**Rejected:** pass/fail by exit code (no comparison with the base commit is possible, so every
pre-existing violation would fail every PR).

### C20 · Talos judges, Thea does the work

**Decision:** Thea is the only implementer. Her tasks, on the VPS and the PC, take tickets the
way any agent would:

- she claims through her hub, which runs `talos ticket claim --agent thea` with her App, so no
  two runs ever hold one ticket. Her tasks hold no GitHub credentials (her G3), so nothing that
  talks to GitHub runs inside a task;
- she works on the ticket branch `<P>-<N>`, and her commits start `[P-N]:`;
- before her daemon pushes, the task runs `talos check --json`, so most fixes never wait on
  CI. The hub looks up the enforced Talos version (C3) and hands it to the task, so the check
  needs no API call of its own: reading rulesets on a private repository needs credentials the
  task doesn't have;
- she reads findings from the check run and its SARIF, not from logs;
- the three-try self-fix limit and the two review rounds bind her too;
- her tasks commit as they go, on a draft PR; before she marks it ready, her daemon squashes
  the task's commits, into one per acceptance criterion where the task kept them apart and
  into one otherwise. A squash can make a middle commit red even when the original series was
  green, so the task runs `talos check` on every squashed commit before the force-push and
  falls back to a single commit if any fails. That happens before review starts, so the
  force-push rewrites nothing anyone has reviewed.

Events she gains, beyond her G8: the Talos gate going red on her PR (with its findings), the
reviewer's verdict, and a canary engine error. A red `main`, a Sentry error or a new advisory
becomes an issue she files, claims and fixes.

Her own decisions this amends, each through an issue in her repository:

- G3: she pushes to the claimed `<P>-<N>` branch, not `thea/…`;
- G7: she arms auto-merge on each PR when she marks it ready, after the squash, instead of
  merging with `pr_merge`;
  the merge queue (C14) and `talos/review` (C16) decide when it lands;
- D8: a debt or chore PR that passes C16 lands without a card; a card can now also approve a
  PR on the owner's behalf, as a `talos-approve` COMMENT review (C16);
- G1: only her SVP-Labs App remains, once C2's transfers are done.

When Thea is down, nothing is implemented and the queue waits; the gate still holds.

**Rejected:**

- an Actions implementer, alone or as Thea's fallback (a second runtime, with its own limits,
  prompts and usage);
- agents in Actions with Thea only dispatching (duplicates her tasks, PRs and events).

### C21 · Architecture rules are written in each tool's own syntax

**Decision:** a project's rules live in its C10 extension file:
`.dependency-cruiser.project.cjs`, import-linter contracts in `pyproject.toml`, or
`deptrac.project.yaml`. The generated base adds the universal rules (no import cycles; shipped
code imports no test code and no dev-only dependency) wherever the language's tool can express
them. The architecture check always runs the universal rules, and the project's rules when it
has some; a violation is an ordinary finding (C8). LoreLock's grandfathered `ignore_imports`
entry goes, since C9 already treats that import as debt.

**Rejected:**

- generic layers in `talos.yml` (they express strict layering only, and can't say Thea's "the
  web app may use the hub's types but not its code");
- both (two places a rule could live).

### C22 · Thea works her own repository like any other

**Decision:** Thea's repository has agents switched on, under the same rules as every other
one, including C16's debt and chore exception. Her `protected` paths (her risk rules and her
gate) still need the owner on every PR. A change that stops the hub starting is caught by D40:
Coolify keeps the running version when the new one fails its health check. This replaces
Thea's D34 (no self-improvement in v1), through an issue and brief in her repository.

**Rejected:**

- keeping her out of her own repository until previews and the validation agent (D24 to D26)
  exist;
- making her whole repository protected, so every change waits for a card.

### C23 · The owner creates a project; Thea fills it

**Decision:** a project starts as a conversation with Thea, which she writes up as its brief.
The owner then runs `talos new <Name>` with their own GitHub login. It creates the repository in
SVP-Labs and runs `talos govern` on it (C29), which, among the rest, sets `talos: evaluate`.
The ticket prefix must be unique across the org, so `talos new` refuses one already in use;
Talos itself takes a prefix other than Thea's `T`. Thea's task then runs `talos adopt` on the
repository, which writes `talos.yml`, the generated configs, `CLAUDE.md`, the issue forms, the
brief and issue #1, and opens the bootstrap PR; that PR touches `talos.yml` and `.github/`, so
it needs the owner's approval on GitHub, through the code-owner rule a repository at `evaluate`
has (C18). She then files the epic and its tickets from the brief and works
them. No automated identity gains the right to create a repository.

**Rejected:**

- Thea asking Talos to create it (her App would need `actions: write` on the Talos repository,
  which would also let her start or cancel Talos's own workflows);
- Thea's App creating repositories (administration rights on every repository, deleting
  included);
- GitHub's template-repository feature (it would copy Talos's engine into every project).

### C24 · `talos.yml`

**Decision:** one file at the repository root, written by `talos adopt` from the manifests it
finds and edited by hand afterwards. Changes to it need the owner (C16).

```yaml
name: Thea
prefix: T
components: # one per language and root; os defaults to linux
  - { lang: ts, root: . }
  - { lang: rust, root: apps/desktop, os: [linux, windows] }
exclude: [] # committed generated or vendored code (LoreLock: [app])
tests:
  full: [apps/web/e2e] # runs at the PR's head; every other test runs per commit
services: # started by the gate; images pinned by digest
  postgres: { image: 'pgvector/pgvector:pg17@sha256:…', env: { POSTGRES_USER: thea } }
setup: .github/talos-setup.sh # one project script, run before the checks
mutation: [packages/shared/src/risk, apps/hub/src/gate.ts]
size: .size-limit.json
licences: { MPL-2.0: lightningcss, OFL-1.1: Geist fonts } # beyond the org allowlist, with reasons
docs: { glossary: docs/glossary.md, briefs: docs/requirements }
protected: [packages/shared/src/risk/**, apps/hub/src/gate.ts]
checks: {} # custom checks (C19)
agents: { max_claims: 2 }
supply_chain: # C27; every entry has a reason and an expiry
  allow: {} # young releases, e.g. "pkg@1.2.3": { reason: "…", expires: 2026-10-30 }
  exceptions: {} # advisories, e.g. "GHSA-xxxx-xxxx-xxxx": { reason: "…", expires: 2026-11-15 }
```

Tool options stay in the C10 extension files and architecture rules in the tools' own syntax
(C21), not here.

**Rejected:** services taken from the project's `docker-compose.yml` (it starts the app's own
services too, and its images aren't pinned by digest).

### C25 · One caller file runs everything that isn't the PR gate

**Decision:** the ruleset gate covers only `pull_request` and `merge_group`, and it holds no
secrets, so `talos govern` commits one more workflow (C29), `.github/workflows/talos.yml`, into each
repository:

```yaml
on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review]
  merge_group:
  issues:
  issue_comment:
  pull_request_review:
  schedule: [{ cron: '17 3 * * *' }]
  workflow_dispatch:
```

_Added 2026-10-23:_ the caller also takes `pull_request_target`'s `edited` type, beyond the
gate's, so fixing a PR's body (its `Closes #N` or a section) reruns `talos/review`.

It does one thing: run `talos job <event>` at the version the repository's rulesets enforce,
found the way local runs find it (C3). Issue readiness, the reviewer, `talos/review` (on every
push, review and merge group), the weekly debt job, the stale-claim sweep and label sync all run
inside that one call; the daily schedule lets each scheduled job decide whether it is due. The
file therefore never changes between releases. It sits under `.github/`, so a change to it needs
the owner (C16), and Thea's App can't write it at all (C15).

`pull_request_target` runs the caller as it is on `main`, with the reviewer's key, so a PR can't
change what reads its own diff. That is also why the job never checks out or executes the PR's
head: it reads the diff and the files through the API only. `merge_group` is different: there,
both the caller and `talos.yml` come from the group's head, so a PR in the queue runs its own
versions of them with the reviewer's key. What guards that is the owner: both files are on
C16's guard list, so a PR that changes either reached the queue only with the owner's approval.

On `issue_comment` and `pull_request_review`, a stranger can trigger the caller on a public
repository. The job exits before any model call, and before using the reviewer's key, unless the
event's author is the owner, a member or a collaborator (C6).

**Rejected:**

- one caller per job, each pinned to a Talos tag (every release would change files in every
  repository, and no App may write workflow files);
- running these jobs on Thea's hub (deterministic checks would depend on Thea being up, and the
  reviewer must stay off her machines);
- a caller without a PR trigger (`talos/review` would never report on an opened or pushed PR,
  and every PR would stall);
- running the reviewer in the gate (the gate holds no secrets and executes PR code).

### C26 · How Talos and its tools reach a machine

**Decision:**

- **The engine** is published as an npm package on every release tag, `@svp-labs/talos@X.Y.Z`,
  from the release workflow through npm's trusted publishing, so no npm token is stored, and
  with provenance proving it was built from the Talos repository at that tag. A pin is always
  a release-tag commit, so the version is the one in `package.json` at that commit; the gate,
  `talos` on Thea's machines (handed over by her hub, C20) and the owner's all resolve it that
  way, run it with `npx`, and refuse a package whose provenance names any other commit (C3).
- **The outside tools** (gitleaks, osv-scanner, semgrep, shellcheck, hadolint, actionlint and
  the rest) are listed in `tools.lock` in Talos: version, download URL per OS, checksum. Talos
  downloads them into a cache and refuses any file whose checksum doesn't match.
- **The language tools a project's editor also uses** (eslint, prettier, ruff, basedpyright and
  the like) are pinned by `talos adopt` in the project's dev dependencies at Talos's versions,
  and the gate checks they still match, so the editor and the gate always agree.

**Rejected:**

- a bundled file attached to each GitHub release (Talos would have to verify what npm's
  provenance already proves);
- mise (one more thing to install first, on every machine);
- the gate bringing its own copies of the language tools (the editor could show different
  results).

### C27 · Supply-chain rules, with a fast lane for security fixes

**Decision:** every repository:

- installs only releases at least a day old;
- allows no git or tarball dependency anywhere in its dependency tree;
- stops an install when a package's provenance is weaker than its earlier releases';
- holds every vulnerability exception to a reason and an expiry date, after which it fails
  again. Exceptions live under `supply_chain.exceptions` in `talos.yml` (C24), from which Talos
  generates each scanner's own ignore file (C10), such as `osv-scanner.toml`.

Each package manager's own settings carry these where it has them; where it doesn't, Talos
checks the lockfile against the registry.

The fast lane: a release younger than a day is allowed when it is the fixed version of an
advisory that affects the version it replaces, so an urgent security fix never waits. Any
other young release needs an entry under `supply_chain.allow` in `talos.yml`, with a reason and
an expiry of at most seven days. Both `talos.yml` and lockfiles need the owner (C16).

**Rejected:**

- the guards for Thea only;
- no fast lane (a fix published today would wait a day while the vulnerable version stays
  installed);
- permanent vulnerability ignores.

### C28 · Runtimes are checked against their vendors' release feeds

**Decision:** C27 covers packages installed from a registry. php2shell (CVE-2026-109618 and
-109619, fixed on 2026-10-21 in PHP 8.5.12, 8.4.27, 8.3.36 and 8.2.35) was in PHP itself, which
the official images build from source. So Talos checks the runtime versions a repository
declares, against the vendors' own feeds:

- **What it reads:** each Dockerfile's `FROM` line, version files (`.nvmrc`, `.node-version`,
  `.python-version`, `rust-toolchain.toml`, the `toolchain` line in `go.mod`), and the runtimes
  in Talos's own `tools.lock`. `config.platform.php` in `composer.json` is not a runtime: it is
  the version Composer resolves dependencies against, often deliberately the lowest patch a
  project supports, so it is read as a declared minimum and never produces a `runtime/security`
  finding; the PHP a project ships is the one in its Dockerfile. A repository that ships no
  runtime of its own (no Dockerfile) is checked only through `tools.lock`.
- **What it compares against:** endoflife.date for every runtime (each cycle's latest patch and
  end of life), plus the vendor's own security flag where one is published: php.net's release
  feed tags security releases, and nodejs.org's `index.json` marks them `security: true`.
- **The findings:**
  - `runtime/security`: a newer patch in the same cycle is a security release;
  - `runtime/eol`: the cycle is past end of life;
  - `runtime/unpinned`: no exact patch is pinned (a floating tag like `php:8.4-fpm`, or a
    version range), so nothing can be checked.

A `runtime/security` finding blocks every PR in its repository until it is fixed (C9);
`runtime/eol` and `runtime/unpinned` are ordinary findings.

The check runs in the gate on every PR, and also hourly, centrally from the Talos repository
as `talos-reviewer`, across every governed repository: a new security release in the morning
can't wait for someone to push. The sweep keeps C15's token scoping: a first step lists the
governed repositories through the organisation's custom properties, with a token that holds
that organisation permission alone and reaches no repository, then a matrix job mints one token
per repository, limited to it and to the two permissions the sweep needs:

```yaml
- uses: actions/create-github-app-token@v2
  with:
    app-id: ${{ vars.TALOS_REVIEWER_APP_ID }}
    private-key: ${{ secrets.TALOS_REVIEWER_KEY }}
    owner: SVP-Labs
    repositories: ${{ matrix.repo }}
    permission-contents: read
    permission-issues: write
```

The sweep files one `security` issue (priority p0, deduplicated)
in each affected repository, which reaches Thea as an event; she fixes it at once, outside her
daily budget (C13). A finding against `tools.lock` lands in Talos itself, and its release takes
C17's urgent path. Dockerfiles and version files join C16's guard list, so a runtime bump is one
tap on Thea's card. Dependency advisories need no second sweep: `talos govern` switches on
Dependabot alerts (C29), which her G8 already turns into events.

**Rejected:**

- scanning built images as the primary check. Syft can identify a PHP built from source (its
  `php-cli-binary`, `php-fpm-binary` and `php-apache-binary` classifiers, in its PHP interpreter
  cataloger), but declared versions can be checked without building an image, the vendors'
  feeds flag a security release the hour it ships, and a scanner's PHP matches go through CPE
  data, which trails the vendor;
- relying on Dependabot (its alerts don't cover runtime versions in Dockerfiles);
- a daily sweep from each repository's caller (up to a day's delay on an actively exploited
  runtime).

### C29 · `talos adopt` writes files; `talos govern` applies settings

**Decision:** bringing a repository in is two commands, split by the rights they need.

- **`talos govern`** runs as the owner, with their own GitHub login, because every step needs
  administration rights no App holds. It:
  - commits the caller (C25) and `CODEOWNERS` (`* @SvenPGH`) straight to the default branch,
    signed by the owner, before any ruleset exists, since no App may write workflow files
    (C15) and a PR's own caller never runs on that PR (`pull_request_target` uses the one on
    `main`);
  - creates two repository rulesets: the merge queue (C14), with no bypass; and, while the
    repository is at `evaluate`, the code-owner approval rule with the owner's bypass (C18);
  - restricts issue and PR creation to collaborators (C6);
  - switches on Dependabot alerts (C28);
  - sets the `talos` property to `evaluate` and `talos-agents` as asked, and adds the
    repository to the Thea, reviewer and `talos-release` App installations (the last so the
    drift report can mint its per-repository token);
  - later, with `--channel canary` or `--channel stable`, moves the property and deletes the
    code-owner ruleset with its bypass.

  Where GitHub's API doesn't expose a setting, `govern` prints the manual step instead.

- **`talos adopt`** writes files and labels issues, and touches no repository setting, so Thea
  can run it: `talos.yml`, the generated configs,
  `CLAUDE.md`, the issue forms, the labels, the brief and issue #1, in one bootstrap PR. It
  marks the repository's existing open issues `legacy` (C18). Because `govern` has already put
  the caller on `main`, the bootstrap PR gets `talos/review` like any other.
- **Drift:** a weekly job compares every governed repository's settings with what `govern` would
  set and files an issue for each difference. It runs centrally from the Talos repository as
  `talos-release`, with one read-only token per repository (C28's pattern, with
  `permission-administration: read`), so the reviewer keeps its narrow permissions.

`talos new` is repository creation followed by `talos govern`. Every existing repository
(Thea, LoreLock, the CoE5 ones) comes in through `govern`, then `adopt`.

**Rejected:**

- one `adopt` doing both (Thea's App has no `administration` permission, so every existing
  repository would end up with no merge queue rule, no creation restriction and no Dependabot
  alerts);
- giving Thea's App `administration` (it includes deleting repositories);
- the caller arriving in the bootstrap PR (Thea's App can't write workflow files, and the PR
  would get no `talos/review` from it).

### C30 · Talos's public runs never name a private repository

**Decision:** the central jobs (C28's sweep, C29's drift report, C17's promotion and rollback)
run in the public Talos repository, whose runs anyone can read. So:

- the matrix carries indices only, never names, and its jobs are named by index
  (`name: sweep-${{ strategy.job-index }}`). GitHub prints a step's script with every
  `${{ }}` already filled in, and prints its `env:` block too, so a repository name may never
  pass through an expression: `echo "::add-mask::${{ matrix.repo }}"` would leak the name in the
  very line meant to hide it;
- each job's first step looks its repository up by index inside the script (listing the
  governed repositories, those whose `talos` property names a channel, through the
  organisation's custom properties, with a token that holds that organisation permission alone
  and reaches no repository: `talos-reviewer`'s for the sweep, `talos-release`'s for drift and
  promotion) and masks the name
  (`::add-mask::`) before printing anything. Later steps then show it masked, including
  `create-github-app-token`'s `repositories` input, which reads it from that step's output;
- a self-test keeps it that way: a scratch repository with a unique canary name is always in
  the matrix, and Talos's own CI fails if that name appears anywhere in a run's logs, and each
  App proves it can see the canary with a token minted for the canary alone, found by the digest
  of its name;
- tool output is captured, never echoed: no finding, path or repository name reaches the log,
  an annotation, the job summary or an artifact, and only counts are printed;
- errors from git and `gh` are captured and replaced by a generic line, since their messages
  name the repository;
- findings go only into issues in the affected repository, and promotion reads gate results
  without printing them.

**Accepted risk:** one uncaptured message from one of these jobs puts a private repository's
name into a public log, readable until the run is deleted.

**Rejected:** a private `Talos-ops` repository for the central jobs, with only the gate
workflow staying public (structurally safer, since nothing printed there can leak, but a second
repository to keep).

### C31 · `talos status`: state is queried, never remembered

_Added 2026-10-23._

**Decision:** `talos status --json` returns each governed repository's current state as one
compact object (`talos.status/1`): its channel, whether `main` is green or red (the gate's last
conclusion on `main`'s head), its open claims, each open PR's stage (`draft`, `ready`, `queued`)
with its gate and `talos/review` states, its open security issues, its debt count and its last
drift report. Lists are capped and counted. Everything comes from GitHub, where Talos already
keeps it. Thea's hub serves it as her `talos_status` tool, run with her App's token, and adds the
approval cards waiting on the owner, which only the hub knows.

**Rejected:** Thea keeping this state in memory (it goes stale within hours, as her N3 snapshots
do), or per-repository lookups she assembles herself (each costs her context).

### C32 · Events carry enough to act on

_Added 2026-10-23._

**Decision:** every event C20 adds names the repository and the PR and carries its findings
summarised, so one event leads to one decision without loading anything else:

- the gate uploads `verdict.json` (`talos.verdict/1`, at most 20 findings listed, the rest
  counted by rule) as the artifact `talos-verdict`; a red gate becomes an event with it, and Thea
  hands it to a task;
- the reviewer's review opens with a machine-readable line
  (`talos-review/1 verdict=REQUEST_CHANGES round=1 findings=3`), so a REQUEST_CHANGES becomes an
  event for the next round with the findings listed;
- a security issue opens with `talos-security/1` and its priority, so a `p0` jumps her budget
  (C28);
- a canary engine error carries the release and the failing check.

**Rejected:** events that only point somewhere (Thea would load logs to decide anything).

### C33 · Agent-facing output is compact

_Added 2026-10-23._

**Decision:** every Talos command an agent runs has a `--json` form that prints capped JSON:
lists cut at a fixed length with a total, messages clipped, and never a tool's raw output, which
stays in files and artifacts (the SARIF, the run results) where a task can read it when it needs
to. Thea's hub tools that wrap Talos return that JSON as it is.

**Rejected:** printing tool output for the agent to read (most session bloat is long command
output, such as repository listings and CI logs).

### C34 · Less memory, not more

_Added 2026-10-23._

**Decision:** lasting things (the owner's decisions and preferences, what each project is for)
stay Thea's core memory entries. Anything Talos can answer at any time (which PRs are open, what
is red, who holds a claim) never becomes memory, and her handoff says "in-flight work: check
`talos_status`" instead of listing it. _Amended 2026-10-23:_ that line covers only what Talos
can answer (claims, PRs, red checks, the queue, debt); the handoff still names in-flight work
outside governed repositories, which `talos_status` can't see: background jobs on the owner's
machines, pod and render runs, tasks in scratch folders, threads in the owner's life. Her prompt
(`persona.ts`) carries one stanza per Talos event type, and `changes.ts` tells her about each
new tool once (her repository's rule for tools).

**Rejected:** a Talos manual in her prompt; snapshots of in-flight work in memory; pointing
the whole handoff at `talos_status` (it sees only governed repositories, so work anywhere else
would be lost between sessions).

## Open

Nothing. Read end to end and settled with the owner on 2026-10-23.
