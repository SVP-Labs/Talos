import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generatedTargets, prepare, RENDERED_VERSION, targetPath } from './prepare.js';
import type { Engine } from './run.js';
import { parseConfig } from '../config/load.js';
import type { Logger } from '../core/log.js';
import type { Pack } from '../core/pack.js';
import type { Exec, ExecResult } from '../exec/exec.js';
import { noTools, tempRepo, testPlan } from '../testing/engine.js';

type Call = { readonly command: string; readonly args: readonly string[]; readonly env?: unknown };

const DIGEST = `redis@sha256:${'a'.repeat(64)}`;
const OTHER = `postgres@sha256:${'b'.repeat(64)}`;

/** An engine whose exec records each call and answers it with `answer`: its output, or a result. */
function engineWith(
  answer: (call: Call) => string | ExecResult | Promise<string>,
  packs: readonly Pack[] = [],
): { engine: Engine; calls: Call[]; warnings: string[] } {
  const calls: Call[] = [];
  const warnings: string[] = [];
  const exec: Exec = (command, args, options) => {
    const call = { command, args, env: options.env };
    calls.push(call);
    return Promise.resolve(answer(call)).then((answered): ExecResult =>
      typeof answered === 'string' ? { code: 0, stdout: answered, stderr: '' } : answered,
    );
  };
  const log: Logger = {
    info: () => undefined,
    warn: (message) => warnings.push(message),
    debug: () => undefined,
  };
  return { engine: { exec, tools: noTools, log, version: '9.9.9', packs }, calls, warnings };
}

const servers: Server[] = [];
const rendered = process.env[RENDERED_VERSION];

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
  for (const key of Object.keys(process.env).filter((k) => k.startsWith('TALOS_SERVICE_'))) {
    Reflect.deleteProperty(process.env, key);
  }
  if (rendered === undefined) Reflect.deleteProperty(process.env, RENDERED_VERSION);
  else process.env[RENDERED_VERSION] = rendered;
});

/** Docker as a started service's: `id` for the container, published on `host`. */
function docker(id: string, host: number): (call: Call) => string {
  return (call) => (call.args[0] === 'port' ? `127.0.0.1:${host}\n` : `${id}\n`);
}

function configWith(yml: string): ReturnType<typeof parseConfig> {
  return parseConfig(`name: Test\nprefix: T\n${yml}`);
}

