import { normalize, readEnvironment } from './environment.js';
import { type Bound } from './run.js';
import type { Finding } from '../../core/finding.js';

/**
 * Each pinned tool against the version installed in the component's environment, which the
 * lockfile decides. A tool at another version makes the editor and the gate disagree.
 */
export function toolchainFindings(
  pins: Readonly<Record<string, string>>,
  installed: ReadonlyMap<string, string>,
): Finding[] {
  return Object.entries(pins).flatMap(([name, version]): Finding[] => {
    const found = installed.get(normalize(name));
    if (found === version) return [];
    const key = `pypi ${name}`;
    if (found === undefined) {
      return [
        {
          rule: 'toolchain/missing',
          message: `${name} is not a dev dependency; Talos runs ${name} ${version}.`,
          key,
        },
      ];
    }
    return [
      {
        rule: 'toolchain/mismatch',
        message: `${name} ${found} is installed but Talos runs ${version}, so the editor and the gate may disagree.`,
        key,
      },
    ];
  });
}

export async function toolchain(
  ctx: Bound,
  pins: Readonly<Record<string, string>>,
): Promise<Finding[]> {
  return toolchainFindings(pins, (await readEnvironment(ctx)).versions);
}
