import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decodeProvenance,
  type ExpectedBuild,
  integrityHex,
  PACKAGE,
  packageUrl,
  ProvenanceError,
  provenanceProblems,
  SLSA_PROVENANCE_V1,
} from './provenance.js';

/** npm's attestations for @sigstore/core@4.0.1, recorded from the public registry. */
const recorded: unknown = JSON.parse(
  readFileSync(new URL('fixtures/sigstore-core-4.0.1.attestations.json', import.meta.url), 'utf8'),
);
const RECORDED_INTEGRITY =
  'sha512-9v5hRjujn5NXq8o7XFEUgLyAtdr5Iisb4pzM05u3K61IS5q3hP3luWAndk0RkPPLTUFoTbg7Vb84UQ1ZQeajWQ==';
const RECORDED_COMMIT = 'd406ea60b342ca37cdeecd7afedb992cd189db92';

const SHA = 'a'.repeat(40);
const INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;

/** A statement shaped like npm's, for Talos itself. */
function statement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [
      {
        name: packageUrl(PACKAGE, '1.2.0'),
        digest: { sha512: Buffer.alloc(64, 7).toString('hex') },
      },
    ],
    predicateType: SLSA_PROVENANCE_V1,
    predicate: {
      buildDefinition: {
        buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
        externalParameters: {
          workflow: {
            ref: 'refs/tags/v1.2.0',
            repository: 'https://github.com/SVP-Labs/Talos',
            path: '.github/workflows/release.yml',
          },
        },
        resolvedDependencies: [
          {
            uri: 'git+https://github.com/SVP-Labs/Talos@refs/tags/v1.2.0',
            digest: { gitCommit: SHA },
          },
        ],
      },
    },
    ...overrides,
  };
}

/** npm's attestations response around a statement. */
function attestations(payload: unknown, extra: unknown[] = []): Record<string, unknown> {
  return {
    attestations: [
      ...extra,
      {
        predicateType: SLSA_PROVENANCE_V1,
        bundle: {
          dsseEnvelope: {
            payload: Buffer.from(JSON.stringify(payload)).toString('base64'),
            payloadType: 'application/vnd.in-toto+json',
            signatures: [{ sig: 'x' }],
          },
        },
      },
    ],
  };
}

const expected: ExpectedBuild = {
  name: PACKAGE,
  version: '1.2.0',
  repository: 'SVP-Labs/Talos',
  commit: SHA,
  integrity: INTEGRITY,
};

describe('decodeProvenance', () => {
  it('reads a real attestation recorded from the npm registry', () => {
    expect(decodeProvenance(recorded)).toEqual({
      repository: 'sigstore/sigstore-js',
      ref: 'refs/heads/main',
      workflow: '.github/workflows/release.yml',
      commit: RECORDED_COMMIT,
      subjects: [
        {
          name: 'pkg:npm/%40sigstore/core@4.0.1',
          sha512:
            'f6fe61463ba39f9357abca3b5c511480bc80b5daf9222b1be29cccd39bb72bad484b9ab784fde5b96027764d1190f3cb4d41684db83b55bf38510d5941e6a359',
        },
      ],
    });
  });

  it('accepts the recorded build only as what it is', () => {
    const real = { name: '@sigstore/core', version: '4.0.1', repository: 'sigstore/sigstore-js' };
    const provenance = decodeProvenance(recorded);
    expect(
      provenanceProblems(provenance, {
        ...real,
        commit: RECORDED_COMMIT,
        integrity: RECORDED_INTEGRITY,
      }),
    ).toEqual([]);
    expect(
      provenanceProblems(provenance, { ...real, commit: SHA, integrity: RECORDED_INTEGRITY }),
    ).toEqual([`it was built from commit ${RECORDED_COMMIT}, not ${SHA}`]);
    expect(
      provenanceProblems(provenance, {
        ...real,
        repository: 'SVP-Labs/Talos',
        commit: RECORDED_COMMIT,
        integrity: RECORDED_INTEGRITY,
      }),
    ).toEqual(['it was built from sigstore/sigstore-js, not SVP-Labs/Talos']);
  });

  it('skips the publish attestation and takes the SLSA provenance', () => {
    const publish = {
      predicateType: 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1',
      bundle: {},
    };
    expect(decodeProvenance(attestations(statement(), [publish])).commit).toBe(SHA);
  });

  it('names no commit when no dependency is the source repository', () => {
    const other = statement({
      predicate: {
        buildDefinition: {
          externalParameters: {
            workflow: { ref: 'r', repository: 'https://github.com/SVP-Labs/Talos', path: 'p' },
          },
          resolvedDependencies: [
            { uri: 'git+https://github.com/someone/else@x', digest: { gitCommit: SHA } },
          ],
        },
      },
    });
    expect(decodeProvenance(attestations(other)).commit).toBeUndefined();
  });

  it('keeps a source URL that is not on GitHub as it is', () => {
    const elsewhere = statement({
      predicate: {
        buildDefinition: {
          externalParameters: {
            workflow: { ref: 'r', repository: 'https://gitlab.com/a/b', path: 'p' },
          },
          resolvedDependencies: [],
        },
      },
    });
    expect(decodeProvenance(attestations(elsewhere)).repository).toBe('https://gitlab.com/a/b');
  });

  it('refuses what is not one readable SLSA provenance', () => {
    const cases: [unknown, string][] = [
      [{}, 'no readable attestations'],
      [{ attestations: [] }, 'found 0'],
      [{ attestations: [{ predicateType: SLSA_PROVENANCE_V1, bundle: {} }] }, 'no DSSE envelope'],
      [
        {
          attestations: [
            ...(attestations(statement()).attestations as unknown[]),
            ...(attestations(statement()).attestations as unknown[]),
          ],
        },
        'found 2',
      ],
      [
        {
          attestations: [
            {
              predicateType: SLSA_PROVENANCE_V1,
              bundle: { dsseEnvelope: { payload: 'e30=', payloadType: 'text/plain' } },
            },
          ],
        },
        'carries text/plain',
      ],
      [
        {
          attestations: [
            {
              predicateType: SLSA_PROVENANCE_V1,
              bundle: {
                dsseEnvelope: {
                  payload: Buffer.from('not json').toString('base64'),
                  payloadType: 'application/vnd.in-toto+json',
                },
              },
            },
          ],
        },
        'not JSON',
      ],
      [
        attestations({ ...statement(), predicateType: 'https://slsa.dev/provenance/v0.2' }),
        'not an in-toto statement',
      ],
      [attestations({ ...statement(), _type: 'x' }), 'not an in-toto statement'],
      [attestations({ ...statement(), subject: [] }), 'not an in-toto statement'],
    ];
    for (const [response, message] of cases) {
      expect(() => decodeProvenance(response)).toThrow(ProvenanceError);
      expect(() => decodeProvenance(response)).toThrow(message);
    }
  });
});

