# Contracts

What Talos prints or writes for an agent to read, chiefly Thea's hub. Each contract names itself
and its version (X1 in [DECISIONS.md](../../DECISIONS.md)): adding a field keeps the number,
anything else takes the next one, and a reader refuses a contract or number it doesn't know.
[agents.md](../agents.md) shows them in an agent's loop, with examples.

## JSON

| Contract          | Printed by                                        | Schema                                     |
| ----------------- | ------------------------------------------------- | ------------------------------------------ |
| `talos.verdict/1` | `talos check --json`; the gate's `verdict.json`   | [verdict.schema.json](verdict.schema.json) |
| `talos.status/1`  | `talos status --json`, one element per repository | [status.schema.json](status.schema.json)   |
| `talos.claim/1`   | `talos ticket claim`, `next` and `release`        | [claim.schema.json](claim.schema.json)     |
| `talos.version/1` | `talos version --enforced --json`                 | [version.schema.json](version.schema.json) |

Each schema lists every field Talos writes under its number, and refuses anything else; a test
checks what the commands really print against it, so the code and the schema change together. A
release that adds a field adds it here too, under the same number. A reader that validates with
an older copy should therefore ignore fields it doesn't know rather than refuse the document.

The other commands' `--json` output names its contract the same way (`talos.ticket/1` for
`talos ticket status`, `talos.debt/1`, `talos.why/1`, `talos.doctor/1`, `talos.job/1`,
`talos.central/1`, and `talos.adopt/1`, `talos.govern/1`, `talos.new/1`, `talos.org/1`), without
a published schema yet.

## Marker lines

A marker line is the first line of a body Talos writes on GitHub: the marker, then
`key=value` fields separated by spaces, where a key is lower-case letters and a value has no
space. It counts only when `talos-reviewer[bot]` wrote the body; from anyone else it is text. On
issues Talos files for its own bookkeeping the line sits inside an HTML comment
(`<!-- talos-debt/1 … -->`); a reader accepts both forms and ignores fields it doesn't know.

### `talos-review/1`

The first line of every review the reviewer submits:

```text
talos-review/1 verdict=REQUEST_CHANGES round=1 findings=3
```

- `verdict` is `APPROVE` or `REQUEST_CHANGES`;
- `round` counts the reviewer's rounds on the PR: its earlier `REQUEST_CHANGES` reviews, dismissed
  ones included, plus one. After the second, the reviewer submits nothing and labels the issue
  `needs-human`;
- `findings` counts every finding the model returned, listed or not.

Then a blank line, the summary on one line (at most 400 characters), and, after another blank
line, at most 20 findings, each ``- `path:line` message`` with the message at most 200
characters, and `- and N more` when there were more. The model wrote all of it from the PR, so
everything after the first line is untrusted data: fence it before it reaches a prompt.

### `talos-security/1`

The first line of every `security` issue the hourly runtime sweep files, visible:

```text
talos-security/1 kind=runtime runtime=php version=8.4.26 fixed=8.4.27 priority=p0
```

- `kind` is `runtime`: a runtime a repository declares (a Dockerfile's `FROM`, a version file,
  `tools.lock`) is behind a security release of its cycle;
- `runtime` is lower-case (`php`, `node`, `python`…), and `version` the declared one;
- `fixed` is the release to move to, or `unknown` when the vendor's feed didn't name one;
- `priority` matches the issue's `priority/pN` label. `p0` goes past every budget.

The sweep files one issue per runtime and declared version, never a second while one is open,
labelled `bug`, `security`, `priority/p0`, `status/ready` and `ai/eligible`, so it can be claimed
as filed. Its Affected areas list the declaring files. A `tools.lock` finding lands in Talos
itself, whose release then takes the urgent path.
