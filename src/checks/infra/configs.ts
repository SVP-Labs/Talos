import { hadolintSettings } from './dockerfile.js';
import {
  dockerfiles,
  namedShellScripts,
  powershellFiles,
  PSSA_SETTINGS,
  shebangCandidates,
} from './files.js';
import { pssaSettings } from './powershell.js';
import { SHELLCHECK_DISABLE, SHELLCHECK_ENABLE } from './shell.js';
import { generatedHeader } from '../../configs/header.js';
import type { ApplyContext } from '../../core/check.js';
import type { Generated, RenderContext } from '../../core/pack.js';

export const SHELLCHECK_RC = '.shellcheckrc';
export const HADOLINT_CONFIG = '.hadolint.yaml';

/** Whether the repository may hold shell scripts; their first lines decide the rest. */
export function mayHaveShellScripts(files: readonly string[]): boolean {
  return namedShellScripts(files).length > 0 || shebangCandidates(files).length > 0;
}

export function renderShellcheckrc(version: string): string {
  return [
    generatedHeader('#', version).trimEnd(),
    `enable=${SHELLCHECK_ENABLE}`,
    `disable=${SHELLCHECK_DISABLE}`,
    'external-sources=true',
    'source-path=SCRIPTDIR',
    '',
  ].join('\n');
}

export function renderHadolint(version: string): string {
  return `${generatedHeader('#', version)}${hadolintSettings()}`;
}

export function renderPssaSettings(version: string): string {
  return `${generatedHeader('#', version)}${pssaSettings()}`;
}

/**
 * The bases editors read. None has an extension file: every rule is already on, and none of
 * these tools reads a second file. The gate passes the same settings itself.
 */
export const INFRA_GENERATED: readonly Generated[] = [
  {
    path: SHELLCHECK_RC,
    scope: 'repo',
    applies: (ctx: ApplyContext) => mayHaveShellScripts(ctx.facts.files),
    render: (ctx: RenderContext) => renderShellcheckrc(ctx.version),
  },
  {
    path: HADOLINT_CONFIG,
    scope: 'repo',
    applies: (ctx: ApplyContext) => dockerfiles(ctx.facts.files).length > 0,
    render: (ctx: RenderContext) => renderHadolint(ctx.version),
  },
  {
    path: PSSA_SETTINGS,
    scope: 'repo',
    applies: (ctx: ApplyContext) => powershellFiles(ctx.facts.files).length > 0,
    render: (ctx: RenderContext) => renderPssaSettings(ctx.version),
  },
];
