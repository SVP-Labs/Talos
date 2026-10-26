import { z } from 'zod';
import { jsonFrom, runScript, type ToolContext } from './run.js';
import { EngineError } from '../../core/check.js';

/** Lists the distributions installed in the interpreter's environment and what they provide. */
const SCRIPT = String.raw`import importlib.metadata as metadata
import json

versions = {}
for dist in metadata.distributions():
    name = dist.metadata["Name"]
    if name:
        versions[name] = dist.version
print(json.dumps({"versions": versions, "modules": metadata.packages_distributions()}))
`;

const shape = z.object({
  versions: z.record(z.string(), z.string()),
  modules: z.record(z.string(), z.array(z.string())),
});

/** Names as the package index compares them: lower case, runs of `-`, `_` and `.` as one `-`. */
export function normalize(name: string): string {
  return name.toLowerCase().replaceAll(/[-_.]+/g, '-');
}

export type Environment = {
  /** Installed distributions by normalized name. */
  readonly versions: ReadonlyMap<string, string>;
  /** Top-level import names and the normalized distributions that provide them. */
  readonly modules: ReadonlyMap<string, readonly string[]>;
};

export function parseEnvironment(text: string): Environment {
  const parsed = shape.safeParse(jsonFrom(text, 'the environment script'));
  if (!parsed.success) throw new EngineError('the environment script printed an unknown shape');
  return {
    versions: new Map(Object.entries(parsed.data.versions).map(([k, v]) => [normalize(k), v])),
    modules: new Map(
      Object.entries(parsed.data.modules).map(([k, v]) => [k, v.map((d) => normalize(d))]),
    ),
  };
}

export async function readEnvironment(ctx: ToolContext): Promise<Environment> {
  return parseEnvironment(await runScript(ctx, 'talos_environment.py', SCRIPT, ''));
}
