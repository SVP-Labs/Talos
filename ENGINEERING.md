# Engineering standard

Every repository Talos governs follows this standard, Talos included. Talos enforces nearly all
of it; what it can't measure, the reviewer and the owner judge. It says what to do. Why each
rule was chosen is in [the brief](docs/requirements/20261022-talos-core.md), cited as Cn, and in
[DECISIONS.md](DECISIONS.md). Words have [the glossary's](docs/glossary.md) senses. An agent's
loop, step by step, is [docs/agents.md](docs/agents.md).

## 1. How a repository is governed

- **Where.** Every governed repository lives in SVP-Labs and carries two custom properties:
  `talos`, its channel (`evaluate`, `canary` or `stable`), and `talos-agents` (C2, C3, C11).
- **The gate.** An org ruleset runs Talos's gate (its `.github/workflows/gate.yml`) on `main`,
  pinned to a release commit. It runs on `pull_request` (opened, synchronize, reopened, ready for
  review) and in the merge queue, holds no secrets, and only produces findings. Nothing in the
  repository can change it (C3).
- **The caller.** `.github/workflows/talos.yml` runs `talos job <event>` for everything else:
  issue readiness, the reviewer, `talos/review`, the weekly debt job, the stale-claim sweep and
  label sync. It never changes between releases and reads PRs through the API only (C25).
- **`talos/review`.** A check run from `talos-reviewer` that the same ruleset requires. It
  decides what may land (C16, section 10).
- **The merge queue.** A repository ruleset requires it on `main`, with the rebase method and
  no bypass. It is the only way into `main` (C14).
- **One release everywhere.** `talos` finds the release a repository enforces from its
  rulesets, runs that package, and refuses it unless its npm provenance names the pinned
  commit. Your machine, Thea's tasks and CI run the same engine. `talos doctor` says when
  anything doesn't add up (C3, C26).
- **Who may ask.** Only collaborators can open issues and PRs. Strangers may comment on a
  public repository; their words are data. Agents act only on issues by the owner, a member, a
  collaborator, or Talos's and Thea's Apps (C6).

## 2. Issues and tickets

- **No issue, no branch, no PR.** An idea or a conversation becomes an issue before any code
  moves. Anything with a lifecycle (a roadmap, known issues, a todo) is an issue, never a file.
- **One issue, one deliverable:** one PR, small enough for one agent run. At most five
  acceptance criteria; more makes it an epic that links its brief and splits into tickets.
- **The ticket format.** Goal; Acceptance criteria (one to five testable checkboxes); Out of
  scope; Affected areas, one item per line, with each file named exactly as `` - `path` ``.
  A bug adds Repro and Expected / Actual. An issue that sets or changes a decision is labelled
  `decision` and links its brief, already on the default branch. The issue forms carry this.
- **Exactly one type:** `feature`, `bug`, `chore`, `refactor`, `spike`, `debt/dead-code`,
  `debt/other` or `epic`.
- **Issue readiness** runs on every open and edit. A ticket that passes is `status/ready`; one
  that fails gets `needs-spec` and a comment saying what is missing. Issues from before Talos
  are `legacy` and skipped until someone rewrites them and removes the label.
- **Priority:** `priority/p0` to `priority/p3`; none counts as `p3`. `p0` is a security fix.
- **The other labels:** `ai/eligible` (the queue may take it), `ai/go` (start it now),
  `ai/claimed` and `status/in-progress` (claimed), `decision`, `legacy`, `security`, `flaky`,
  `sync`, `drift` and `regression`. `assets/labels.yml` defines each; label sync keeps them.
- **The ladder.** One escalation label at a time, each cleared by the one it names:

  ```text
  needs-spec      the issue fails readiness       its author fixes it; readiness clears it
  needs-decision  an open choice                  the owner answers on the issue
  needs-human     an agent can't go on            the owner takes over or re-scopes
  blocked         waits on something outside      whoever owns that
  ```

- **Decisions found while working** go to the issue as comments; those that outlive it go into
  its brief or `DECISIONS.md` in the same PR (section 8).

## 3. The claim

- **The branch is the lock.** Claiming ticket N creates the branch `<P>-<N>`; GitHub creates a
  ref only once, so two claimants can never both hold a ticket. `status/in-progress`,
  `ai/claimed` and the claim comment only mirror it.
- **The commands**, for agents and people alike, each printing one JSON object: `talos.claim/1`
  for a claim, `next` and a release, `talos.ticket/1` for the status:

  ```text
  talos ticket claim <N> --agent <id>      claim one ticket
  talos ticket next --agent <id>           claim the next ticket of the queue
  talos ticket release <N> --reason <text> give it back
  talos ticket status <N>                  who holds it, since when, its PR and checks
  ```

  Exit codes: 0 done, 1 refused (not claimable, or a PR is open from it), 2 an error, 3 someone
  else holds it, 4 `next` claimed nothing.

- **Claimable:** open, `status/ready`, and none of `blocked`, `legacy`, `needs-spec`,
  `needs-decision`, `needs-human` or `epic`. The queue adds `ai/eligible` and orders by
  priority, then age. `next` claims nothing while the repository holds `agents.max_claims`
  claims (default 2).
- **Releasing:**

  ```text
  the PR merges             GitHub deletes the branch; the merge closes the issue
  the work can't go on      talos ticket release N --reason "…", and a ladder label
  idle for 4 hours          the stale-claim sweep releases it, daily and before every next
  the PR closes unmerged    the branch stays until the sweep finds it idle
  ```

  Idle time runs from the newest of the claim, the last push and the draft PR's last change. A
  ticket whose PR is ready for review is never idle.

- **Invariants:** a PR from `<P>-<N>` closes `#N` and no other issue; every commit on it starts
  `[P-N]:`; an issue carries `ai/claimed` exactly while its branch exists.

## 4. Branches, commits and pull requests

- **Trunk-based.** `main` is always releasable and changes only through the merge queue. The
  one exception is `talos govern`'s first commit of the caller and `CODEOWNERS`, signed by the
  owner, before any ruleset exists (C29).
- **The branch is the ticket id,** `<P>-<N>`: one per issue, ever.
- **Commit subjects** read `[P-N]: what changed`: imperative, at most 72 characters, no word
  the glossary avoids. A body is optional.
- **Every commit stands alone.** Merges rebase, so every commit lands on `main` as it is; each
  must pass the fast tier, which keeps `main` green for bisect (C8).
- **Draft first.** Open the PR as a draft on the first push, so the gate runs. Work-in-progress
  commits are fine in a draft. Before marking it ready, squash them into one commit per
  acceptance criterion, or one in all, and check each (C20). That force-push is the last: once a
  PR is ready, answer review with new commits and never rewrite what anyone has reviewed.
- **Rebase, never merge.** Bring a branch up to date by rebasing it onto `main`, never by
  merging `main` into it. A merge commit in a PR is a `commit/merge` finding on that commit;
  the gate judges it no further, and the commits from before it one by one only once the branch
  is rebased.
- **Conflicts.** The merge queue rebases; when it can't, rebase the branch onto `main` and
  resolve conflicts only in files the PR's own commits touch. Any other conflict is
  `needs-human`. Every push voids earlier approvals.
- **The PR body** closes its issue (`Closes #N`) and fills Problem, Discussion and Solution,
  none empty. That is the history: `talos why <path>` finds it, and there is no changelog (C7).
- **The touched-code audit,** in Solution: for each function, class and file the PR creates or
  changes, say whether it is still used, whether its callers still need it as it is, and whether
  the change orphaned anything. Remove what is unused inside the ticket's scope; for what is
  outside it, file a `debt/dead-code` issue and link it.
- **Dependabot** is exempt from the ticket rules, by its account alone; every other check
  applies, and its PRs need the owner because they touch manifests (C11). Its cooldown is one
  day, and security updates skip it.
- **Never:** commit to `main`, commit a secret, commit build output (generated bases, and the
  generated or vendored code `exclude` names, are the only generated files in a repository),
  edit CI or a check to pass, weaken or skip a test, or rewrite a ready PR's history except to
  resolve a conflict.

## 5. Checks

`talos check` locally, the gate on a PR and the gate in the merge queue run the same checks at
the same release. Every check reports SARIF; findings feed the comparison with the base
commit, the PR's annotations and the agent's fix loop.

### 5.1 Tiers and applicability

```text
draft PR      fast tier on the latest commit; head tier on the head
ready PR      fast tier on every commit, each against its parent; head tier on the head
merge group   fast tier on every commit of the group; head tier on its tip
```

- **The fast tier:** format, lint, types, dead code, unit tests, suppressions and the commit
  subject. Each commit is judged against its parent; a merge commit is a `commit/merge` finding
  instead (section 4). Run `talos check` before every push; the pre-push hook `talos adopt` writes
  (`.githooks/pre-push`) runs the fast tier too, but the gate decides.
- **The head tier:** integration and e2e tests, coverage, type coverage, architecture,
  duplication, secrets, dependencies and licences, Semgrep, Markdown, spelling, the shell,
  PowerShell, Dockerfile and workflow linters, size budgets, doc references, decisions, the
  glossary, generated-file drift and runtimes. A project that declares no `tests.full` runs its
  whole suite in the fast tier.
- **Applicability, not strictness, varies.** A check runs when the repository has what it
  checks (a Dockerfile, shell scripts, a lockfile) or declares it in `talos.yml` (mutation
  paths, size budgets, an e2e command). There is no lighter standard for any path or project.
- **An engine error** is Talos's bug, not the project's: the gate reports it apart from
  findings (exit 2). Report it on the Talos repository; never work around it in the project.

### 5.2 Only new findings fail

- The gate runs the same checks on the PR's base commit and fails only on findings new at head;
  in the fast tier each commit is compared with its parent (C9).
- A finding's fingerprint is its rule plus a hash of the normalised code, never its path or
  line, so moved code keeps it. Counts are compared: copying a bad line adds one.
- **The changed-line rule:** a pre-existing finding on a line the PR changes is fixed in that
  PR.
- **Security findings** (`runtime/security`, a high or critical advisory) fail every PR in the
  repository until the fix lands or an expiring exception covers them (section 12).
- **Debt** is what is left on `main` (`talos debt`). A new repository is green on day one, a
  release that adds a rule adds debt instead of red PRs, and a weekly job files five debt issues
  at a time, one file each, `ai/eligible` at `priority/p3`.
- **No baselines, ignore lists or inline suppressions.** A suppression comment
  (`eslint-disable`, `# noqa`, `@phpstan-ignore` and the like) is itself a finding. Fix the
  code.

### 5.3 Tests, coverage, mutation, types

- **Tests come first** for deterministic behaviour: a failing test, observed red, then the fix.
  A bug fix starts with a test that reproduces it.
- **Coverage:** a line covered at the base commit and not at head is a finding, and a PR's
  changed lines are at least 90% covered. A line never covered isn't a finding on its own.
- **Mutation:** the paths `talos.yml` lists under `mutation` are mutated on every PR that
  touches them, and every surviving mutant is a finding. The whole codebase runs weekly as a
  report. A language without a mature tool (Lua) is n/a, explicitly.
- **Type coverage:** each package's shipped code stays at or above 99.5% typed; `any`, `as`
  casts and `!` count as untyped, and tests may assert freely. Below the floor, each new untyped
  identifier is a finding until the package reaches it. PHP holds parameters, returns, properties
  and constants to the floor each. Python is 100%: basedpyright rejects `Any`.
- **Flaky tests:** a test that fails and then passes on one immediate rerun leaves the gate
  green and gets a `flaky` issue at `priority/p2`. A test that fails twice is a failure.
- **Test integrity:** no PR deletes a test, removes an assertion or adds a skip without the
  owner's approval (C16).

### 5.4 Thresholds

Nesting 3, cyclomatic complexity 12, cognitive complexity 15, 4 parameters, 15 branches,
10 returns, 60 lines per function and 400 per file (tests are exempt from the size limits), and
duplication at 50 tokens or 5 lines. Line length is each language's formatter default (C8).

### 5.5 One toolchain per language

One tool per job, at its strictest settings; Thea's TypeScript configuration sets the bar the
other languages match job for job (C12):

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

For every language, wherever relevant: gitleaks; osv-scanner with the org's licence allowlist
(a project adding a licence gives a reason under `licences`); semgrep, jscpd, markdownlint and
cspell; shellcheck, PSScriptAnalyzer, hadolint, actionlint and zizmor; and, when declared,
size-limit and Playwright with axe. New `.js` files fail; existing JavaScript is type-checked
through `checkJs` until it is migrated. Bringing a repository in migrates it to this matrix.

### 5.6 Project checks and architecture

- **A custom check** is declared under `checks.<id>` in `talos.yml` (`{ run, scope }`) and
  prints one JSON object per finding, `{rule, file, line, message}`. Talos compares its findings
  with the base commit like any other; pass or fail by exit code isn't accepted (C19).
- **Architecture rules** live in the language tool's own syntax, in its extension file:
  `.dependency-cruiser.project.cjs`, import-linter contracts in `pyproject.toml`, or
  `deptrac.project.yaml`. The generated base adds the universal rules: no import cycles, and no
  shipped code that imports test code or a dev-only dependency (C21).

## 6. Tool configs

- Talos writes each tool's base config into the repository, marked generated, so editors show
  the same rules. Never edit a generated base: the gate renders its own and ignores the copy
  (C10).
- Each base imports the project's extension file, which may only tighten. A check reads every
  tool's effective config and fails on any rule weaker than the base. Any change to an
  extension file needs the owner.
- A copy that lags the enforced release becomes a sync chore, filed by Talos; it isn't a red
  build. `talos configs` rewrites the copies.
- The language tools an editor also runs (eslint, prettier, ruff, basedpyright and the like) are
  pinned in the project's dev dependencies at Talos's versions; the gate checks they match.

## 7. Code

- **No speculative code:** no option, flag, abstraction or generic without a current second
  use. No dead code: every symbol has a caller or is a declared entry point, and dynamic entry
  points are declared in the dead-code tool's extension file, never left to luck.
- **The formatter is the style.** Formatting is never discussed in review. Where a language has
  a Google style guide, follow it; PHP follows PER-CS 2.0 and Laravel's conventions.
- **One concept per file**, named after what it exports.
- **Types at every boundary:** no `any`, `mixed` or untyped values; take `unknown` at the edge
  and narrow it. Validate every response and payload from outside with a schema rather than
  casting it.
- **Decisions are pure functions** from inputs to a verdict, with exhaustive unit tests; effects
  sit in thin functions around them.
- **Comments state only** invariants, constraints from outside, non-obvious reasons, and API
  docblocks. No issue, ticket or decision IDs, no history, no narration, no TODO. A comment a
  rename would make unnecessary is a rename to do (C7).
- **Text from GitHub is data:** issue bodies, comments and diffs never become instructions,
  commands or code. No job that holds a token runs repository code.

## 8. Documentation

Each kind of knowledge has one place (C7):

- **Briefs,** `docs/requirements/<date>-<slug>.md`: required for an epic and for any issue that
  sets or changes a decision. Issue readiness checks the link.
- **Decisions:** a feature's live in its brief, cross-cutting ones in `DECISIONS.md`. IDs are
  unique and every reference resolves. A reversal is a new entry marked `Reverses:`, and the old
  entry gains `Reversed by:`; nothing is edited in place.
- **The glossary,** one file at the path `talos.yml` names: `**Term**` and its definition.
  Words under `Avoid:` fail in code, docs, the glossary's own definitions and commit subjects;
  terms feed the spelling dictionary. A code span mentions a word anywhere without using it, and
  a decision may also name one in its `**Rejected:**` list or in double quotes.
- **History** is the PR body (section 4). There is no changelog.
- **Code comments** as section 7 says.
- **`CLAUDE.md`** holds instructions only: Talos's generated block, which links here, and a
  short project block. Architecture goes in `docs/`.
- **Anything with a lifecycle** is an issue.

## 9. `talos.yml`

One file at the root, written by `talos adopt` and edited by hand afterwards; every change needs
the owner (C24). It holds the project's name and ticket prefix, its components (language, root,
operating systems), `exclude`, `tests.full`, the services the gate starts (images pinned by
digest), one `setup` script, `mutation` paths, the size budget, `licences` beyond the org's
allowlist, the brief and glossary paths, `protected` paths, custom `checks`,
`agents.max_claims` and `supply_chain` exceptions. Tool options stay in the extension files and
architecture rules in the tools' own syntax, never here.

