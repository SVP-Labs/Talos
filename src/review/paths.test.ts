import { describe, expect, it } from 'vitest';
import { defaultOwners } from './codeowners.js';
import { extensionFiles, guardedPaths, isGuarded, protectedPaths } from './guard.js';
import { labelSetter, outsideScope, touchedPaths, typeOf } from './scope.js';
import { isTestOf, isTestPath } from './testfiles.js';
import type { IssueEvent, PullFile } from './types.js';
import { isDeclaringFile } from '../checks/runtime/declarations.js';
import { PACKS } from '../core/registry.js';

const GUARD = {
  extensions: ['eslint.project.js', 'tsconfig.json', 'ruff.project.toml'],
  briefs: 'docs/requirements',
  glossary: 'docs/glossary.md',
};

describe('the guard list', () => {
  it.each([
    '.github/workflows/talos.yml',
    '.github/CODEOWNERS',
    'CODEOWNERS',
    'docs/CODEOWNERS',
    'talos.yml',
    'eslint.project.js',
    'apps/web/eslint.project.js',
    'packages/shared/tsconfig.json',
    'package.json',
    'apps/hub/package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.npmrc',
    'pyproject.toml',
    'requirements.txt',
    'requirements-dev.txt',
    'requirements/base.in',
    'constraints.txt',
    'uv.lock',
    'poetry.lock',
    'composer.json',
    'composer.lock',
    'Cargo.toml',
    'apps/desktop/Cargo.lock',
    'go.mod',
    'go.sum',
    'kong-2.8.rockspec',
    'Dockerfile',
    'docker/api.Dockerfile',
    'Dockerfile.dev',
    'Containerfile',
    'dockerfile',
    'app.dockerfile',
    'docker/api.dockerfile',
    'build/Containerfile.dev',
    'prod.containerfile',
    'x/app.Containerfile',
    'deptrac.project.yaml',
    'packages/a/deptrac.project.yaml',
    '.nvmrc',
    '.node-version',
    '.python-version',
    'rust-toolchain.toml',
    '.tool-versions',
    'DECISIONS.md',
    'docs/requirements/20261022-talos-core.md',
    'docs/glossary.md',
    'CLAUDE.md',
    'apps/hub/CLAUDE.md',
    '.claude/settings.json',
  ])('guards %s', (path) => {
    expect(isGuarded(path, GUARD)).toBe(true);
  });

  it.each([
    'src/parser.ts',
    'src/parser.test.ts',
    'docs/architecture.md',
    'docs/requirements-old.md',
    'README.md',
    'src/package.ts',
    'src/talos.yml.ts',
    'src/dockerfile.ts',
    'notes/glossary.md',
  ])('leaves %s to the issue', (path) => {
    expect(isGuarded(path, GUARD)).toBe(false);
  });

  it('guards every file that declares a runtime', () => {
    const paths = [
      'Dockerfile',
      'services/web/dockerfile',
      'build/Containerfile.dev',
      'x/app.Containerfile',
      'apps/api/.python-version',
      'rust-toolchain',
      'tools.lock',
      'src/dockerfile.ts',
    ];
    for (const path of paths.filter((p) => isDeclaringFile(p))) {
      expect(isGuarded(path, GUARD)).toBe(true);
    }
  });

  it('follows talos.yml for the briefs and the glossary', () => {
    const custom = { ...GUARD, briefs: 'design/briefs/', glossary: 'TERMS.md' };
    expect(isGuarded('design/briefs/x.md', custom)).toBe(true);
    expect(isGuarded('TERMS.md', custom)).toBe(true);
    expect(isGuarded('docs/requirements/x.md', custom)).toBe(false);
  });

  it('filters a list', () => {
    expect(guardedPaths(['src/a.ts', 'package.json'], GUARD)).toEqual(['package.json']);
  });

  it("reads the packs' extension files", () => {
    const packs = [
      {
        generated: [
          { extension: { path: 'b.project.js' } },
          {},
          { extension: { path: 'a.project.json' } },
        ],
      },
      {},
      { generated: [{ extension: { path: 'b.project.js' } }] },
    ].map((pack) => ({
      generated: (pack.generated ?? []).map((file) => ({
        path: 'base',
        scope: 'repo' as const,
        applies: () => true,
        render: () => '',
        ...('extension' in file
          ? { extension: { path: file.extension.path, initial: () => '' } }
          : {}),
      })),
    }));
    expect(extensionFiles(packs)).toEqual(['a.project.json', 'b.project.js']);
  });

  it("includes every extension file Talos's own packs declare", () => {
    const files = extensionFiles(PACKS);
    expect(files).toEqual(
      expect.arrayContaining(['eslint.project.js', 'tsconfig.json', 'vitest.project.ts']),
    );
    for (const file of files) {
      expect(isGuarded(`apps/x/${file}`, { ...GUARD, extensions: files })).toBe(true);
    }
  });
});

