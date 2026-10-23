# The Rust pack

Checks for every component with `lang: rust` in `talos.yml`. Each runs once per component, on
each OS it declares (Rust components are often `[linux, windows]`, so code behind
`#[cfg(windows)]` is checked on the Windows run), with the toolchain the component pins in its
`rust-toolchain.toml`. The component's root is a package or a workspace; Talos checks its
tracked `.rs` files minus `talos.yml`'s `exclude` and anything under a `target` directory.

| Check                         | Tier         | Tool                                              | Rules                                                                 |
| ----------------------------- | ------------ | ------------------------------------------------- | --------------------------------------------------------------------- |
| `rust/format`                 | commit       | rustfmt (`cargo fmt --check`)                     | `rustfmt/format`                                                      |
| `rust/lint`                   | commit       | Clippy, rustc, Talos                              | `clippy/<lint>`, `rustc/<lint>`, `talos/max-lines`, `talos/max-depth` |
| `rust/types`                  | commit       | rustc                                             | `rustc/<error code>`, `rustc/error` for an error without one          |
| `rust/deadcode`               | commit       | rustc, cargo-machete                              | `rustc/dead_code`, `cargo-machete/unused-dependency`                  |
| `rust/tests`, `rust/coverage` | commit, head | cargo-nextest, cargo-llvm-cov, `cargo test --doc` | the shared quality rules                                              |
| `rust/mutation`               | head         | cargo-mutants                                     | `mutation/survived`                                                   |
| `rust/config-strength`        | head         | rustfmt, Talos                                    | `config/weaker`                                                       |
| `rust/toolchain`              | head         | Talos                                             | `toolchain/unpinned`, `toolchain/missing`                             |

There is no type coverage and no architecture check: rustc types everything, and Rust has no
mature tool for layer rules.

One Clippy run per component and run feeds `rust/lint`, `rust/types` and `rust/deadcode`:
`cargo clippy --workspace --all-targets --all-features --locked --keep-going
--message-format=json`. Clippy compiles exactly what `cargo check` compiles and adds its lints,
so rustc's errors in its output are the type check. Each diagnostic is reported once, though a
library is compiled twice under `--all-targets` (as itself and with its tests), and at the first
place in the project's own files: code a macro expanded is reported where the macro was called.
An error in a file the repository doesn't track keeps no location and is keyed by its message;
a warning there is dropped.

## Installing

`install()` works in the component's root:

1. Without a `Cargo.lock` the component can't be installed: an engine error. Talos installs Rust
   dependencies only from a lockfile.
2. Where the machine has rustup: `rustup toolchain install`, which installs what the nearest
   `rust-toolchain.toml` pins, when one does, then `rustup component add clippy rustfmt
llvm-tools` for the toolchain the component uses. A Rust from a distribution's packages has
   no rustup and must bring those itself.
3. `cargo fetch --locked`. Every later cargo command passes `--locked` too, so nothing a check
   runs can change `Cargo.lock`.

cargo-nextest, cargo-llvm-cov, cargo-mutants and cargo-machete come from `tools.lock`. The
checks start each one directly (`cargo-nextest nextest run …`, as cargo itself would) with its
directory first on `PATH`, so cargo-llvm-cov and cargo-mutants find the same nextest.

## Configs