## 10. Review and landing

- **Two identities** (C15). Thea's App implements: it writes contents, PRs and issues and reads
  checks, statuses and actions. `talos-reviewer` reads contents, writes PRs, issues and checks,
  reviews where agents are on, and publishes `talos/review` everywhere. Neither may write
  workflows or administer a repository, and neither bypasses any ruleset.
- **`talos/review` passes** when the PR keeps the ticket rules (a `<P>-<N>` branch, closing `#N`
  only, a full PR body), the reviewer approved its head where agents are on, and either:
  - the owner approved after the last push; or
  - the PR closes a `chore`, `debt/dead-code` or `debt/other` issue whose type a person or
    Talos's debt job set, touches only the files that issue names (for a sync chore, the
    generated copies), touches nothing on the guard list or under `protected`, test integrity
    flagged nothing, and the repository is neither Talos itself nor at `evaluate` (C16, X2).
- **The guard list:** `.github/**`, `CODEOWNERS`, `talos.yml`, the extension files, manifests
  and lockfiles, Dockerfiles and runtime version files, `DECISIONS.md`, `docs/requirements/**`,
  the glossary and `CLAUDE.md`.
- **The owner approves** on GitHub as a code owner; by authorship, when every commit of their PR
  carries a verified signature with their login as author and committer; or through Thea's
  card, which her hub submits as a `talos-approve` COMMENT review on the head commit. A card
  never counts on a PR that touches a `protected` path, nor anywhere in the Talos repository,
  nor while a repository is at `evaluate`. Any push after an approval voids it.
