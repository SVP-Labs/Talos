import { posix } from 'node:path';
import { checkPrefix, type ConfigInput, parsed, resolveConfig } from './config.js';
import { type Deletion, type Draft, type PlannedFile, startDraft } from './draft.js';
import { type KitAssets, kitFiles } from './kit.js';
import { type LanguageAssets, languageSteps } from './languages.js';
import type { Seed } from './python.js';
import { fromScaffold, scaffoldLeftovers } from './scaffold.js';
import { securityMigration } from './security.js';
import { withAdditions } from './talos-yml.js';
import { briefPath } from './texts.js';
import { GITLEAKS_PROJECT } from '../checks/security/gitleaks-config.js';
import type { TalosConfig } from '../config/schema.js';
import { renderConfigs } from '../configs/files.js';
import type { ApplyContext } from '../core/check.js';
import type { Pack } from '../core/pack.js';
import type { PrefixUse } from '../govern/create.js';
import { repoFacts } from '../repo/facts.js';

export type { Deletion, PlannedFile } from './draft.js';

/** What adoption copies into every repository from Talos's assets. */
export type AdoptAssets = KitAssets & LanguageAssets;

export type AdoptInput = ConfigInput & {
  /** A brief to add, as given: its file name and text. */
  readonly brief?: { readonly fileName: string; readonly text: string } | undefined;
  readonly now: Date;
  /** The Talos version rendering the generated files. */
  readonly version: string;
  readonly packs: readonly Pack[];
  readonly assets: AdoptAssets;
  /** Every prefix the organisation's repositories use, when the organisation could be read. */
  readonly prefixesInUse?: readonly PrefixUse[] | undefined;
};

export type AdoptPlan = {
  readonly config: TalosConfig;
  readonly talosYml: 'written' | 'completed' | 'kept';
  readonly brief: string | undefined;
  readonly scaffold: boolean;
  /** Only files whose content changes. */
  readonly write: readonly PlannedFile[];
  readonly delete: readonly Deletion[];
  /** What whoever commits must do first: refresh lock files, finish what adoption couldn't. */
  readonly next: readonly string[];
};

type Settled = { readonly config: TalosConfig; readonly status: AdoptPlan['talosYml'] };

/**
 * `talos.yml`, with what the repository's own scanner settings held. The security settings are
 * read from the tree as it was, before any generated file takes their place.
 */
function settle(draft: Draft, input: AdoptInput, seeds: Map<string, Seed>): Settled {
  const resolved = resolveConfig({ ...input, files: draft.files(), read: draft.read });
  const security = securityMigration(input.files, input.read);
  const current = resolved.text ?? draft.read('talos.yml') ?? '';
  const text = withAdditions(current, security.additions);
  if (resolved.text !== undefined || text !== current) draft.write('talos.yml', text, 'talos.yml');
  for (const file of security.moved) draft.remove(file, 'migrated');
  for (const step of security.next) draft.next(step);
  const gitleaks = security.gitleaks;
  const project = draft.read(GITLEAKS_PROJECT);
  if (gitleaks !== undefined && project !== undefined) {
    draft.write(GITLEAKS_PROJECT, gitleaks(project), 'migration');
  } else if (gitleaks !== undefined) {
    seeds.set(GITLEAKS_PROJECT, gitleaks);
  }
  return { config: parsed(text), status: resolved.status };
}

/**
 * Every generated base through the shared rendering, and each missing extension file once: from
 * its initial text, or the project's own settings moved into it.
 */
function generated(
  draft: Draft,
  input: AdoptInput,
  config: TalosConfig,
  seeds: ReadonlyMap<string, Seed>,
): void {
  const ctx: ApplyContext = {
    facts: repoFacts(draft.files(), config.exclude),
    config,
    side: 'alone',
    tiers: ['commit', 'head'],
  };
  for (const file of renderConfigs(input.packs, ctx, input.version)) {
    const extension = file.extension;
    const missing = extension !== undefined && !draft.has(extension.path);
    draft.write(file.path, file.content, 'generated');
    if (extension === undefined || !missing) continue;
    const seed = seeds.get(extension.path);
    draft.write(
      extension.path,
      seed === undefined ? extension.content : seed(extension.content),
      'extension',
    );
  }
}

function brief(draft: Draft, input: AdoptInput, config: TalosConfig): string | undefined {
  if (input.brief === undefined) return undefined;
  const path = briefPath(config.docs.briefs, input.brief.fileName, input.brief.text, input.now);
  const text = input.brief.text;
  draft.write(path, text.endsWith('\n') ? text : `${text}\n`, 'brief');
  return path;
}

/**
 * Everything adoption writes and deletes in the working tree, and what must follow. Pure: it
 * reads the tree only through `input.read`, and running it twice plans nothing the second time.
 * It refuses a prefix another repository of the organisation uses, when it was given them.
 */
export function adoptPlan(input: AdoptInput): AdoptPlan {
  const draft = startDraft(input.files, input.read);
  for (const path of scaffoldLeftovers(input.files, input.read)) draft.remove(path, 'scaffold');
  const scaffold = fromScaffold(input.files, input.read);
  const seeds = new Map<string, Seed>();
  const { config, status } = settle(draft, input, seeds);
  checkPrefix(input.prefixesInUse, input.repo, config.prefix);
  kitFiles(draft, config, input.assets, scaffold);
  for (const [path, seed] of languageSteps(draft, config, input.packs, input.assets)) {
    seeds.set(path, seed);
  }
  const briefFile = brief(draft, input, config);
  generated(draft, input, config, seeds);
  const done = draft.done();
  return {
    config,
    talosYml: status,
    brief: briefFile,
    scaffold,
    write: done.write,
    delete: done.delete,
    next: done.next,
  };
}

/** The paths a plan touches, for staging exactly them and nothing else. */
export function touchedPaths(plan: AdoptPlan): string[] {
  return [...plan.write.map((f) => f.path), ...plan.delete.map((d) => d.path)].map((p) =>
    posix.normalize(p),
  );
}
