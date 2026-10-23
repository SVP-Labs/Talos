/** One dependency cargo-machete found no use of. */
export type Unused = {
  readonly crate: string;
  /** The manifest as cargo-machete printed it, relative to where it ran. */
  readonly manifest: string;
  readonly dependency: string;
};

/**
 * cargo-machete's report: a `<crate> -- <manifest>:` line per crate, then its unused
 * dependencies, one per tab-indented line. It has no machine-readable output.
 */
export function parseMachete(stdout: string): Unused[] {
  const found: Unused[] = [];
  let current: { crate: string; manifest: string } | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const header = /^(\S+) -- (.+):$/.exec(line);
    if (header?.[1] !== undefined && header[2] !== undefined) {
      current = { crate: header[1], manifest: header[2].replaceAll('\\', '/') };
    } else if (current !== undefined && line.startsWith('\t') && line.trim() !== '') {
      found.push({ ...current, dependency: line.trim() });
    } else if (line.trim() === '') {
      current = undefined;
    }
  }
  return found;
}

function escape(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** The 1-based line a manifest declares a dependency on, or 1 when it can't be found. */
export function dependencyLine(manifest: string, dependency: string): number {
  const name = escape(dependency);
  const entry = new RegExp(String.raw`^\s*["']?${name}["']?\s*=`);
  const table = new RegExp(String.raw`^\s*\[[^\]]*dependencies\.["']?${name}["']?\s*\]`);
  let inDependencies = false;
  const lines = manifest.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (table.test(line)) return index + 1;
    if (/^\s*\[/.test(line)) inDependencies = /dependencies\s*\]\s*$/.test(line);
    else if (inDependencies && entry.test(line)) return index + 1;
  }
  return 1;
}