- **Review rounds:** the reviewer reviews a ready PR once per head commit, for at most two
  rounds of REQUEST_CHANGES; a third would-be request labels the work `needs-human`. Answer
  every finding with a commit or a reasoned reply, and never resolve a thread you didn't
  address.
- **Landing:** auto-merge is armed when the PR is marked ready; nothing merges until the gate
  and `talos/review` pass. The merge queue rebases onto the latest `main`, runs the gate on
  every commit of its group, and merges in order (C14). No one merges by hand.
- **A red `main`** gets an issue and a revert or fix through the normal ticket flow.

## 11. Agents

- **Opt-in.** Agents work a repository only while its `talos-agents` property is on; the gate,
  the forms, the labels and the ticket rules apply everywhere (C11).
- **Thea is the only implementer** (C20). Her hub claims tickets and holds her App; her tasks
  hold no GitHub credentials and get the enforced release from the hub. Agents in Actions don't
  implement.
- **The queue** (C13). Thea's own rhythm claims the next `ai/eligible` ticket while fewer than
  `agents.max_claims` are claimed. `ai/go`, or the owner asking, starts one directly. Queue
  tickets draw on a daily budget of their own (default 5); a `p0` security issue is fixed at
  once, outside any budget.
- **Before every push,** `talos check --json`; fix what it reports. After three tries at its own
  findings, the agent stops and asks the owner, and the PR stays a draft.
