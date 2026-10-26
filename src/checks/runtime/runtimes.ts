/** The runtimes Talos checks, by the name findings and issues use. */
export type Runtime = 'php' | 'node' | 'python' | 'rust' | 'go' | 'ruby' | 'bun' | 'deno' | 'lua';

/**
 * Where a runtime's security releases are known from:
 * - `php.net`: php.net's release feed tags each security release;
 * - `nodejs`: nodejs.org's `index.json` marks each one `security: true`;
 * - `phase`: the vendor publishes no flag, but a cycle past active support gets security
 *   releases only, so a release made in that phase is one (CPython);
 * - `none`: no source; only end of life and pinning are checked.
 */
type SecuritySource = 'php.net' | 'nodejs' | 'phase' | 'none';

export type RuntimeSpec = {
  /** The product's name on endoflife.date. */
  readonly product: string;
  readonly label: string;
  readonly security: SecuritySource;
};

export const RUNTIMES: Readonly<Record<Runtime, RuntimeSpec>> = {
  php: { product: 'php', label: 'PHP', security: 'php.net' },
  node: { product: 'nodejs', label: 'Node.js', security: 'nodejs' },
  python: { product: 'python', label: 'Python', security: 'phase' },
  rust: { product: 'rust', label: 'Rust', security: 'none' },
  go: { product: 'go', label: 'Go', security: 'none' },
  ruby: { product: 'ruby', label: 'Ruby', security: 'none' },
  bun: { product: 'bun', label: 'Bun', security: 'none' },
  deno: { product: 'deno', label: 'Deno', security: 'none' },
  lua: { product: 'lua', label: 'Lua', security: 'none' },
};

const NAMES: ReadonlyMap<string, Runtime> = new Map<string, Runtime>([
  ['php', 'php'],
  ['node', 'node'],
  ['nodejs', 'node'],
  ['python', 'python'],
  ['cpython', 'python'],
  ['rust', 'rust'],
  ['go', 'go'],
  ['golang', 'go'],
  ['ruby', 'ruby'],
  ['bun', 'bun'],
  ['deno', 'deno'],
  ['lua', 'lua'],
]);

/** A runtime by its name or a common alias (`nodejs`, `golang`), or `undefined`. */
export function runtimeNamed(name: string): Runtime | undefined {
  return NAMES.get(name.toLowerCase());
}
