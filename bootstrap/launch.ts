#!/usr/bin/env node
/**
 * Runs Talos at the release this checkout of the Talos repository is at, for workflows that have
 * no Talos yet. The checkout is at the pinned commit; this reads its own `package.json` version,
 * installs `@svp-labs/talos@<version>` with npm (no install scripts), has `npm audit signatures`
 * verify the registry's signatures and attestations, refuses the package unless its SLSA
 * provenance names the Talos repository, this checkout's HEAD and the installed tarball, then
 * runs it with the given arguments and exits with its code.
 *
 * Dependency-free on purpose: nothing is installed before it runs, and Node runs this file as it
 * is, stripping its types, so it holds only syntax that erases (no enums, namespaces or parameter
 * properties). What it reads from npm and the registry is narrowed by hand, field by field. It
 * prints nothing of its own but one generic line when it refuses, since npm's messages can name
 * things a public log must not show. Neither npm nor git is looked up on PATH: npm is the one
 * beside the running Node, and HEAD is read from the checkout's files.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PACKAGE = '@svp-labs/talos';
export const SOURCE = 'SVP-Labs/Talos';
const PROVENANCE = 'https://slsa.dev/provenance/v1';
const STATEMENT = 'https://in-toto.io/Statement/v1';
const PAYLOAD = 'application/vnd.in-toto+json';
const GITHUB = 'https://github.com/';
const REGISTRY = 'https://registry.npmjs.org';
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SHA512 = 'sha512-';

type Env = Readonly<Record<string, string | undefined>>;

/** A parsed JSON object: any field may hold anything. */
type JsonObject = Readonly<Record<string, unknown>>;

/** The DSSE envelope of an attestation, as far as it has been checked. */
type Envelope = { readonly payload: string; readonly payloadType?: unknown };

type BuildDefinition = {
  readonly resolvedDependencies: readonly unknown[];
  readonly externalParameters: { readonly workflow: { readonly repository: string } };
};

/** The parts of an in-toto statement of SLSA provenance this reads, as far as it checks them. */
type Statement = {
  readonly subject: readonly unknown[];
  readonly predicate: { readonly buildDefinition: BuildDefinition };
};

/** The build a release must come from. */
type Expected = {
  readonly name: string;
  readonly version: string;
  /** `owner/name`. */
  readonly repository: string;
  readonly commit: string;
  /** The installed tarball's integrity, from the lockfile. */
  readonly integrity: string;
};

type Release = { readonly version: string; readonly sha: string };

/** How an npm run ended; its status and output are null when it never started. */
type NpmRun = { readonly status: number | null; readonly stdout: string | null };

