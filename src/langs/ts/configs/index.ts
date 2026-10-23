import {
  DEPCRUISE_BASE,
  DEPCRUISE_PROJECT,
  depcruiseProjectInitial,
  renderDepcruise,
} from './depcruise.js';
import { ESLINT_BASE, ESLINT_PROJECT, eslintProjectInitial, renderEslint } from './eslint.js';
import { KNIP_BASE, KNIP_PROJECT, knipProjectInitial, renderKnip } from './knip.js';
import {
  PRETTIER_CONFIG,
  PRETTIER_IGNORE,
  renderPrettier,
  renderPrettierIgnore,
} from './prettier.js';
import { renderStryker, STRYKER_BASE, STRYKER_PROJECT, strykerProjectInitial } from './stryker.js';
import { renderTsconfig, TSCONFIG_BASE, TSCONFIG_PROJECT, tsconfigInitial } from './tsconfig.js';
import { renderVitest, VITEST_BASE, VITEST_PROJECT, vitestProjectInitial } from './vitest.js';
import type { Generated, RenderContext } from '../../../core/pack.js';

type File = Pick<Generated, 'path' | 'render' | 'extension'>;

/** Every file the TypeScript pack renders, with the extension file each base imports. */
const FILES: readonly File[] = [
  {
    path: ESLINT_BASE,
    render: renderEslint,
    extension: { path: ESLINT_PROJECT, initial: eslintProjectInitial },
  },
  {
    path: TSCONFIG_BASE,
    render: renderTsconfig,
    extension: { path: TSCONFIG_PROJECT, initial: tsconfigInitial },
  },
  { path: PRETTIER_CONFIG, render: renderPrettier },
  {
    path: DEPCRUISE_BASE,
    render: renderDepcruise,
    extension: { path: DEPCRUISE_PROJECT, initial: depcruiseProjectInitial },
  },
  {
    path: KNIP_BASE,
    render: renderKnip,
    extension: { path: KNIP_PROJECT, initial: knipProjectInitial },
  },
  {
    path: VITEST_BASE,
    render: renderVitest,
    extension: { path: VITEST_PROJECT, initial: vitestProjectInitial },
  },
  {
    path: STRYKER_BASE,
    render: renderStryker,
    extension: { path: STRYKER_PROJECT, initial: strykerProjectInitial },
  },
];

/** The paths of the files Talos renders for a component, relative to its root. */
export const GENERATED_PATHS: readonly string[] = [
  ...FILES.map((file) => file.path),
  PRETTIER_IGNORE,
];

/** The project-owned files the bases import, relative to the component's root. */
export const EXTENSION_PATHS: readonly string[] = FILES.flatMap((file) =>
  file.extension === undefined ? [] : [file.extension.path],
);

function component(file: File): Generated {
  return { ...file, scope: 'component', langs: ['ts'], applies: () => true };
}

export const TS_GENERATED: readonly Generated[] = [
  ...FILES.map((file) => component(file)),
  component({
    path: PRETTIER_IGNORE,
    render: (ctx: RenderContext) => renderPrettierIgnore(ctx, GENERATED_PATHS),
  }),
];
