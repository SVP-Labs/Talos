/** A way to silence a tool, recognised in a comment or, for attributes, in code. */
export type Directive = {
  /** The finding's rule is `suppression/<kind>`. */
  readonly kind: string;
  readonly pattern: RegExp;
  readonly message: string;
};

function silences(directive: string, tool: string): string {
  return `\`${directive}\` silences ${tool}: fix what it reports instead.`;
}

function uncovers(directive: string): string {
  return `\`${directive}\` hides code from coverage: test it instead.`;
}

function formatterSkips(directive: string, tool: string): string {
  return `\`${directive}\` keeps ${tool} from formatting this code: let it format it.`;
}

function mutationSkips(directive: string, tool: string): string {
  return `\`${directive}\` keeps ${tool} from mutating this code: test it so its mutants die.`;
}

function hidesSecret(directive: string, tool: string): string {
  return `\`${directive}\` hides a possible secret from ${tool}: remove the secret instead.`;
}

function reconfigures(directive: string, tool: string): string {
  return `A \`${directive}\` comment changes ${tool}'s rules here: keep the rules Talos sets.`;
}

/** TypeScript and JavaScript tools, read from comments. */
const JS: readonly Directive[] = [
  {
    kind: 'eslint-disable',
    pattern: /^eslint-disable(?:-next-line|-line)?(?![\w-])/,
    message: silences('eslint-disable', 'ESLint'),
  },
  {
    kind: 'eslint-config',
    pattern: /^eslint\s+[@\w/-]+\s*:/,
    message: reconfigures('eslint', 'ESLint'),
  },
  { kind: 'ts-ignore', pattern: /^@ts-ignore\b/, message: silences('@ts-ignore', 'TypeScript') },
  {
    kind: 'ts-expect-error',
    pattern: /^@ts-expect-error\b/,
    message: silences('@ts-expect-error', 'TypeScript'),
  },
  { kind: 'ts-nocheck', pattern: /^@ts-nocheck\b/, message: silences('@ts-nocheck', 'TypeScript') },
  {
    kind: 'istanbul-ignore',
    pattern: /^istanbul\s+ignore\b/,
    message: uncovers('istanbul ignore'),
  },
  { kind: 'c8-ignore', pattern: /^c8\s+ignore\b/, message: uncovers('c8 ignore') },
  { kind: 'v8-ignore', pattern: /^v8\s+ignore\b/, message: uncovers('v8 ignore') },
  {
    kind: 'node-coverage-ignore',
    pattern: /^node:coverage\s+(?:ignore|disable)\b/,
    message: uncovers('node:coverage ignore'),
  },
  {
    kind: 'prettier-ignore',
    pattern: /^prettier-ignore(?:-start)?\b/,
    message: formatterSkips('prettier-ignore', 'Prettier'),
  },
  {
    kind: 'type-coverage-ignore',
    pattern: /^type-coverage:ignore-(?:next-)?line\b/,
    message: '`type-coverage:ignore` hides untyped code from type coverage: type it instead.',
  },
  {
    kind: 'stryker-disable',
    pattern: /^Stryker\s+disable\b/i,
    message: mutationSkips('Stryker disable', 'Stryker'),
  },
];

