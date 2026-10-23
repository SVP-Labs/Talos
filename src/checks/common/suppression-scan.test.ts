import { describe, expect, it } from 'vitest';
import { suppressionsIn } from './suppression-scan.js';

function kinds(file: string, text: string): string[] {
  return suppressionsIn(file, text).map((hit) => `${hit.line}:${hit.kind}`);
}

describe('suppressionsIn', () => {
  it('finds the TypeScript and JavaScript directives in comments only', () => {
    const source = [
      '// eslint-disable-next-line no-console',
      'console.log(1); // eslint-disable-line',
      '/* eslint-disable */',
      '/* eslint no-console: "off" */',
      '// @ts-expect-error: wrong on purpose',
      '/** @ts-ignore */',
      '// @ts-nocheck',
      '/* istanbul ignore next */',
      '/* c8 ignore start */',
      '/* v8 ignore next */',
      '// prettier-ignore',
      '// type-coverage:ignore-next-line',
      '// Stryker disable next-line all',
      '// jscpd:ignore-start',
      '// cspell:disable-next-line',
      "const text = '// eslint-disable-line';",
      'const pattern = /\\/\\/ @ts-ignore/;',
      '// explains eslint-disable usage in prose',
    ].join('\n');
    expect(kinds('src/a.ts', source)).toEqual([
      '1:eslint-disable',
      '2:eslint-disable',
      '3:eslint-disable',
      '4:eslint-config',
      '5:ts-expect-error',
      '6:ts-ignore',
      '7:ts-nocheck',
      '8:istanbul-ignore',
      '9:c8-ignore',
      '10:v8-ignore',
      '11:prettier-ignore',
      '12:type-coverage-ignore',
      '13:stryker-disable',
      '14:jscpd-ignore',
      '15:cspell',
    ]);
  });

  it('finds the Python directives, but not in doc strings', () => {
    const source = [
      'import os  # noqa: F401',
      'x: int = "a"  # type: ignore[assignment]  # noqa',
      'y = f()  # pyright: ignore[reportUnknownVariableType]',
      '# pyright: basic',
      '# pyright: strict',
      'if debug:  # pragma: no cover',
      'z = 1  # pragma: no mutate',
      '# fmt: off',
      'run(cmd, shell=True)  # nosec B602',
      'def f():',
      '    """Never write # noqa or type: ignore here."""',
      '# mypy: ignore-errors',
      '# pylint: disable=invalid-name',
      '# Explains that `# noqa` and `# nosec` are suppressions, and a noqa marker too.',
      'x = 1  # ruff: noqa: E501',
    ].join('\n');
    expect(kinds('app/m.py', source)).toEqual([
      '1:noqa',
      '2:noqa',
      '2:type-ignore',
      '3:pyright-ignore',
      '4:pyright-config',
      '6:pragma-no-cover',
      '7:pragma-no-mutate',
      '8:fmt-off',
      '9:nosec',
      '12:mypy-config',
      '13:pylint-disable',
      '15:noqa',
    ]);
  });

  it('finds the PHP directives in comments and doc comments', () => {
    const source = [
      '<?php',
      '/** @phpstan-ignore-next-line */',
      '$a = $b; // @phpstan-ignore-line',
      '/**',
      ' * @codeCoverageIgnore',
      ' * @SuppressWarnings(PHPMD.StaticAccess)',
      ' * @psalm-suppress MixedAssignment',
      ' * @infection-ignore-all',
      ' */',
      '// phpcs:ignore Generic.Files',
      '#[\\Override]',
      "$s = '// @phpstan-ignore-line';",
    ].join('\n');
    expect(kinds('src/A.php', source)).toEqual([
      '2:phpstan-ignore',
      '3:phpstan-ignore',
      '5:code-coverage-ignore',
      '6:suppress-warnings',
      '7:psalm-suppress',
      '8:infection-ignore',
      '10:phpcs-ignore',
    ]);
  });

  it('finds the Lua directives', () => {
    const source = [
      '-- luacheck: ignore 212',
      'local x = 1 -- luacheck: no unused',
      '-- luacheck: push',
      '-- luacheck: pop',
      '---@diagnostic disable-next-line: undefined-global',
      '-- stylua: ignore',
      '-- luacov: disable',
      'local s = "-- luacheck: ignore"',
    ].join('\n');
    expect(kinds('lib/a.lua', source)).toEqual([
      '1:luacheck',
      '2:luacheck',
      '5:diagnostic-disable',
      '6:stylua-ignore',
      '7:luacov-disable',
    ]);
  });

  it("finds Rust's attributes and comments", () => {
    const source = [
      '#![allow(clippy::pedantic)]',
      '#[allow(dead_code)]',
      '#[cfg_attr(test, allow(unused))]',
      '#[expect(clippy::too_many_lines)]',
      '#[rustfmt::skip]',
      '#[cfg_attr(coverage_nightly, coverage(off))]',
      '#[mutants::skip]',
      '/// #[allow(dead_code)] in a doc example',
      '// nosemgrep: rust.lang.security',
      '#[derive(Debug)]',
      'let s = "#[allow(x)]";',
    ].join('\n');
    expect(kinds('src/lib.rs', source)).toEqual([
      '1:allow',
      '2:allow',
      '3:allow',
      '4:expect',
      '5:rustfmt-skip',
      '6:coverage-off',
      '7:mutants-skip',
      '9:nosemgrep',
    ]);
  });

  it('finds shell, PowerShell, Dockerfile and workflow directives', () => {
    expect(kinds('run.sh', '#!/bin/bash\n# shellcheck disable=SC2086\necho $a\n')).toEqual([
      '2:shellcheck-disable',
    ]);
    const ps = [
      "[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '')]",
      'param()',
      "[System.Diagnostics.CodeAnalysis.suppressMessage('PSUseShouldProcess', '')]",
    ].join('\n');
    expect(kinds('tools/a.ps1', ps)).toEqual(['1:suppress-message', '3:suppress-message']);
    const docker = 'FROM x\n# hadolint ignore=DL3008\nRUN apt-get install -y curl\n';
    expect(kinds('Dockerfile', docker)).toEqual(['2:hadolint-ignore']);
    const workflow = [
      'on: push',
      'jobs:',
      '  a:',
      '    runs-on: ubuntu-latest # zizmor: ignore[unpinned-uses]',
      '    steps:',
      '      - run: |',
      '          # shellcheck disable=SC2086',
      '          echo "token # gitleaks:allow"',
      '      - run: echo "#nosemgrep"',
    ].join('\n');
    expect(kinds('.github/workflows/ci.yml', workflow)).toEqual([
      '4:zizmor-ignore',
      '7:shellcheck-disable',
      '8:gitleaks-allow',
    ]);
  });

  it('finds Markdown directives outside code', () => {
    const doc = [
      '# Title',
      '<!-- markdownlint-disable MD013 -->',
      'Use `<!-- markdownlint-disable -->` never.',
      '```html',
      '<!-- cspell:disable -->',
      '```',
      '<!--',
      'prettier-ignore',
      '-->',
    ].join('\n');
    expect(kinds('docs/a.md', doc)).toEqual(['2:markdownlint-disable', '8:prettier-ignore']);
  });

  it('finds the secret scanners and Sonar in any language, once a line each', () => {
    const source = [
      'const key = "abc"; // gitleaks:allow gitleaks:allow',
      'const token = "def"; // pragma: allowlist secret',
      'run(); // NOSONAR',
      '// Never add `gitleaks:allow` or a nosemgrep marker.',
    ].join('\n');
    expect(kinds('src/k.js', source)).toEqual([
      '1:gitleaks-allow',
      '2:allowlist-secret',
      '3:nosonar',
    ]);
    expect(suppressionsIn('src/k.js', '// eslint-disable\n')[0]?.message).toBe(
      '`eslint-disable` silences ESLint: fix what it reports instead.',
    );
  });

  it('reads nothing from files of no language it knows', () => {
    expect(kinds('data.json', '{"//": "eslint-disable"}')).toEqual([]);
  });
});
