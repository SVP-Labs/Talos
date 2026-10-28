import { execFile, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { auditProblems, auditSignatures, lockedIntegrity, npmArguments } from './install.js';
import { selectChannelPin, selectPin } from './pin.js';
import {
  decodeProvenance,
  type ExpectedBuild,
  integrityHex,
  packageUrl,
  provenanceProblems,
  SLSA_PROVENANCE_V1,
} from './provenance.js';
import * as bootstrap from '../../bootstrap/launch.js';
import type { Ruleset } from '../github/rulesets.js';

/** The dependency-free scripts the workflows run before Talos is installed. */
const BOOTSTRAP = fileURLToPath(new URL('../../bootstrap/', import.meta.url));

const recorded: unknown = JSON.parse(
  readFileSync(new URL('fixtures/sigstore-core-4.0.1.attestations.json', import.meta.url), 'utf8'),
);
const RECORDED: ExpectedBuild = {
  name: '@sigstore/core',
  version: '4.0.1',
  repository: 'sigstore/sigstore-js',
  commit: 'd406ea60b342ca37cdeecd7afedb992cd189db92',
  integrity:
    'sha512-9v5hRjujn5NXq8o7XFEUgLyAtdr5Iisb4pzM05u3K61IS5q3hP3luWAndk0RkPPLTUFoTbg7Vb84UQ1ZQeajWQ==',
};

function wrap(statement: unknown): unknown {
  return {
    attestations: [
      {
        predicateType: SLSA_PROVENANCE_V1,
        bundle: {
          dsseEnvelope: {
            payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
            payloadType: 'application/vnd.in-toto+json',
          },
        },
      },
    ],
  };
}

type Verdict = { readonly refused: boolean; readonly problems: readonly string[] };

function verdictOf(judge: () => string[]): Verdict {
  try {
    return { refused: false, problems: judge() };
  } catch {
    return { refused: true, problems: [] };
  }
}

/** Both implementations' verdict on one response: its problems, or the refusal to read it. */
function verdicts(response: unknown, expected: ExpectedBuild): [Verdict, Verdict] {
  return [
    verdictOf(() => provenanceProblems(decodeProvenance(response), expected)),
    verdictOf(() => bootstrap.provenanceProblems(bootstrap.readStatement(response), expected)),
  ];
}

describe('bootstrap/launch.ts agrees with the engine', () => {
  const recordedStatement: unknown = JSON.parse(
    Buffer.from(
      (
        recorded as {
          attestations: { predicateType: string; bundle: { dsseEnvelope: { payload: string } } }[];
        }
      ).attestations.find((a) => a.predicateType === SLSA_PROVENANCE_V1)?.bundle.dsseEnvelope
        .payload ?? '',
      'base64',
    ).toString('utf8'),
  );

  const cases: [string, unknown, ExpectedBuild][] = [
    ['the recorded build', recorded, RECORDED],
    ['another commit', recorded, { ...RECORDED, commit: 'a'.repeat(40) }],
    ['another repository', recorded, { ...RECORDED, repository: 'SVP-Labs/Talos' }],
    ['another version', recorded, { ...RECORDED, version: '4.0.2' }],
    [
      'another tarball',
      recorded,
      { ...RECORDED, integrity: `sha512-${Buffer.alloc(64).toString('base64')}` },
    ],
    ['a broken integrity', recorded, { ...RECORDED, integrity: 'sha1-x' }],
    ['no attestations', {}, RECORDED],
    ['an empty list', { attestations: [] }, RECORDED],
    [
      'a statement of another type',
      wrap({ ...(recordedStatement as object), _type: 'x' }),
      RECORDED,
    ],
    [
      'a statement without a predicate',
      wrap({ ...(recordedStatement as object), predicate: {} }),
      RECORDED,
    ],
    [
      'a digest that is not a string',
      wrap({
        ...(recordedStatement as object),
        subject: [{ name: packageUrl(RECORDED.name, RECORDED.version), digest: { sha512: 5 } }],
      }),
      RECORDED,
    ],
    [
      'a payload that is not JSON',
      {
        attestations: [
          {
            predicateType: SLSA_PROVENANCE_V1,
            bundle: {
              dsseEnvelope: { payload: 'bm9wZQ==', payloadType: 'application/vnd.in-toto+json' },
            },
          },
        ],
      },
      RECORDED,
    ],
  ];

  for (const [name, response, expected] of cases) {
    it(`on ${name}`, () => {
      const [ours, theirs] = verdicts(response, expected);
      expect(theirs).toEqual(ours);
    });
  }

  it('on integrity, package URLs, audits and lockfiles', () => {
    for (const value of [
      RECORDED.integrity,
      'sha1-x',
      'sha512-AAAA',
      '',
      ` x ${RECORDED.integrity}`,
    ]) {
      expect(bootstrap.integrityHex(value)).toBe(integrityHex(value));
    }
    expect(bootstrap.integrityHex(42)).toBeUndefined();
    expect(bootstrap.packageUrl('@svp-labs/talos', '1.0.0')).toBe(
      packageUrl('@svp-labs/talos', '1.0.0'),
    );
    for (const [code, stdout] of [
      [0, '{"invalid":[],"missing":[]}'],
      [1, '{"invalid":[1],"missing":[2]}'],
      [1, '{"invalid":[],"missing":[]}'],
      [1, 'x'],
      [0, '{"invalid":3}'],
    ] as const) {
      expect(bootstrap.auditProblems(code, stdout)).toEqual(auditProblems(code, stdout));
    }
    const lock = {
      packages: { 'node_modules/@svp-labs/talos': { version: '1.0.0', integrity: 'sha512-x' } },
    };
    for (const [value, version] of [
      [lock, '1.0.0'],
      [lock, '1.0.1'],
      [{}, '1.0.0'],
      [null, '1.0.0'],
    ] as const) {
      expect(bootstrap.lockedIntegrity(value, version)).toBe(lockedIntegrity(value, version));
    }
  });
});

const HEAD = 'e'.repeat(40);
const BRANCH = 'f'.repeat(40);

function checkout(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'talos-kit-test-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe('bootstrap: the checkout it runs from', () => {
  it('reads a detached HEAD, a loose ref and a packed ref', () => {
    expect(bootstrap.headCommit(checkout({ '.git/HEAD': `${HEAD}\n` }))).toBe(HEAD);
    const loose = checkout({
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.git/refs/heads/main': `${BRANCH}\n`,
    });
    expect(bootstrap.headCommit(loose)).toBe(BRANCH);
    const packed = checkout({
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.git/packed-refs': `# pack-refs with: peeled\n${HEAD} refs/heads/other\n${BRANCH} refs/heads/main\n`,
    });
    expect(bootstrap.headCommit(packed)).toBe(BRANCH);
  });

  it('follows a .git file to the repository it names', () => {
    const repo = checkout({ 'store/HEAD': `${HEAD}\n` });
    const worktree = checkout({ '.git': `gitdir: ${join(repo, 'store')}\n` });
    expect(bootstrap.headCommit(worktree)).toBe(HEAD);
  });

  it('has no commit for anything else', () => {
    expect(bootstrap.headCommit(checkout({}))).toBeUndefined();
    expect(bootstrap.headCommit(checkout({ '.git/HEAD': 'garbage' }))).toBeUndefined();
    expect(bootstrap.headCommit(checkout({ '.git/HEAD': 'ref: refs/heads/gone' }))).toBeUndefined();
    const bad = checkout({ '.git/HEAD': 'ref: refs/heads/main', '.git/refs/heads/main': 'nope' });
    expect(bootstrap.headCommit(bad)).toBeUndefined();
  });

  it("reads a Talos checkout's release and refuses anything else", () => {
    const kit = checkout({
      'package.json': JSON.stringify({ name: '@svp-labs/talos', version: '1.2.0' }),
      '.git/HEAD': HEAD,
    });
    expect(bootstrap.kitRelease(kit)).toEqual({ version: '1.2.0', sha: HEAD });
    const other = checkout({
      'package.json': JSON.stringify({ name: 'x', version: '1.2.0' }),
      '.git/HEAD': HEAD,
    });
    expect(() => bootstrap.kitRelease(other)).toThrow('not a Talos release');
    const listed = checkout({
      'package.json': JSON.stringify({ name: '@svp-labs/talos', version: ['1.2.0'] }),
      '.git/HEAD': HEAD,
    });
    expect(() => bootstrap.kitRelease(listed)).toThrow('not a Talos release');
    const noCommit = checkout({
      'package.json': JSON.stringify({ name: '@svp-labs/talos', version: '1.2.0' }),
    });
    expect(() => bootstrap.kitRelease(noCommit)).toThrow('no commit');
  });

  it('finds npm beside the running Node, not on PATH', () => {
    const found = bootstrap.npmCli(process.execPath, process.platform, {});
    expect(found === undefined || found.endsWith(join('npm', 'bin', 'npm-cli.js'))).toBe(true);
    expect(bootstrap.npmCli('/nowhere/bin/node', 'linux', {})).toBeUndefined();
    expect(bootstrap.npmCli('/nowhere/node.exe', 'win32', { npm_execpath: BOOTSTRAP })).toBe(
      BOOTSTRAP,
    );
  });
});

