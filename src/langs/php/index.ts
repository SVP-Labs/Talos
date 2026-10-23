import { deadCode, lint, types } from './analysis.js';
import { PHP_GENERATED } from './configs.js';
import { arch } from './deptrac.js';
import { format } from './format.js';
import { infectionRunner } from './infection.js';
import { install } from './install.js';
import { phpFiles, shippedFiles, tracks } from './paths.js';
import { pestRunner } from './pest.js';
import { bind, type Bound } from './run.js';
import { strength } from './strength.js';
import { PHP_DEV_TOOLS, toolchain } from './toolchain.js';
import { typecov } from './typecov.js';
import {
  APPLIES,
  type ApplyContext,
  type Applicability,
  type Check,
  skip,
  type Tier,
} from '../../core/check.js';
import type { Finding } from '../../core/finding.js';
import type { Pack } from '../../core/pack.js';
import { mutationChecks, testChecks } from '../../quality/index.js';

function hasPhp(ctx: ApplyContext): Applicability {
  return phpFiles(ctx).length > 0 ? APPLIES : skip('the component has no PHP files');
}

function hasShipped(ctx: ApplyContext): Applicability {
  return shippedFiles(ctx).length > 0 ? APPLIES : skip('the component ships no PHP, only tests');
}

function hasComposer(ctx: ApplyContext): Applicability {
  return tracks(ctx, 'composer.json') ? APPLIES : skip('the component has no composer.json');
}

/** A PHP check: what it runs, when, and where it applies (wherever there is PHP, by default). */
type Spec = {
  readonly name: string;
  readonly tier: Tier;
  readonly title: string;
  readonly run: (ctx: Bound) => Promise<Finding[]>;
  readonly applies?: (ctx: ApplyContext) => Applicability;
};

function check({ name, tier, title, run, applies = hasPhp }: Spec): Check {
  return {
    scope: 'component',
    langs: ['php'],
    id: `php/${name}`,
    tier,
    title,
    applies,
    run: async (ctx) => run(bind(ctx)),
  };
}

const own: Check[] = [
  check({ name: 'format', tier: 'commit', title: 'pint, Laravel preset', run: format }),
  check({
    name: 'lint',
    tier: 'commit',
    title: 'PHPMD, cognitive complexity, nesting and file size',
    run: lint,
  }),
  check({ name: 'types', tier: 'commit', title: 'PHPStan max with strict-rules', run: types }),
  check({ name: 'deadcode', tier: 'commit', title: 'PHPStan dead-code rules', run: deadCode }),
  check({
    name: 'typecov',
    tier: 'head',
    title: 'Type coverage of shipped code',
    applies: hasShipped,
    run: typecov,
  }),
  check({
    name: 'arch',
    tier: 'head',
    title: 'deptrac: the universal rules and the project’s',
    applies: hasShipped,
    run: arch,
  }),
  check({
    name: 'config-strength',
    tier: 'head',
    title: 'PHPStan, PHPMD and PHPUnit settings no weaker than the base',
    run: strength,
  }),
  check({
    name: 'toolchain',
    tier: 'head',
    title: 'The dev tools at the versions Talos pins',
    applies: hasComposer,
    run: toolchain,
  }),
];

export const phpPack: Pack = {
  name: 'php',
  lang: 'php',
  checks: [...own, ...testChecks('php', pestRunner), ...mutationChecks('php', infectionRunner)],
  generated: PHP_GENERATED,
  install,
  devTools: PHP_DEV_TOOLS,
};
