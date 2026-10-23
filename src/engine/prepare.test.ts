import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generatedTargets, prepare, targetPath } from './prepare.js';
import type { Engine } from './run.js';
import { parseConfig } from '../config/load.js';
import type { Logger } from '../core/log.js';
import type { Pack } from '../core/pack.js';
import type { Exec, ExecResult } from '../exec/exec.js';
import { noTools, tempRepo, testPlan } from '../testing/engine.js';

type Call = { readonly command: string; readonly args: readonly string[]; readonly env?: unknown };

const DIGEST = `redis@sha256:${'a'.repeat(64)}`;

/** An engine whose exec records each call and answers it with `answer`. */
function engineWith(
  answer: (call: Call) => string,
  packs: readonly Pack[] = [],
): { engine: Engine; calls: Call[]; warnings: string[] } {
  const calls: Call[] = [];
  const warnings: string[] = [];
  const exec: Exec = (command, args, options) => {
    const call = { command, args, env: options.env };
    calls.push(call);
    const result: ExecResult = { code: 0, stdout: answer(call), stderr: '' };
    return Promise.resolve(result);
  };
  const log: Logger = {
    info: () => undefined,
    warn: (message) => warnings.push(message),
    debug: () => undefined,
  };
  return { engine: { exec, tools: noTools, log, version: '9.9.9', packs }, calls, warnings };
}

const servers: Server[] = [];
const touched = new Set<string>();

/** A port something listens on, as a started service's would. */
async function listening(): Promise<number> {
  const server = createServer((socket) => socket.end());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  for (const key of touched) Reflect.deleteProperty(process.env, key);
  touched.clear();
});

function configWith(yml: string): ReturnType<typeof parseConfig> {
  return parseConfig(`name: Test\nprefix: T\n${yml}`);
}

describe('prepare: services', () => {
  it('starts each declared service on its ports, waits for them and stops them on release', async () => {
    const port = await listening();
    const root = await tempRepo({});
    const { engine, calls } = engineWith(() => 'container-1\n');
    const config = configWith(
      `services:\n  cache-db:\n    image: ${DIGEST}\n    ports: [${port}]\n    env: { MODE: test }\n`,
    );
    const prepared = await prepare(engine, testPlan(root, [], config));
    touched.add('TALOS_SERVICE_CACHE_DB_HOST').add('TALOS_SERVICE_CACHE_DB_PORT');
    expect(prepared.env).toEqual({
      TALOS_SERVICE_CACHE_DB_HOST: '127.0.0.1',
      TALOS_SERVICE_CACHE_DB_PORT: String(port),
    });
    expect(process.env.TALOS_SERVICE_CACHE_DB_PORT).toBe(String(port));
    expect(calls.map((c) => [c.command, ...c.args])).toEqual([
      ['docker', 'run', '-d', '--rm', '-p', `127.0.0.1:${port}:${port}`, '-e', 'MODE=test', DIGEST],
    ]);
    await prepared.release();
    expect(calls.at(-1)).toMatchObject({ command: 'docker', args: ['rm', '-f', 'container-1'] });
  });

  it('publishes the ports the image exposes when the service names none', async () => {
    const port = await listening();
    const root = await tempRepo({});
    const { engine, calls } = engineWith((call) =>
      call.args[0] === 'image' ? `{"${port}/tcp":{},"bogus":{}}\n` : 'container-2\n',
    );
    const config = configWith(`services:\n  db:\n    image: ${DIGEST}\n`);
    const prepared = await prepare(engine, testPlan(root, [], config));
    touched.add('TALOS_SERVICE_DB_HOST').add('TALOS_SERVICE_DB_PORT');
    expect(prepared.env.TALOS_SERVICE_DB_PORT).toBe(String(port));
    expect(calls.map((c) => c.args.slice(0, 2))).toEqual([
      ['pull', '--quiet'],
      ['image', 'inspect'],
      ['run', '-d'],
    ]);
  });

  it('starts a service that exposes nothing without a port to wait for', async () => {
    const root = await tempRepo({});
    const { engine } = engineWith((call) =>
      call.args[0] === 'image' ? 'null\n' : 'container-3\n',
    );
    const config = configWith(`services:\n  worker:\n    image: ${DIGEST}\n`);
    const prepared = await prepare(engine, testPlan(root, [], config));
    touched.add('TALOS_SERVICE_WORKER_HOST');
    expect(prepared.env).toEqual({ TALOS_SERVICE_WORKER_HOST: '127.0.0.1' });
  });

  it('runs without services off Linux, and says so', async () => {
    const root = await tempRepo({});
    const { engine, calls, warnings } = engineWith(() => '');
    const config = configWith(`services:\n  db:\n    image: ${DIGEST}\n    ports: [5432]\n`);
    const prepared = await prepare(engine, { ...testPlan(root, [], config), os: 'macos' });
    expect(prepared.env).toEqual({});
    expect(calls).toEqual([]);
    expect(warnings).toEqual(['services run on Linux only; macos runs without them']);
    await prepared.release();
    expect(calls).toEqual([]);
  });
});

