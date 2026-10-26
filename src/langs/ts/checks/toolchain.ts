import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Check, type CheckContext, skip, APPLIES } from '../../../core/check.js';
import type { Finding } from '../../../core/finding.js';
import { TS_DEV_TOOLS } from '../devtools.js';
import { componentFiles, inRepo, rootOf } from '../files.js';
import { componentDir, installedPackage } from '../node.js';

/** What the component has installed of each pinned tool; undefined when it is missing. */
export type Installed = Readonly<Record<string, string | undefined>>;

/**
 * A pinned tool at another version, or missing, is a finding at the line of package.json that
 * names it (so a change to that line must set it right); its identity is the package and version.
 */
export function toolchainFindings(
  pinned: Readonly<Record<string, string>>,
  installed: Installed,
  manifest: { readonly file: string; readonly lines: readonly string[] },
): Finding[] {
  return Object.entries(pinned).flatMap(([name, version]): Finding[] => {
    const actual = installed[name];
    if (actual === version) return [];
    const index = manifest.lines.findIndex((line) => line.includes(`"${name}"`));
    const message =
      actual === undefined
        ? `${name} is not installed; Talos pins ${version}.`
        : `${name} is ${actual}; Talos pins ${version}, which editors and the gate must share.`;
    return [
      {
        rule: 'toolchain/version',
        message,
        key: `${name}@${actual ?? 'missing'}`,
        location: { file: manifest.file, line: index + 1 || 1 },
      },
    ];
  });
}

async function run(ctx: CheckContext): Promise<Finding[]> {
  const installed: Record<string, string | undefined> = {};
  for (const name of Object.keys(TS_DEV_TOOLS.packages)) {
    installed[name] = (await installedPackage(ctx, name))?.version;
  }
  const text = await readFile(join(componentDir(ctx), 'package.json'), 'utf8').catch(() => '');
  const manifest = {
    file: inRepo(rootOf(ctx.component), 'package.json'),
    lines: text.split(/\r?\n/),
  };
  return toolchainFindings(TS_DEV_TOOLS.packages, installed, manifest);
}

export const toolchainCheck: Check = {
  id: 'ts/toolchain',
  tier: 'head',
  scope: 'component',
  langs: ['ts'],
  title: "The component's tools at Talos's versions",
  applies: (ctx) => {
    const manifest = inRepo(rootOf(ctx.component), 'package.json');
    return componentFiles(ctx).includes(manifest) ? APPLIES : skip('no package.json');
  },
  run,
};
