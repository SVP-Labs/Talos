import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePssa, powershell, pssaSettings } from './powershell.js';
import { infraContext, ok, recording } from './test/context.js';
import { EngineError } from '../../core/check.js';
import { ExecError } from '../../exec/exec.js';

/** Talos's runner over PSScriptAnalyzer 1.25.0 in pwsh 7.6.8, messages as printed. */
const RECORDED = JSON.stringify([
  {
    rule: 'PSAvoidUsingWriteHost',
    file: 'scripts/install.ps1',
    line: 3,
    endLine: 3,
    column: 5,
    message:
      "File 'install.ps1' uses Write-Host. Avoid using Write-Host because it might not work in all hosts, does not work when there is no host, and (prior to PS 5.0) cannot be suppressed, captured, or redirected. Instead, use Write-Output, Write-Verbose, or Write-Information.",
  },
  {
    rule: 'PSUseConsistentIndentation',
    file: 'scripts/install.ps1',
    line: 2,
    endLine: 2,
    column: 1,
    message: 'Indentation not consistent',
  },
  {
    rule: 'MissingEndCurlyBrace',
    file: 'scripts/broken.ps1',
    line: 1,
    endLine: 1,
    column: 18,
    message: "Missing closing '}' in statement block or type definition.",
  },
]);

describe('parsePssa', () => {
  it('reports rules and parse errors under their names, with the docs for rules', () => {
    const findings = parsePssa(RECORDED);
    expect(findings[0]).toEqual({
      rule: 'psscriptanalyzer/PSAvoidUsingWriteHost',
      message: "File 'install.ps1' uses Write-Host.",
      location: { file: 'scripts/install.ps1', line: 3, column: 5 },
      docs: 'https://learn.microsoft.com/powershell/utility-modules/psscriptanalyzer/rules/AvoidUsingWriteHost',
    });
    expect(findings[1]?.message).toBe('Indentation not consistent.');
    expect(findings[2]).toEqual({
      rule: 'psscriptanalyzer/MissingEndCurlyBrace',
      message: "Missing closing '}' in statement block or type definition.",
      location: { file: 'scripts/broken.ps1', line: 1, column: 18 },
    });
  });

  it('keeps a span, reads an empty list as clean, and refuses anything else', () => {
    const spanning = JSON.stringify([
      { rule: 'PSX', file: 'a.ps1', line: 2, endLine: 5, column: null, message: 'x' },
    ]);
    expect(parsePssa(spanning)[0]?.location).toEqual({ file: 'a.ps1', line: 2, endLine: 5 });
    expect(parsePssa('﻿[]')).toEqual([]);
    expect(() => parsePssa('')).toThrow(EngineError);
    expect(() => parsePssa('{"rule":1}')).toThrow(EngineError);
  });
});

describe('pssaSettings', () => {
  it('turns on every rule at every severity, and the formatting rules at two spaces', () => {
    const settings = pssaSettings();
    expect(settings).toContain("Severity = @('Error', 'Warning', 'Information', 'ParseError')");
    expect(settings).toContain('IncludeDefaultRules = $true');
    expect(settings).toContain('IndentationSize = 2');
    expect(settings).not.toMatch(/ExcludeRules|Enable = \$false/);
  });
});

describe('powershell', () => {
  it('runs the analyser through pwsh with the module from tools.lock', async () => {
    const { exec, calls } = recording(async (call) => {
      const out = call.args[call.args.indexOf('-Out') + 1] ?? '';
      await writeFile(out, RECORDED);
      return ok('');
    });
    const ctx = await infraContext(
      { 'scripts/install.ps1': 'Write-Host x\n', 'PSScriptAnalyzerSettings.psd1': '@{}\n' },
      exec,
    );
    const findings = await powershell(ctx);
    expect(findings).toHaveLength(3);
    expect(calls[0]?.command).toBe('pwsh');
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining(['-NoProfile', '-NonInteractive', '/tools/psscriptanalyzer']),
    );
    expect(await readFile(join(ctx.scratch, 'files.txt'), 'utf8')).toBe('scripts/install.ps1\n');
    expect(await readFile(join(ctx.scratch, 'settings.psd1'), 'utf8')).toBe(pssaSettings());
  });

  it('is an engine error without pwsh, or when the analyser fails', async () => {
    const missing = recording(() => Promise.reject(new ExecError('pwsh could not start: ENOENT')));
    const ctx = await infraContext({ 'a.ps1': 'x\n' }, missing.exec);
    await expect(powershell(ctx)).rejects.toThrow(/needs PowerShell 7 \(pwsh\) on PATH/);
    const failing = recording(() => ({ code: 1, stdout: '', stderr: 'Cannot find path' }));
    const again = await infraContext({ 'a.ps1': 'x\n' }, failing.exec);
    await expect(powershell(again)).rejects.toThrow('PSScriptAnalyzer exited 1:\nCannot find path');
  });
});