export class Refusal extends Error {
  override name = 'Refusal';
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** A parsed JSON value's field, as `value?.[key]` reads it: undefined unless it is an object. */
function field(value: unknown, key: string): unknown {
  return isObject(value) ? value[key] : undefined;
}

/**
 * A parsed JSON value in lower case, as `value?.toLowerCase()` reads it: undefined when there is
 * none, and a throw when it is there but not a string.
 */
function lowerCase(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new TypeError('expected a string');
  return value.toLowerCase();
}

function isEnvelope(value: unknown): value is Envelope {
  return isObject(value) && typeof value.payload === 'string';
}

/** The SHA-512 of a Subresource Integrity string as hex, or undefined. */
export function integrityHex(integrity: unknown): string | undefined {
  if (typeof integrity !== 'string') return undefined;
  const parts = integrity.trim().split(/\s+/);
  const base64 = parts.find((part) => part.startsWith(SHA512))?.slice(SHA512.length);
  const bytes = base64 === undefined ? undefined : Buffer.from(base64, 'base64');
  return bytes?.length === 64 ? bytes.toString('hex') : undefined;
}

export function packageUrl(name: string, version: string): string {
  return `pkg:npm/${name.replace(/^@/, '%40')}@${version}`;
}

function provenanceEnvelope(response: unknown): Envelope {
  const attestations = field(response, 'attestations');
  if (!isList(attestations)) throw new Refusal('the registry returned no attestations');
  const provenance = attestations.filter((a) => field(a, 'predicateType') === PROVENANCE);
  const envelope =
    provenance.length === 1 ? field(field(provenance[0], 'bundle'), 'dsseEnvelope') : undefined;
  if (!isEnvelope(envelope)) {
    throw new Refusal(`expected one SLSA provenance attestation, found ${provenance.length}`);
  }
  if (envelope.payloadType !== PAYLOAD) throw new Refusal('the provenance is not in-toto');
  return envelope;
}

function isProvenanceStatement(statement: unknown): statement is Statement {
  const definition = field(field(statement, 'predicate'), 'buildDefinition');
  const workflow = field(field(definition, 'externalParameters'), 'workflow');
  return (
    isObject(statement) &&
    statement._type === STATEMENT &&
    statement.predicateType === PROVENANCE &&
    isList(statement.subject) &&
    isList(field(definition, 'resolvedDependencies')) &&
    typeof field(workflow, 'repository') === 'string'
  );
}

/** The in-toto statement of the SLSA provenance among npm's attestations for a version. */
export function readStatement(response: unknown): Statement {
  const envelope = provenanceEnvelope(response);
  let statement: unknown;
  try {
    statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
  } catch {
    throw new Refusal('the provenance payload is not JSON');
  }
  if (!isProvenanceStatement(statement)) {
    throw new Refusal('the provenance is not an in-toto statement of SLSA provenance v1');
  }
  return statement;
}

function sourceCommit(definition: BuildDefinition): string | undefined {
  const prefix = `git+${definition.externalParameters.workflow.repository}@`.toLowerCase();
  const source = definition.resolvedDependencies.find((d) => {
    const uri = field(d, 'uri');
    return typeof uri === 'string' && uri.toLowerCase().startsWith(prefix);
  });
  const commit = field(field(source, 'digest'), 'gitCommit');
  return typeof commit === 'string' ? commit : undefined;
}

/** Every way a statement fails to describe the expected build; empty when it matches. */
export function provenanceProblems(statement: Statement, expected: Expected): string[] {
  const problems: string[] = [];
  const definition = statement.predicate.buildDefinition;
  const url = definition.externalParameters.workflow.repository;
  const repository = url.toLowerCase().startsWith(GITHUB) ? url.slice(GITHUB.length) : url;
  if (repository.toLowerCase() !== expected.repository.toLowerCase()) {
    problems.push(`it was built from ${repository}, not ${expected.repository}`);
  }
  const commit = sourceCommit(definition);
  if (commit?.toLowerCase() !== expected.commit.toLowerCase()) {
    problems.push(`it was built from commit ${commit ?? '(none named)'}, not ${expected.commit}`);
  }
  const name = packageUrl(expected.name, expected.version);
  const subject = statement.subject.find((s) => field(s, 'name') === name);
  const digest = integrityHex(expected.integrity);
  if (subject === undefined) {
    problems.push(`it attests no ${name}`);
  } else if (
    digest === undefined ||
    lowerCase(field(field(subject, 'digest'), 'sha512')) !== digest
  ) {
    problems.push('the digest it attests is not the installed tarball’s');
  }
  return problems;
}

/** What `npm audit signatures --json` objects to; empty when every signature verified. */
export function auditProblems(code: number, stdout: string): string[] {
  let report: unknown;
  try {
    report = JSON.parse(stdout);
  } catch {
    return [`npm audit signatures exited ${code} without a readable report`];
  }
  const invalid = field(report, 'invalid');
  const missing = field(report, 'missing');
  if (!isList(invalid) || !isList(missing)) {
    return [`npm audit signatures exited ${code} without a readable report`];
  }
  const problems: string[] = [];
  if (invalid.length > 0) problems.push(`${invalid.length} invalid signatures`);
  if (missing.length > 0) problems.push(`${missing.length} missing signatures`);
  if (problems.length === 0 && code !== 0) problems.push(`npm audit signatures exited ${code}`);
  return problems;
}

/** The integrity npm recorded for the installed package, when it is the expected version. */
export function lockedIntegrity(lock: unknown, version: string): string | undefined {
  const entry = field(field(lock, 'packages'), `node_modules/${PACKAGE}`);
  return isObject(entry) && entry.version === version && typeof entry.integrity === 'string'
    ? entry.integrity
    : undefined;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return undefined;
  }
}

function gitDirOf(root: string): string {
  const dotGit = join(root, '.git');
  const pointer = readText(dotGit);
  return pointer?.startsWith('gitdir: ') ? resolve(root, pointer.slice('gitdir: '.length)) : dotGit;
}

/**
 * The commit a checkout's HEAD is at, read from its files rather than by running git: a detached
 * HEAD holds the commit; a branch's HEAD points at a loose or a packed ref.
 */