describe('protectedPaths', () => {
  it("matches talos.yml's globs, and a plain path as a file or a folder", () => {
    const globs = ['packages/shared/src/risk/**', 'apps/hub/src/gate.ts', 'src/review/'];
    expect(
      protectedPaths(
        [
          'packages/shared/src/risk/rules.ts',
          'apps/hub/src/gate.ts',
          'apps/hub/src/gate.test.ts',
          'src/review/job.ts',
          'src/a.ts',
        ],
        globs,
      ),
    ).toEqual(['packages/shared/src/risk/rules.ts', 'apps/hub/src/gate.ts', 'src/review/job.ts']);
  });

  it('matches dot files, and nothing without globs', () => {
    expect(protectedPaths(['.github/x.yml'], ['.github/**'])).toEqual(['.github/x.yml']);
    expect(protectedPaths(['a.ts'], [])).toEqual([]);
  });
});

describe('test files', () => {
  it.each([
    'src/a.test.ts',
    'src/a.spec.tsx',
    'src/a.test.mjs',
    'src/__tests__/a.ts',
    'tests/test_a.py',
    'pkg/a_test.py',
    'tests/conftest.py',
    'tests/Unit/ATest.php',
    'spec/a_spec.lua',
    'tests/integration.rs',
    'pkg/a_test.go',
    'test/a.js',
  ])('%s is a test', (path) => {
    expect(isTestPath(path)).toBe(true);
  });

  it.each(['src/a.ts', 'src/testing.ts', 'src/contest.py', 'src/latest/a.ts', 'src/attest.go'])(
    '%s is no test',
    (path) => {
      expect(isTestPath(path)).toBe(false);
    },
  );

  it.each([
    ['src/a/util.test.ts', 'src/a/util.ts'],
    ['src/a/util.spec.ts', 'src/a/util.ts'],
    ['src/a/__tests__/util.ts', 'src/a/util.ts'],
    ['__tests__/util.ts', 'util.ts'],
    ['tests/test_util.py', 'src/pkg/util.py'],
    ['tests/pkg/util_test.py', 'src/pkg/util.py'],
    ['tests/Unit/Models/UserTest.php', 'app/Models/User.php'],
    ['spec/util_spec.lua', 'src/util.lua'],
    ['pkg/util_test.go', 'pkg/util.go'],
  ])('%s tests %s', (test, source) => {
    expect(isTestOf(test, source)).toBe(true);
  });

  it.each([
    ['src/a/other.test.ts', 'src/a/util.ts'],
    ['src/b/util.test.ts', 'src/a/util.ts'],
    ['src/a/util.ts', 'src/a/util.ts'],
    ['src/a/util.test.ts', 'src/a/util.test.ts'],
    ['src/a/util.ts', 'src/a/util.test.ts'],
  ])('%s does not test %s', (test, source) => {
    expect(isTestOf(test, source)).toBe(false);
  });
});

function event(overrides: Partial<IssueEvent>): IssueEvent {
  return {
    event: 'labeled',
    label: 'chore',
    actor: 'SvenPGH',
    actorType: 'User',
    createdAt: '2026-10-20T00:00:00Z',
    ...overrides,
  };
}

