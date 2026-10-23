import { posix } from 'node:path';
import type { ClaudeRenderer } from './claude.js';
import { type ConfigInput, resolveConfig } from './config.js';
import { DEPENDABOT_PATH, dependabotYml, ecosystems, type UpdateDefaults } from './dependabot.js';
import { isScaffoldClaude, fromScaffold, scaffoldLeftovers } from './scaffold.js';
import { briefPath } from './texts.js';
import { type PlannedFile, toolPins } from './tool-pins.js';
import type { TalosConfig } from '../config/schema.js';
import type { ApplyContext, Component } from '../core/check.js';
import type { Pack, RenderContext } from '../core/pack.js';
import { generatedTargets, targetPath } from '../engine/prepare.js';
import { type RepoFacts, repoFacts } from '../repo/facts.js';

/** What adoption copies into every repository from Talos's assets. */
export type AdoptAssets = {
  /** `assets/issue-forms/*`, by file name. */
  readonly issueForms: Readonly<Record<string, string>>;
  /** `assets/pull_request_template.md`, when this Talos ships it. */
  readonly prTemplate: string | undefined;
  readonly dependabot: UpdateDefaults;
};

export type AdoptInput = ConfigInput & {
  /** A brief to add, as given: its file name and text. */
  readonly brief?: { readonly fileName: string; readonly text: string } | undefined;
  readonly now: Date;
  /** The Talos version rendering the generated files. */
  readonly version: string;
  readonly packs: readonly Pack[];
  readonly assets: AdoptAssets;
  readonly claude: ClaudeRenderer;
};

type Deletion = { readonly path: string; readonly why: 'scaffold' | 'pr-template' };

export type AdoptPlan = {
  readonly config: TalosConfig;
  readonly talosYml: 'written' | 'completed' | 'kept';
  readonly brief: string | undefined;
  readonly scaffold: boolean;
  /** Only files whose content changes. */
  readonly write: readonly PlannedFile[];
  readonly delete: readonly Deletion[];
  /** What whoever commits must do first: refresh lock files, pin what adoption can't. */
  readonly next: readonly string[];
};

const PR_TEMPLATE_PATH = '.github/pull_request_template.md';
const PR_TEMPLATES = [
  PR_TEMPLATE_PATH,
  'pull_request_template.md',
  'docs/pull_request_template.md',
];
const ISSUE_FORMS = '.github/ISSUE_TEMPLATE';

function inRoot(component: Component | undefined, path: string): string {
  return component === undefined || component.root === '.' ? path : `${component.root}/${path}`;
}

function generatedFiles(input: AdoptInput, config: TalosConfig, facts: RepoFacts): PlannedFile[] {
  const ctx: ApplyContext = { facts, config, side: 'alone', tiers: ['commit', 'head'] };
  return generatedTargets(input.packs, ctx).flatMap((target): PlannedFile[] => {
    const render: RenderContext = {
      config,
      facts,
      version: input.version,
      ...(target.component === undefined ? {} : { component: target.component }),
    };
    const base: PlannedFile = {
      path: targetPath(target),
      content: target.file.render(render),
      why: 'generated',
    };
    const extension = target.file.extension;
    if (extension === undefined) return [base];
    const path = inRoot(target.component, extension.path);
    if (input.files.includes(path) || input.read(path) !== undefined) return [base];
    return [base, { path, content: extension.initial(render), why: 'extension' }];
  });
}

function kitFiles(input: AdoptInput, config: TalosConfig, scaffold: boolean): PlannedFile[] {
  const claudeNow = input.read('CLAUDE.md');
  const keep = claudeNow !== undefined && !(scaffold && isScaffoldClaude(claudeNow));
  const files: PlannedFile[] = [
    {
      path: 'CLAUDE.md',
      content: input.claude(keep ? claudeNow : undefined, { config, version: input.version }),
      why: 'claude',
    },
    ...Object.entries(input.assets.issueForms).map(([name, content]): PlannedFile => ({
      path: `${ISSUE_FORMS}/${name}`,
      content,
      why: 'issue-form',
    })),
  ];
  if (input.assets.prTemplate !== undefined) {
    files.push({ path: PR_TEMPLATE_PATH, content: input.assets.prTemplate, why: 'pr-template' });
  }
  const dependabot = dependabotYml(
    input.read(DEPENDABOT_PATH),
    ecosystems(config.components, input.files),
    input.assets.dependabot,
  );
  if (dependabot !== undefined) {
    files.push({ path: DEPENDABOT_PATH, content: dependabot, why: 'dependabot' });
  }
  return files;
}

function briefFile(input: AdoptInput, config: TalosConfig): PlannedFile | undefined {
  if (input.brief === undefined) return undefined;
  const path = briefPath(config.docs.briefs, input.brief.fileName, input.brief.text, input.now);
  const content = input.brief.text.endsWith('\n') ? input.brief.text : `${input.brief.text}\n`;
  return { path, content, why: 'brief' };
}

function deletions(input: AdoptInput, writes: readonly PlannedFile[]): Deletion[] {
  const writing = new Set(writes.map((file) => file.path));
  const templates = input.files.filter(
    (file) => PR_TEMPLATES.includes(file.toLowerCase()) && !writing.has(file),
  );
  return [
    ...scaffoldLeftovers(input.files, input.read).map((path): Deletion => ({
      path,
      why: 'scaffold',
    })),
    ...(writing.has(PR_TEMPLATE_PATH)
      ? templates.map((path): Deletion => ({ path, why: 'pr-template' }))
      : []),
  ];
}

function changed(input: AdoptInput, files: readonly PlannedFile[]): PlannedFile[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  return [...byPath.values()].filter((file) => input.read(file.path) !== file.content);
}

/**
 * Everything adoption writes and deletes in the working tree, and what must follow. Pure: it
 * reads the tree only through `input.read`, and running it twice plans nothing the second time.
 */
export function adoptPlan(input: AdoptInput): AdoptPlan {
  const leftovers = new Set(scaffoldLeftovers(input.files, input.read));
  const kept: AdoptInput = { ...input, files: input.files.filter((file) => !leftovers.has(file)) };
  const resolved = resolveConfig(kept);
  const config = resolved.config;
  const facts = repoFacts(kept.files, config.exclude);
  const scaffold = fromScaffold(input.files, input.read);
  const pins = toolPins(config.components, input.packs, kept.files, input.read);
  const brief = briefFile(input, config);
  const talosYml: PlannedFile[] =
    resolved.text === undefined
      ? []
      : [{ path: 'talos.yml', content: resolved.text, why: 'talos.yml' }];
  const all: PlannedFile[] = [
    ...talosYml,
    ...generatedFiles(kept, config, facts),
    ...kitFiles(kept, config, scaffold),
    ...pins.files,
    ...(brief === undefined ? [] : [brief]),
  ];
  const write = changed(input, all);
  return {
    config,
    talosYml: resolved.status,
    brief: brief?.path,
    scaffold,
    write,
    delete: deletions(input, write),
    next: pins.next,
  };
}

/** The paths a plan touches, for staging exactly them and nothing else. */
export function touchedPaths(plan: AdoptPlan): string[] {
  return [...plan.write.map((f) => f.path), ...plan.delete.map((d) => d.path)].map((p) =>
    posix.normalize(p),
  );
}