- **State is queried, never remembered** (C31, C34). `talos status --json` (Thea's
  `talos_status`) answers which PRs are open, what is red and who holds a claim; none of that
  becomes memory or a handoff list. What lasts (the owner's decisions and preferences, what each
  project is for) is memory.
- **Events carry enough to act on** (C32), and **agent-facing output is compact** (C33): every
  command an agent runs has `--json`, lists capped at 20 with a total, messages clipped to 200
  characters, never a tool's raw output. The contracts are in [docs/agents.md](docs/agents.md).
- **When Thea is down,** nothing is implemented and the queue waits; the gate still holds.

## 12. Supply chain and runtimes

- Install only releases at least a day old. The fast lane: a younger release is allowed when it
  fixes an advisory against the version it replaces. Any other young release needs an entry
  under `supply_chain.allow`, with a reason and an expiry of at most seven days (C27).
- No git or tarball dependency anywhere in the tree, and no install whose provenance is weaker
  than the package's earlier releases'.
- Every vulnerability exception has a reason and an expiry date, under
  `supply_chain.exceptions`; Talos generates each scanner's ignore file from it. An entry named
  `<runtime> <version>`, such as `php 8.4.26`, excuses that runtime's `runtime/security` finding.
  When it expires, the finding fails again. Nothing is ignored forever.
