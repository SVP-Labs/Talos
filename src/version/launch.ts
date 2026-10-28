import { spawn } from 'node:child_process';
import { z } from 'zod';
import { enforcedRelease } from './enforced.js';
import { ensureVerified, type Installed } from './install.js';
import { type Release } from './release.js';
import { ownInstallMarker, ownVersion } from './self.js';
import { exec as realExec } from '../exec/exec.js';
import { currentRepository, isRepoName } from '../github/remote.js';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The commands that act on a repository at the version it enforces. The rest run as they are:
 * `version`, `help` and `self-test` need no repository; `doctor` reports a mismatch instead of
 * fixing it; `status` and `why` only read GitHub; `central`, `org`, `govern` and `new` act on
 * the organisation from Talos's own jobs or the owner's machine.
 */
export const LAUNCHED_COMMANDS: ReadonlySet<string> = new Set([
  'check',
  'run',
  'plan',
  'verdict',
  'debt',
  'configs',
  'adopt',
  'ticket',
  'job',
]);

/** Whether this invocation must run at the enforced version rather than as it is. */
export function needsLaunch(argv: readonly string[], env: Env): boolean {
  if ((env.TALOS_LAUNCHED ?? '') !== '' || env.TALOS_DEV === '1') return false;
  const [command] = argv;
  return command !== undefined && LAUNCHED_COMMANDS.has(command);
}

/** The `--repo owner/name` a command was given, which then names the repository to look up. */
export function repoArgument(argv: readonly string[]): string | undefined {
  for (const [index, arg] of argv.entries()) {
    const value = arg === '--repo' ? argv[index + 1] : /^--repo=(.+)$/.exec(arg)?.[1];
    if (value !== undefined && isRepoName(value)) return value;
  }
  return undefined;
}

const markerSchema = z.object({ version: z.string(), sha: z.string() });

/** Whether `marker` says the running code is the verified install of `release`. */
export function isVerifiedInstall(marker: unknown, running: string, release: Release): boolean {
  const parsed = markerSchema.safeParse(marker);
  return (
    running === release.version &&
    parsed.success &&
    parsed.data.version === release.version &&
    parsed.data.sha === release.sha
  );
}

export type LaunchDeps = {
  readonly env: Env;
  readonly err: (text: string) => void;
  readonly resolve: (argv: readonly string[]) => Promise<Release>;
  readonly isRunning: (release: Release) => Promise<boolean>;
  readonly install: (release: Release) => Promise<Installed>;
  readonly run: (bin: string, argv: readonly string[], env: Env) => Promise<number>;
};

/** Runs a Talos entry point with this Node, its output on this terminal; resolves its exit code. */
export function runNode(bin: string, argv: readonly string[], env: Env): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...argv], { stdio: 'inherit', env });
    child.on('error', reject);
    child.on('exit', (code) => {
      resolve(code ?? 1);
    });
  });
}

function defaultDeps(): LaunchDeps {
  const env = process.env;
  const cwd = process.cwd();
  return {
    env,
    err: (text) => process.stderr.write(text),
    resolve: async (argv) =>
      enforcedRelease({
        env,
        repo: repoArgument(argv) ?? (await currentRepository(env, cwd, realExec)),
      }),
    isRunning: async (release) =>
      isVerifiedInstall(await ownInstallMarker(), ownVersion(), release),
    install: (release) =>
      ensureVerified(release, {
        exec: realExec,
        fetch,
        env,
        log: (line) => process.stderr.write(`talos: ${line}\n`),
      }),
    run: runNode,
  };
}

/** `launch` with its effects passed in. */
export async function launchWith(
  argv: readonly string[],
  deps: LaunchDeps,
): Promise<number | undefined> {
  if (!needsLaunch(argv, deps.env)) return undefined;
  try {
    const release = await deps.resolve(argv);
    if (await deps.isRunning(release)) return undefined;
    const installed = await deps.install(release);
    return await deps.run(installed.bin, argv, {
      ...deps.env,
      TALOS_LAUNCHED: '1',
      TALOS_VERSION: release.version,
      TALOS_SHA: release.sha,
    });
  } catch (error) {
    deps.err(`talos: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

/**
 * Runs the Talos version the repository's rulesets enforce when this isn't it, and
 * returns its exit code; `undefined` means this process is the right version and goes on.
 */
export function launch(argv: readonly string[]): Promise<number | undefined> {
  return launchWith(argv, defaultDeps());
}
