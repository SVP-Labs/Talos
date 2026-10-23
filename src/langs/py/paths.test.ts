import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fromTool, inComponent, inRepo, isTestPath, pythonFiles, venvTool } from './paths.js';
import { parseConfig } from '../../config/load.js';
import { EngineError } from '../../core/check.js';
import { repoFacts } from '../../repo/facts.js';
import { tempRepo } from '../../testing/engine.js';

describe('component paths', () => {
  it('moves paths between the repository and a component', () => {
    expect(inComponent('svc', 'svc/src/a.py')).toBe('src/a.py');
    expect(inComponent('svc/', 'svc/src/a.py')).toBe('src/a.py');
    expect(inComponent('svc', 'web/a.py')).toBeUndefined();
    expect(inComponent('.', 'a.py')).toBe('a.py');
    expect(inRepo('svc', 'src/a.py')).toBe('svc/src/a.py');
    expect(inRepo('.', './a.py')).toBe('a.py');
  });

  it('makes a tool’s absolute or relative path repository-relative', () => {
    const place = { root: '/repo', component: { lang: 'py' as const, root: 'svc', os: [] } };
    expect(fromTool(place, '/repo/svc/src/a.py')).toBe('svc/src/a.py');
    expect(fromTool(place, 'src/a.py')).toBe('svc/src/a.py');
    expect(fromTool(place, './src/a.py')).toBe('svc/src/a.py');
  });
});

describe('pythonFiles', () => {
  it('lists the component’s tracked sources and stubs, minus exclusions', () => {
    const config = parseConfig(
      'name: T\nprefix: T\ncomponents:\n  - { lang: py, root: svc }\nexclude: [svc/gen]\n',
    );
    const facts = repoFacts(
      ['svc/src/a.py', 'svc/src/a.pyi', 'svc/gen/b.py', 'svc/README.md', 'web/c.py'],
      config.exclude,
    );
    const component = config.components[0];
    expect(pythonFiles({ facts, ...(component ? { component } : {}) })).toEqual([
      'src/a.py',
      'src/a.pyi',
    ]);
    expect(() => pythonFiles({ facts })).toThrow(EngineError);
  });
});

describe('isTestPath', () => {
  it('knows pytest’s layouts', () => {
    expect(isTestPath('tests/unit/helpers.py')).toBe(true);
    expect(isTestPath('src/pkg/test/x.py')).toBe(true);
    expect(isTestPath('src/pkg/test_x.py')).toBe(true);
    expect(isTestPath('src/pkg/x_test.py')).toBe(true);
    expect(isTestPath('conftest.py')).toBe(true);
    expect(isTestPath('src/pkg/testing.py')).toBe(false);
    expect(isTestPath('src/contest.py')).toBe(false);
  });
});

describe('venvTool', () => {
  it('finds a console script, and names what to install when it is missing', async () => {
    const root = await tempRepo({ '.venv/bin/ruff': '', '.venv/Scripts/ruff.exe': '' });
    const component = { lang: 'py' as const, root: '.', os: [] };
    expect(await venvTool({ root, component, os: 'linux' }, 'ruff')).toBe(
      join(root, '.venv', 'bin', 'ruff'),
    );
    expect(await venvTool({ root, component, os: 'windows' }, 'ruff')).toBe(
      join(root, '.venv', 'Scripts', 'ruff.exe'),
    );
    await expect(venvTool({ root, component, os: 'linux' }, 'vulture')).rejects.toThrow(
      /vulture is not installed in \.venv/,
    );
  });
});