type AuditRun = { readonly status: number | null; readonly stdout: string | null };

const CLEAN: AuditRun = { status: 0, stdout: '{"invalid":[],"missing":[]}' };

function report(invalid: readonly unknown[], missing: readonly unknown[] = []): AuditRun {
  return { status: 1, stdout: JSON.stringify({ invalid, missing }) };
}

const RACED = {
  code: 'EATTESTATIONVERIFY',
  name: '@sigstore/core',
  version: '3.1.0',
  message: 'Unterminated string in JSON at position 4096',
};

/** `npm audit signatures` answering each run with the next of `runs`, and what it logged. */
function audits(...runs: AuditRun[]): {
  problems: () => string[];
  calls: () => number;
  logged: string[];
} {
  let calls = 0;
  const logged: string[] = [];
  const audit = (): AuditRun => {
    const run = runs[calls];
    calls += 1;
    if (run === undefined) throw new Error(`no audit run ${calls} expected`);
    return run;
  };
  return {
    problems: () => bootstrap.auditSignatures(audit, (line) => logged.push(line)),
    calls: () => calls,
    logged,
  };
}

/** The engine's verdict on the same runs; an audit that never started is exit 1, no output. */
async function engineAudits(
  ...runs: AuditRun[]
): Promise<{ problems: string[]; calls: number; logged: string[] }> {
  let calls = 0;
  const logged: string[] = [];
  const problems = await auditSignatures(
    () => {
      const run = runs[calls];
      calls += 1;
      if (run === undefined) throw new Error(`no audit run ${calls} expected`);
      return Promise.resolve({ code: run.status ?? 1, stdout: run.stdout ?? '' });
    },
    (line) => logged.push(line),
  );
  return { problems, calls, logged };
}

