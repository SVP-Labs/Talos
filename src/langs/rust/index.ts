import { clippyBase, rustfmtBase } from './configs.js';
import { deadCode } from './deadcode.js';
import { format } from './format.js';
import { install } from './install.js';
import { lint } from './lint.js';
import { mutantsRunner } from './mutants.js';
import { nextestRunner } from './nextest.js';
import { hasRust } from './paths.js';
import { type Bound, bind } from './run.js';
import { strength } from './strength.js';
import { toolchain } from './toolchain.js';
import { types } from './types.js';
import { type Check } from '../../core/check.js';
import { componentCheck, type ComponentCheckSpec } from '../../core/component.js';
import type { Pack } from '../../core/pack.js';
import { mutationChecks, testChecks } from '../../quality/index.js';

function check(spec: ComponentCheckSpec<Bound>): Check {
  return componentCheck('rust', bind, hasRust, spec);
}

const own: Check[] = [
  check({ name: 'format', tier: 'commit', title: 'rustfmt', run: format }),
  check({
    name: 'lint',
    tier: 'commit',
    title: 'Clippy pedantic and rustc lints, file size and nesting',
    run: lint,
  }),
  check({ name: 'types', tier: 'commit', title: 'rustc', run: types }),
  check({ name: 'deadcode', tier: 'commit', title: 'dead_code and cargo-machete', run: deadCode }),
  check({
    name: 'config-strength',
    tier: 'head',
    title: 'lint levels and tool settings no weaker than the base',
    run: strength,
  }),
  check({
    name: 'toolchain',
    tier: 'head',
    title: 'the Rust toolchain pinned to an exact release',
    run: toolchain,
  }),
];

export const rustPack: Pack = {
  name: 'rust',
  lang: 'rust',
  checks: [...own, ...testChecks('rust', nextestRunner), ...mutationChecks('rust', mutantsRunner)],
  generated: [rustfmtBase, clippyBase],
  install,
};
