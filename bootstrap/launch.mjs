#!/usr/bin/env node
/**
 * Runs Talos at the release this checkout of the Talos repository is at, for workflows that have
 * no Talos yet. The checkout is at the pinned commit; this reads its own `package.json` version,
 * installs `@svp-labs/talos@<version>` with npm (no install scripts), has `npm audit signatures`
 * verify the registry's signatures and attestations, refuses the package unless its SLSA
 * provenance names the Talos repository, this checkout's HEAD and the installed tarball, then
 * runs it with the given arguments and exits with its code.
 *
 * Dependency-free on purpose: nothing is installed before it runs. It prints nothing of its own
 * but one generic line when it refuses, since npm's messages can name things a public log must
 * not show. Neither npm nor git is looked up on PATH: npm is the one beside the running Node,
 * and HEAD is read from the checkout's files.
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

export class Refusal extends Error {
  name = 'Refusal';
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The SHA-512 of a Subresource Integrity string as hex, or undefined. */
export function integrityHex(integrity) {
  if (typeof integrity !== 'string') return undefined;
  const entry = integrity
    .trim()
    .split(/\s+/)
    .find((part) => part.startsWith('sha512-'));
  if (entry === undefined) return undefined;
  const bytes = Buffer.from(entry.slice('sha512-'.length), 'base64');
  return bytes.length === 64 ? bytes.toString('hex') : undefined;
}

export function packageUrl(name, version) {
  return `pkg:npm/${name.replace(/^@/, '%40')}@${version}`;
}

function provenanceEnvelope(response) {
  const attestations = isObject(response) ? response.attestations : undefined;
  if (!Array.isArray(attestations)) throw new Refusal('the registry returned no attestations');
  const provenance = attestations.filter((a) => isObject(a) && a.predicateType === PROVENANCE);
  const envelope = provenance.length === 1 ? provenance[0].bundle?.dsseEnvelope : undefined;
  if (!isObject(envelope) || typeof envelope.payload !== 'string') {
    throw new Refusal(`expected one SLSA provenance attestation, found ${provenance.length}`);
  }
  if (envelope.payloadType !== PAYLOAD) throw new Refusal('the provenance is not in-toto');
  return envelope;
}

function isProvenanceStatement(statement) {
  const definition = statement?.predicate?.buildDefinition;
  return (
    isObject(statement) &&
    statement._type === STATEMENT &&
    statement.predicateType === PROVENANCE &&
    Array.isArray(statement.subject) &&
    Array.isArray(definition?.resolvedDependencies) &&
    typeof definition?.externalParameters?.workflow?.repository === 'string'
  );
}

/** The in-toto statement of the SLSA provenance among npm's attestations for a version. */
export function readStatement(response) {
  const envelope = provenanceEnvelope(response);
  let statement;
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

function sourceCommit(definition) {
  const prefix = `git+${definition.externalParameters.workflow.repository}@`.toLowerCase();
  const source = definition.resolvedDependencies.find(
    (d) => typeof d?.uri === 'string' && d.uri.toLowerCase().startsWith(prefix),
  );
  const commit = source?.digest?.gitCommit;
  return typeof commit === 'string' ? commit : undefined;
}

/** Every way a statement fails to describe the expected build; empty when it matches. */
export function provenanceProblems(statement, expected) {
  const problems = [];
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
  const subject = statement.subject.find((s) => isObject(s) && s.name === name);
  const digest = integrityHex(expected.integrity);
  if (subject === undefined) {
    problems.push(`it attests no ${name}`);
  } else if (digest === undefined || subject.digest?.sha512?.toLowerCase() !== digest) {
    problems.push('the digest it attests is not the installed tarball’s');
  }
  return problems;
}

/** What `npm audit signatures --json` objects to; empty when every signature verified. */
export function auditProblems(code, stdout) {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    return [`npm audit signatures exited ${code} without a readable report`];
  }
  if (!isObject(report) || !Array.isArray(report.invalid) || !Array.isArray(report.missing)) {
    return [`npm audit signatures exited ${code} without a readable report`];
  }
  const problems = [];
  if (report.invalid.length > 0) problems.push(`${report.invalid.length} invalid signatures`);
  if (report.missing.length > 0) problems.push(`${report.missing.length} missing signatures`);
  if (problems.length === 0 && code !== 0) problems.push(`npm audit signatures exited ${code}`);
  return problems;
}

/** The integrity npm recorded for the installed package, when it is the expected version. */
export function lockedIntegrity(lock, version) {
  const packages = isObject(lock) && isObject(lock.packages) ? lock.packages : {};
  const entry = packages[`node_modules/${PACKAGE}`];
  return isObject(entry) && entry.version === version && typeof entry.integrity === 'string'
    ? entry.integrity
    : undefined;
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return undefined;
  }
}

function gitDirOf(root) {
  const dotGit = join(root, '.git');
  const pointer = readText(dotGit);
  return pointer?.startsWith('gitdir: ') ? resolve(root, pointer.slice('gitdir: '.length)) : dotGit;
}

/**
 * The commit a checkout's HEAD is at, read from its files rather than by running git: a detached
 * HEAD holds the commit; a branch's HEAD points at a loose or a packed ref.
 */
export function headCommit(root) {
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
export function kitRelease(kitRoot) {
  const manifest = JSON.parse(readFileSync(join(kitRoot, 'package.json'), 'utf8'));
  if (manifest?.name !== PACKAGE || !VERSION.test(String(manifest?.version))) {
    throw new Refusal('the checkout is not a Talos release');
  }
  const sha = headCommit(kitRoot);
  if (sha === undefined) throw new Refusal('the checkout has no commit');
  return { version: manifest.version, sha };
}

/** npm's own script beside the running Node, so nothing is looked up on PATH. */
export function npmCli(execPath, platform, env) {
  const bin = dirname(execPath);
  const beside =
    platform === 'win32'
      ? join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return [beside, env.npm_execpath].find((path) => path !== undefined && existsSync(path));
}

function npm(args, cwd) {
  const cli = npmCli(process.execPath, process.platform, process.env);
  if (cli === undefined) throw new Refusal('npm was not found beside node');
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

async function verifiedProvenance(release, integrity) {
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

async function installVerified(release, directory) {
  writeFileSync(join(directory, 'package.json'), '{ "private": true }\n');
  const spec = `${PACKAGE}@${release.version}`;
  const flags = ['--ignore-scripts', '--no-audit', '--no-fund', '--save-exact'];
  const install = npm(['install', ...flags, spec], directory);
  if (install.status !== 0) throw new Refusal(`npm install exited ${install.status}`);
  const lock = JSON.parse(readFileSync(join(directory, 'package-lock.json'), 'utf8'));
  const integrity = lockedIntegrity(lock, release.version);
  if (integrity === undefined) throw new Refusal(`npm installed no ${spec}`);
  const audit = npm(['audit', 'signatures', '--json'], directory);
  const audited = auditProblems(audit.status ?? 1, audit.stdout ?? '');
  if (audited.length > 0) throw new Refusal(audited.join('; '));
  await verifiedProvenance(release, integrity);
  return join(directory, 'node_modules', '@svp-labs', 'talos', 'dist', 'bin', 'talos.js');
}

function run(bin, args, env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [bin, ...args], { stdio: 'inherit', env });
    child.on('error', () => done(2));
    child.on('exit', (code) => done(code ?? 1));
  });
}

/** Installs and verifies the checkout's release, runs it with `args`, and returns its code. */
export async function main(args, env) {
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
