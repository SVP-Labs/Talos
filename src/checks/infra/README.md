# The infra pack

Linters for what isn't a language component: shell scripts, PowerShell, Dockerfiles and GitHub
Actions. Each check runs once per repository, on Linux, in the head tier, and only where the
repository has files for it.

| Check              | Tool                        | Files                                                                   | Rules                                       |
| ------------------ | --------------------------- | ----------------------------------------------------------------------- | ------------------------------------------- |
| `infra/shell`      | shellcheck                  | `*.sh`, `*.bash`, and extensionless files whose shebang names a shell   | `shellcheck/SC<code>`                       |
| `infra/powershell` | PSScriptAnalyzer, in `pwsh` | `*.ps1`, `*.psm1`, `*.psd1`, but `PSScriptAnalyzerSettings.psd1`        | `psscriptanalyzer/<rule>`, parse errors too |
| `infra/dockerfile` | hadolint                    | `Dockerfile`, `Containerfile`, `Dockerfile.*`, `*.dockerfile`           | `hadolint/DL<code>`, `hadolint/SC<code>`    |
| `infra/workflows`  | actionlint, zizmor          | `.github/workflows/*.yml`, every `action.yml`, `.github/dependabot.yml` | `actionlint/<kind>`, `zizmor/<audit>`       |

Every tool comes from `tools.lock`, PSScriptAnalyzer included (its PowerShell Gallery package,
imported by path). `pwsh` itself must be on `PATH`, as it is on GitHub's runners; without it
`infra/powershell` is an engine error.

## What each tool is held to

- **shellcheck:** every optional check except SC2250 (braces around every variable), at every
  severity down to style, following `source`d files from the script's own directory.
- **PSScriptAnalyzer:** every default rule at every severity, parse errors included, plus the
  rules that are off by default for formatting (braces on the same line, two-space indentation,
  consistent whitespace and casing), semicolons ending lines, and the `!` operator.
- **hadolint:** everything down to `info`; `style` findings are left out.
- **actionlint:** every check, with shellcheck from `tools.lock` for `run:` scripts (at its
  default rules: the runner's variables would trip the optional ones).
- **zizmor:** the `pedantic` persona, offline. The online audits need a GitHub token, which a job
  running repository code never holds. Dependabot's cooldown may be one day, the minimum release
  age across SVP-Labs, where zizmor's default asks for seven.

## Configs

The gate never reads a repository's settings for these tools: each check passes its settings on
the command line or writes them into its scratch directory. The generated files exist for
editors, which read them; `configs/drift` keeps them current.

| Tool             | Generated base (repository root) | The project's file                                     |
| ---------------- | -------------------------------- | ------------------------------------------------------ |
| shellcheck       | `.shellcheckrc`                  | none: every check is on; the gate passes `--norc`      |
| PSScriptAnalyzer | `PSScriptAnalyzerSettings.psd1`  | none: every rule is on, and the tool reads one file    |
| hadolint         | `.hadolint.yaml`                 | none: the gate passes `--config` with its own copy     |
| actionlint       | none                             | `.github/actionlint.yaml`, read for runner labels only |
| zizmor           | none                             | none: the gate passes `--config` with its own settings |

Of a project's `.github/actionlint.yaml` the gate keeps only `self-hosted-runner.labels` and
`config-variables`, which declare what exists; its `paths` section, which can ignore errors, is
dropped. With none of these tools able to weaken the base, the pack has no `config-strength`
check. What a project can still do is suppress one finding in place (`# shellcheck disable=`,
`# hadolint ignore=`, `# zizmor: ignore[...]`, `[Diagnostics.CodeAnalysis.SuppressMessage]`),
which counts as a suppression like any other.

## Test projects

`test-projects/infra/` holds a failing project per check and `clean`, which has a file of every
kind and must pass all four.
