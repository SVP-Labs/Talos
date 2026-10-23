/**
 * What Scaffold left in the repositories generated from it, which Talos replaces: its callers of
 * the old shared workflows, its scripts, justfile, language folders, git hooks and project file.
 * Only Scaffold's own files go; a project's own scripts beside them stay.
 */

export type Reader = (path: string) => string | undefined;

const FILES: ReadonlySet<string> = new Set([
  'justfile',
  'lefthook.yml',
  'project.yml',
  'scripts/audit.sh',
  'scripts/commit-msg.sh',
  'scripts/copy-config.sh',
  'scripts/require.sh',
  'scripts/sources.sh',
  'scripts/ticket',
  'scripts/with-sources.sh',
  '.github/labels.yml',
  '.github/scripts/apply-labels.sh',
  '.github/scripts/apply-rulesets.sh',
  '.github/rulesets/main.json',
  '.github/rulesets/main-review.json',
]);

const FOLDERS: readonly string[] = ['.lang/', '.github/scaffold/'];

const OLD_KIT = /SVP-Labs\/Workflows|\.github\/scripts\/apply-|\.github\/scaffold\//;

/** Whether the repository was generated from Scaffold. */
export function fromScaffold(files: readonly string[], read: Reader): boolean {
  if (files.some((file) => /^\.lang\/[^/]+\/lang\.just$/.test(file))) return true;
  if (files.includes('.github/scaffold/managed')) return true;
  return files.includes('project.yml') && /^scaffold:/m.test(read('project.yml') ?? '');
}

function scaffoldsOwn(file: string, read: Reader): boolean {
  if (file === 'ENGINEERING.md') {
    return (read(file) ?? '').startsWith('# Engineering Standards & Workflow');
  }
  if (file === '.claude/hooks/session-start.sh') return OLD_KIT.test(read(file) ?? '');
  if (file === '.claude/settings.json') return onlyScaffoldsHook(read(file) ?? '');
  return false;
}

function onlyScaffoldsHook(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return false;
    return Object.keys(parsed).join(',') === 'hooks' && text.includes('session-start.sh');
  } catch {
    return false;
  }
}

/**
 * The tracked files Scaffold put there, to delete, when the repository came from Scaffold. The
 * workflow callers are not among them: no App may write workflow files, so `talos govern`
 * removes those with the owner's login.
 */
export function scaffoldLeftovers(files: readonly string[], read: Reader): string[] {
  if (!fromScaffold(files, read)) return [];
  return files.filter(
    (file) =>
      FILES.has(file) ||
      FOLDERS.some((folder) => file.startsWith(folder)) ||
      scaffoldsOwn(file, read),
  );
}

/** Whether a `CLAUDE.md` is Scaffold's, whose instructions (`just gates`, its ticket script) go. */
export function isScaffoldClaude(text: string): boolean {
  return /`just gates`|scripts\/ticket|SVP-Labs\/Workflows/.test(text);
}

/** The workflow files that call the old kit: the shared workflows, or Scaffold's own scripts. */
export function oldKitCallers(workflows: readonly { path: string; text: string }[]): string[] {
  return workflows
    .filter((workflow) => /\.ya?ml$/.test(workflow.path) && OLD_KIT.test(workflow.text))
    .map((workflow) => workflow.path);
}
