import { fromTool, shippedFiles } from './paths.js';
import { TYPE_COVERAGE } from './phpstan-config.js';
import { analyse, type PhpstanReport, writeConfig } from './phpstan.js';
import type { Bound } from './run.js';
import { scopeFor } from './scope.js';
import { EngineError } from '../../core/check.js';
import type { Finding, Policy } from '../../core/finding.js';

/** Per mille: 99.5% of each kind of declaration in shipped code carries a type. */
const FLOOR_PER_MILLE = 995;

type Kind = 'param' | 'return' | 'property' | 'constant';

const IDENTIFIER = /^typeCoverage\.(param|return|property|constant)TypeCoverage$/;
const COUNTS = /^Out of (\d+) possible \w+ types, only (\d+) - /;

export type Untyped = {
  readonly kind: Kind;
  readonly file: string;
  readonly line: number;
  /** Declarations of this kind in the component's shipped code, and how many are typed. */
  readonly total: number;
  readonly typed: number;
};

function kindOf(identifier: string): Kind | undefined {
  const match = IDENTIFIER.exec(identifier);
  const kind = match?.[1];
  return kind === 'param' || kind === 'return' || kind === 'property' || kind === 'constant'
    ? kind
    : undefined;
}

/**
 * The extension's messages, one per untyped declaration, each carrying its kind's totals. Its
 * other errors (an analysis at level 0 of shipped code alone) are none of this check's business.
 */
export function untypedFrom(report: PhpstanReport): Untyped[] {
  if (report.general.length > 0) {
    throw new EngineError(`PHPStan could not measure type coverage: ${report.general.join(' ')}`);
  }
  return report.messages.flatMap((m): Untyped[] => {
    const kind = kindOf(m.identifier);
    if (kind === undefined) return [];
    const counts = COUNTS.exec(m.message);
    if (counts === null) throw new EngineError(`type-coverage printed "${m.message}"`);
    const [total, typed] = [Number(counts[1]), Number(counts[2])];
    return [{ kind, file: m.file, line: m.line, total, typed }];
  });
}

export function atFloor(untyped: Pick<Untyped, 'total' | 'typed'>): boolean {
  return untyped.typed * 1000 >= untyped.total * FLOOR_PER_MILLE;
}

const MISSING: Readonly<Record<Kind, string>> = {
  param: 'This parameter has no type',
  return: 'This function has no return type',
  property: 'This property has no type',
  constant: 'This class constant has no type',
};

const PLURAL: Readonly<Record<Kind, string>> = {
  param: 'parameters',
  return: 'functions',
  property: 'properties',
  constant: 'class constants',
};

function percent(u: Untyped): string {
  return ((u.typed * 100) / u.total).toFixed(1);
}

/**
 * Each untyped declaration: `standard` while its kind is under the floor in the component's
 * shipped code, so no new one lands; `info` once the kind is at or above it.
 */
export function typecovFindings(
  untyped: readonly Untyped[],
  toRepo: (file: string) => string,
): Finding[] {
  return untyped.map((u): Finding => {
    const floor = atFloor(u);
    const where = floor ? 'at or above' : 'under';
    const policy: Policy | undefined = floor ? 'info' : undefined;
    return {
      rule: `typecov/${u.kind}`,
      message:
        `${MISSING[u.kind]}; ${u.typed} of ${u.total} ${PLURAL[u.kind]} in shipped code ` +
        `are typed (${percent(u)}%), ${where} the 99.5% floor.`,
      location: { file: toRepo(u.file), line: u.line },
      ...(policy === undefined ? {} : { policy }),
    };
  });
}

/** PHPStan at level 0 over shipped code with the type-coverage extension asking for 100%. */
export async function typecov(ctx: Bound): Promise<Finding[]> {
  const scope = await scopeFor(ctx, shippedFiles(ctx));
  const config = await writeConfig(ctx, 'typecov', {
    scope,
    extra: [TYPE_COVERAGE],
    parameters: {
      level: 0,
      type_coverage: { return: 100, param: 100, property: 100, constant: 100 },
    },
  });
  return typecovFindings(untypedFrom(await analyse(ctx, config)), (file) => fromTool(ctx, file));
}