describe('bootstrap/launch.ts audits signatures as the engine does', () => {
  const many = Array.from({ length: 23 }, (_, i) => ({ name: `p${i}`, version: '1.0.0' }));
  const cases: [string, AuditRun[]][] = [
    ['a clean audit', [CLEAN]],
    ['a race the second audit clears', [report([RACED]), CLEAN]],
    ['invalid signatures twice', [report([RACED]), report([RACED]), CLEAN]],
    ['missing signatures on the second audit', [report([RACED]), report([], [RACED]), CLEAN]],
    ['missing signatures', [report([], [RACED]), CLEAN]],
    ['invalid and missing signatures', [report([RACED], [RACED]), CLEAN]],
    ['an audit that never started', [{ status: null, stdout: null }, CLEAN]],
    ['a report without its missing list', [{ status: 1, stdout: '{"invalid":[1]}' }, CLEAN]],
    ['a clean report and exit 1', [{ ...CLEAN, status: 1 }, CLEAN]],
    [
      'packages without the shape npm gives them',
      [report([{ code: 'x y', name: 'a b', version: '1' }, 'entry'], many), CLEAN],
    ],
  ];

  for (const [name, runs] of cases) {
    it(`on ${name}`, async () => {
      const ours = audits(...runs);
      const theirs = { problems: ours.problems(), calls: ours.calls(), logged: ours.logged };
      expect(theirs).toEqual(await engineAudits(...runs));
    });
  }

  it("gives npm the same cache of the run's own", () => {
    const directory = join(tmpdir(), 'talos-x');
    const args = ['install', '--ignore-scripts', '@svp-labs/talos@1.2.0'];
    expect(bootstrap.npmArguments(args, directory)).toEqual(npmArguments(args, directory));
  });
});

