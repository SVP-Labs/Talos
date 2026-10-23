import { detectComponents, detectDocs, guessExclude, type OsOverride } from './detect.js';
import type { Reader } from './scaffold.js';
import { derivePrefix, isSeed, renderTalosYml } from './talos-yml.js';
import { ConfigError, parseConfig } from '../config/load.js';
import type { TalosConfig } from '../config/schema.js';
import { repoFacts } from '../repo/facts.js';

export class AdoptRefusal extends Error {
  override readonly name = 'AdoptRefusal';
}

export type ConfigInput = {
  /** `owner/name`: the name part is the project's name unless one is given. */
  readonly repo: string;
  readonly files: readonly string[];
  readonly read: Reader;
  readonly name?: string | undefined;
  readonly prefix?: string | undefined;
  readonly os: readonly OsOverride[];
};

export type ResolvedConfig = {
  readonly config: TalosConfig;
  /** `talos.yml`'s text when adoption writes it; `undefined` when the repository's is kept. */
  readonly text: string | undefined;
  readonly status: 'written' | 'completed' | 'kept';
};

function parsed(text: string): TalosConfig {
  try {
    return parseConfig(text);
  } catch (error) {
    if (error instanceof ConfigError) throw new AdoptRefusal(error.message);
    throw error;
  }
}

function agree(flag: string | undefined, recorded: string, what: string): void {
  if (flag !== undefined && flag !== recorded) {
    throw new AdoptRefusal(`talos.yml already names ${what} ${recorded}, not ${flag}`);
  }
}

function draftConfig(input: ConfigInput, recorded: TalosConfig | undefined): string {
  const name = recorded?.name ?? input.name ?? input.repo.split('/').at(-1) ?? input.repo;
  const exclude = guessExclude(input.files, input.read);
  const facts = repoFacts(input.files, exclude);
  return renderTalosYml({
    name,
    prefix: recorded?.prefix ?? input.prefix ?? derivePrefix(name),
    components: detectComponents(facts.files, input.read, input.os),
    exclude,
    docs: detectDocs(facts.files),
  });
}

/**
 * The repository's `talos.yml`: kept when someone has set it up, completed when it is only the
 * name and prefix `talos new` recorded, and written from the manifests when there is none.
 */
export function resolveConfig(input: ConfigInput): ResolvedConfig {
  const existing = input.files.includes('talos.yml') ? input.read('talos.yml') : undefined;
  if (existing === undefined) {
    const text = draftConfig(input, undefined);
    return { config: parsed(text), text, status: 'written' };
  }
  const recorded = parsed(existing);
  agree(input.prefix, recorded.prefix, 'the prefix');
  agree(input.name, recorded.name, 'the name');
  if (!isSeed(existing)) return { config: recorded, text: undefined, status: 'kept' };
  const text = draftConfig(input, recorded);
  return { config: parsed(text), text, status: 'completed' };
}