describe('prepare: services', () => {
  it('starts each declared service on a free host port, waits for it and stops it on release', async () => {
    const port = await listening();
    const root = await tempRepo({});
    const { engine, calls } = engineWith(docker('container-1', port));
    const config = configWith(
      `services:\n  cache-db:\n    image: ${DIGEST}\n    ports: [5432]\n    env: { MODE: test }\n`,
    );
    const prepared = await prepare(engine, testPlan(root, [], config));
    expect(prepared.env).toEqual({
      TALOS_SERVICE_CACHE_DB_HOST: '127.0.0.1',
      TALOS_SERVICE_CACHE_DB_PORT: String(port),
      TALOS_SERVICE_CACHE_DB_PORT_5432: String(port),
      TALOS_RENDERED_VERSION: '9.9.9',
    });
    expect(process.env.TALOS_SERVICE_CACHE_DB_PORT).toBe(String(port));
    const label = expect.stringMatching(/^talos\.run=[\w-]+$/) as string;
    expect(calls.map((c) => [c.command, ...c.args])).toEqual([
      [
        'docker',
        'run',
        '--label',
        label,
        '-d',
        '--rm',
        '-p',
        '127.0.0.1::5432',
        '-e',
        'MODE=test',
      ].concat([DIGEST]),
      ['docker', 'port', 'container-1', '5432/tcp'],
    ]);
    await prepared.release();
    expect(calls.slice(2).map((c) => c.args)).toEqual([
      ['ps', '-aq', '--filter', `label=${String(calls[0]?.args[2])}`],
      ['rm', '-f', 'container-1'],
    ]);
  });

  it('publishes the ports the image exposes when the service names none', async () => {
    const port = await listening();
    const root = await tempRepo({});
    const { engine, calls } = engineWith((call) =>
      call.args[0] === 'image' ? '{"6379/tcp":{},"bogus":{}}\n' : docker('container-2', port)(call),
    );
    const config = configWith(`services:\n  db:\n    image: ${DIGEST}\n`);
    const prepared = await prepare(engine, testPlan(root, [], config));
    expect(prepared.env.TALOS_SERVICE_DB_PORT).toBe(String(port));
    expect(calls.map((c) => c.args.slice(0, 2))).toEqual([
      ['pull', '--quiet'],
      ['image', 'inspect'],
      ['run', '--label'],
      ['port', 'container-2'],
    ]);
    expect(calls[2]?.args).toContain('127.0.0.1::6379');
  });

  it('publishes a service whose port something on the host already holds', async () => {
    const held = await listening();
    const free = await listening();
    const root = await tempRepo({});
    const { engine, calls } = engineWith(docker('container-4', free));
    const config = configWith(`services:\n  db:\n    image: ${DIGEST}\n    ports: [${held}]\n`);
    const prepared = await prepare(engine, testPlan(root, [], config));
    expect(calls[0]?.args.slice(3)).toEqual(['-d', '--rm', '-p', `127.0.0.1::${held}`, DIGEST]);
    expect(calls[1]?.args).toEqual(['port', 'container-4', `${held}/tcp`]);
    expect(prepared.env.TALOS_SERVICE_DB_PORT).toBe(String(free));
    expect(process.env.TALOS_SERVICE_DB_PORT).toBe(String(free));
  });

  it('gives the checks the host port of each port a service publishes', async () => {
    const first = await listening();
    const second = await listening();
    const root = await tempRepo({});
    const hosts: Record<string, number> = { '5432/tcp': first, '8080/tcp': second };
    const { engine } = engineWith((call) =>
      call.args[0] === 'port' ? `127.0.0.1:${hosts[call.args[2] ?? ''] ?? 0}\n` : 'container-6\n',
    );
    const config = configWith(`services:\n  db:\n    image: ${DIGEST}\n    ports: [5432, 8080]\n`);
    const prepared = await prepare(engine, testPlan(root, [], config));
    expect(prepared.env).toEqual({
      TALOS_SERVICE_DB_HOST: '127.0.0.1',
      TALOS_SERVICE_DB_PORT: String(first),
      TALOS_SERVICE_DB_PORT_5432: String(first),
      TALOS_SERVICE_DB_PORT_8080: String(second),
      TALOS_RENDERED_VERSION: '9.9.9',
    });
    expect(process.env.TALOS_SERVICE_DB_PORT_8080).toBe(String(second));
  });

  it("removes a service whose host port Docker doesn't say", async () => {
    const root = await tempRepo({});
    const { engine, calls } = engineWith((call) =>
      call.args[0] === 'port' ? '\n' : 'container-5\n',
    );
    const config = configWith(`services:\n  db:\n    image: ${DIGEST}\n    ports: [5432]\n`);
    await expect(prepare(engine, testPlan(root, [], config))).rejects.toThrow(
      "docker did not say which host port publishes a declared service's 5432",
    );
    expect(calls.at(-1)?.args).toEqual(['rm', '-f', 'container-5']);
    expect(calls.at(-2)?.args[0]).toBe('ps');
  });

  it('starts a service that exposes nothing without a port to wait for', async () => {
    const root = await tempRepo({});
    const { engine } = engineWith((call) =>
      call.args[0] === 'image' ? 'null\n' : 'container-3\n',
    );
    const config = configWith(`services:\n  worker:\n    image: ${DIGEST}\n`);
    const prepared = await prepare(engine, testPlan(root, [], config));
    expect(prepared.env).toEqual({
      TALOS_SERVICE_WORKER_HOST: '127.0.0.1',
      TALOS_RENDERED_VERSION: '9.9.9',
    });
  });

  it('runs without services off Linux, and says so', async () => {
    const root = await tempRepo({});
    const { engine, calls, warnings } = engineWith(() => '');
    const config = configWith(`services:\n  db:\n    image: ${DIGEST}\n    ports: [5432]\n`);
    const prepared = await prepare(engine, { ...testPlan(root, [], config), os: 'macos' });
    expect(prepared.env).toEqual({ TALOS_RENDERED_VERSION: '9.9.9' });
    expect(calls).toEqual([]);
    expect(warnings).toEqual(['services run on Linux only; macos runs without them']);
    await prepared.release();
    expect(calls).toEqual([]);
  });
});

