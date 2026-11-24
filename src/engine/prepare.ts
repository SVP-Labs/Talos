import { access, mkdir, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { type Engine, installKey, type RunPlan } from './run.js';
import { bashFor } from '../checks/common/custom.js';
import type { ApplyContext, Component } from '../core/check.js';
import type { Generated, Pack } from '../core/pack.js';
import { execOk } from '../exec/exec.js';

/**
 * The variable that names the Talos version the generated files on disk were rendered with: a
 * check comparing them with its own render can't use its package's version, which a release
 * commit bumps past the engine's.
 */
export const RENDERED_VERSION = 'TALOS_RENDERED_VERSION';

export type Prepared = {
  /** Environment for the checks: where each declared service listens, and the rendered version. */
  readonly env: Readonly<Record<string, string>>;
  /** Components whose dependencies couldn't be installed, by root, with why. */
  readonly failedInstalls: ReadonlyMap<string, string>;
  /** The setup script `talos.yml` names that a base commit lacks, which its run went without. */
  readonly withoutSetup?: string;
  release(): Promise<void>;
};

function componentPath(component: Component | undefined, path: string): string {
  return component === undefined || component.root === '.' ? path : `${component.root}/${path}`;
}

type Target = { readonly file: Generated; readonly component?: Component };

/** Every generated file that applies to the repository or one of its components. */
export function generatedTargets(packs: readonly Pack[], ctx: ApplyContext): Target[] {
  return packs.flatMap((pack) =>
    (pack.generated ?? []).flatMap((file): Target[] => {
      if (file.scope === 'repo') return file.applies(ctx) ? [{ file }] : [];
      return ctx.config.components
        .filter((c) => (file.langs ?? []).includes(c.lang))
        .filter((component) => file.applies({ ...ctx, component }))
        .map((component) => ({ file, component }));
    }),
  );
}

export function targetPath(target: Target): string {
  return componentPath(target.component, target.file.path);
}

export async function present(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

export async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

/**
 * The gate never trusts the repository's copy of a base config: it writes its own. A base commit
 * that predates an extension file gets the one `talos adopt` writes, which adds nothing, so its
 * base config loads there as it will once the file is committed.
 */
async function writeGenerated(engine: Engine, plan: RunPlan): Promise<void> {
  const ctx = { facts: plan.facts, config: plan.config, side: plan.side, tiers: plan.tiers };
  for (const target of generatedTargets(engine.packs, ctx)) {
    const render = {
      config: plan.config,
      facts: plan.facts,
      version: engine.version,
      ...(target.component ? { component: target.component } : {}),
    };
    await put(join(plan.root, targetPath(target)), target.file.render(render));
    const extension = target.file.extension;
    if (plan.side !== 'base' || extension === undefined) continue;
    const path = join(plan.root, componentPath(target.component, extension.path));
    if (!(await present(path))) await put(path, extension.initial(render));
  }
}

/** Installs every component; one that fails is an engine error for its own checks only. */
async function installComponents(engine: Engine, plan: RunPlan): Promise<Map<string, string>> {
  const failed = new Map<string, string>();
  for (const component of plan.config.components.filter((c) => c.os.includes(plan.os))) {
    const pack = engine.packs.find((p) => p.lang === component.lang);
    try {
      await pack?.install?.({
        root: plan.root,
        component,
        config: plan.config,
        exec: engine.exec,
        tools: engine.tools,
        log: engine.log,
        os: plan.os,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failed.set(
        installKey(component),
        `installing ${component.lang} at ${component.root}: ${reason}`,
      );
    }
  }
  return failed;
}

async function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`a declared service did not open port ${port} within ${timeoutMs / 1000} s`);
}

async function exposedPorts(engine: Engine, image: string, root: string): Promise<number[]> {
  await execOk(engine.exec, 'docker', ['pull', '--quiet', image], { cwd: root });
  const out = await execOk(
    engine.exec,
    'docker',
    ['image', 'inspect', '--format', '{{json .Config.ExposedPorts}}', image],
    { cwd: root },
  );
  const ports = JSON.parse(out.trim() || 'null') as Record<string, unknown> | null;
  return Object.keys(ports ?? {})
    .map((key) => Number.parseInt(key, 10))
    .filter((p) => p > 0);
}

const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

type Containers = {
  readonly add: (id: string) => void;
  /** Removes every container added so far, once however often it is called; never throws. */
  readonly remove: () => Promise<void>;
};

/**
 * The service containers a run started. `--rm` removes a container only once it exits, which a
 * service never does by itself, so each one lives until the run removes it: a container left
 * behind holds its host port on the machine. While any is up, SIGINT and SIGTERM remove them
 * before the process ends as the signal would have ended it.
 */
function containers(engine: Engine, root: string): Containers {
  const ids: string[] = [];
  let removed: Promise<void> | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    void remove().then(() => process.kill(process.pid, signal));
  };
  const removeAll = async (): Promise<void> => {
    for (const id of ids) {
      try {
        const result = await engine.exec('docker', ['rm', '-f', id], { cwd: root });
        if (result.code !== 0) engine.log.warn(`could not remove service container ${id}`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        engine.log.warn(`could not remove service container ${id}: ${reason}`);
      }
    }
    for (const signal of STOP_SIGNALS) process.off(signal, onSignal);
  };
  const remove = (): Promise<void> => {
    removed ??= removeAll();
    return removed;
  };
  return {
    add: (id) => {
      if (ids.length === 0) for (const signal of STOP_SIGNALS) process.on(signal, onSignal);
      ids.push(id);
    },
    remove,
  };
}

/** Starts the services `talos.yml` declares, pinned by digest; Linux only. */
async function startServices(
  engine: Engine,
  plan: RunPlan,
  started: Containers,
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  const services = Object.entries(plan.config.services);
  if (services.length > 0 && plan.os !== 'linux') {
    engine.log.warn(`services run on Linux only; ${plan.os} runs without them`);
    return env;
  }
  for (const [name, service] of services) {
    const ports =
      service.ports.length > 0
        ? service.ports
        : await exposedPorts(engine, service.image, plan.root);
    const args = ['run', '-d', '--rm', ...ports.flatMap((p) => ['-p', `127.0.0.1:${p}:${p}`])];
    for (const [key, value] of Object.entries(service.env)) args.push('-e', `${key}=${value}`);
    const id = (
      await execOk(engine.exec, 'docker', [...args, service.image], { cwd: plan.root })
    ).trim();
    started.add(id);
    const upper = name.toUpperCase().replaceAll('-', '_');
    env[`TALOS_SERVICE_${upper}_HOST`] = '127.0.0.1';
    if (ports[0] !== undefined) env[`TALOS_SERVICE_${upper}_PORT`] = String(ports[0]);
    for (const port of ports) await waitForPort(port, 120_000);
  }
  return env;
}

/** Runs the setup script; at a base commit that lacks it, says so and answers its path. */
async function runSetupScript(
  engine: Engine,
  plan: RunPlan,
  env: Record<string, string>,
): Promise<string | undefined> {
  if (plan.config.setup === undefined) return undefined;
  const script = join(plan.root, plan.config.setup);
  if (plan.side === 'base' && !(await present(script))) {
    engine.log.warn(
      `the base commit has no ${plan.config.setup}, the setup script talos.yml names: ` +
        'its run goes without one',
    );
    return plan.config.setup;
  }
  const shell = await bashFor(plan.os, process.env);
  const path = plan.os === 'windows' ? script.replaceAll('\\', '/') : script;
  await execOk(engine.exec, shell, [path], { cwd: plan.root, env, timeoutMs: 60 * 60 * 1000 });
  return undefined;
}

/**
 * Everything before the checks: generated configs, services, dependencies, the setup script. When
 * a step after the services start throws, it removes them before passing the error on.
 */
export async function prepare(engine: Engine, plan: RunPlan): Promise<Prepared> {
  await writeGenerated(engine, plan);
  const started = containers(engine, plan.root);
  try {
    const serviceEnv = await startServices(engine, plan, started);
    const env = { ...serviceEnv, [RENDERED_VERSION]: engine.version };
    Object.assign(process.env, env);
    const failedInstalls = await installComponents(engine, plan);
    const withoutSetup = await runSetupScript(engine, plan, serviceEnv);
    return {
      env,
      failedInstalls,
      ...(withoutSetup === undefined ? {} : { withoutSetup }),
      release: started.remove,
    };
  } catch (error) {
    await started.remove();
    throw error;
  }
}
