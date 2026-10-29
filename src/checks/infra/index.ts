import { actionlint } from './actionlint.js';
import { INFRA_GENERATED, mayHaveShellScripts } from './configs.js';
import { dockerfile } from './dockerfile.js';
import { applyExceptions, configText, workflowSteps } from './exceptions.js';
import {
  actionFiles,
  dependabotFiles,
  dockerfiles,
  powershellFiles,
  workflowFiles,
} from './files.js';
import { powershell } from './powershell.js';
import { shell } from './shell.js';
import { zizmor } from './zizmor.js';
import {
  type ApplyContext,
  APPLIES,
  type Check,
  type CheckContext,
  skip,
} from '../../core/check.js';
import type { Finding } from '../../core/finding.js';
import type { Pack } from '../../core/pack.js';

function zizmorInputs(files: readonly string[]): string[] {
  return [...workflowFiles(files), ...actionFiles(files), ...dependabotFiles(files)];
}

/**
 * actionlint for correctness, then zizmor for security, less the zizmor findings `talos.yml`
 * excepts. `now` is the clock the exceptions' expiry is read against.
 */
export async function workflows(ctx: CheckContext, now = new Date()): Promise<Finding[]> {
  const files = ctx.facts.files;
  const correctness = await actionlint(ctx, workflowFiles(files));
  const security = await applyExceptions(await zizmor(ctx, zizmorInputs(files)), {
    entries: ctx.config.exceptions.workflows,
    now,
    stepName: workflowSteps(ctx.root),
    configText: await configText(ctx.root),
  });
  return [...correctness, ...security];
}

const REPO = { tier: 'head', scope: 'repo' } as const;

const checks: Check[] = [
  {
    ...REPO,
    id: 'infra/shell',
    title: 'shellcheck, every optional check but SC2250',
    applies: (ctx: ApplyContext) =>
      mayHaveShellScripts(ctx.facts.files) ? APPLIES : skip('the repository has no shell scripts'),
    run: shell,
  },
  {
    ...REPO,
    id: 'infra/powershell',
    title: 'PSScriptAnalyzer, every rule at every severity',
    applies: (ctx: ApplyContext) =>
      powershellFiles(ctx.facts.files).length > 0
        ? APPLIES
        : skip('the repository has no PowerShell files'),
    run: powershell,
  },
  {
    ...REPO,
    id: 'infra/dockerfile',
    title: 'hadolint, down to info',
    applies: (ctx: ApplyContext) =>
      dockerfiles(ctx.facts.files).length > 0 ? APPLIES : skip('the repository has no Dockerfile'),
    run: dockerfile,
  },
  {
    ...REPO,
    id: 'infra/workflows',
    title: 'actionlint, and zizmor at its pedantic persona',
    applies: (ctx: ApplyContext) =>
      zizmorInputs(ctx.facts.files).length > 0 || ctx.config.exceptions.workflows.length > 0
        ? APPLIES
        : skip('the repository has no workflows, actions or Dependabot config'),
    run: (ctx: CheckContext) => workflows(ctx),
  },
];

export const infraPack: Pack = {
  name: 'infra',
  checks,
  generated: INFRA_GENERATED,
};