describe('bootstrap: npm audit signatures', () => {
  it('audits once when every signature verifies', () => {
    const npm = audits(CLEAN);
    expect(npm.problems()).toEqual([]);
    expect(npm.calls()).toBe(1);
    expect(npm.logged).toEqual([]);
  });

  it('passes when an audit that found invalid signatures is clean the second time', () => {
    const npm = audits(report([RACED]), CLEAN);
    expect(npm.problems()).toEqual([]);
    expect(npm.calls()).toBe(2);
    expect(npm.logged).toEqual([
      'npm audit signatures: invalid: @sigstore/core@3.1.0 (EATTESTATIONVERIFY)',
      'npm audit signatures found invalid signatures only: auditing once more',
    ]);
  });

  it('refuses when the second audit finds invalid signatures too, and audits no third time', () => {
    const bad = { code: 'EINTEGRITYSIGNATURE', name: 'left-pad', version: '1.3.0' };
    const npm = audits(report([RACED]), report([bad]), CLEAN);
    expect(npm.problems()).toEqual(['1 invalid signatures']);
    expect(npm.calls()).toBe(2);
    expect(npm.logged).toEqual([
      'npm audit signatures: invalid: @sigstore/core@3.1.0 (EATTESTATIONVERIFY)',
      'npm audit signatures found invalid signatures only: auditing once more',
      'npm audit signatures: invalid: left-pad@1.3.0 (EINTEGRITYSIGNATURE)',
    ]);
  });

  it('refuses when the second audit fails in any other way', () => {
    expect(audits(report([RACED]), report([], [RACED])).problems()).toEqual([
      '1 missing signatures',
    ]);
    expect(audits(report([RACED]), { status: 1, stdout: 'npm ERR!' }).problems()).toEqual([
      'npm audit signatures exited 1 without a readable report',
    ]);
    expect(audits(report([RACED]), { ...CLEAN, status: 1 }).problems()).toEqual([
      'npm audit signatures exited 1',
    ]);
  });

  it('audits once more for nothing but invalid signatures', () => {
    const missing = { name: 'left-pad', version: '1.3.0' };
    const cases: [AuditRun, string[]][] = [
      [report([], [missing]), ['1 missing signatures']],
      [report([RACED], [missing]), ['1 invalid signatures', '1 missing signatures']],
      [{ ...CLEAN, status: 1 }, ['npm audit signatures exited 1']],
      [{ status: null, stdout: null }, ['npm audit signatures exited 1 without a readable report']],
      [
        { status: 1, stdout: '{"invalid":"x","missing":[]}' },
        ['npm audit signatures exited 1 without a readable report'],
      ],
      [
        { status: 1, stdout: JSON.stringify({ invalid: [RACED] }) },
        ['npm audit signatures exited 1 without a readable report'],
      ],
    ];
    for (const [run, problems] of cases) {
      const npm = audits(run, CLEAN);
      expect(npm.problems()).toEqual(problems);
      expect(npm.calls()).toBe(1);
      expect(npm.logged).not.toContain(
        'npm audit signatures found invalid signatures only: auditing once more',
      );
    }
  });

  it('names each package it objects to, and nothing that lacks the shape npm gives it', () => {
    const npm = audits(
      report(
        [
          RACED,
          { code: 'EATTESTATIONVERIFY', name: 'secret org/repo', version: '1.0.0' },
          { code: 'nope: look here', name: 'ok', version: '1.0.0' },
          { name: 'ok', version: 'one' },
          'not an entry',
        ],
        [{ name: 'left-pad', version: '1.3.0' }],
      ),
    );
    expect(npm.problems()).toEqual(['5 invalid signatures', '1 missing signatures']);
    expect(npm.logged).toEqual([
      'npm audit signatures: invalid: @sigstore/core@3.1.0 (EATTESTATIONVERIFY)',
      'npm audit signatures: invalid: a package npm did not name (EATTESTATIONVERIFY)',
      'npm audit signatures: invalid: ok@1.0.0',
      'npm audit signatures: invalid: a package npm did not name',
      'npm audit signatures: invalid: a package npm did not name',
      'npm audit signatures: missing: left-pad@1.3.0',
    ]);
    expect(npm.logged.join('\n')).not.toContain('Unterminated');
  });

  it('names at most twenty packages of each kind', () => {
    const many = Array.from({ length: 23 }, (_, i) => ({ name: `p${i}`, version: '1.0.0' }));
    const npm = audits(report([], many));
    npm.problems();
    expect(npm.logged).toHaveLength(21);
    expect(npm.logged.at(19)).toBe('npm audit signatures: missing: p19@1.0.0');
    expect(npm.logged.at(20)).toBe('npm audit signatures: missing: 3 more');
  });

  it("gives npm a cache of the run's own, inside its directory", () => {
    const directory = join(tmpdir(), 'talos-x');
    expect(bootstrap.npmArguments(['audit', 'signatures', '--json'], directory)).toEqual([
      'audit',
      'signatures',
      '--json',
      '--cache',
      join(directory, 'npm-cache'),
    ]);
  });
});

