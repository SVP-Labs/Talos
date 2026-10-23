import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import {
  arrayEnd,
  mergeRequirements,
  pinJsonManifest,
  pinPythonProject,
  pinRequirementsIn,
  requirementName,
} from './dev-deps.js';

const NPM = { dev: 'devDependencies', runtime: 'dependencies' };

describe('pinJsonManifest', () => {
  it('adds and corrects dev dependencies, sorted, keeping the file’s indent and key order', () => {
    const text =
      '{\n    "name": "x",\n    "devDependencies": { "zod": "^4", "eslint": "^9" },\n    "type": "module"\n}\n';
    const out = pinJsonManifest(text, NPM, { eslint: '10.13.0', prettier: '3.9.10' });
    expect(out).toBe(
      '{\n    "name": "x",\n    "devDependencies": {\n        "eslint": "10.13.0",\n' +
        '        "prettier": "3.9.10",\n        "zod": "^4"\n    },\n    "type": "module"\n}\n',
    );
  });

  it('pins a tool the project lists as a runtime dependency where it is', () => {
    const text = '{\n  "dependencies": { "typescript": "^5" }\n}';
    const out = JSON.parse(pinJsonManifest(text, NPM, { typescript: '6.0.3' }) ?? '{}');
    expect(out).toEqual({ dependencies: { typescript: '6.0.3' }, devDependencies: {} });
  });

  it('changes nothing when every pin is there', () => {
    const text = '{"devDependencies":{"eslint":"10.13.0"}}';
    expect(pinJsonManifest(text, NPM, { eslint: '10.13.0' })).toBeUndefined();
  });

  it('writes composer.json the same way', () => {
    const out = pinJsonManifest(
      '{}',
      { dev: 'require-dev', runtime: 'require' },
      { 'vendor/tool': '4.1.0' },
    );
    expect(JSON.parse(out ?? '{}')).toEqual({ 'require-dev': { 'vendor/tool': '4.1.0' } });
  });
});

describe('requirements', () => {
  it('names a requirement the way pip compares names', () => {
    expect(requirementName('Import_Linter[toml]>=2')).toBe('import-linter');
    expect(requirementName('# comment')).toBeUndefined();
  });

  it('replaces any entry for a pinned tool and keeps the rest', () => {
    expect(
      mergeRequirements(['ruff>=0.5', 'requests', '# note'], { ruff: '0.17.2', pytest: '9.1.1' }),
    ).toEqual(['requests', '# note', 'ruff==0.17.2', 'pytest==9.1.1']);
  });

  it('writes requirements-dev.in, or nothing when it is right', () => {
    expect(pinRequirementsIn(undefined, { ruff: '0.17.2' })).toBe('ruff==0.17.2\n');
    expect(pinRequirementsIn('ruff==0.17.2\n', { ruff: '0.17.2' })).toBeUndefined();
    expect(pinRequirementsIn('ruff\n', { ruff: '0.17.2' })).toBe('ruff==0.17.2\n');
  });
});

describe('arrayEnd', () => {
  it('skips brackets inside strings and comments', () => {
    const text = 'dev = [\n  "a[x]", # ] not this\n  \'b]\', "c\\"]",\n]\nrest';
    const end = arrayEnd(text, text.indexOf('['));
    expect(text.slice(end)).toBe('\nrest');
    expect(arrayEnd('[ "open', 0)).toBe(-1);
  });
});

describe('pinPythonProject', () => {
  const PINS = { ruff: '0.17.2', pytest: '9.1.1' };

  function devOf(text: string): unknown {
    return (parseToml(text) as { 'dependency-groups'?: { dev?: unknown } })['dependency-groups']
      ?.dev;
  }

  it('adds a dependency-groups table to a pyproject without one', () => {
    const result = pinPythonProject('[project]\nname = "x"\n', PINS);
    expect(result.kind).toBe('changed');
    const text = result.kind === 'changed' ? result.text : '';
    expect(text.startsWith('[project]\nname = "x"\n\n[dependency-groups]\n')).toBe(true);
    expect(devOf(text)).toEqual(['ruff==0.17.2', 'pytest==9.1.1']);
  });

  it('rewrites the dev group in place, keeping comments and the tables after it', () => {
    const text =
      '# top\n[dependency-groups]\n# groups\ndev = [\n  "ruff>=0.5",  # old\n  "black",\n]\ndocs = ["sphinx"]\n\n[tool.ruff]\nline-length = 88\n';
    const result = pinPythonProject(text, PINS);
    const out = result.kind === 'changed' ? result.text : '';
    expect(out).toContain('# top\n[dependency-groups]\n# groups\ndev = [\n    "black",\n');
    expect(out).toContain('docs = ["sphinx"]\n\n[tool.ruff]\nline-length = 88\n');
    expect(devOf(out)).toEqual(['black', 'ruff==0.17.2', 'pytest==9.1.1']);
  });

  it('adds a dev key to a dependency-groups table that lacks one', () => {
    const result = pinPythonProject('[dependency-groups]\ndocs = ["sphinx"]\n', PINS);
    expect(result.kind === 'changed' ? devOf(result.text) : undefined).toEqual([
      'ruff==0.17.2',
      'pytest==9.1.1',
    ]);
  });

  it('leaves a pinned file alone, and an unusual one to a person', () => {
    const pinned = '[dependency-groups]\ndev = ["ruff==0.17.2", "pytest==9.1.1"]\n';
    expect(pinPythonProject(pinned, PINS)).toEqual({ kind: 'unchanged' });
    expect(pinPythonProject('not [ toml', PINS).kind).toBe('manual');
    expect(pinPythonProject('dependency-groups.dev = ["x"]\n', PINS).kind).toBe('manual');
    expect(pinPythonProject('[dependency-groups]\ndev = "x"\n', PINS).kind).toBe('manual');
  });
});
