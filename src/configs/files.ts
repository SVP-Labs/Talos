import type { ApplyContext, Component } from '../core/check.js';
import type { Pack, RenderContext } from '../core/pack.js';
import { generatedTargets, targetPath } from '../engine/prepare.js';

/** A file to write: repository-relative path and content. */
export type ConfigFile = { readonly path: string; readonly content: string };

/** A generated file as this Talos renders it, with the project's extension file of it. */
export type RenderedConfig = ConfigFile & { readonly extension?: ConfigFile };

function inComponent(component: Component | undefined, path: string): string {
  return component === undefined || component.root === '.' ? path : `${component.root}/${path}`;
}

/**
 * Every generated file that applies to the repository and its components, rendered at
 * `version`, each with its extension file's path and initial content. One entry per path.
 */
export function renderConfigs(
  packs: readonly Pack[],
  ctx: ApplyContext,
  version: string,
): RenderedConfig[] {
  const byPath = new Map<string, RenderedConfig>();
  for (const target of generatedTargets(packs, ctx)) {
    const render: RenderContext = {
      config: ctx.config,
      facts: ctx.facts,
      version,
      ...(target.component === undefined ? {} : { component: target.component }),
    };
    const path = targetPath(target);
    const extension = target.file.extension;
    byPath.set(path, {
      path,
      content: target.file.render(render),
      ...(extension === undefined
        ? {}
        : {
            extension: {
              path: inComponent(target.component, extension.path),
              content: extension.initial(render),
            },
          }),
    });
  }
  return [...byPath.values()];
}
