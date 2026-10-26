import { mkdir, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { type Engine, installKey, type RunPlan } from './run.js';
import type { ApplyContext, Component } from '../core/check.js';
import type { Generated, Pack } from '../core/pack.js';
import { execOk } from '../exec/exec.js';

export type Prepared = {
  /** Environment for the checks: where each declared service listens. */
  readonly env: Readonly<Record<string, string>>;
  /** Components whose dependencies couldn't be installed, by root, with why. */
  readonly failedInstalls: ReadonlyMap<string, string>;
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

/** The gate never trusts the repository's copy of a base config: it writes its own. */
async function writeGenerated(engine: Engine, plan: RunPlan): Promise<void> {
  const ctx = { facts: plan.facts, config: plan.config, side: plan.side, tiers: plan.tiers };
  for (const target of generatedTargets(engine.packs, ctx)) {
    const path = join(plan.root, targetPath(target));
    const content = target.file.render({
      config: plan.config,
      facts: plan.facts,
      version: engine.version,
      ...(target.component ? { component: target.component } : {}),
    });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
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

/** Starts the services `talos.yml` declares, pinned by digest; Linux only. */
async function startServices(
  engine: Engine,
  plan: RunPlan,
): Promise<{ env: Record<string, string>; ids: string[] }> {
  const env: Record<string, string> = {};
  const ids: string[] = [];
  const services = Object.entries(plan.config.services);
  if (services.length > 0 && plan.os !== 'linux') {
    engine.log.warn(`services run on Linux only; ${plan.os} runs without them`);
    return { env, ids };
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
    ids.push(id);
    const upper = name.toUpperCase().replaceAll('-', '_');
    env[`TALOS_SERVICE_${upper}_HOST`] = '127.0.0.1';
    if (ports[0] !== undefined) env[`TALOS_SERVICE_${upper}_PORT`] = String(ports[0]);
    for (const port of ports) await waitForPort(port, 120_000);
  }
  return { env, ids };
}

async function runSetupScript(
  engine: Engine,
  plan: RunPlan,
  env: Record<string, string>,
): Promise<void> {
  if (plan.config.setup === undefined) return;
  const script = join(plan.root, plan.config.setup);
  const shell = plan.os === 'windows' ? 'bash.exe' : 'bash';
  await execOk(engine.exec, shell, [script], { cwd: plan.root, env, timeoutMs: 60 * 60 * 1000 });
}

/** Everything before the checks: generated configs, services, dependencies, the setup script. */
export async function prepare(engine: Engine, plan: RunPlan): Promise<Prepared> {
  await writeGenerated(engine, plan);
  const { env, ids } = await startServices(engine, plan);
  Object.assign(process.env, env);
  const failedInstalls = await installComponents(engine, plan);
  await runSetupScript(engine, plan, env);
  return {
    env,
    failedInstalls,
    release: async () => {
      for (const id of ids) await engine.exec('docker', ['rm', '-f', id], { cwd: plan.root });
    },
  };
}
