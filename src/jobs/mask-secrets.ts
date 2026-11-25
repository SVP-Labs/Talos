const MASK = '***';

/**
 * Secret-shaped text a tool may print: tokens with a known prefix, private keys, JWTs, the
 * credentials of a URL or an `Authorization` header, and the value after a name that says secret.
 * Each replacement keeps what precedes the secret itself.
 */
const SECRETS: readonly (readonly [RegExp, string])[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  [/\b(?:gh[opr-u]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/g, MASK],
  [/\b(?:AKI|ASI)A[0-9A-Z]{16}\b/g, MASK],
  [/\b(?:xox)[a-bpr-s]-[\w-]{10,}/g, MASK],
  [/\b(?:npm|gl(?:pat)|sk|pk|rk)[_-][A-Za-z0-9_-]{16,}/g, MASK],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, MASK],
  [/(\/\/)[^/\s:@]+:[^/\s@]+@/g, `$1${MASK}@`],
  [/\b(Authorization:\s*(?:Bearer|Basic|token)\s+)[\w.~+/=-]{8,}/gi, `$1${MASK}`],
  [
    /\b([\w-]*(?:password|passwd|secret|token|api[_-]?key|credential)s?)(["']?\s*[=:]\s*["']?)[^\s"',;]{8,}/gi,
    `$1$2${MASK}`,
  ],
];

/** The text with every {@link SECRETS} match masked. */
export function maskSecrets(text: string): string {
  return SECRETS.reduce((masked, [pattern, by]) => masked.replaceAll(pattern, by), text);
}
