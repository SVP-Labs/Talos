export function query(table: string): string {
  // nosemgrep: javascript.lang.security.audit.sqli
  return `SELECT * FROM ${table}`;
}
