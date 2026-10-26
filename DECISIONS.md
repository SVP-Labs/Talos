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