describe('prepare: removing services', () => {
  const failed: ExecResult = { code: 1, stdout: '', stderr: 'boom' };
  const removals = (calls: readonly Call[]): string[] =>
    calls.filter((c) => c.args[0] === 'rm').map((c) => c.args.join(' '));

  it('removes the services it started when a later step throws, and stops listening for signals', async () => {
    const port = await listening();
    const root = await tempRepo({});
    const { engine, calls } = engineWith((call) =>
      call.command === 'bash' ? failed : docker('svc-1', port)(call),
    );
    const config = configWith(
      `services:\n  db:\n    image: ${DIGEST}\n    ports: [${port}]\nsetup: scripts/setup.sh\n`,
    );
    const signalListeners = (): number[] =>
      ['SIGINT', 'SIGTERM'].map((s) => process.listenerCount(s));
    const before = signalListeners();
    await expect(prepare(engine, testPlan(root, [], config))).rejects.toThrow(/exited 1:\nboom/);
    expect(removals(calls)).toEqual(['rm -f svc-1']);
    expect(signalListeners()).toEqual(before);
  });

  it('removes the services already up when a later one fails to start', async () => {
    const port = await listening();
    const root = await tempRepo({});
    const { engine, calls } = engineWith((call) =>
      call.args.includes(OTHER) ? failed : docker('svc-1', port)(call),
    );
    const config = configWith(
      [
        'services:',
        `  first:\n    image: ${DIGEST}\n    ports: [${port}]`,
        `  second:\n    image: ${OTHER}\n    ports: [${port}]`,
        '',
      ].join('\n'),
    );
    await expect(prepare(engine, testPlan(root, [], config))).rejects.toThrow(/exited 1/);
    expect(removals(calls)).toEqual(['rm -f svc-1']);
  });

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'removes the services on %s, then ends as the signal would have',
    async (signal) => {
      const port = await listening();
      const root = await tempRepo({});
      const { engine, calls } = engineWith(docker('svc-1', port));
      const config = configWith(`services:\n  db:\n    image: ${DIGEST}\n    ports: [${port}]\n`);
      const prepared = await prepare(engine, testPlan(root, [], config));
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      try {
        process.emit(signal, signal);
        await vi.waitFor(() => {
          expect(kill).toHaveBeenCalledWith(process.pid, signal);
        });
        expect(removals(calls)).toEqual(['rm -f svc-1']);
        await prepared.release();
        expect(removals(calls)).toEqual(['rm -f svc-1']);
      } finally {
        kill.mockRestore();
      }
    },
  );

  it('removes a service whose docker run had not answered when the signal came, starting no more', async () => {
    const port = await listening();
    const root = await tempRepo({});
    const answerRun: ((id: string) => void)[] = [];
    const running = new Promise<string>((resolve) => {
      answerRun.push(resolve);
    });
    const { engine, calls } = engineWith((call) =>
      call.args[0] === 'run' && call.args.includes(DIGEST) ? running : docker('svc-1', port)(call),
    );
    const config = configWith(
      [
        'services:',
        `  first:\n    image: ${DIGEST}\n    ports: [${port}]`,
        `  second:\n    image: ${OTHER}\n    ports: [${port}]`,
        '',
      ].join('\n'),
    );
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const preparing = prepare(engine, testPlan(root, [], config));
      await vi.waitFor(() => {
        expect(calls).toHaveLength(1);
      });
      process.emit('SIGTERM', 'SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(calls).toHaveLength(1);
      expect(kill).not.toHaveBeenCalled();
      answerRun[0]?.('svc-1\n');
      await expect(preparing).rejects.toThrow('the run is stopping: no further service starts');
      await vi.waitFor(() => {
        expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
      });
      expect(calls.map((c) => c.args[0])).toEqual(['run', 'port', 'ps', 'rm']);
      expect(removals(calls)).toEqual(['rm -f svc-1']);
    } finally {
      kill.mockRestore();
    }
  });

  it('warns about a container it could not remove', async () => {
    const port = await listening();
    const root = await tempRepo({});
    const { engine, warnings } = engineWith((call) =>
      call.args[0] === 'rm' ? failed : docker('svc-1', port)(call),
    );
    const config = configWith(`services:\n  db:\n    image: ${DIGEST}\n    ports: [${port}]\n`);
    await (await prepare(engine, testPlan(root, [], config))).release();
    expect(warnings).toEqual(['could not remove service containers svc-1: boom']);
  });
});

