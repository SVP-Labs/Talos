import { arch } from './arch.js';
import { pyrightBase, ruffBase } from './configs.js';
import { deadCode } from './deadcode.js';
import { format } from './format.js';
import { packageRoots } from './importlinter.js';
import { install } from './install.js';
import { lint } from './lint.js';
import { mutmutRunner } from './mutation.js';
import { pythonFiles } from './paths.js';
import { pytestRunner } from './pytest.js';
import { bind, type Bound } from './run.js';
import { strength } from './strength.js';
import { toolchain } from './toolchain.js';
import { types } from './types.js';
import {
  APPLIES,
  type ApplyContext,
  type Applicability,
  type Check,
  skip,
  type Tier,
} from '../../core/check.js';
import type { Finding } from '../../core/finding.js';
import type { DevTools, Pack } from '../../core/pack.js';
import { mutationChecks, testChecks } from '../../quality/index.js';

/** The tools a Python project pins in its dev dependencies, at exactly these versions. */
export const PY_DEV_TOOLS: DevTools = {
  manager: 'pypi',
  packages: {
    basedpyright: '1.40.2',
    complexipy: '8.1.0',
    coverage: '7.17.0',
    'import-linter': '2.15',
    mutmut: '3.8.0',
    pytest: '9.1.1',
    ruff: '0.17.2',
    vulture: '2.16',
  },
};

function hasPython(ctx: ApplyContext): Applicability {
  return pythonFiles(ctx).length > 0 ? APPLIES : skip('the component has no Python files');
}

function hasPackages(ctx: ApplyContext): Applicability {
  return packageRoots(pythonFiles(ctx)).shipped.length > 0
    ? APPLIES
    : skip('the component has no package (no __init__.py at its root or under src/)');
}

type Spec = {
  readonly name: string;
  readonly tier: Tier;
  readonly title: string;
  readonly applies?: (ctx: ApplyContext) => Applicability;
  readonly run: (ctx: Bound) => Promise<Finding[]>;
};

function check(spec: Spec): Check {
  return {
    id: `py/${spec.name}`,
    tier: spec.tier,
    scope: 'component',
    langs: ['py'],
    title: spec.title,
    applies: spec.applies ?? hasPython,
    run: (ctx) => spec.run(bind(ctx)),
  };
}

const own: Check[] = [
  check({ name: 'format', tier: 'commit', title: 'ruff format', run: format }),
  check({ name: 'lint', tier: 'commit', title: 'ruff, complexipy and size limits', run: lint }),
  check({ name: 'types', tier: 'commit', title: 'basedpyright, every rule', run: types }),
  check({ name: 'deadcode', tier: 'commit', title: 'vulture', run: deadCode }),
  check({
    name: 'arch',
    tier: 'head',
    title: 'import-linter: the universal contracts and the project’s',
    applies: hasPackages,
    run: arch,
  }),
  check({
    name: 'config-strength',
    tier: 'head',
    title: 'ruff and basedpyright settings no weaker than the base',
    run: strength,
  }),
  check({
    name: 'toolchain',
    tier: 'head',
    title: 'the dev tools at the versions Talos pins',
    run: (ctx) => toolchain(ctx, PY_DEV_TOOLS.packages),
  }),
];

export const pyPack: Pack = {
  name: 'py',
  lang: 'py',
  checks: [...own, ...testChecks('py', pytestRunner), ...mutationChecks('py', mutmutRunner)],
  generated: [ruffBase, pyrightBase],
  install,
  devTools: PY_DEV_TOOLS,
};