export function headCommit(root: string): string | undefined {
  const gitDir = gitDirOf(root);
  const head = readText(join(gitDir, 'HEAD')) ?? '';
  if (COMMIT.test(head)) return head;
  const ref = /^ref: (refs\/[\w./-]+)$/.exec(head)?.[1];
  if (ref === undefined) return undefined;
  const loose = readText(join(gitDir, ref));
  if (loose !== undefined) return COMMIT.test(loose) ? loose : undefined;
  const packed = (readText(join(gitDir, 'packed-refs')) ?? '').split('\n');
  const commit = packed.find((line) => line.endsWith(` ${ref}`))?.slice(0, 40);
  return commit !== undefined && COMMIT.test(commit) ? commit : undefined;
}

/** The release a checkout of the Talos repository is at: its version and HEAD commit. */
export function kitRelease(kitRoot: string): Release {
  const manifest: unknown = JSON.parse(readFileSync(join(kitRoot, 'package.json'), 'utf8'));
  const version = field(manifest, 'version');
  if (
    field(manifest, 'name') !== PACKAGE ||
    typeof version !== 'string' ||
    !VERSION.test(version)
  ) {
    throw new Refusal('the checkout is not a Talos release');
  }
  const sha = headCommit(kitRoot);
  if (sha === undefined) throw new Refusal('the checkout has no commit');
  return { version, sha };
}

/** npm's own script beside the running Node, so nothing is looked up on PATH. */
export function npmCli(execPath: string, platform: string, env: Env): string | undefined {
  const bin = dirname(execPath);
  const beside =
    platform === 'win32'
      ? join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return [beside, env.npm_execpath].find((path) => path !== undefined && existsSync(path));
}

function npm(args: readonly string[], cwd: string): NpmRun {
  const cli = npmCli(process.execPath, process.platform, process.env);
  if (cli === undefined) throw new Refusal('npm was not found beside node');
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

async function verifiedProvenance(release: Release, integrity: string): Promise<void> {
  const url = `${REGISTRY}/-/npm/v1/attestations/${encodeURIComponent(PACKAGE)}@${release.version}`;
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Refusal(`${PACKAGE}@${release.version} has no provenance`);
  const problems = provenanceProblems(readStatement(await response.json()), {
    name: PACKAGE,
    version: release.version,
    repository: SOURCE,
    commit: release.sha,
    integrity,
  });
  if (problems.length > 0) throw new Refusal(problems.join('; '));
}

async function installVerified(release: Release, directory: string): Promise<string> {
  writeFileSync(join(directory, 'package.json'), '{ "private": true }\n');
  const spec = `${PACKAGE}@${release.version}`;
  const flags = ['--ignore-scripts', '--no-audit', '--no-fund', '--save-exact'];
  const install = npm(['install', ...flags, spec], directory);
  if (install.status !== 0) throw new Refusal(`npm install exited ${String(install.status)}`);
  const lock: unknown = JSON.parse(readFileSync(join(directory, 'package-lock.json'), 'utf8'));
  const integrity = lockedIntegrity(lock, release.version);
  if (integrity === undefined) throw new Refusal(`npm installed no ${spec}`);
  const audit = npm(['audit', 'signatures', '--json'], directory);
  const audited = auditProblems(audit.status ?? 1, audit.stdout ?? '');
  if (audited.length > 0) throw new Refusal(audited.join('; '));
  await verifiedProvenance(release, integrity);
  return join(directory, 'node_modules', '@svp-labs', 'talos', 'dist', 'bin', 'talos.js');
}

function run(bin: string, args: readonly string[], env: Env): Promise<number> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [bin, ...args], { stdio: 'inherit', env });
    child.on('error', () => done(2));
    child.on('exit', (code) => done(code ?? 1));
  });
}

/** Installs and verifies the checkout's release, runs it with `args`, and returns its code. */
export async function main(args: readonly string[], env: Env): Promise<number> {
  const kitRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  try {
    const release = kitRelease(kitRoot);
    const directory = mkdtempSync(join(env.RUNNER_TEMP ?? tmpdir(), 'talos-'));
    const bin = await installVerified(release, directory);
    return await run(bin, args, {
      ...env,
      TALOS_LAUNCHED: '1',
      TALOS_VERSION: release.version,
      TALOS_SHA: release.sha,
    });
  } catch (error) {
    const reason = error instanceof Refusal ? error.message : 'the release could not be installed';
    process.stderr.write(`talos bootstrap: refused: ${reason}\n`);
    return 2;
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
