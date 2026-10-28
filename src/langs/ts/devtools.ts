import type { DevTools } from '../../core/pack.js';

/**
 * The tools a TypeScript component installs at exactly these versions: every package the
 * generated configs load, and every program the checks run. A unit test keeps them equal to
 * Talos's own lockfile, so Talos holds itself to the versions it hands out.
 */
export const TS_DEV_TOOLS: DevTools = {
  manager: 'npm',
  packages: {
    '@eslint-community/eslint-plugin-eslint-comments': '4.8.1',
    '@eslint/js': '10.0.1',
    '@stryker-mutator/core': '10.0.0',
    '@stryker-mutator/vitest-runner': '10.0.0',
    '@stylistic/eslint-plugin': '5.10.0',
    '@vitest/coverage-v8': '5.0.5',
    'dependency-cruiser': '18.7.0',
    eslint: '10.13.0',
    'eslint-plugin-import-x': '4.17.1',
    'eslint-plugin-sonarjs': '4.2.2',
    'eslint-plugin-unicorn': '79.0.0',
    globals: '17.13.0',
    knip: '6.43.0',
    prettier: '3.9.10',
    'type-coverage': '2.30.4',
    typescript: '6.0.3',
    'typescript-eslint': '8.72.0',
    vitest: '5.0.5',
  },
};
