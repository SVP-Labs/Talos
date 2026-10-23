import { treeDir } from './paths.js';
import { type Bound, failed, runTree } from './run.js';
import type { Finding } from '../../core/finding.js';

/** `luarocks list --porcelain`: a rock, a version, a status and a tree per line, tab-separated. */
export function parseRockList(stdout: string): Map<string, string[]> {
  const installed = new Map<string, string[]>();
  for (const line of stdout.split(/\r?\n/)) {
    const [name, version] = line.split('\t');
    if (name === undefined || version === undefined || name === '') continue;
    installed.set(name, [...(installed.get(name) ?? []), version]);
  }
  return installed;
}

/**
 * Each pinned tool against what the tree has. The project's rockspec can bring another version
 * of one; then the editor and the gate may disagree about what it reports.
 */
export function toolchainFindings(
  pins: Readonly<Record<string, string>>,
  installed: ReadonlyMap<string, readonly string[]>,
): Finding[] {
  return Object.entries(pins).flatMap(([name, version]): Finding[] => {
    const found = installed.get(name) ?? [];
    const others = found.filter((v) => v !== version);
    const key = `luarocks ${name}`;
    if (found.length === 0) {
      return [
        {
          rule: 'toolchain/missing',
          message: `${name} is not installed; Talos runs ${name} ${version}.`,
          key,
        },
      ];
    }
    if (others.length === 0) return [];
    return [
      {
        rule: 'toolchain/mismatch',
        message: `${name} ${others.join(', ')} is installed but Talos runs ${version}, so the editor and the gate may disagree.`,
        key,
      },
    ];
  });
}

export async function toolchain(
  ctx: Bound,
  pins: Readonly<Record<string, string>>,
): Promise<Finding[]> {
  const result = await runTree(ctx, 'luarocks', ['--tree', treeDir(ctx), 'list', '--porcelain']);
  if (result.code !== 0) throw failed('luarocks list', result);
  return toolchainFindings(pins, parseRockList(result.stdout));
}
