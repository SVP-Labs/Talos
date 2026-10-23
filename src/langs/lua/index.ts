import { bustedRunner } from './busted.js';
import { LUA_GENERATED } from './configs.js';
import { deadCode } from './deadcode.js';
import { LUA_DEV_TOOLS } from './devtools.js';
import { format } from './format.js';
import { install } from './install.js';
import { lint } from './lint.js';
import { luaFiles } from './paths.js';
import { bind, type Bound } from './run.js';
import { strength } from './strength.js';
import { toolchain } from './toolchain.js';
import { types } from './types.js';
import { type ApplyContext, type Check, skip } from '../../core/check.js';
import { APPLIES } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';
import type { Pack } from '../../core/pack.js';
import { testChecks } from '../../quality/index.js';

/** Why Lua has no mutation testing: the matrix marks it N/A, and the check says so. */
export const NO_MUTATION = 'no mature mutation tool for Lua';

/** What every Lua check shares: it runs per component, where there is Lua to check. */
const PER_COMPONENT = {
  scope: 'component',
  langs: ['lua'],
  applies: (ctx: ApplyContext) =>
    luaFiles(ctx).length > 0 ? APPLIES : skip('the component has no Lua files'),
} as const;

function bound(run: (ctx: Bound) => Promise<Finding[]>): Check['run'] {
  return (ctx) => run(bind(ctx));
}

const own: Check[] = [
  { ...PER_COMPONENT, id: 'lua/format', tier: 'commit', title: 'StyLua', run: bound(format) },
  {
    ...PER_COMPONENT,
    id: 'lua/lint',
    tier: 'commit',
    title: 'luacheck, and the size, nesting and complexity limits',
    run: bound(lint),
  },
  {
    ...PER_COMPONENT,
    id: 'lua/types',
    tier: 'commit',
    title: 'lua-language-server --check',
    run: bound(types),
  },
  {
    ...PER_COMPONENT,
    id: 'lua/deadcode',
    tier: 'commit',
    title: "luacheck's unused-code warnings",
    run: bound(deadCode),
  },
  {
    ...PER_COMPONENT,
    id: 'lua/config-strength',
    tier: 'head',
    title: 'luacheck settings no weaker than the base',
    run: bound(strength),
  },
  {
    ...PER_COMPONENT,
    id: 'lua/toolchain',
    tier: 'head',
    title: 'the rocks at the versions Talos pins',
    run: bound((ctx) => toolchain(ctx, LUA_DEV_TOOLS.packages)),
  },
  {
    ...PER_COMPONENT,
    id: 'lua/mutation',
    tier: 'head',
    title: 'mutation testing, which Lua has no mature tool for',
    applies: () => skip(NO_MUTATION),
    run: () => Promise.resolve([]),
  },
];

/**
 * Lua 5.4: StyLua, luacheck (lint and dead code), lua-language-server and busted with luacov
 * through the shared test checks. Mutation testing is N/A and says so; there is no type
 * coverage and no architecture tool.
 */
export const luaPack: Pack = {
  name: 'lua',
  lang: 'lua',
  checks: [...own, ...testChecks('lua', bustedRunner)],
  generated: LUA_GENERATED,
  install,
  devTools: LUA_DEV_TOOLS,
};