describe('the issue', () => {
  it('has one type label, or none that counts', () => {
    expect(typeOf(['chore', 'status/ready'])).toBe('chore');
    expect(typeOf(['debt/other', 'priority/p3'])).toBe('debt/other');
    expect(typeOf(['chore', 'feature'])).toBeUndefined();
    expect(typeOf(['status/ready'])).toBeUndefined();
  });

  it('knows who last set its type label', () => {
    const reviewer = 'talos-reviewer[bot]';
    expect(labelSetter([event({})], 'chore', reviewer)).toBe('person');
    expect(
      labelSetter([event({ actor: reviewer, actorType: 'Bot' })], 'chore', 'Talos-Reviewer[bot]'),
    ).toBe('reviewer');
    expect(labelSetter([event({ actor: reviewer, actorType: 'Bot' })], 'chore', reviewer)).toBe(
      'reviewer',
    );
    expect(
      labelSetter([event({ actor: 'thea-svp[bot]', actorType: 'Bot' })], 'chore', reviewer),
    ).toBe('other');
    expect(
      labelSetter([event({ actor: 'someone', actorType: undefined })], 'chore', reviewer),
    ).toBe('other');
    expect(labelSetter([event({ actor: undefined })], 'chore', reviewer)).toBe('unknown');
    expect(labelSetter([], 'chore', reviewer)).toBe('unknown');
  });

  it('reads only the latest labelling with that label', () => {
    const reviewer = 'talos-reviewer[bot]';
    const relabelled = [
      event({}),
      event({ event: 'unlabeled', actor: 'thea-svp[bot]', actorType: 'Bot' }),
      event({ actor: 'thea-svp[bot]', actorType: 'Bot' }),
      event({ label: 'priority/p3', actor: 'SvenPGH' }),
    ];
    expect(labelSetter(relabelled, 'chore', reviewer)).toBe('other');
    expect(
      labelSetter(
        [event({ actor: 'thea-svp[bot]', actorType: 'Bot' }), event({})],
        'chore',
        reviewer,
      ),
    ).toBe('person');
  });
});

function changed(path: string, previousPath?: string): PullFile {
  return {
    path,
    status: previousPath === undefined ? 'modified' : 'renamed',
    previousPath,
    changes: 1,
    patch: '@@ -1 +1 @@',
  };
}

describe('scope', () => {
  const DEBT = '### Affected areas\n\n- `src/a/util.ts`\n- `src/b.ts`\n';

  it('takes every path a PR touches, old names of renamed files included', () => {
    expect(
      touchedPaths([changed('src/a.ts'), changed('src/new.ts', 'src/old.ts'), changed('src/a.ts')]),
    ).toEqual(['src/a.ts', 'src/old.ts', 'src/new.ts']);
  });

  it('holds a debt issue to its files and their tests', () => {
    const paths = ['src/a/util.ts', 'src/a/util.test.ts', 'src/b.ts', 'src/c.ts', 'src/c.test.ts'];
    expect(outsideScope(paths, DEBT, 'debt/other')).toEqual(['src/c.ts', 'src/c.test.ts']);
    expect(outsideScope(paths, DEBT, 'debt/dead-code')).toEqual(['src/c.ts', 'src/c.test.ts']);
  });

  it('holds a chore to exactly the files it names', () => {
    expect(outsideScope(['src/a/util.ts', 'src/a/util.test.ts'], DEBT, 'chore')).toEqual([
      'src/a/util.test.ts',
    ]);
  });

  it('allows nothing when the issue names no file', () => {
    expect(outsideScope(['src/a.ts'], '### Affected areas\n\nthe parser\n', 'chore')).toEqual([
      'src/a.ts',
    ]);
  });
});

describe('defaultOwners', () => {
  it("takes the people on CODEOWNERS' last * rule", () => {
    expect(defaultOwners('* @SvenPGH\n')).toEqual(['SvenPGH']);
    expect(
      defaultOwners(
        '# owners\n* @old\n*.md @docs\n* @SvenPGH @SVP-Labs/maintainers a@b.c # main\n',
      ),
    ).toEqual(['SvenPGH']);
    expect(defaultOwners('/src/ @SvenPGH\n')).toEqual([]);
    expect(defaultOwners('')).toEqual([]);
  });
});
