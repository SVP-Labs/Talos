import { z } from 'zod';
import { manifestText, parseManifest } from './dev-deps.js';
import type { Draft } from './draft.js';

/**
 * Talos's pre-push hook, which runs the fast tier before a push so the gate's answer arrives
 * early, and what makes git run it: `core.hooksPath` set to `.githooks`, which a Node project's
 * `prepare` script does on install. A hook manager the project already uses keeps the hooks;
 * it is asked to call Talos's, never replaced.
 */

export type HookAssets = {
  /** `assets/hooks/pre-push`. */
  readonly prePush: string;
};

export const PRE_PUSH = '.githooks/pre-push';

/** The line that makes a `pre-push` Talos's, which adoption may rewrite. */
const MARK = "# Talos's pre-push hook, written by talos adopt, which rewrites it.";
const HOOKS_PATH = 'core.hooksPath .githooks';
const PREPARE = `git config ${HOOKS_PATH} || exit 0`;
const FAST_TIER = 'npx @svp-labs/talos check --tiers commit';
const MANIFEST = 'package.json';

type Manager = {
  readonly name: string;
  /** Whether a tracked file is this manager's configuration. */
  readonly owns: (file: string) => boolean;
  /** Whether `package.json` hands this manager the hooks. */
  readonly inManifest: (manifest: Readonly<Record<string, unknown>>) => boolean;
};

const scripts = z.record(z.string(), z.unknown());

function prepareOf(manifest: Readonly<Record<string, unknown>>): string {
  const prepare = scripts.catch({}).parse(manifest.scripts ?? {}).prepare;
  return typeof prepare === 'string' ? prepare : '';
}

const MANAGERS: readonly Manager[] = [
  {
    name: 'pre-commit',
    owns: (file) => /^\.pre-commit-config\.ya?ml$/.test(file),
    inManifest: () => false,
  },
  {
    name: 'lefthook',
    owns: (file) => /^\.?lefthook(?:-local)?\.(?:ya?ml|jsonc?|toml)$/.test(file),
    inManifest: (manifest) => /\blefthook\b/.test(prepareOf(manifest)),
  },
  {
    name: 'husky',
    owns: (file) => file.startsWith('.husky/'),
    inManifest: (manifest) => 'husky' in manifest || /\bhusky\b/.test(prepareOf(manifest)),
  },
  {
    name: 'simple-git-hooks',
    owns: (file) => /^\.?simple-git-hooks\.(?:json|[cm]?js)$/.test(file),
    inManifest: (manifest) => 'simple-git-hooks' in manifest,
  },
  { name: 'overcommit', owns: (file) => file === '.overcommit.yml', inManifest: () => false },
];

type Found = { readonly name: string; readonly files: readonly string[] };

/** The hook manager the project uses, with the files that configure it. */
function hookManager(draft: Draft): Found | undefined {
  const text = draft.read(MANIFEST);
  const manifest = text === undefined ? undefined : parseManifest(text);
  const files = draft.files();
  for (const manager of MANAGERS) {
    const own = files.filter((file) => manager.owns(file));
    const viaManifest = manifest !== undefined && manager.inManifest(manifest);
    if (own.length > 0 || viaManifest) {
      return { name: manager.name, files: viaManifest ? [...own, MANIFEST] : own };
    }
  }
  return undefined;
}

function isTalosHook(text: string): boolean {
  return text.split(/\r?\n/, 4).includes(MARK);
}

/** `package.json` with a `prepare` script that sets `core.hooksPath`, or the step to do it. */
function hooksPathOnInstall(draft: Draft): void {
  const text = draft.read(MANIFEST);
  const manifest = text === undefined ? undefined : parseManifest(text);
  if (text === undefined || manifest === undefined) return;
  const parsed = scripts.safeParse(manifest.scripts ?? {});
  if (!parsed.success) return;
  const prepare = parsed.data.prepare;
  if (prepare === undefined) {
    const next = { ...manifest, scripts: { ...parsed.data, prepare: PREPARE } };
    draft.write(MANIFEST, manifestText(next, text), 'hook');
    return;
  }
  const command = typeof prepare === 'string' ? prepare : '';
  if (command.includes(HOOKS_PATH)) return;
  draft.next(
    command.includes('core.hooksPath')
      ? `package.json's prepare points core.hooksPath elsewhere: make the pre-push hook there run ${PRE_PUSH}, Talos's fast tier`
      : `add \`${PREPARE}\` to package.json's prepare script, so installing has git run ${PRE_PUSH}`,
  );
}

/**
 * Talos's `pre-push`, written unless the project has its own there, and what makes git run it:
 * the hook manager the project uses, or else `core.hooksPath` set on install.
 */
export function prePushHook(draft: Draft, assets: HookAssets): void {
  const existing = draft.read(PRE_PUSH);
  if (existing !== undefined && !isTalosHook(existing)) {
    if (!existing.includes('talos check')) {
      draft.next(
        `${PRE_PUSH} is the project's own: make it run Talos's fast tier too (${FAST_TIER})`,
      );
    }
  } else {
    draft.write(PRE_PUSH, assets.prePush, 'hook', 'executable');
  }
  const manager = hookManager(draft);
  if (manager === undefined) {
    hooksPathOnInstall(draft);
    return;
  }
  const wired = manager.files.some((file) => draft.read(file)?.includes(PRE_PUSH) === true);
  if (!wired) {
    draft.next(
      `${manager.name} runs the git hooks here: make its pre-push run ${PRE_PUSH}, Talos's fast tier, and leave core.hooksPath to ${manager.name}`,
    );
  }
}
