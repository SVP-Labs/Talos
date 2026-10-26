# Talos

One kit for every SVP-Labs repository: the engineering standard, the check engine, each
language's tool configs, the issue and PR conventions, and the rules agents work by. It replaces
SVP-Labs/Scaffold and SVP-Labs/Workflows.

Talos judges; Thea does the work. An organisation ruleset runs Talos's gate on every pull
request and in the merge queue of every governed repository, pinned to a release, so nothing in
a repository can change what judges it. The gate runs the same checks on the PR's base commit
and fails only on what is new, so a repository is green the day it comes in, and its old
findings become debt that a weekly job files as tickets. Talos's reviewer App publishes
`talos/review`, which decides what may land: the owner approves every PR except debt and chore
work that stays inside the files its issue names. Thea, the owner's assistant, is the only
implementer: she claims tickets, checks before every push, and asks Talos how work stands
instead of remembering it.

It works in TypeScript, JavaScript, Python, PHP, Lua and Rust, on Linux, Windows and macOS. The
strictness never varies; which checks apply depends on what a repository has.

## Where things are

- [ENGINEERING.md](ENGINEERING.md): the standard every governed repository follows.
- [docs/requirements/20261022-talos-core.md](docs/requirements/20261022-talos-core.md): the
  brief, with every decision behind the standard and what was rejected.
- [DECISIONS.md](DECISIONS.md): decisions that cut across features.
- [docs/glossary.md](docs/glossary.md): Talos's words, and the ones to avoid.
- [docs/agents.md](docs/agents.md): how an agent works with Talos, and the contracts it reads.
- [docs/setup.md](docs/setup.md): standing Talos up and bringing repositories in.
- [docs/architecture.md](docs/architecture.md): how the engine is built.
- [docs/development.md](docs/development.md): working on Talos, and cutting a release.
- [docs/contracts/](docs/contracts/): the JSON schemas of the contracts.

## Using it

Talos is the npm package `@svp-labs/talos`. In a governed repository, `npx @svp-labs/talos`
finds the release the repository enforces and runs that one, so your machine and CI always agree:

```bash
npx @svp-labs/talos check --json      # what the gate will say, before a push
npx @svp-labs/talos status --json     # the repository's state: claims, PRs, what is red
npx @svp-labs/talos ticket claim 42 --agent sven
npx @svp-labs/talos doctor            # whether this machine and repository are set up
```

`talos` with no command lists them all.

## Licence

MIT.
