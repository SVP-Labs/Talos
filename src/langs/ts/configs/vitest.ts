import { excludeGlobs, excludes, lines, quote } from './shared.js';
import { generatedHeader } from '../../../configs/header.js';
import type { RenderContext } from '../../../core/pack.js';

export const VITEST_BASE = 'vitest.config.ts';
export const VITEST_PROJECT = 'vitest.project.ts';

const IGNORED = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/.stryker-tmp/**',
  '**/.talos/**',
];

/**
 * Vitest with V8 coverage. The project's file (a plain config object) names its test files,
 * timeouts, setup and coverage scope; the runner sets reporters and output paths itself.
 */
export function renderVitest(ctx: RenderContext): string {
  const exclude = [...IGNORED, ...excludes(ctx).flatMap((entry) => excludeGlobs(entry).slice(-1))];
  return `${generatedHeader('//', ctx.version, VITEST_PROJECT)}import { defineConfig, mergeConfig } from 'vitest/config';
import project from './${VITEST_PROJECT.replace(/\.ts$/, '.js')}';

export default mergeConfig(
  defineConfig({
    test: {
      exclude: [
${lines(exclude.map(quote), '        ')}      ],
      coverage: { provider: 'v8' },
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
