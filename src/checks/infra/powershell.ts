import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { powershellFiles } from './files.js';
import { parseJson, sentence, toolFailed } from './report.js';
import { EngineError } from '../../core/check.js';
import type { CheckContext } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';
import type { ExecResult } from '../../exec/exec.js';

/**
 * PSScriptAnalyzer's settings: every rule at every severity, parse errors included, and the
 * formatting rules that are off by default, at two spaces with braces on the same line.
 */
export function pssaSettings(): string {
  return [
    '@{',
    "  Severity = @('Error', 'Warning', 'Information', 'ParseError')",
    '  IncludeDefaultRules = $true',
    '  Rules = @{',
    '    PSAvoidExclaimOperator = @{ Enable = $true }',
    '    PSAvoidSemicolonsAsLineTerminators = @{ Enable = $true }',
    '    PSPlaceCloseBrace = @{ Enable = $true; IgnoreOneLineBlock = $true }',
    '    PSPlaceOpenBrace = @{ Enable = $true; OnSameLine = $true; IgnoreOneLineBlock = $true }',
    '    PSUseConsistentIndentation = @{',
    '      Enable = $true',
    '      IndentationSize = 2',
    "      Kind = 'space'",
    "      PipelineIndentation = 'IncreaseIndentationForFirstPipeline'",
    '    }',
    '    PSUseConsistentWhitespace = @{ Enable = $true }',
    '    PSUseCorrectCasing = @{ Enable = $true }',
    '  }',
    '}',
    '',
  ].join('\n');
}

/**
 * Analyses each listed file with the module imported by path, and writes the results as JSON,
 * each naming the file as listed.
 */
const PSSA_RUNNER = String.raw`param(
  [Parameter(Mandatory)][string] $Module,
  [Parameter(Mandatory)][string] $Settings,
  [Parameter(Mandatory)][string] $List,
  [Parameter(Mandatory)][string] $Out
)
$ErrorActionPreference = 'Stop'
Import-Module -Name $Module -Force
$records = @(
  foreach ($file in Get-Content -LiteralPath $List) {
    foreach ($record in Invoke-ScriptAnalyzer -Path $file -Settings $Settings) {
      [ordered]@{
        rule = $record.RuleName
        file = $file
        line = $record.Line
        endLine = if ($record.Extent) { $record.Extent.EndLineNumber } else { $null }
        column = $record.Column
        message = $record.Message
      }
    }
  }
)
ConvertTo-Json -InputObject $records -Depth 3 | Set-Content -LiteralPath $Out -Encoding utf8
`;

const record = z.object({
  rule: z.string(),
  file: z.string(),
  line: z.number().int(),
  endLine: z.number().int().nullable(),
  column: z.number().int().nullable(),
  message: z.string(),
});

function docsFor(rule: string): string | undefined {
  return rule.startsWith('PS')
    ? `https://learn.microsoft.com/powershell/utility-modules/psscriptanalyzer/rules/${rule.slice(2)}`
    : undefined;
}

/** The runner's JSON as findings. */
export function parsePssa(text: string): Finding[] {
  const parsed = z.array(record).safeParse(parseJson(text, 'PSScriptAnalyzer'));
  if (!parsed.success) throw new EngineError('PSScriptAnalyzer wrote JSON Talos cannot read');
  return parsed.data.map((r) => {
    const docs = docsFor(r.rule);
    return {
      rule: `psscriptanalyzer/${r.rule}`,
      message: sentence(r.message),
      location: {
        file: r.file,
        line: r.line,
        ...(r.endLine !== null && r.endLine > r.line ? { endLine: r.endLine } : {}),
        ...(r.column === null ? {} : { column: r.column }),
      },
      ...(docs === undefined ? {} : { docs }),
    };
  });
}

async function pwsh(ctx: CheckContext, args: readonly string[]): Promise<ExecResult> {
  try {
    return await ctx.exec('pwsh', args, {
      cwd: ctx.root,
      env: { NO_COLOR: '1', POWERSHELL_TELEMETRY_OPTOUT: '1', POWERSHELL_UPDATECHECK: 'Off' },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new EngineError(`infra/powershell needs PowerShell 7 (pwsh) on PATH: ${reason}`);
  }
}

/**
 * PSScriptAnalyzer from `tools.lock`, run through pwsh with the settings Talos writes into its
 * scratch directory, over every `.ps1`, `.psm1` and `.psd1` but the generated settings file.
 */
export async function powershell(ctx: CheckContext): Promise<Finding[]> {
  const files = powershellFiles(ctx.facts.files);
  if (files.length === 0) return [];
  const module = await ctx.tools.path('psscriptanalyzer');
  const at = (name: string): string => join(ctx.scratch, name);
  await writeFile(at('settings.psd1'), pssaSettings());
  await writeFile(at('analyse.ps1'), PSSA_RUNNER);
  await writeFile(at('files.txt'), `${files.join('\n')}\n`);
  const args = ['-NoProfile', '-NonInteractive', '-File', at('analyse.ps1'), '-Module', module];
  const more = ['-Settings', at('settings.psd1'), '-List', at('files.txt'), '-Out', at('out.json')];
  const result = await pwsh(ctx, [...args, ...more]);
  if (result.code !== 0) throw toolFailed('PSScriptAnalyzer', result);
  const text = await readFile(at('out.json'), 'utf8').catch(() => '');
  return parsePssa(text);
}
