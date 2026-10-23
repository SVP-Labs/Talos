/**
 * How a finding counts against a change:
 * - `standard`: blocking when it is new at head, or when its lines are lines the change touched;
 * - `always`: blocking whatever the base commit had (a security finding);
 * - `lost`: blocking when new at head on lines the change did not touch (coverage lost);
 * - `info`: never blocking; it feeds the debt list and reports only.
 */
export type Policy = 'standard' | 'always' | 'lost' | 'info';

export type Location = {
  /** Repository-relative, forward slashes. */
  readonly file: string;
  /** 1-based. */
  readonly line: number;
  readonly endLine?: number;
  readonly column?: number;
};

export type Finding = {
  /** `<tool>/<rule>`, such as `eslint/complexity` or `coverage/uncovered`. */
  readonly rule: string;
  readonly message: string;
  readonly location?: Location;
  /**
   * What identifies the finding when no code does (a package and advisory, a runtime and its
   * version). Findings with a location are identified by the code they point at instead.
   */
  readonly key?: string;
  readonly policy?: Policy;
  readonly docs?: string;
};

export type Reported = Omit<Finding, 'policy'> & {
  readonly check: string;
  readonly fingerprint: string;
  readonly policy: Policy;
};
