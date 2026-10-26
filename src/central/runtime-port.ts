import { alertOf, type RuntimeAlert } from './sweep.js';
import { runtimeFindings } from '../checks/runtime/check.js';
import { isDeclaringFile } from '../checks/runtime/declarations.js';
import { defaultFetcher, type Fetcher } from '../checks/runtime/fetchers.js';
import { parseConfig } from '../config/load.js';
import type { TalosConfig } from '../config/schema.js';
import { repoFacts } from '../repo/facts.js';

/**
 * How the sweep asks the runtime check about a repository it never checks out: the declaring
 * files, read through the API, go to the same function the gate's `runtime/runtimes` calls, with
 * `talos.yml`'s `exclude` and exceptions. Nothing from the repository is executed or written to
 * disk: the check parses the files and asks the vendors' feeds.
 */
type Assessment = { readonly alerts: readonly RuntimeAlert[]; readonly errors: number };

/** Files by repository-relative path. */
export type RuntimeAssessor = (files: ReadonlyMap<string, string>) => Promise<Assessment>;

const FALLBACK_CONFIG = 'name: sweep\nprefix: S\n';

function configOf(text: string | undefined): TalosConfig {
  if (text !== undefined) {
    try {
      return parseConfig(text);
    } catch {
      // An invalid talos.yml fails the repository's own gate; the sweep still checks runtimes.
    }
  }
  return parseConfig(FALLBACK_CONFIG);
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export type AssessorOptions = {
  readonly fetcher?: Fetcher;
  /** `YYYY-MM-DD`, in UTC. */
  readonly today?: () => string;
};

/**
 * The runtime check as an assessor. A feed that can't be read fails the whole repository's
 * assessment, counted as one error and never as a pass; its message, which may name a file, is
 * dropped, since the sweep's log is public.
 */
export function runtimeAssessor(options: AssessorOptions = {}): RuntimeAssessor {
  return async (files) => {
    const config = configOf(files.get('talos.yml'));
    const declaring = new Map(
      repoFacts([...files.keys()], config.exclude)
        .files.filter((path) => isDeclaringFile(path))
        .flatMap((path): [string, string][] => {
          const text = files.get(path);
          return text === undefined ? [] : [[path, text]];
        }),
    );
    try {
      const findings = await runtimeFindings(declaring, {
        fetcher: options.fetcher ?? defaultFetcher(),
        today: (options.today ?? utcToday)(),
        exceptions: config.supply_chain.exceptions,
      });
      return { alerts: findings.flatMap((f) => alertOf(f) ?? []), errors: 0 };
    } catch {
      return { alerts: [], errors: 1 };
    }
  };
}
