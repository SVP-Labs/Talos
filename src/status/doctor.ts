import { homedir } from 'node:os';
import { join } from 'node:path';
import semver from 'semver';
import { missingTools } from './resolve.js';
import { clip, MAX_MESSAGE } from './schema.js';
import { loadConfig } from '../config/load.js';
import type { TalosConfig } from '../config/schema.js';
import type { Pack } from '../core/pack.js';
import type { Exec } from '../exec/exec.js';
import { github, type GitHub, tokenFromEnvironment } from '../github/api.js';
import { identities } from '../github/identities.js';
import { currentRepository } from '../github/remote.js';
import { lookupMode, pinFinder } from '../version/pin.js';
import { releaseFromEnvironment, versionAt } from '../version/release.js';

type Env = Readonly<Record<string, string | undefined>>;

type DoctorStatus = 'ok' | 'warn' | 'fail' | 'skip';
export type DoctorItem = {
  readonly id: string;
  readonly status: DoctorStatus;
  readonly detail: string;
};

export type DoctorDeps = {
  readonly cwd: string;
  readonly env: Env;
  readonly exec: Exec;
  /** This Node's version and the range Talos's `package.json` asks for. */
  readonly node: { readonly version: string; readonly range: string };
  /** The Talos version running this. */
  readonly running: string;
  /** Talos's check packs, loaded only when the components are checked. */
  loadPacks(): Promise<readonly Pack[]>;
  readonly client?: (token: string) => GitHub;
};

function item(id: string, status: DoctorStatus, detail: string): DoctorItem {
  return { id, status, detail: clip(detail, MAX_MESSAGE) };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? (error.message.split('\n')[0] ?? '') : 'unknown error';
}

async function versionLine(exec: Exec, command: string, cwd: string): Promise<string | undefined> {
  try {
    const result = await exec(command, ['--version'], { cwd, timeoutMs: 15_000 });
    return result.code === 0 ? result.stdout.split('\n')[0]?.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function nodeItem(node: DoctorDeps['node']): DoctorItem {
  if (semver.satisfies(node.version, node.range)) return item('node', 'ok', node.version);
  return item('node', 'fail', `${node.version}; Talos needs ${node.range}`);
}

async function toolItems(deps: DoctorDeps): Promise<DoctorItem[]> {
  const gitVersion = await versionLine(deps.exec, 'git', deps.cwd);
  const ghVersion = await versionLine(deps.exec, 'gh', deps.cwd);
  return [
    item('git', gitVersion === undefined ? 'fail' : 'ok', gitVersion ?? 'git is not on PATH'),
    item(
      'gh',
      ghVersion === undefined ? 'warn' : 'ok',
      ghVersion ?? 'the GitHub CLI is not on PATH; GITHUB_TOKEN works instead',
    ),
  ];
}

async function configItem(cwd: string): Promise<{ config?: TalosConfig; item: DoctorItem }> {
  try {
    const config = await loadConfig(cwd);
    return {
      config,
      item: item('config', 'ok', `talos.yml: ${config.name}, prefix ${config.prefix}`),
    };
  } catch (error) {
    return { item: item('config', 'fail', messageOf(error)) };
  }
}

function tokenSource(env: Env): string {
  const fromEnv = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  if (fromEnv === undefined || fromEnv === '') return 'gh auth token';
  return env.GITHUB_TOKEN === undefined ? 'GH_TOKEN' : 'GITHUB_TOKEN';
}

async function tokenItem(env: Env): Promise<{ token?: string; item: DoctorItem }> {
  try {
    const token = await tokenFromEnvironment(env);
    return { token, item: item('token', 'ok', `from ${tokenSource(env)}`) };
  } catch {
    return {
      item: item('token', 'fail', 'no GitHub token: set GITHUB_TOKEN or run `gh auth login`'),
    };
  }
}

/** The pin, found exactly once, and the version it enforces against the running one. */
async function pinItems(deps: DoctorDeps, repo: string, gh: GitHub): Promise<DoctorItem[]> {
  const { talosRepo } = identities(deps.env);
  const mode = lookupMode(deps.env);
  const lookup = await pinFinder(gh, talosRepo, mode)(repo);
  if (!lookup.found) {
    return [item('pin', 'fail', `${mode}: ${lookup.reason}`), item('version', 'skip', 'no pin')];
  }
  const { pin } = lookup;
  const enforced = await versionAt(gh, talosRepo, pin.sha);
  const where = `${pin.source} (${pin.enforcement}) pins ${pin.sha.slice(0, 12)}`;
  const same = enforced === deps.running;
  const detail = same
    ? `running ${deps.running}, as enforced`
    : `running ${deps.running}, enforced ${enforced}: commands that act on the repository run ${enforced}`;
  return [item('pin', 'ok', `${mode}: ${where}`), item('version', same ? 'ok' : 'warn', detail)];
}

async function githubItems(deps: DoctorDeps): Promise<DoctorItem[]> {
  const repo = await currentRepository(deps.env, deps.cwd, deps.exec);
  const repoItem = item(
    'repository',
    repo === undefined ? 'fail' : 'ok',
    repo ?? 'no GitHub origin here',
  );
  const token = await tokenItem(deps.env);
  const given = releaseFromEnvironment(deps.env);
  if (given !== undefined) {
    const detail = `TALOS_VERSION ${given.version} at ${given.sha.slice(0, 12)}, running ${deps.running}`;
    return [
      repoItem,
      token.item,
      item('pin', 'skip', 'handed over by the environment'),
      item('version', given.version === deps.running ? 'ok' : 'warn', detail),
    ];
  }
  if (repo === undefined || token.token === undefined) {
    return [repoItem, token.item, item('pin', 'skip', 'needs a repository and a token')];
  }
  try {
    return [
      repoItem,
      token.item,
      ...(await pinItems(deps, repo, (deps.client ?? github)(token.token))),
    ];
  } catch (error) {
    return [repoItem, token.item, item('pin', 'fail', messageOf(error))];
  }
}

async function componentItems(deps: DoctorDeps, config: TalosConfig): Promise<DoctorItem[]> {
  let packs: readonly Pack[];
  try {
    packs = await deps.loadPacks();
  } catch (error) {
    return [item('tools', 'fail', `Talos's check packs did not load: ${messageOf(error)}`)];
  }
  return Promise.all(
    config.components.map(async (component) => {
      const id = `tools:${component.lang}@${component.root}`;
      const devTools = packs.find((pack) => pack.lang === component.lang)?.devTools;
      if (devTools === undefined) return item(id, 'skip', 'the pack declares no editor tools');
      const root = join(deps.cwd, component.root);
      const missing = await missingTools(devTools, {
        root,
        top: deps.cwd,
        env: deps.env,
        home: homedir(),
      });
      const total = Object.keys(devTools.packages).length;
      return missing.length === 0
        ? item(id, 'ok', `${total} tools resolvable`)
        : item(id, 'warn', `missing ${missing.join(', ')}: install the component's dependencies`);
    }),
  );
}

/** Whether this machine and repository are set up for Talos, one item per concern. */
export async function doctorReport(deps: DoctorDeps): Promise<DoctorItem[]> {
  const config = await configItem(deps.cwd);
  return [
    nodeItem(deps.node),
    ...(await toolItems(deps)),
    config.item,
    ...(await githubItems(deps)),
    ...(config.config === undefined ? [] : await componentItems(deps, config.config)),
  ];
}
