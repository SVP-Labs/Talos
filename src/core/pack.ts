import type { ApplyContext, Check, Component, Lang, Os } from './check.js';
import type { Logger } from './log.js';
import type { TalosConfig } from '../config/schema.js';
import type { Exec } from '../exec/exec.js';
import type { RepoFacts } from '../repo/facts.js';
import type { Tools } from '../tools/tools.js';

export type RenderContext = {
  readonly config: TalosConfig;
  readonly facts: RepoFacts;
  readonly component?: Component;
  /** The Talos version rendering the file, written into its generated-file header. */
  readonly version: string;
};

/**
 * A tool's base config: Talos writes it into the repository, marked generated, for editors
 * to read, and the gate renders it afresh rather than trusting the copy. Each base imports a
 * project-owned extension file, which may only tighten it.
 */
export type Generated = {
  /** Relative to the repository root, or to the component's root for component files. */
  readonly path: string;
  readonly scope: 'repo' | 'component';
  readonly langs?: readonly Lang[];
  applies(ctx: ApplyContext): boolean;
  render(ctx: RenderContext): string;
  /** The project's own extension file, which `talos adopt` writes once when it's missing. */
  readonly extension?: {
    readonly path: string;
    initial(ctx: RenderContext): string;
  };
};

export type InstallContext = {
  readonly root: string;
  readonly component: Component;
  readonly config: TalosConfig;
  readonly exec: Exec;
  readonly tools: Tools;
  readonly log: Logger;
  readonly os: Os;
};

/**
 * The language tools a project's editor also uses, pinned by `talos adopt` in the project's dev
 * dependencies at these exact versions; the pack's `<lang>/toolchain` check keeps them matching.
 */
export type DevTools = {
  readonly manager: 'npm' | 'pypi' | 'composer' | 'cargo' | 'luarocks';
  readonly packages: Readonly<Record<string, string>>;
};

export type Pack = {
  readonly name: string;
  readonly checks: readonly Check[];
  readonly generated?: readonly Generated[];
  /** Installs a component's dependencies before any check runs (language packs). */
  install?(ctx: InstallContext): Promise<void>;
  readonly lang?: Lang;
  readonly devTools?: DevTools;
};
