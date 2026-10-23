import {
  DEPENDABOT_PATH,
  dependabotYml,
  ecosystems,
  fixturePaths,
  type UpdateDefaults,
} from './dependabot.js';
import type { Draft } from './draft.js';
import { isScaffoldClaude } from './scaffold.js';
import type { TalosConfig } from '../config/schema.js';
import { KIT_BEGIN, KIT_END, renderClaudeMd } from '../docs/claude.js';
import { repoFacts } from '../repo/facts.js';

/**
 * What every governed repository gets from the kit itself: `CLAUDE.md` with Talos's block, the
 * issue forms, the PR template, and Dependabot held a day for every ecosystem it has.
 */

export type KitAssets = {
  /** `assets/issue-forms/*`, by file name. */
  readonly issueForms: Readonly<Record<string, string>>;
  /** `assets/pull_request_template.md`, when this Talos ships it. */
  readonly prTemplate: string | undefined;
  readonly dependabot: UpdateDefaults;
  /** `assets/claude/kit-block.md`, the template of `CLAUDE.md`'s block. */
  readonly claudeKit: string;
};

export const PR_TEMPLATE_PATH = '.github/pull_request_template.md';
const PR_TEMPLATES = [
  PR_TEMPLATE_PATH,
  'pull_request_template.md',
  'docs/pull_request_template.md',
];
const ISSUE_FORMS = '.github/ISSUE_TEMPLATE';

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const TITLE = /^ {0,3}#(?=[ \t]|$)/;

/**
 * The project's own `# ` titles made `## `, outside code and outside Talos's block: the block
 * holds the file's one top-level heading.
 */
export function demoteTitles(text: string): string {
  let fence: string | undefined;
  let kit = false;
  return text
    .split('\n')
    .map((line) => {
      const marker = FENCE.exec(line)?.[1];
      if (marker !== undefined) {
        if (fence === undefined) fence = marker;
        else if (marker.startsWith(fence)) fence = undefined;
        return line;
      }
      if (line.trim() === KIT_BEGIN) kit = true;
      if (line.trim() === KIT_END) kit = false;
      return fence === undefined && !kit && TITLE.test(line) ? line.replace('#', '##') : line;
    })
    .join('\n');
}

/** `CLAUDE.md` with Talos's block; Scaffold's, whose instructions no longer hold, is replaced. */
export function claudeMd(
  existing: string | undefined,
  config: TalosConfig,
  template: string,
  scaffold: boolean,
): string {
  const own =
    existing === undefined || (scaffold && isScaffoldClaude(existing)) ? undefined : existing;
  return renderClaudeMd(own === undefined ? undefined : demoteTitles(own), { config }, template);
}

function prTemplate(draft: Draft, template: string | undefined): void {
  if (template === undefined) return;
  draft.write(PR_TEMPLATE_PATH, template, 'pr-template');
  const others = draft
    .files()
    .filter((file) => file !== PR_TEMPLATE_PATH && PR_TEMPLATES.includes(file.toLowerCase()));
  for (const file of others) draft.remove(file, 'pr-template');
}

/** The kit's files, written into the draft. */
export function kitFiles(
  draft: Draft,
  config: TalosConfig,
  assets: KitAssets,
  scaffold: boolean,
): void {
  draft.write(
    'CLAUDE.md',
    claudeMd(draft.read('CLAUDE.md'), config, assets.claudeKit, scaffold),
    'claude',
  );
  for (const [name, content] of Object.entries(assets.issueForms)) {
    draft.write(`${ISSUE_FORMS}/${name}`, content, 'issue-form');
  }
  prTemplate(draft, assets.prTemplate);
  const files = draft.files();
  const present = ecosystems(config.components, repoFacts(files, config.exclude).files);
  const dependabot = dependabotYml(
    draft.read(DEPENDABOT_PATH),
    present,
    assets.dependabot,
    fixturePaths(files),
  );
  if (dependabot !== undefined) draft.write(DEPENDABOT_PATH, dependabot, 'dependabot');
}
