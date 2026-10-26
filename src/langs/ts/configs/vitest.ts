import { excludeGlobs, excludes, lines, quote } from './shared.js';
import { generatedHeader } from '../../../configs/header.js';
import type { RenderContext } from '../../../core/pack.js';
import { TEST_GLOBS } from '../files.js';

export const VITEST_BASE = 'vitest.config.ts';
export const VITEST_PROJECT = 'vitest.project.ts';

const IGNORED = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/.stryker-tmp/**',
  '**/.talos/**',
];

/** Every file the pack reads as code, by extension. */
const CODE = '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}';

/** Code that is never measured: tests, tool configs, type declarations and reports. */
const NOT_MEASURED = [
  ...TEST_GLOBS,
  '**/*.{config,project}.{ts,mts,cts,js,mjs,cjs}',
  '**/.*.{js,mjs,cjs}',
  '**/*.d.{ts,mts,cts}',
  '**/coverage/**',
];

/**
 * Vitest with V8 coverage of every source file, whether a test loads it or not: V8 sees only
 * what runs, so a module no test imports would otherwise be missing from the report rather than
 * uncovered. The project's file (a plain config object) names its test files, timeouts and setup;
 * the runner sets reporters and output paths itself.
 */
export function renderVitest(ctx: RenderContext): string {
  const excluded = excludes(ctx).flatMap((entry) => excludeGlobs(entry).slice(-1));
  const exclude = [...IGNORED, ...excluded];
  const unmeasured = [...IGNORED, ...NOT_MEASURED, ...excluded];
  return `${generatedHeader('//', ctx.version, VITEST_PROJECT)}import { defineConfig, mergeConfig } from 'vitest/config';
import project from './${VITEST_PROJECT.replace(/\.ts$/, '.js')}';

export default mergeConfig(
  defineConfig({
    test: {
      exclude: [
${lines(exclude.map(quote), '        ')}      ],
      coverage: {
        provider: 'v8',
        include: [${quote(CODE)}],
        exclude: [
${lines(unmeasured.map(quote), '          ')}        ],
      },
    },
  }),
  project,
);
`;
}

export function vitestProjectInitial(): string {
  return `import { defineConfig } from 'vitest/config';

// The project's additions to the generated Vitest base (${VITEST_BASE}).
export default defineConfig({
  test: {},
});
`;
}