| Tool    | Base (generated, in the component's root) | The project's own settings                                       |
| ------- | ----------------------------------------- | ---------------------------------------------------------------- |
| rustfmt | `rustfmt.toml`                            | none: formatting is not a project's choice                       |
| Clippy  | `clippy.toml`                             | lint levels in `Cargo.toml` (below); Clippy reads no second file |

Neither rustfmt nor Clippy can import another file or be extended, so both bases are whole and
there is no extension file. The gate never reads the repository's copies: `rust/format` passes
its own rendering with `--config-path`, so neither a `.rustfmt.toml` nor a `rustfmt.toml` in a
subdirectory changes what it expects, and Clippy runs with `CLIPPY_CONF_DIR` pointing at a fresh
rendering of `clippy.toml`.

**rustfmt** keeps its defaults, written out (`max_width = 100`): Rust is formatted the way rustfmt
formats it out of the box.

**Clippy** gets the standard limits it has a setting for: cognitive complexity 15, 4 arguments,
60 lines per function. `unwrap` and `expect` are not allowed in tests either, and lints that
would change a public API still fire (`avoid-breaking-exported-api = false`).

### Lint levels

Clippy reads lint levels from no config file, so the gate passes them on its command line,
after the levels the project's `Cargo.toml` (`[lints]`, `[workspace.lints]`) sets, which the
command line overrides:

```text
--cap-lints warn -W warnings -W unused -W nonstandard_style -W future_incompatible
-W clippy::all -W clippy::pedantic -W clippy::cognitive_complexity -W clippy::unwrap_used
-W clippy::expect_used -W clippy::dbg_macro -W clippy::todo -W clippy::unimplemented
--force-warn unsafe_code
```

Every warning is a finding, which is what `-D warnings` means here: the gate keeps every level at
`warn` and caps attributes at `warn`, so one crate's findings never stop the crates that depend
on it from being checked, and a crate-level `#![deny(...)]` can't turn a lint into an error that
would end the run. `unsafe_code` is forced: no `#[allow(unsafe_code)]` silences it, so unsafe
code is forbidden at the gate whatever the source says. Any other `#[allow(...)]` or
`#[expect(...)]` is an inline suppression, which the suppressions check reports.

A `.cargo/config.toml` that passes lint flags in `rustflags` (`--cap-lints allow`, `-A ...`)
could silence the gate, so when one does, the gate replaces cargo's flags with the
repository's `build.rustflags` minus every lint flag (through `CARGO_ENCODED_RUSTFLAGS`).

The editor learns the same levels from the manifest. `talos adopt` writes them as
`[workspace.lints]` into a workspace's root `Cargo.toml` (each member then sets
`[lints] workspace = true`), or as `[lints]` into a lone package's (`lintsBlock` in `lints.ts`):

```toml
[workspace.lints.rust]
unsafe_code = "deny"

[workspace.lints.clippy]
all = { level = "warn", priority = -1 }
pedantic = { level = "warn", priority = -1 }
cognitive_complexity = "warn"
unwrap_used = "warn"
expect_used = "warn"
dbg_macro = "warn"
todo = "warn"
unimplemented = "warn"
```

