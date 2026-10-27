import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative } from 'node:path';

type Env = Readonly<Record<string, string | undefined>>;

/** Where the tests' git reads its only configuration, and the directories it never looks above. */
type Isolation = { readonly config: string; readonly ceilings: readonly string[] };

/**
 * Config every git a test runs reads first: no credential helper, and no transport but a local
 * path, so a push or a fetch can only ever reach a bare repository the test made.
 */
const ISOLATED_CONFIG: readonly (readonly [string, string])[] = [
  ['credential.helper', ''],
  ['protocol.allow', 'never'],
  ['protocol.file.allow', 'always'],
];

/**
 * The environment the tests' git runs in. Every `GIT_*` variable the tests were started with is
 * dropped: git exports `GIT_DIR` to a hook run from a linked worktree, and a fixture's
 * `git init`, `git config` or `git push` would then act on that repository and its remote.
 * Global and system config are an empty file, so no identity, credential or `autocrlf` of the
 * machine applies, git never looks for a repository above `ceilings`, and it never prompts.
 */
export function isolatedGitEnv(env: Env, isolation: Isolation): Record<string, string | undefined> {
  const kept = Object.entries(env).filter(([name]) => !/^GIT_/i.test(name));
  return {
    ...Object.fromEntries(kept),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: isolation.config,
    GIT_CONFIG_GLOBAL: isolation.config,
    GIT_CEILING_DIRECTORIES: isolation.ceilings.join(delimiter),
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_CONFIG_COUNT: String(ISOLATED_CONFIG.length),
    ...Object.fromEntries(
      ISOLATED_CONFIG.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${String(index)}`, key],
        [`GIT_CONFIG_VALUE_${String(index)}`, value],
      ]),
    ),
  };
}

/** Whether `path` is `directory` or inside it. */
export function within(directory: string, path: string): boolean {
  const rest = relative(directory, path);
  return rest === '' || (!rest.startsWith('..') && !isAbsolute(rest));
}

/** Marks a worker whose environment this file has already isolated. */
const MARK = 'TALOS_TEST_GIT_ISOLATED';

/**
 * Vitest's setup file: isolates the worker's environment once, before any test runs, so every
 * program a test starts inherits it. Fixtures live in the system's temporary directory, which
 * must lie outside the checkout under test.
 */
function isolate(): void {
  if (process.env[MARK] === '1') return;
  const checkout = process.cwd();
  const temp = tmpdir();
  if (within(checkout, temp) || within(checkout, realpathSync(temp))) {
    throw new Error(`the temporary directory ${temp} is inside the checkout ${checkout}`);
  }
  const config = join(mkdtempSync(join(temp, 'talos-git-config-')), 'gitconfig');
  writeFileSync(config, '');
  const env = isolatedGitEnv(process.env, {
    config,
    ceilings: [...new Set([temp, realpathSync(temp), checkout])],
  });
  for (const name of Object.keys(process.env)) {
    if (!(name in env)) Reflect.deleteProperty(process.env, name);
  }
  Object.assign(process.env, env, { [MARK]: '1' });
}

isolate();
