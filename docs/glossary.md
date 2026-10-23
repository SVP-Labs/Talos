# Glossary

Talos's words, in these senses, in code, docs, commit subjects and the issues and PRs it writes.
Each entry is a term in bold and its definition. A word listed after `Avoid:` fails Talos's
glossary check wherever it is used, these definitions included; a code span only mentions it,
and so does a decision's `**Rejected:**` list or double quotes. Every term here feeds the
spelling dictionary. Decisions written Cn are [the brief's](requirements/20261022-talos-core.md),
Xn are [DECISIONS.md](../DECISIONS.md)'s.

## The kit and how it reaches a repository

**Talos**
The kit in `SVP-Labs/Talos`: the engineering standard, the check engine, each language's tool
configs, the issue and PR conventions, and the rules for agents. Talos judges; Thea does the
work (C20).

**Governed repository**
A repository whose `talos` custom property is set, so exactly one Talos org ruleset applies to
it and pins the gate to a release (C3).

**Owner**
The one person whose approval `talos/review` accepts: the org's owner, `TALOS_OWNER`.

**Gate**
The workflow an org ruleset runs on every pull request and in the merge queue, at a pinned
release: `.github/workflows/gate.yml` in the Talos repository. It runs the PR's code, holds no
secrets and only produces findings (C3).
Avoid: gates workflow

**Caller**
`.github/workflows/talos.yml` in each governed repository. It runs `talos job <event>` for
everything that isn't the gate: issue readiness, the reviewer, `talos/review`, the weekly
debt job, the stale-claim sweep and label sync (C25).

**Pin**
The commit a channel's org ruleset runs the gate at. A pin is always a release tag's commit,
so the version follows from it (C3, C17).

**Channel**
Which pin a repository runs, chosen by its `talos` property: `evaluate`, `canary` or `stable`
(C3, C17).

**Evaluate**
The channel every repository comes in at: the gate runs in Evaluate mode, at stable's pin, and
blocks nothing; a code-owner ruleset requires the owner's approval meanwhile (C18).

**Canary**
The channel that runs a release first: Talos itself and Thea (C17).

**Stable**
The channel every other repository runs once it is green. A release reaches it seven days
after canary, unless something holds it (C17).

**Release**
A `vX.Y.Z` tag on `SVP-Labs/Talos`, which only the owner can create, and the npm package
`@svp-labs/talos@X.Y.Z` built from it with provenance (C17, C26).

**Promotion**
The scheduled job that moves stable's and evaluate's pins to a release after its week on
canary (C17).

**Regression issue**
An issue labelled `regression` on the Talos repository, opened or labelled by the owner, Thea
or a Talos App. It moves canary's pin back to the previous release and holds promotion (C17).

**Engine error**
A Talos bug: a check that couldn't run, a component that couldn't be installed, or tool output
that couldn't be read. Reported apart from findings, exit code 2, and it blocks promotion (C17).
Avoid: tool crash

**Central jobs**
The jobs that run in the public Talos repository across every governed repository: the
runtime sweep, the drift report, promotion and rollback. They print counts only (C30).

**Drift report**
The weekly central job that compares each governed repository's settings with what
`talos govern` sets, and files a `drift` issue for each difference (C29).

**Privacy canary**
A private scratch repository that stays governed, so every central job has it in its matrix.
Each central workflow fails when a private repository's name shows in its logs, or when the
canary wasn't watched; Talos knows the canary only by the SHA-256 of its name (C30).

## Checks and findings

**Check**
One rule set run over a repository, with an id `<area>/<name>` such as `ts/lint`. It returns
findings, never prints, and reports a tool it can't read as an engine error.

**Pack**
A group of checks with the generated configs they need: one per language, and one per
language-independent area (security, supply chain, runtime, docs, infrastructure).

**Component**
One language at one root in `talos.yml`, such as `{ lang: rust, root: apps/desktop }`, with
the operating systems it runs on (C24).

**Tier**
When a check runs. The commit tier (the fast tier) runs on every commit of a ready PR and of a
merge group; the head tier runs on the PR's head (C8).

**Pre-push hook**
`.githooks/pre-push`, which `talos adopt` writes: it runs the fast tier on the working tree
before a push, once a clone's `core.hooksPath` is `.githooks`. It gives an early answer; the gate
decides (C4).

**Applicability**
Whether a check runs at all: when the repository has what it checks, or declares it in
`talos.yml`. Strictness never varies (C8).
Avoid: strictness profile

**Finding**
One thing a check reports: a rule `<tool>/<rule>`, a place or a key, a message and a policy
that says how it counts against a change.

**Fingerprint**
A finding's identity: its rule plus a hash of the normalised code, never its path or line, so
moved code keeps it. The gate compares counts of fingerprints (C9).

**Base commit**
The commit a PR is compared with. The gate runs the same checks there, at the same release,
and fails only on findings new at head (C9).
Avoid: baseline commit

**Changed-line rule**
A pre-existing finding on a line a PR changes must be fixed in that PR (C9).

**Debt**
The findings on the default branch: what `talos debt` lists. A weekly job files a batch of it
as debt issues (C9).

**Lost coverage**
A line covered at the base commit and uncovered at head: a finding. A PR's changed lines must
also be at least 90% covered (C8).

**Surviving mutant**
A mutation of a declared critical path that no test catches: a finding (C8).

**Type coverage**
The share of a package's shipped identifiers that are typed. The floor is 99.5%, in PHP for
parameters, returns, properties and constants each; below it, each new untyped identifier is a
finding (C8).

**Flaky test**
A test that fails and then passes on one immediate rerun: a `tests/flaky` finding that never
blocks. The gate stays green, and Talos files an issue to fix it (C8).

**Security finding**
A `runtime/security` finding or a high or critical dependency advisory. It fails every PR in
the repository, whatever the base commit had, until it is fixed or an exception covers it (C9).

**Exception**
An entry under `supply_chain.exceptions` in `talos.yml` that excuses one advisory, with a
reason and an expiry date (C27). One named `<runtime> <version>`, such as `php 8.4.26`, excuses
that runtime's `runtime/security` finding. When it expires, the finding fails again.

**Fast lane**
A release younger than a day that may still be installed because it fixes an advisory against
the version it replaces (C27).

**Generated base**
A tool's base config that Talos writes into the repository, marked generated, for editors. The
gate never trusts the copy: it renders its own (C10).
Avoid: managed file

**Extension file**
The project's own file a generated base imports, such as `eslint.project.js`. It may only
tighten, and any change to it needs the owner (C10).

**Sync chore**
A `chore` issue labelled `sync`, filed by Talos when generated copies lag the enforced
release. Its PR touches only those copies (C16).

**Custom check**
A project's own check, declared under `checks` in `talos.yml`, that prints one JSON object per
finding (C19).

**Universal rules**
The architecture rules every generated base adds: no import cycles, and no shipped code that
imports test code or a dev-only dependency (C21).

**Verdict**
The gate's judgement of a PR, and `talos check`'s of a working tree: `green`, `red` or
`engine-error`, written as `talos.verdict/1` (C32). The reviewer's verdict on a review is
APPROVE or REQUEST_CHANGES, on its marker line.

**Test project**
A small project under `test-projects/` that a check must fail on, or a clean one it must pass
(C5).

## Tickets and the claim

**Ticket**
An issue in the ticket format (Goal, Acceptance criteria, Out of scope, Affected areas) that
passed issue readiness. Its id is `<P>-<N>`: the project's prefix and the issue's number.
Avoid: work item

**Prefix**
The project's ticket prefix in `talos.yml`, unique across the org: `TL` for Talos, `T` for
Thea (C23).

**Issue readiness**
The caller's check of an issue on every open and edit: the ticket format, one type label, and
the brief's link when the issue sets a decision. A failing issue gets `needs-spec`.

**Claim**
Holding a ticket: its branch `<P>-<N>` exists. Creating that branch is the lock, so two
claimants can never both hold one; labels and comments only mirror it.

**Queue**
The open `status/ready` and `ai/eligible` tickets, by priority and then age, that
`talos ticket next` claims from (C13).

**Queue budget**
How many queue tickets Thea's own rhythm may take on in a day, 5 by default, counted apart from
her other initiative (C13).

**Debt issue**
A `debt/dead-code` or `debt/other` issue the weekly debt job files, one file per issue, at
`priority/p3` (C9).

**Legacy issue**
An issue open before the repository came under Talos, labelled `legacy`, which readiness
leaves alone until it is rewritten (C18).

**Epic**
An issue that splits work into tickets and links its brief. It is never claimed itself.

## Pull requests, review and landing

**Draft**
A PR still being worked on. Its gate runs the fast tier on the latest commit only, and the
reviewer doesn't review it yet (C8).

**Ready**
A PR marked ready for review, after its commits were squashed and each checked; every commit
must pass the fast tier from now on (C20).

**Squash at ready**
Folding a task's commits into one per acceptance criterion, or one in all, before the PR leaves
draft (C20).

**Merge queue**
GitHub's queue on `main`: it rebases an approved PR onto the latest `main`, runs the gate on
every commit of the group, and merges in order with the rebase method (C14).
Avoid: merge train

**Merge group**
The commits the merge queue tests together, on a temporary branch, before it pushes them to
`main` (C14).

**Reviewer**
`talos-reviewer[bot]`, the App that reviews where agents are switched on, publishes
`talos/review` everywhere and files Talos's issues (C15).

**talos/review**
The check run the reviewer publishes and the ruleset requires. It passes only when the PR keeps
the ticket rules, the reviewer approved where agents are on, and the owner approved or the
debt-and-chore exception holds (C16).

**Review round**
One REQUEST_CHANGES from the reviewer and the answer to it. A PR gets at most two; a third
would-be request labels its issue `needs-human` (C20).

**Debt-and-chore exception**
The conditions under which a PR lands without the owner: it closes a `chore`, `debt/dead-code`
or `debt/other` issue and touches only the files that issue names, nothing guarded or protected
(C16).

**Guard list**
The paths no PR may touch without the owner: `.github/**`, `CODEOWNERS`, `talos.yml`, extension
files, manifests and lockfiles, Dockerfiles, runtime version files, `DECISIONS.md`, briefs, the
glossary and `CLAUDE.md` (C16).

**Protected path**
A path a project lists under `protected` in `talos.yml`. A card's approval never counts on a PR
that touches one (C16).

**Test integrity**
The review job's check that a PR deletes no test, removes no assertion and adds no skip (C16).

**Card**
An approval card in Thea's apps: the owner's tap there becomes a `talos-approve` review (C16).
Avoid: approval comment

**talos-approve**
The COMMENT review Thea's hub submits when the owner taps Approve on a card, pinned to the head
commit the card names: `talos-approve <card id> <head sha>`. Only Thea's App may write it, and
any later push voids it (C16).

## Agents and their contracts

**Agents switched on**
A repository whose `talos-agents` property is on: Thea implements there and the reviewer adds
its AI review (C11).

**Thea**
The owner's assistant, and the only implementer. Her hub holds her App; her tasks hold no
GitHub credentials (C20).

**Task**
The Claude Code session Thea's daemon runs to do one ticket's work on its branch. Not the
ticket itself.

**Self-fix limit**
Three tries at a check's own findings; then the agent asks the owner (C20).

**Contract**
A versioned shape an agent reads: a JSON document whose `schema` is `talos.<name>/<n>`, or a
first line that opens `talos-<kind>/<n>` (X1).

**Marker line**
A contract's first line in a review or issue body, such as
`talos-review/1 verdict=REQUEST_CHANGES round=1 findings=3`.

**Status**
A governed repository's state as one compact object, `talos.status/1`, read from GitHub on
demand: Thea's `talos_status` (C31).

**Compact output**
What every command an agent runs prints with `--json`: lists capped at 20 with a total,
messages clipped to 200 characters, never a tool's raw output (C33).

**Event**
What Thea's hub hears from GitHub and hands her, carrying the repository, the PR and the
findings summarised, so one event leads to one decision (C32).

**Handoff**
What Thea leaves her next session. For in-flight work it says "in-flight work: check
`talos_status`" instead of listing it (C34).

## Documents

**Brief**
`docs/requirements/<date>-<slug>.md`: a feature's requirement and its decisions, required for
an epic and for any issue that sets or changes a decision (C7).

**Decision**
A numbered entry with what was decided and what was rejected: a feature's in its brief, a
cross-cutting one in `DECISIONS.md`. IDs are unique and every reference resolves (C7).

**Reversal**
A new decision that replaces an old one. The new entry says `Reverses:` and the old one gains
`Reversed by:`; neither is edited otherwise (C7).

**History**
A PR's Problem, Discussion and Solution sections. `talos why <path>` finds them; there is no
changelog (C7).

**Bootstrap PR**
The PR `talos adopt` opens to bring a repository's files under Talos: `talos.yml`, the
generated configs, `CLAUDE.md`, the issue forms, the pre-push hook, each language's setup and
the brief, closing the issue #1 adoption files (C29).
