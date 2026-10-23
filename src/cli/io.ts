import { parseArgs, type ParseArgsConfig } from 'node:util';

export type Io = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  out(text: string): void;
  err(text: string): void;
};

export const processIo: Io = {
  cwd: process.cwd(),
  env: process.env,
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
};

export type Command = (argv: readonly string[], io: Io) => Promise<number>;

export class UsageError extends Error {
  override readonly name = 'UsageError';
}

type Options = NonNullable<ParseArgsConfig['options']>;

/** `node:util`'s parser, strict, with unknown flags reported as usage errors. */
export function parse<T extends Options>(
  argv: readonly string[],
  options: T,
  allowPositionals = false,
): ReturnType<
  typeof parseArgs<{ args: string[]; options: T; allowPositionals: boolean; strict: true }>
> {
  try {
    return parseArgs({ args: [...argv], options, allowPositionals, strict: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

export function required(value: string | undefined, flag: string): string {
  if (value === undefined || value === '') throw new UsageError(`--${flag} is required`);
  return value;
}