describe('bootstrap/launch.ts as a workflow runs it', () => {
  it('runs under plain node, with no loader, and refuses a checkout that is no release', () => {
    const kit = checkout({
      'package.json': JSON.stringify({ name: 'x', version: '1.2.0', type: 'module' }),
      '.git/HEAD': HEAD,
    });
    mkdirSync(join(kit, 'bootstrap'));
    const launcher = join(kit, 'bootstrap', 'launch.ts');
    copyFileSync(join(BOOTSTRAP, 'launch.ts'), launcher);
    // Plain node, as a workflow runs it: no loader, and no NODE_* setting that makes Node speak.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('NODE_')),
    );
    const ran = spawnSync(process.execPath, [launcher], { cwd: kit, env, encoding: 'utf8' });
    expect({ code: ran.status, stdout: ran.stdout, stderr: ran.stderr }).toEqual({
      code: 2,
      stdout: '',
      stderr: 'talos bootstrap: refused: the checkout is not a Talos release\n',
    });
  });
});

/** Runs a program found on PATH; tests only. */
async function run(
  command: string,
  args: readonly string[],
  env: Record<string, string | undefined> = process.env,
): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await promisify(execFile)(command, [...args], { env, encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { code: typeof code === 'number' ? code : 127, stdout: '' };
  }
}

async function hasTool(command: string): Promise<boolean> {
  return (await run(command, ['--version'])).code === 0;
}

const canRunScripts = (await hasTool('bash')) && (await hasTool('jq'));

const TALOS_ID = 900;

/** A file as GitHub's contents API answers it: base64 wrapped at 60 characters. */
function contentsOf(text: string): { content: string; encoding: string } {
  const base64 = Buffer.from(text).toString('base64');
  return { content: `${base64.replaceAll(/.{60}/g, '$&\n')}\n`, encoding: 'base64' };
}

/**
 * `gh` as find-pin.sh calls it: `gh api [--paginate] [-H <accept>] <path>`, answered from files;
 * with the raw media type, a contents answer is its file's text, as GitHub sends it.
 */
function fakeGh(answers: Record<string, unknown>): string {
  const directory = mkdtempSync(join(tmpdir(), 'talos-fake-gh-'));
  const answersDir = join(directory, 'answers');
  mkdirSync(answersDir);
  for (const [path, body] of Object.entries(answers)) {
    const file = join(answersDir, path.replaceAll(/[/?=&]/g, '_'));
    writeFileSync(file, JSON.stringify(body));
    if (typeof body === 'object' && body !== null && 'content' in body) {
      writeFileSync(`${file}.raw`, Buffer.from(String(body.content), 'base64'));
    }
  }
  const script = [
    '#!/usr/bin/env bash',
    'path="" raw=""',
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    api | --paginate | -H) ;;',
    '    "Accept: application/vnd.github.raw") raw=".raw" ;;',
    '    *) path="$arg" ;;',
    '  esac',
    'done',
    `file="${answersDir}/$(printf '%s' "$path" | tr '/?=&' '____')$raw"`,
    '[ -f "$file" ] || { echo "HTTP 404: $path" >&2; exit 1; }',
    'cat "$file"',
  ].join('\n');
  writeFileSync(join(directory, 'gh'), `${script}\n`);
  chmodSync(join(directory, 'gh'), 0o755);
  return directory;
}