- Pin every runtime to an exact patch: Dockerfile `FROM` lines, `.nvmrc`, `.node-version`,
  `.python-version`, `rust-toolchain.toml`, `go.mod`'s `toolchain`. Talos checks them against
  the vendors' feeds: `runtime/security` blocks every PR until fixed, and `runtime/eol` and
  `runtime/unpinned` are ordinary findings. An hourly sweep files a `security` issue at
  `priority/p0` the hour a security release ships (C28).

## 13. Releases and channels

- A release is a `vX.Y.Z` tag on `SVP-Labs/Talos` that only the owner can create, on a commit
  that is on `main`. Its npm package carries provenance for that commit (C17, C26).
- Canary's pin moves to a new release from a job on `main`. Seven days later, promotion moves
  stable's and evaluate's pins, provided canary saw at least five gate runs under it, none ended
  in an engine error, and no `regression` issue is open. A release with a security fix may be
  promoted by the owner after one clean canary run.
- A `regression` issue on the Talos repository moves canary's pin back at once.
- Upgrading a repository is moving a pin; no file in it changes.

## 14. Bringing a repository in

- **`talos new <Name> --prefix <P>`:** the owner creates a repository with their own login; the
  prefix must be unused in the org (C23).
- **`talos govern`:** the owner applies the settings: the caller and `CODEOWNERS`, the
  merge-queue ruleset, the owner-review ruleset while at `evaluate` (it requires `talos/review`
  from the reviewer App, X2), collaborator-only issues and PRs, Dependabot alerts, the
  properties and the App installations. `--channel canary|stable` moves a green repository on
  and removes the owner-review ruleset. Where GitHub's API exposes no
  setting, or refuses the owner's token one (adding a repository to an App's installation), it
  prints the manual step (C29).
- **`talos adopt`:** writes the files and labels in one bootstrap PR: `talos.yml`, the generated
  configs, `CLAUDE.md`, the issue forms, the labels, the pre-push hook, each language's setup
  (pinned dev tools, supply-chain settings, toolchain), the brief and issue #1. The project's own
  tool settings move into the extension files and `talos.yml`; what it can't do itself, it lists
  as next steps. It refuses a prefix another repository uses. Existing open issues become
  `legacy`. Thea can run it.
- A repository comes in at `evaluate`, where nothing blocks and the owner approves every PR on
  GitHub, and moves to its channel once it is green (C18).
- The settings are checked weekly by the drift report; a difference becomes a `drift` issue.

## 15. Definition of done

- [ ] Every acceptance criterion is met and backed by a test or a stated manual check.
- [ ] `talos check --json` is green on every commit; nothing is suppressed.
- [ ] The touched-code audit is in the PR body; dead code is removed or has its issue.
- [ ] The brief, `DECISIONS.md` and the glossary say what changed in decisions and words.
- [ ] The PR closes its issue, and the merge closes it, not a hand.