`unsafe_code` is `deny` there, not `forbid`: an existing, reviewed `#[allow(unsafe_code)]` around
a call into the operating system still compiles in the editor, while the gate keeps reporting
it. A project may set any level higher or enable more lints (Clippy's `restriction` or `nursery`
lints, rustc's `missing_docs`); the gate's flags never mention those, so the project's levels
stand, capped at `warn` like the rest.

### What counts as weaker

`rust/config-strength` reports `config/weaker` for:

- a `[lints]` table (or the `[workspace.lints]` table a member defers to) that is missing, leaves
  out a lint the base sets, or sets one lower; and any lint it allows, which is a suppression for
  a whole crate;
- a `rustflags` entry in a tracked `.cargo/config.toml` (or `.cargo/config`), from the
  repository's root down to the component, that allows a lint or caps lint levels;
- a `rustfmt.toml`, `.rustfmt.toml`, `clippy.toml` or `.clippy.toml` other than the base in the
  component's root: the gate ignores it, but an editor reads it, so each setting that differs from
  the base (over rustfmt's own defaults, printed by the pinned `rustfmt --print-config default`)
  makes the editor and the gate disagree;
- `[package.metadata.cargo-machete] ignored` or `[workspace.metadata.cargo-machete] ignored`: an
  unused dependency should go, not be ignored.

The gate's own command line already overrides all of these; the check keeps the editor honest.

## Lint beyond Clippy

Clippy has no file length, and its `excessive_nesting` counts the blocks of `mod`, `impl` and the
function body too, which would make nesting 3 far stricter than in every other language. Talos
measures both itself with a small tokenizer (`scan.ts`, `structure.ts`):

- `talos/max-lines`: at most 400 lines of code per file, blank lines and comments not counted,
  test code exempt (`#[cfg(test)]` and `#[test]` items, files only tests compile);
- `talos/max-depth`: control blocks (`if`, `else`, `for`, `while`, `loop`, `match`) at most 3
  deep inside a function or closure, counted as ESLint's `max-depth` counts them: a function's
  body, `impl` and `mod` blocks, match arms and plain blocks add no level, an `else if` chain is
  one level, and a closure or nested function starts again from zero. The finding spans the
  block that goes one level too deep.

Clippy reports `too_many_lines`, `cognitive_complexity` and `too_many_arguments` on a
function's signature or name; the check widens them to the function's closing brace, so changing
any line of the function touches the finding. `too_many_lines` doesn't apply to tests, as the
size limits don't in any language.

## Dead code

`rustc/dead_code` comes from the same Clippy run (`-W unused`) and is left out of `rust/lint`.
Unused imports, variables and `mut`s stay in `rust/lint`, as ESLint's `no-unused-vars` does.
cargo-machete reports dependencies no code uses; it runs with `--with-metadata`, so a library
whose crate is named differently from its package isn't reported. Each finding points at the
dependency's line in the member's `Cargo.toml`.

## Tests

JUnit output from libtest isn't stable, so the runner uses cargo-nextest, under cargo-llvm-cov
when coverage is asked for:

```text
cargo-nextest nextest run --workspace --all-features --locked --no-fail-fast --retries 0
  --ignore-default-filter --no-tests pass --tool-config-file talos:<scratch>/nextest.toml
  --profile talos [-E <filterset>]
cargo-llvm-cov llvm-cov nextest <the same> --lcov --output-path <scratch>/raw.lcov
```

Talos's tool config defines the `talos` profile, writing JUnit into the check's scratch
directory. The repository's `.config/nextest.toml` may set timeouts and test groups; retries,
fail-fast and the default filter are overridden on the command line, so a flaky test reaches the
shared rerun and no `default-filter` hides a test from the gate. The per-commit suite leaves out
`tests.full` with a filterset (`not (...)`), and a rerun selects the failing tests' files: a
file that is a crate root selects its whole test binary, any other file the tests under the
module it holds. nextest names each case's binary and module path but not its file, so the runner
adds a `file` attribute by following the module path from the binary's crate root through
`<module>.rs` and `<module>/mod.rs` files.

nextest can't run doctests, so `cargo test --doc --workspace --all-features --locked
--no-fail-fast` runs them, read from libtest's plain `test <name> ... ok` lines into a second
JUnit report. A doctest's name starts with its file. A run that can't build its tests (nextest
exits 101) or its doctests stands for one failing case on `Cargo.toml`, so broken tests fail the
tests rather than the engine.

Coverage is LCOV from cargo-llvm-cov, with paths made relative to the component's root, files
outside it and test files dropped, and the lines of `#[cfg(test)]` and `#[test]` items removed:
tests are not the code coverage measures. Doctests add no coverage (cargo-llvm-cov measures them
only on nightly).

## Mutation

cargo-mutants mutates only the requested files (`--file`, relative to the workspace root), in its
own copy of the tree, testing each mutant with nextest over the whole workspace:
`--no-config` (so `.cargo/mutants.toml` can't exclude anything), `--no-shuffle`, `--cap-lints
true`, `--all-features`, two jobs, and nextest's retries off. Its `mutants.out/outcomes.json` is
the report (format `cargo-mutants`), read by the shared mutation check. A run whose baseline
tests fail exits 4 and judges no mutant; `rust/tests` reports those failures.

## Toolchain

`rust/toolchain` wants the component's `rust-toolchain.toml` (its own or the nearest one above
it in the repository; the legacy one-line `rust-toolchain` file counts) to pin an exact release,
such as `channel = "1.97.0"`, with the `clippy` and `rustfmt` components, so the editor, `talos
check` and the gate run the same rustc, Clippy and rustfmt. A channel such as `stable` or `1.97`
is `toolchain/unpinned`; a missing file or component is `toolchain/missing`.
