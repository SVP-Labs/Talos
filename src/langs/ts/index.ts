import { archCheck } from './checks/arch.js';
import { deadcodeCheck } from './checks/deadcode.js';
import { e2eCheck } from './checks/e2e.js';
import { formatCheck } from './checks/format.js';
import { javascriptCheck } from './checks/javascript.js';
import { lintCheck } from './checks/lint.js';
import { sizeCheck } from './checks/size.js';
import { strengthCheck } from './checks/strength.js';
import { toolchainCheck } from './checks/toolchain.js';
import { typecovCheck } from './checks/typecov.js';
import { typesCheck } from './checks/types.js';
import { TS_GENERATED } from './configs/index.js';
import { TS_DEV_TOOLS } from './devtools.js';
import { installTs } from './install.js';
import { strykerRunner } from './runners/stryker.js';
import { vitestRunner } from './runners/vitest.js';
import type { Pack } from '../../core/pack.js';
import { mutationChecks, testChecks } from '../../quality/index.js';

/**
 * TypeScript, and JavaScript through `checkJs`: Prettier, ESLint, tsc, Knip and no new
 * JavaScript per commit; type coverage, dependency-cruiser, size budgets, Playwright with axe,
 * config strength and the toolchain at the head; Vitest and Stryker through the shared checks.
 */
export const tsPack: Pack = {
  name: 'ts',
  lang: 'ts',
  checks: [
    formatCheck,
    lintCheck,
    typesCheck,
    deadcodeCheck,
    javascriptCheck,
    ...testChecks('ts', vitestRunner),
    typecovCheck,
    archCheck,
    sizeCheck,
    e2eCheck,
    strengthCheck,
    toolchainCheck,
    ...mutationChecks('ts', strykerRunner),
  ],
  generated: TS_GENERATED,
  install: installTs,
  devTools: TS_DEV_TOOLS,
};
