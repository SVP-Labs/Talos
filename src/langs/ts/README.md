# The TypeScript pack

TypeScript, and JavaScript type-checked through `checkJs` until it is migrated. Each component
with `lang: ts` gets the files below rendered at its root before any check runs, and its
dependencies installed by the package manager its lockfile names (`pnpm install
--frozen-lockfile`, `npm ci` or `yarn install --immutable`, looking up to the repository root
for a workspace's lockfile).

## Files

| Base (rendered, never edited) | Project's extension (edited, may only tighten)              | Why this shape                                                                                                                                             |
| ----------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eslint.config.js`            | `eslint.project.js`: `{ ignores, defaultProject, configs }` | ESLint's flat config is code; the base imports the project's object and also exports `base`, the base alone, which the config-strength check compares with |
| `tsconfig.talos.json`         | `tsconfig.json`, which `extends` it                         | tsconfig only extends in that direction; the base carries a `"//"` note since JSON has no comments                                                         |
| `prettier.config.js`          | none                                                        | formatting is not a project's choice; JavaScript so the header can be a comment, and every option `.editorconfig` could set is pinned                      |
| `.prettierignore`             | none                                                        | lock files, the rendered files and `talos.yml`'s `exclude`, so an editor formats what the gate checks                                                      |
| `.dependency-cruiser.cjs`     | `.dependency-cruiser.project.cjs`                           | the project's rules in the tool's own syntax; the base adds the universal ones                                                                             |
| `knip.config.js`              | `knip.project.json`                                         | Knip's options are data, so the extension is JSON the base reads                                                                                           |
| `vitest.config.ts`            | `vitest.project.ts`                                         | merged with `mergeConfig`; the runner sets reporters and output paths on the command line                                                                  |
| `stryker.config.mjs`          | `stryker.project.json`                                      | Stryker's options are data; `mutate` comes from `talos.yml`'s `mutation`                                                                                   |

`talos.yml`'s `exclude` reaches every tool from the bases, so no project lists it twice.

## Checks

| Check                     | Tier         | Tool                                              | Rules                                                               |
| ------------------------- | ------------ | ------------------------------------------------- | ------------------------------------------------------------------- |
| `ts/format`               | commit       | `prettier --list-different`                       | `prettier/unformatted`, `prettier/syntax-error`                     |
| `ts/lint`                 | commit       | `eslint -f json`                                  | `eslint/<rule id>`, `eslint/parse-error`, `eslint/unused-directive` |
| `ts/types`                | commit       | `tsc --noEmit -p` for each `tsconfig.json`        | `tsc/TS<code>`                                                      |
| `ts/deadcode`             | commit       | `knip --reporter json`                            | `knip/<issue type>`                                                 |
| `ts/javascript`           | commit       | none                                              | `ts/javascript`                                                     |
| `ts/tests`, `ts/coverage` | commit, head | Vitest, through the shared checks                 | see `src/quality/`                                                  |
| `ts/typecov`              | head         | `type-coverage --strict` per `tsconfig.json`      | `typecov/untyped`                                                   |
| `ts/arch`                 | head         | `depcruise --output-type json`                    | `depcruise/<rule name>`                                             |
| `ts/size`                 | head         | `size-limit --json`, when `talos.yml` sets `size` | `size-limit/exceeded`                                               |
| `ts/e2e`                  | head         | Playwright, for `tests.full` paths it runs        | `playwright/failed`, `e2e/no-axe`                                   |
| `ts/config-strength`      | head         | `eslint --print-config`, `tsc --showConfig`       | `config/weaker`, `config/shadowed`                                  |
| `ts/toolchain`            | head         | the installed packages                            | `toolchain/version`                                                 |
| `ts/mutation`             | head         | Stryker, through the shared check                 | see `src/quality/`                                                  |

Complexity findings span the whole function (found with the component's own TypeScript), so
a change anywhere in a function that is too complex touches it.