/** Python tools, read from comments. */
const PYTHON: readonly Directive[] = [
  {
    kind: 'noqa',
    pattern: /(?:^|#\s*)(?:(?:ruff|flake8):\s*)?noqa\b/i,
    message: silences('noqa', 'Ruff'),
  },
  {
    kind: 'type-ignore',
    pattern: /(?:^|#\s*)type:\s*ignore\b/,
    message: silences('type: ignore', 'the type checker'),
  },
  {
    kind: 'pyright-ignore',
    pattern: /(?:^|#\s*)(?:based)?pyright:\s*ignore\b/,
    message: silences('pyright: ignore', 'basedpyright'),
  },
  {
    kind: 'pyright-config',
    pattern: /^(?:based)?pyright:\s*(?!ignore\b|strict\s*$)\S/,
    message: reconfigures('pyright:', 'basedpyright'),
  },
  {
    kind: 'mypy-config',
    pattern: /^mypy:\s*\S/,
    message: reconfigures('mypy:', 'the type checker'),
  },
  {
    kind: 'pragma-no-cover',
    pattern: /^pragma:\s*no\s+(?:cover|branch)\b/,
    message: uncovers('pragma: no cover'),
  },
  {
    kind: 'pragma-no-mutate',
    pattern: /^pragma:\s*no\s+mutate\b/,
    message: mutationSkips('pragma: no mutate', 'mutmut'),
  },
  {
    kind: 'fmt-off',
    pattern: /(?:^|#\s*)fmt:\s*(?:off|skip)\b/,
    message: formatterSkips('fmt: off', 'Ruff'),
  },
  {
    kind: 'pylint-disable',
    pattern: /^pylint:\s*disable\b/,
    message: silences('pylint: disable', 'Pylint'),
  },
];

/** PHP tools, read from comments and doc comments. */
const PHP: readonly Directive[] = [
  {
    kind: 'phpstan-ignore',
    pattern: /^@phpstan-ignore(?:-line|-next-line|-error)?\b/,
    message: silences('@phpstan-ignore', 'PHPStan'),
  },
  {
    kind: 'psalm-suppress',
    pattern: /^@psalm-suppress\b/,
    message: silences('@psalm-suppress', 'Psalm'),
  },
  {
    kind: 'code-coverage-ignore',
    pattern: /^@codeCoverageIgnore(?!End)/,
    message: uncovers('@codeCoverageIgnore'),
  },
  {
    kind: 'suppress-warnings',
    pattern: /^@SuppressWarnings\s*\(/,
    message: silences('@SuppressWarnings', 'PHPMD'),
  },
  {
    kind: 'phpcs-ignore',
    pattern: /^(?:phpcs:(?:ignore|disable)\b|@codingStandardsIgnore)/,
    message: silences('phpcs:ignore', 'PHP_CodeSniffer'),
  },
  {
    kind: 'infection-ignore',
    pattern: /^@infection-ignore-all\b/,
    message: mutationSkips('@infection-ignore-all', 'Infection'),
  },
];

/** Lua tools, read from comments. */
const LUA: readonly Directive[] = [
  {
    kind: 'luacheck',
    pattern: /^luacheck:\s*(?!pop\b|push\s*$)\S/,
    message: silences('luacheck:', 'luacheck'),
  },
  {
    kind: 'diagnostic-disable',
    pattern: /^@diagnostic\s+disable\b/,
    message: silences('@diagnostic disable', 'LuaLS'),
  },
  {
    kind: 'stylua-ignore',
    pattern: /^stylua:\s*ignore\b/,
    message: formatterSkips('stylua: ignore', 'StyLua'),
  },
  { kind: 'luacov-disable', pattern: /^luacov:\s*disable\b/, message: uncovers('luacov: disable') },
];

/** Scripts, containers, workflows and docs, read from comments. */
const INFRA: readonly Directive[] = [
  {
    kind: 'shellcheck-disable',
    pattern: /^shellcheck\s+(?:\S+\s+)*?disable=/,
    message: silences('shellcheck disable', 'ShellCheck'),
  },
  {
    kind: 'hadolint-ignore',
    pattern: /^hadolint\s+(?:global\s+)?ignore=/,
    message: silences('hadolint ignore', 'hadolint'),
  },
  {
    kind: 'zizmor-ignore',
    pattern: /^zizmor:\s*ignore\b/,
    message: silences('zizmor: ignore', 'zizmor'),
  },
  {
    kind: 'markdownlint-disable',
    pattern: /^markdownlint-(?:disable|configure-file)\b/,
    message: silences('markdownlint-disable', 'markdownlint'),
  },
];

/** Tools that read the same markers in every language. */
const ANY: readonly Directive[] = [
  {
    kind: 'jscpd-ignore',
    pattern: /^jscpd:ignore-start\b/,
    message: '`jscpd:ignore-start` hides repeated code from jscpd: keep one copy and share it.',
  },
  {
    kind: 'cspell',
    pattern: /^(?:cspell|spell-checker):\s*(?:disable|ignore|words)\b/i,
    message:
      'A `cspell:` comment silences the spell checker: fix the word or add it to the word list.',
  },
  {
    kind: 'nosemgrep',
    pattern: /(?:^|#\s*)nosemgrep\b/,
    message: silences('nosemgrep', 'Semgrep'),
  },
  { kind: 'nosonar', pattern: /\bNOSONAR\b/, message: silences('NOSONAR', "Sonar's rules") },
  {
    kind: 'nosec',
    pattern: /(?:^#?|#\s*)nosec\b/,
    message: silences('nosec', 'the security linter'),
  },
  {
    kind: 'gitleaks-allow',
    pattern: /\bgitleaks:allow\b/,
    message: hidesSecret('gitleaks:allow', 'gitleaks'),
  },
  {
    kind: 'allowlist-secret',
    pattern: /(?:^|#\s*)pragma:\s*allowlist\s+(?:nextline\s+)?secret\b/,
    message: hidesSecret('pragma: allowlist secret', 'the secret scanners'),
  },
];

/**
 * Every directive a comment can carry. Each is looked for in every language's comments: the
 * markers are distinct enough that one never reads as another tool's.
 */
export const COMMENT_DIRECTIVES: readonly Directive[] = [
  ...JS,
  ...PYTHON,
  ...PHP,
  ...LUA,
  ...INFRA,
  ...ANY,
];

const ATTRIBUTE = String.raw`^\s*#!?\[\s*`;

function rustAttribute(name: string): RegExp {
  return new RegExp(`${ATTRIBUTE}(?:${name}|cfg_attr\\s*\\(.*\\b${name})`);
}

/** Rust's attributes, read from code lines. */
export const RUST_ATTRIBUTES: readonly Directive[] = [
  {
    kind: 'allow',
    pattern: rustAttribute(String.raw`allow\s*\(`),
    message: silences('#[allow]', 'the compiler and Clippy'),
  },
  {
    kind: 'expect',
    pattern: rustAttribute(String.raw`expect\s*\(`),
    message: silences('#[expect]', 'the compiler and Clippy'),
  },
  {
    kind: 'rustfmt-skip',
    pattern: new RegExp(String.raw`${ATTRIBUTE}rustfmt::skip\b`),
    message: formatterSkips('#[rustfmt::skip]', 'rustfmt'),
  },
  {
    kind: 'coverage-off',
    pattern: rustAttribute(String.raw`coverage\s*\(\s*off`),
    message: uncovers('coverage(off)'),
  },
  {
    kind: 'mutants-skip',
    pattern: new RegExp(String.raw`${ATTRIBUTE}mutants::skip\b`),
    message: mutationSkips('#[mutants::skip]', 'cargo-mutants'),
  },
];

/** PowerShell's attribute, read from code lines; PowerShell ignores case. */
export const POWERSHELL_ATTRIBUTES: readonly Directive[] = [
  {
    kind: 'suppress-message',
    pattern:
      /^\s*\[\s*(?:System\.)?(?:Diagnostics\.CodeAnalysis\.)?SuppressMessage(?:Attribute)?\s*\(/i,
    message: silences('[SuppressMessage]', 'PSScriptAnalyzer'),
  },
];
