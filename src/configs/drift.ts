import { createHash } from 'node:crypto';
import { renderConfigs, type RenderedConfig } from './files.js';
import { withoutVersion } from './header.js';
import { APPLIES, type Check, type CheckContext, EngineError, skip } from '../core/check.js';
import type { Finding } from '../core/finding.js';
import type { Pack } from '../core/pack.js';
import { generatedTargets } from '../engine/prepare.js';
import { git, showFile } from '../repo/git.js';
import { ownVersion } from '../version/self.js';

/** What a commit holds: every path in it, and the content of the paths asked for. */
export type Committed = {
  readonly paths: ReadonlySet<string>;
  readonly contents: ReadonlyMap<string, string>;
};

function comparable(text: string): string {
  return withoutVersion(text.replaceAll('\r\n', '\n'));
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** The 1-based line where two texts first differ. */
export function firstDifference(committed: string, rendered: string): number {
  const ours = committed.split('\n');
  const theirs = rendered.split('\n');
  const index = ours.findIndex((line, at) => line !== theirs[at]);
  return index === -1 ? Math.max(1, ours.length) : index + 1;
}

function generatedFinding(file: RenderedConfig, committed: Committed): Finding | undefined {
  const content = committed.contents.get(file.path);
  if (content === undefined) {
    return {
      rule: 'config/drift',
      key: `${file.path} missing`,
      message: `${file.path} is missing: run \`talos configs\` to write it.`,
    };
  }
  const ours = comparable(content);
  if (ours === comparable(file.content)) return undefined;
  const line = firstDifference(ours, comparable(file.content));
  return {
    rule: 'config/drift',
    key: `${file.path} ${hash(content)}`,
    location: { file: file.path, line },
    message: `${file.path} differs from what Talos renders, from line ${line}: run \`talos configs\`.`,
  };
}

function extensionFinding(file: RenderedConfig, committed: Committed): Finding | undefined {
  const extension = file.extension;
  if (extension === undefined || committed.paths.has(extension.path)) return undefined;
  return {
    rule: 'config/missing-extension',
    key: extension.path,
    message:
      `${extension.path}, the project's extension of ${file.path}, is missing: ` +
      'run `talos configs` to create it.',
  };
}

/**
 * Each generated file that is missing or differs from the rendering (its version aside), keyed
 * by its path and a hash of what is committed: an unchanged stale copy keeps its fingerprint and
 * is debt, while an edit makes a new one. Each extension file a base imports and the commit
 * lacks is a finding too.
 */
export function driftFindings(
  rendered: readonly RenderedConfig[],
  committed: Committed,
): Finding[] {
  const extensions = new Set<string>();
  const findings: Finding[] = [];
  for (const file of rendered) {
    const generated = generatedFinding(file, committed);
    if (generated !== undefined) findings.push(generated);
    const extension = extensionFinding(file, committed);
    if (extension !== undefined && !extensions.has(extension.key ?? '')) {
      extensions.add(extension.key ?? '');
      findings.push(extension);
    }
  }
  return findings;
}

/** The commit's copy of the files, read from git: the working copy holds the rendering. */
async function readCommitted(
  ctx: CheckContext,
  rendered: readonly RenderedConfig[],
): Promise<Committed> {
  const repo = git(ctx.exec, ctx.root);
  let listing: string;
  try {
    listing = await repo.run(['ls-tree', '-r', '-z', '--name-only', ctx.sha]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new EngineError(`could not list commit ${ctx.sha.slice(0, 12)}: ${reason}`);
  }
  const paths = new Set(listing.split('\0').filter(Boolean));
  const contents = new Map<string, string>();
  for (const file of rendered.filter((f) => paths.has(f.path))) {
    const content = await showFile(repo, ctx.sha, file.path);
    if (content !== undefined) contents.set(file.path, content);
  }
  return { paths, contents };
}

/**
 * `configs/drift`: the generated files committed at the judged commit against this Talos's
 * rendering of them, for the packs given.
 */
export function driftCheck(packs: readonly Pack[]): Check {
  return {
    id: 'configs/drift',
    tier: 'head',
    scope: 'repo',
    title: 'generated configs as Talos renders them, and their extension files',
    applies: (ctx) =>
      generatedTargets(packs, ctx).length > 0
        ? APPLIES
        : skip('no generated config applies to the repository'),
    run: async (ctx) => {
      const rendered = renderConfigs(packs, ctx, ownVersion());
      return driftFindings(rendered, await readCommitted(ctx, rendered));
    },
  };
}
