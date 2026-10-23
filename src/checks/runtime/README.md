# The runtime pack

One check, `runtime/runtimes` (head tier, once per repository), compares every runtime a
repository declares with its vendor's release feed. The hourly sweep in `src/central/` asks the
same pack about repositories it never checks out.

## What it reads

| File                                         | Declares                                                        |
| -------------------------------------------- | --------------------------------------------------------------- |
| `Dockerfile`, `*.Dockerfile`, `Dockerfile.*` | every stage's `FROM`, build arguments resolved                  |
| `.nvmrc`, `.node-version`                    | Node.js: the first line that isn't a comment                    |
| `.python-version`                            | Python: each CPython line, and `system`                         |
| `rust-toolchain.toml`, `rust-toolchain`      | Rust: the channel                                               |
| `go.mod`                                     | Go: the `toolchain` line (the `go` line is a language version)  |
| `composer.json`                              | PHP: `config.platform.php`, a minimum, never what the app ships |
| `tools.lock` at the root                     | the entries Talos marks as runtimes (below)                     |

`Containerfile` counts as a Dockerfile. A `FROM` names a runtime when its image is an official
one, from any registry: `php`, `node`, `python`, `rust`, `golang`, `ruby`, `oven/bun` and
`denoland/deno`. Other images, earlier stages and `scratch` are left alone. The release is the
tag's first dash-separated part that starts with a digit (`8.4.26` in `8.4.26-fpm-alpine`,
`2.1.4` in `alpine-2.1.4`); a digest beside the tag doesn't change it. Build arguments come from
the `ARG` lines before the first `FROM`, the only ones a `FROM` may use, and a finding about a
version an argument carries is placed on that `ARG` line.

A declaration is exact when it names one release, major, minor and patch (`8.4.26`). Anything
else floats: a cycle (`8.4`, `22`), a moving tag (`latest`, `lts/*`, `stable`), a pre-release, a
range, a digest without a tag, or a build argument with no value.

## Findings

| Rule               | Policy     | When                                                              |
| ------------------ | ---------- | ----------------------------------------------------------------- |
| `runtime/security` | `always`   | an exact release has a newer security release in its cycle        |
| `runtime/eol`      | `standard` | the declared cycle is past its end of life (a minimum's too)      |
| `runtime/unpinned` | `standard` | no exact release is pinned, so security releases can't be checked |

Each finding sits on the line that sets the version. A security finding's key is
`<runtime> <version>` (`php 8.4.26`), and its message names the release to move to, which the
sweep's issue repeats. `composer.json`'s platform PHP is never a security finding: Composer
resolves dependencies against it, often deliberately the lowest patch the project supports.

An entry under `supply_chain.exceptions` in `talos.yml` named after the key, such as
`"php 8.4.26": { reason: "…", expires: 2026-10-30 }`, excuses that security finding until it
expires.

## Feeds

| Feed                                                   | Gives                                         |
| ------------------------------------------------------ | --------------------------------------------- |
| `https://endoflife.date/api/v1/products/<product>`     | every runtime's cycles: newest release, dates |
| `https://www.php.net/releases/index.php?json&version=` | PHP's releases of a cycle, tagged `security`  |
| `https://nodejs.org/dist/index.json`                   | Node.js releases, marked `security: true`     |

A newer release in the declared cycle counts as a security release when:

- PHP: php.net tags it `security`;
- Node.js: `index.json` marks it `security: true` (the cycle is the major, `22`);
- Python: CPython publishes no flag, but a cycle past the end of active support gets security
  releases only, so the cycle's newest release counts when it came out after that date;
- Rust, Go, Ruby, Bun, Deno and Lua: never; only their end of life and pinning are checked.

The vendor feeds are fetched only for the cycles an exact declaration pins. Each feed is
fetched once per process and kept for ten minutes, so the sweep reads it once across
repositories. A feed that can't be fetched or read is an engine error, never a pass. Behind a
proxy, Node's `fetch` needs `NODE_USE_ENV_PROXY=1` to use `HTTPS_PROXY`.

## Recorded feeds

`TALOS_RUNTIME_FEEDS=<dir>` makes the check read `<dir>/<name>.json` instead of the network:
`endoflife-<product>.json`, `php-releases-<cycle>.json` and `node-index.json`. The self-test
needs it, so that its expectations don't move when a vendor ships a release:

```bash
TALOS_RUNTIME_FEEDS=$PWD/test-projects/runtime/feeds \
  node dist/bin/talos.js self-test test-projects --only runtime
```

The recordings in `test-projects/runtime/feeds/` were taken on 2026-10-23, the day after
php2shell's fix shipped in PHP 8.5.12, 8.4.27, 8.3.36 and 8.2.35. php.net's answers keep only
each release's tags and date, and `index.json` only Node.js 20 and later, with the fields the
check reads. The clean case pins cycles whose end of life is years away, since that date is
compared with the day the self-test runs. To record again, fetch each URL above into its name
and update the cases' expectations.

## `tools.lock` runtimes

An entry under `tools` with a `runtime` field is a runtime: `true` when the entry's name is the
runtime, or the runtime's name (`"python"`, `"node"`, `"lua"`). Its `version` is read like any
other declaration. A runtime Talos doesn't know is an engine error, since only Talos writes the
file.

```json
{ "tools": { "python": { "version": "3.13.9", "runtime": true } } }
```

## Using it without a checkout

`runtimeFindings(files, { fetcher, today, exceptions })` in `check.ts` takes files by
repository-relative path and returns the same findings the check does; `declaredRuntimes`,
`loadFeeds` and `assessRuntimes` are its three steps, each usable alone.
