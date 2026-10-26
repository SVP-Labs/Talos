import { generatedJsonNote } from '../../../configs/header.js';
import type { RenderContext } from '../../../core/pack.js';

export const TSCONFIG_BASE = 'tsconfig.talos.json';
export const TSCONFIG_PROJECT = 'tsconfig.json';

/**
 * The compiler flags every TypeScript component is held to: `strict` plus Thea's extras, and
 * JavaScript type-checked through `checkJs` until it is migrated.
 * `noPropertyAccessFromIndexSignature` stays off: with `noUncheckedIndexedAccess` it only swaps
 * `x.key` for `x['key']`.
 */
export const TSC_FLAGS: Readonly<Record<string, boolean>> = {
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noImplicitReturns: true,
  noImplicitOverride: true,
  noFallthroughCasesInSwitch: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  useUnknownInCatchVariables: true,
  verbatimModuleSyntax: true,
  isolatedModules: true,
  allowUnreachableCode: false,
  allowUnusedLabels: false,
  forceConsistentCasingInFileNames: true,
  allowJs: true,
  checkJs: true,
};

/** What `strict` switches on; a project that turns one back off is weaker than the base. */
export const STRICT_FAMILY = [
  'alwaysStrict',
  'noImplicitAny',
  'noImplicitThis',
  'strictBindCallApply',
  'strictBuiltinIteratorReturn',
  'strictFunctionTypes',
  'strictNullChecks',
  'strictPropertyInitialization',
] as const;

/** Set for speed; a project may turn it off, which is stricter. */
const CONVENIENCE = { skipLibCheck: true };

export function renderTsconfig(ctx: RenderContext): string {
  const config = {
    '//': generatedJsonNote(ctx.version, TSCONFIG_PROJECT),
    compilerOptions: { ...TSC_FLAGS, ...CONVENIENCE },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Written as Prettier formats it, since the project's copy is checked like any other file. */
export function tsconfigInitial(): string {
  return `{
  "extends": "./${TSCONFIG_BASE}",
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src", "test", "*.config.ts", "*.project.ts"]
}
`;
}
