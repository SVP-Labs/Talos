# Decisions

Talos's cross-cutting decisions: the ones that bind more than one feature. A feature's own
decisions live in its brief under `docs/requirements/`; the founding brief,
[Talos core](docs/requirements/20261022-talos-core.md), holds C1 to C34. Terms are the
[glossary's](docs/glossary.md).

## How an entry is written

Each entry is a heading with a unique ID and a title, then what was decided and what was
rejected, with the reason for each:

```markdown
### X<n> · Short title in sentence case

_Decided 2026-11-02._

**Decision:** what holds now, in a few plain sentences.

**Rejected:** each alternative, with why it lost.
```

- IDs here are `X` and a number, never reused. A brief uses its own letter (the core brief
  uses `C`), so every ID is unique across the repository, and every reference to one resolves.
  Thea's decisions, which these documents cite as hers (her G1, her D46), use other letters.
- An entry is never edited to change what it decided. A reversal is a new entry whose first
  line under the heading names the one it replaces, and the old entry gains the matching line,
  so each links to the other:

  ```markdown
  Reverses: <the old entry's ID>
  ```

  ```markdown
  Reversed by: <the new entry's ID>
  ```

- An entry records a decision the owner made, first on its issue (labelled `decision`), and
  lands in that issue's PR. This file, like the briefs, needs the owner's approval on every
  change.
- Reasons stay out of code: code comments never cite an ID (ENGINEERING.md, documentation).

## Entries

### X1 · Agent-facing contracts are named and versioned

_Proposed 2026-10-23; the owner's approval of the PR that adds it decides it._

**Decision:** everything Talos produces for an agent to read names its contract and version:

- every JSON document a command prints carries `schema: "talos.<name>/<n>"`, such as
  `talos.verdict/1`, `talos.status/1` and `talos.claim/1`;
- every machine-readable line Talos writes into a review, an issue or a comment is the body's
  first line and reads `talos-<kind>/<n>` followed by `key=value` fields, such as
  `talos-review/1 verdict=REQUEST_CHANGES round=1 findings=3`. On the issues and comments Talos
  files for its own bookkeeping (`talos-debt/1`, `talos-flaky/1`, `talos-sync/1`,
  `talos-readiness/1`, `talos-drift/1`) the line sits inside an HTML comment; readers accept
  both forms.

Adding a field keeps the number. Removing or renaming a field, or changing what a value means,
takes the next number. A reader refuses a contract or number it doesn't know instead of
guessing, and a marker line counts only when the App that writes it (`talos-reviewer[bot]`)
wrote it; from anyone else it is text.

**Rejected:**

- unversioned output (a renamed field would break Thea's hub without a word);
- the Talos release as the contract's version (every release would look like a breaking change
  to every reader);
- markers anywhere in a body (a quoted marker in someone's comment would read as Talos's).

### X2 · At `evaluate`, `talos/review` holds the branch

_Decided 2026-10-28, by the owner, after smoke test 3 failed: the owner's own signed PR could
not enter the merge queue at `evaluate`._

**Decision:** while a repository is at `evaluate`, the repository ruleset `talos-owner-review`
requires the check `talos/review`, accepted from `talos-reviewer` alone, with no bypass, in
place of C18's code-owner approval rule. There `talos/review` passes only with the owner's
approval: a code owner's APPROVE of the head on GitHub, or the owner's own PR with every commit
signed by them. Thea's cards and the debt-and-chore path don't count until the repository is on
`canary` or `stable`. The merge queue stays the only way into `main`, and the owner's PR lands
through the review instead of a bypass, which GitHub doesn't offer at the queue (it answers
"New changes require approval from someone other than the last pusher").

**Rejected:**

- the reviewer App approving the owner's signed PRs: an App can't be a code owner, so the rule
  would have to drop its code-owner requirement, and then the reviewer's own APPROVE of an
  agent's PR would satisfy it, landing Thea's work on a bot's word while nothing enforces
  `talos/review`;
- one ruleset holding both the queue and the code-owner rule, with the owner's bypass: the
  bypass would let the owner merge around the queue.
