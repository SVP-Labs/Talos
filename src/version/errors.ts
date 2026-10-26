/**
 * Why the enforced Talos version can't be found, installed or trusted. Its message is written for
 * the person or agent running Talos and says what to do; it never quotes a response body.
 */
export class VersionError extends Error {
  override readonly name = 'VersionError';
}
