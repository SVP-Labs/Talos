import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { type Environment, normalize } from './environment.js';

const dependency = z.object({ name: z.string(), extra: z.array(z.string()).optional() });
const groups = z.record(z.string(), z.array(dependency));

const lockPackage = z.object({
  name: z.string(),
  source: z.record(z.string(), z.unknown()).optional(),
  dependencies: z.array(dependency).optional(),
  'optional-dependencies': groups.optional(),
  'dev-dependencies': groups.optional(),
});

const lockFile = z.object({ package: z.array(lockPackage).default([]) });

type LockPackage = z.infer<typeof lockPackage>;
type Lock = z.infer<typeof lockFile>;

function readLock(text: string): Lock | undefined {
  try {
    const parsed = lockFile.safeParse(parseToml(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
type Dependency = z.infer<typeof dependency>;

function isMember(pkg: LockPackage): boolean {
  return pkg.source !== undefined && ('editable' in pkg.source || 'virtual' in pkg.source);
}

function closure(
  packages: ReadonlyMap<string, LockPackage>,
  start: readonly Dependency[],
): Set<string> {
  const seen = new Set<string>();
  const queue = [...start];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const name = normalize(next.name);
    const pkg = packages.get(name);
    const extras = (next.extra ?? []).flatMap(
      (extra) => pkg?.['optional-dependencies']?.[extra] ?? [],
    );
    queue.push(...extras);
    if (seen.has(name)) continue;
    seen.add(name);
    queue.push(...(pkg?.dependencies ?? []));
  }
  return seen;
}

/**
 * Distributions a uv.lock installs only for its dependency groups: reached from the project's
 * groups and not from its dependencies or extras. Undefined when the text isn't a uv.lock.
 */
export function devOnlyDistributions(text: string): Set<string> | undefined {
  const lock = readLock(text);
  if (lock === undefined) return undefined;
  const packages = new Map(lock.package.map((pkg) => [normalize(pkg.name), pkg]));
  const members = lock.package.filter((pkg) => isMember(pkg));
  const runtime = closure(packages, [
    ...members.map((pkg) => ({ name: pkg.name })),
    ...members.flatMap((pkg) => Object.values(pkg['optional-dependencies'] ?? {}).flat()),
  ]);
  const dev = closure(
    packages,
    members.flatMap((pkg) => Object.values(pkg['dev-dependencies'] ?? {}).flat()),
  );
  return new Set([...dev].filter((name) => !runtime.has(name)));
}

/** Top-level modules that only dev-only distributions provide. */
export function devOnlyModules(devOnly: ReadonlySet<string>, env: Environment): string[] {
  return [...env.modules]
    .filter(([module, providers]) => /^(?!__)[A-Za-z_]\w*$/.test(module) && providers.length > 0)
    .filter(([, providers]) => providers.every((dist) => devOnly.has(dist)))
    .map(([module]) => module)
    .sort((a, b) => a.localeCompare(b));
}
