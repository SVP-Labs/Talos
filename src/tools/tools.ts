/**
 * Outside tools: each is listed in `tools.lock` with its version, a download per OS and a
 * checksum; Talos downloads it into a cache and refuses a file whose checksum doesn't match.
 */
export type Tools = {
  /** The absolute path of the tool's executable, downloaded and verified on first use. */
  path(name: string): Promise<string>;
  /** The version `tools.lock` pins. */
  version(name: string): string;
};