describe('provenanceProblems', () => {
  const provenance = decodeProvenance(attestations(statement()));

  it('accepts the pinned commit, the Talos repository and the installed tarball', () => {
    expect(provenanceProblems(provenance, expected)).toEqual([]);
  });

  it('ignores case in the repository and the commit', () => {
    expect(
      provenanceProblems(provenance, {
        ...expected,
        repository: 'svp-labs/talos',
        commit: SHA.toUpperCase(),
      }),
    ).toEqual([]);
  });

  it('refuses another commit', () => {
    const other = 'b'.repeat(40);
    expect(provenanceProblems(provenance, { ...expected, commit: other })).toEqual([
      `it was built from commit ${SHA}, not ${other}`,
    ]);
  });

  it('refuses a provenance that names no commit', () => {
    expect(provenanceProblems({ ...provenance, commit: undefined }, expected)).toEqual([
      `it was built from commit (none named), not ${SHA}`,
    ]);
  });

  it('refuses another repository, such as a fork', () => {
    expect(provenanceProblems({ ...provenance, repository: 'evil/Talos' }, expected)).toEqual([
      'it was built from evil/Talos, not SVP-Labs/Talos',
    ]);
  });

  it('refuses another version or package', () => {
    expect(provenanceProblems(provenance, { ...expected, version: '1.2.1' })).toEqual([
      'it attests no pkg:npm/%40svp-labs/talos@1.2.1',
    ]);
  });

  it('refuses a tarball other than the attested one', () => {
    const other = `sha512-${Buffer.alloc(64, 8).toString('base64')}`;
    expect(provenanceProblems(provenance, { ...expected, integrity: other })).toEqual([
      'the digest it attests is not the installed tarball’s',
    ]);
    expect(provenanceProblems(provenance, { ...expected, integrity: 'sha1-abc' })).toHaveLength(1);
    const noDigest = {
      ...provenance,
      subjects: [{ name: packageUrl(PACKAGE, '1.2.0'), sha512: undefined }],
    };
    expect(provenanceProblems(noDigest, expected)).toHaveLength(1);
  });

  it('accepts an attested digest in upper case', () => {
    const upper = {
      ...provenance,
      subjects: provenance.subjects.map((s) => ({ ...s, sha512: s.sha512?.toUpperCase() })),
    };
    expect(provenanceProblems(upper, expected)).toEqual([]);
  });

  it('lists every problem at once', () => {
    expect(
      provenanceProblems(
        { ...provenance, repository: 'a/b', commit: 'c'.repeat(40) },
        { ...expected, version: '9.9.9' },
      ),
    ).toHaveLength(3);
  });
});

describe('packageUrl and integrityHex', () => {
  it('spells a scoped package as npm attests it', () => {
    expect(packageUrl('@svp-labs/talos', '1.2.0')).toBe('pkg:npm/%40svp-labs/talos@1.2.0');
    expect(packageUrl('semver', '7.7.3')).toBe('pkg:npm/semver@7.7.3');
  });

  it('turns an SRI sha512 into hex', () => {
    expect(integrityHex(RECORDED_INTEGRITY)).toBe(decodeProvenance(recorded).subjects[0]?.sha512);
    expect(integrityHex(` sha1-abc ${INTEGRITY} `)).toBe(Buffer.alloc(64, 7).toString('hex'));
  });

  it('has no hex for another algorithm or a wrong length', () => {
    expect(integrityHex('sha1-abc')).toBeUndefined();
    expect(integrityHex('sha512-AAAA')).toBeUndefined();
    expect(integrityHex('')).toBeUndefined();
  });
});
