import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type Command, parse, required, UsageError } from './io.js';
import { shrinkwrapOf } from '../version/shrinkwrap.js';

/**
 * `talos shrinkwrap <dir> --out <file>`: the `npm-shrinkwrap.json` a release ships, from a hoisted
 * install of Talos's production dependencies in `dir`, beside its `package.json` and lockfile. The
 * release job runs it before packing.
 */
export const shrinkwrap: Command = async (argv, io) => {
  const { values, positionals } = parse(argv, { out: { type: 'string' } }, true);
  const [dir, ...extra] = positionals;
  if (dir === undefined || extra.length > 0) throw new UsageError('give one directory');
  const out = resolve(io.cwd, required(values.out, 'out'));
  const wrap = await shrinkwrapOf(resolve(io.cwd, dir));
  await writeFile(out, `${JSON.stringify(wrap, null, 2)}\n`);
  return 0;
};
