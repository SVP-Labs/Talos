import { z } from 'zod';

/** The package every Talos release is published as. */
export const PACKAGE = '@svp-labs/talos';

export const SLSA_PROVENANCE_V1 = 'https://slsa.dev/provenance/v1';
const STATEMENT_V1 = 'https://in-toto.io/Statement/v1';
const STATEMENT_PAYLOAD = 'application/vnd.in-toto+json';
const GITHUB = 'https://github.com/';

export class ProvenanceError extends Error {
  override readonly name = 'ProvenanceError';
}

const attestationsSchema = z.object({
  attestations: z.array(z.object({ predicateType: z.string(), bundle: z.unknown() })),
});

const bundleSchema = z.object({
  dsseEnvelope: z.object({ payload: z.string(), payloadType: z.string() }),
});

const digestSchema = z.record(z.string(), z.string());

const statementSchema = z.object({
  _type: z.literal(STATEMENT_V1),
  subject: z.array(z.object({ name: z.string(), digest: digestSchema })).min(1),
  predicateType: z.literal(SLSA_PROVENANCE_V1),
  predicate: z.object({
    buildDefinition: z.object({
      externalParameters: z.object({
        workflow: z.object({ repository: z.string(), ref: z.string(), path: z.string() }),
      }),
      resolvedDependencies: z.array(z.object({ uri: z.string(), digest: digestSchema })),
    }),
  }),
});

export type Provenance = {
  /** `owner/name` when built on GitHub, else the source URL as given. */
  readonly repository: string;
  /** The ref the release workflow ran on, such as `refs/tags/v1.2.0`. */
  readonly ref: string;
  /** The workflow file that built it. */
  readonly workflow: string;
  /** The source commit, from the resolved dependency that is the source repository. */
  readonly commit: string | undefined;
  readonly subjects: readonly { readonly name: string; readonly sha512: string | undefined }[];
};

function repositoryOf(url: string): string {
  return url.toLowerCase().startsWith(GITHUB) ? url.slice(GITHUB.length) : url;
}

function payloadOf(response: unknown): string {
  const parsed = attestationsSchema.safeParse(response);
  if (!parsed.success) throw new ProvenanceError('the registry returned no readable attestations');
  const provenance = parsed.data.attestations.filter(
    (attestation) => attestation.predicateType === SLSA_PROVENANCE_V1,
  );
  const [only] = provenance;
  if (only === undefined || provenance.length > 1) {
    throw new ProvenanceError(
      `expected one SLSA provenance attestation, found ${provenance.length}`,
    );
  }
  const bundle = bundleSchema.safeParse(only.bundle);
  if (!bundle.success) throw new ProvenanceError('the provenance bundle has no DSSE envelope');
  const envelope = bundle.data.dsseEnvelope;
  if (envelope.payloadType !== STATEMENT_PAYLOAD) {
    throw new ProvenanceError(`the provenance envelope carries ${envelope.payloadType}`);
  }
  return Buffer.from(envelope.payload, 'base64').toString('utf8');
}

/**
 * The SLSA provenance among a package version's attestations, as npm's registry serves them
 * (`/-/npm/v1/attestations/<name>@<version>`), decoded from its DSSE envelope. It reads the
 * statement only: `npm audit signatures` is what verifies the envelope's signature.
 */
export function decodeProvenance(response: unknown): Provenance {
  let statement: unknown;
  try {
    statement = JSON.parse(payloadOf(response));
  } catch (error) {
    if (error instanceof ProvenanceError) throw error;
    throw new ProvenanceError('the provenance payload is not JSON');
  }
  const parsed = statementSchema.safeParse(statement);
  if (!parsed.success) {
    throw new ProvenanceError('the provenance is not an in-toto statement of SLSA provenance v1');
  }
  const { subject, predicate } = parsed.data;
  const { workflow } = predicate.buildDefinition.externalParameters;
  const sourcePrefix = `git+${workflow.repository}@`.toLowerCase();
  const source = predicate.buildDefinition.resolvedDependencies.find((dependency) =>
    dependency.uri.toLowerCase().startsWith(sourcePrefix),
  );
  return {
    repository: repositoryOf(workflow.repository),
    ref: workflow.ref,
    workflow: workflow.path,
    commit: source?.digest.gitCommit,
    subjects: subject.map((s) => ({ name: s.name, sha512: s.digest.sha512 })),
  };
}

/** The package URL a provenance subject names: `pkg:npm/%40svp-labs/talos@1.2.0`. */
export function packageUrl(name: string, version: string): string {
  return `pkg:npm/${name.replace(/^@/, '%40')}@${version}`;
}

/** The SHA-512 of a Subresource Integrity string (`sha512-<base64>`) as hex. */
export function integrityHex(integrity: string): string | undefined {
  const entry = integrity.split(/\s/).find((part) => part.startsWith('sha512-'));
  if (entry === undefined) return undefined;
  const bytes = Buffer.from(entry.slice('sha512-'.length), 'base64');
  return bytes.length === 64 ? bytes.toString('hex') : undefined;
}

export type ExpectedBuild = {
  readonly name: string;
  readonly version: string;
  /** `owner/name`. */
  readonly repository: string;
  /** The pinned commit. */
  readonly commit: string;
  /** The installed tarball's integrity, from the lockfile. */
  readonly integrity: string;
};

/**
 * Every way a provenance fails to describe the expected build; empty when it names the source
 * repository, the pinned commit, and the very tarball that was installed.
 */
export function provenanceProblems(provenance: Provenance, expected: ExpectedBuild): string[] {
  const problems: string[] = [];
  if (provenance.repository.toLowerCase() !== expected.repository.toLowerCase()) {
    problems.push(`it was built from ${provenance.repository}, not ${expected.repository}`);
  }
  if (provenance.commit?.toLowerCase() !== expected.commit.toLowerCase()) {
    problems.push(
      `it was built from commit ${provenance.commit ?? '(none named)'}, not ${expected.commit}`,
    );
  }
  const name = packageUrl(expected.name, expected.version);
  const subject = provenance.subjects.find((s) => s.name === name);
  const digest = integrityHex(expected.integrity);
  if (subject === undefined) {
    problems.push(`it attests no ${name}`);
  } else if (digest === undefined || subject.sha512?.toLowerCase() !== digest) {
    problems.push('the digest it attests is not the installed tarball’s');
  }
  return problems;
}