async function findPin(
  answers: Record<string, unknown>,
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string }> {
  const bin = fakeGh(answers);
  return run('bash', [join(BOOTSTRAP, 'find-pin.sh')], {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
    GITHUB_REPOSITORY: 'o/r',
    ...env,
  });
}

function rulesetJson(id: number, name: string, enforcement: string, workflows: object[]): Ruleset {
  return { id, name, enforcement, rules: [{ type: 'workflows', parameters: { workflows } }] };
}

const scenarios: Record<string, Ruleset[]> = {
  'one active pin': [
    rulesetJson(1, 'talos-canary', 'active', [
      { path: 'g.yml', repository_id: TALOS_ID, sha: HEAD },
    ]),
  ],
  'an evaluate pin beside a disabled one': [
    rulesetJson(1, 'talos-stable', 'disabled', [
      { path: 'g.yml', repository_id: TALOS_ID, sha: BRANCH },
    ]),
    rulesetJson(2, 'talos-evaluate', 'evaluate', [
      { path: 'g.yml', repository_id: TALOS_ID, sha: HEAD },
    ]),
  ],
  'no Talos ruleset': [
    rulesetJson(1, 'other', 'active', [{ path: 'g.yml', repository_id: 5, sha: HEAD }]),
  ],
  'two Talos rulesets': [
    rulesetJson(1, 'talos-canary', 'active', [
      { path: 'g.yml', repository_id: TALOS_ID, sha: HEAD },
    ]),
    rulesetJson(2, 'talos-stable', 'active', [
      { path: 'g.yml', repository_id: TALOS_ID, sha: HEAD },
    ]),
  ],
  'two commits in one ruleset': [
    rulesetJson(1, 'talos-canary', 'active', [
      { path: 'g.yml', repository_id: TALOS_ID, sha: HEAD },
      { path: 'h.yml', repository_id: TALOS_ID, sha: BRANCH },
    ]),
  ],
  'a ref instead of a commit': [
    rulesetJson(1, 'talos-canary', 'active', [
      { path: 'g.yml', repository_id: TALOS_ID, ref: 'v1' },
    ]),
  ],
};

describe.skipIf(!canRunScripts)('bootstrap/find-pin.sh agrees with selectPin', () => {
  for (const [name, rulesets] of Object.entries(scenarios)) {
    it(`for ${name}`, async () => {
      const answers: Record<string, unknown> = {
        'repos/SVP-Labs/Talos': { id: TALOS_ID },
        'repos/o/r/rulesets?includes_parents=true': rulesets.map(
          ({ id, name: n, enforcement }) => ({ id, name: n, enforcement }),
        ),
      };
      for (const ruleset of rulesets) {
        answers[`repos/o/r/rulesets/${ruleset.id}?includes_parents=true`] = ruleset;
      }
      const lookup = selectPin(rulesets, TALOS_ID);
      const result = await findPin(answers);
      expect(result).toEqual(
        lookup.found ? { code: 0, stdout: `${lookup.pin.sha}\n` } : { code: 1, stdout: '' },
      );
    });
  }

  it('reads channels.json in channels mode, however GitHub wraps its base64', async () => {
    const channels = { evaluate: BRANCH, canary: HEAD, stable: BRANCH };
    const answers = {
      'repos/o/r': { id: 1, custom_properties: { talos: 'canary' } },
      'repos/SVP-Labs/Talos/contents/channels.json?ref=channels': contentsOf(
        JSON.stringify(channels, null, 2),
      ),
    };
    expect(await findPin(answers, { TALOS_LOOKUP: 'channels' })).toEqual({
      code: 0,
      stdout: `${HEAD}\n`,
    });
    const lookup = selectChannelPin('canary', channels);
    expect(lookup.found && lookup.pin.sha).toBe(HEAD);
    const noChannel = { ...answers, 'repos/o/r': { id: 1, custom_properties: {} } };
    expect((await findPin(noChannel, { TALOS_LOOKUP: 'channels' })).code).toBe(1);
  });

  it('fails without a repository, an API answer or a known mode', async () => {
    expect((await findPin({}, { GITHUB_REPOSITORY: '' })).code).toBe(1);
    expect((await findPin({})).code).toBe(1);
    expect((await findPin({}, { TALOS_LOOKUP: 'branch' })).code).toBe(1);
  });
});