describe('prepare: setup and installs', () => {
  it("runs the setup script with the services' environment, through bash.exe on Windows", async () => {
    const root = await tempRepo({});
    const { engine, calls } = engineWith(() => '');
    const config = configWith('setup: scripts/setup.sh\n');
    await prepare(engine, testPlan(root, [], config));
    await prepare(engine, { ...testPlan(root, [], config), os: 'windows' });
    expect(calls.map((c) => [c.command, ...c.args])).toEqual([
      ['bash', join(root, 'scripts/setup.sh')],
      ['bash.exe', join(root, 'scripts/setup.sh')],
    ]);
    expect(calls[0]?.env).toEqual({});
  });

  it('records a component whose install failed, and installs only the components on this OS', async () => {
    const installed: string[] = [];
    const pack = (lang: 'ts' | 'py'): Pack => ({
      name: lang,
      lang,
      checks: [],
      install: (ctx) => {
        installed.push(`${ctx.component.lang}@${ctx.component.root}`);
        return ctx.component.root === 'broken'
          ? Promise.reject(new Error('npm ci failed'))
          : Promise.resolve();
      },
    });
    const root = await tempRepo({});
    const { engine } = engineWith(() => '', [pack('ts'), pack('py')]);
    const config = configWith(
      [
        'components:',
        '  - { lang: ts, root: app }',
        '  - { lang: ts, root: broken }',
        '  - { lang: py, root: mac, os: [macos] }',
        '',
      ].join('\n'),
    );
    const prepared = await prepare(engine, testPlan(root, [], config));
    expect(installed).toEqual(['ts@app', 'ts@broken']);
    expect([...prepared.failedInstalls]).toEqual([
      ['broken', 'installing ts at broken: npm ci failed'],
    ]);
  });
});

describe('prepare: generated files', () => {
  const bases: Pack['generated'] = [
    {
      path: 'base.json',
      scope: 'repo',
      applies: () => true,
      render: (ctx) => `repo ${ctx.version}\n`,
    },
    {
      path: 'never.json',
      scope: 'repo',
      applies: () => false,
      render: () => 'never\n',
    },
    {
      path: 'tool/base.toml',
      scope: 'component',
      langs: ['py'],
      applies: (ctx) => ctx.component?.root !== 'skipped',
      render: (ctx) => `component ${ctx.component?.root ?? ''}\n`,
    },
  ];
  const packs: Pack[] = [{ name: 'gen', checks: [], generated: bases }];

  it("writes the gate's own copy of each base that applies, over the repository's", async () => {
    const root = await tempRepo({ 'base.json': 'edited\n' });
    const { engine } = engineWith(() => '', packs);
    const config = configWith(
      [
        'components:',
        '  - { lang: py, root: . }',
        '  - { lang: py, root: svc }',
        '  - { lang: py, root: skipped }',
        '  - { lang: ts, root: web }',
        '',
      ].join('\n'),
    );
    const plan = testPlan(root, [], config);
    await prepare(engine, plan);
    expect(await readFile(join(root, 'base.json'), 'utf8')).toBe('repo 9.9.9\n');
    expect(await readFile(join(root, 'tool/base.toml'), 'utf8')).toBe('component .\n');
    expect(await readFile(join(root, 'svc/tool/base.toml'), 'utf8')).toBe('component svc\n');
    const targets = generatedTargets(packs, { ...plan, side: 'alone' }).map(targetPath);
    expect(targets).toEqual(['base.json', 'tool/base.toml', 'svc/tool/base.toml']);
  });
});