describe('prepare: setup and installs', () => {
  /** The shell each setup run went to, with `ProgramFiles` naming `programs` meanwhile. */
  async function setupShells(programs: string): Promise<{ root: string; calls: Call[] }> {
    const saved = process.env.ProgramFiles;
    process.env.ProgramFiles = programs;
    try {
      const root = await tempRepo({});
      const { engine, calls } = engineWith(() => '');
      const config = configWith('setup: scripts/setup.sh\n');
      await prepare(engine, testPlan(root, [], config));
      await prepare(engine, { ...testPlan(root, [], config), os: 'windows' });
      return { root, calls };
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, 'ProgramFiles');
      else process.env.ProgramFiles = saved;
    }
  }

  it("runs the setup script with the services' environment, and bash.exe without Git Bash", async () => {
    const { root, calls } = await setupShells(await tempRepo({}));
    expect(calls.map((c) => [c.command, ...c.args])).toEqual([
      ['bash', join(root, 'scripts/setup.sh')],
      ['bash.exe', join(root, 'scripts/setup.sh').replaceAll('\\', '/')],
    ]);
    expect(calls[0]?.env).toEqual({});
  });

  it('runs the setup script through the Git Bash in ProgramFiles on Windows', async () => {
    const programs = await tempRepo({ 'Git/bin/bash.exe': '' });
    const { calls } = await setupShells(programs);
    expect(calls[1]?.command).toBe(join(programs, 'Git', 'bin', 'bash.exe'));
  });

  it('gives bash a setup script path with forward slashes on Windows', async () => {
    const { engine, calls } = engineWith(() => '');
    const config = configWith('setup: .github/talos-setup.sh\n');
    const root = String.raw`C:\Users\me\worktrees\Repo-1\.talos\worktrees\abc-1`;
    await prepare(engine, { ...testPlan(root, [], config), os: 'windows' });
    expect(calls.map((c) => c.args)).toEqual([
      ['C:/Users/me/worktrees/Repo-1/.talos/worktrees/abc-1/.github/talos-setup.sh'],
    ]);
  });

  it('runs a base commit without the setup script it lacks, and says so', async () => {
    const root = await tempRepo({ 'old/setup.sh': 'true\n' });
    const { engine, calls, warnings } = engineWith(() => '');
    const missing = testPlan(root, [], configWith('setup: scripts/setup.sh\n'));
    const without = await prepare(engine, { ...missing, side: 'base' });
    expect(without.withoutSetup).toBe('scripts/setup.sh');
    expect(calls).toEqual([]);
    expect(warnings).toEqual([
      'the base commit has no scripts/setup.sh, the setup script talos.yml names: ' +
        'its run goes without one',
    ]);
    const present = testPlan(root, [], configWith('setup: old/setup.sh\n'));
    expect((await prepare(engine, { ...present, side: 'base' })).withoutSetup).toBeUndefined();
    expect((await prepare(engine, { ...missing, side: 'head' })).withoutSetup).toBeUndefined();
    expect(calls.map((c) => c.args)).toEqual([
      [join(root, 'old/setup.sh')],
      [join(root, 'scripts/setup.sh')],
    ]);
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
      ['ts@broken', 'installing ts at broken: npm ci failed'],
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

  const extended: Pack[] = [
    {
      name: 'ext',
      checks: [],
      generated: [
        {
          path: 'lint.config.js',
          scope: 'component',
          langs: ['ts'],
          applies: () => true,
          render: () => "import project from './lint.project.js';\n",
          extension: {
            path: 'lint.project.js',
            initial: (ctx) => `export default []; // ${ctx.component?.root ?? ''}\n`,
          },
        },
      ],
    },
  ];
  const twoComponents = configWith(
    'components:\n  - { lang: ts, root: . }\n  - { lang: ts, root: web }\n',
  );

  it('gives a base commit each extension file it lacks as adoption writes it, keeping its own', async () => {
    const root = await tempRepo({ 'web/lint.project.js': 'export default [strict];\n' });
    const { engine } = engineWith(() => '', extended);
    await prepare(engine, { ...testPlan(root, [], twoComponents), side: 'base' });
    expect(await readFile(join(root, 'lint.project.js'), 'utf8')).toBe('export default []; // .\n');
    expect(await readFile(join(root, 'web/lint.project.js'), 'utf8')).toBe(
      'export default [strict];\n',
    );
  });

  it('tells the checks, through the environment, which version rendered the files', async () => {
    const root = await tempRepo({});
    const { engine } = engineWith(() => '', packs);
    const prepared = await prepare(engine, testPlan(root, [], configWith('')));
    expect(await readFile(join(root, 'base.json'), 'utf8')).toBe('repo 9.9.9\n');
    expect(prepared.env[RENDERED_VERSION]).toBe('9.9.9');
    expect(process.env[RENDERED_VERSION]).toBe('9.9.9');
  });

  it('leaves a missing extension file missing outside a base run', async () => {
    const root = await tempRepo({});
    const { engine } = engineWith(() => '', extended);
    for (const side of ['head', 'alone'] as const) {
      await prepare(engine, { ...testPlan(root, [], twoComponents), side });
    }
    await expect(readFile(join(root, 'lint.project.js'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(root, 'web/lint.project.js'), 'utf8')).rejects.toThrow();
  });
});
