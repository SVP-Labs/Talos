/**
 * markdownlint's promise API, which markdownlint-cli2 re-exports without type declarations.
 * Only what the Markdown check passes is declared; the result is validated, so it is unknown.
 */
declare module 'markdownlint-cli2/markdownlint/promise' {
  export type LintOptions = {
    readonly strings: Readonly<Record<string, string>>;
    readonly config: Readonly<Record<string, unknown>>;
    readonly noInlineConfig: boolean;
    readonly handleRuleFailures: boolean;
  };
  export function lint(options: LintOptions): Promise<unknown>;
}
