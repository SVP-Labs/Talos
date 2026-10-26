/** What each character that can't stand for itself in XML text or an attribute is written as. */
const REFERENCES: ReadonlyMap<string, string> = new Map([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ["'", '&apos;'],
  ['\t', '&#9;'],
  ['\n', '&#10;'],
  ['\r', '&#13;'],
]);

const REPLACEMENT = '�';

/** Whether XML 1.0 can hold a character at all, written as itself or as a reference. */
function allowed(code: number): boolean {
  if (code < 0xd8_00) return code >= 0x20;
  if (code < 0xe0_00) return false;
  return code !== 0xff_fe && code !== 0xff_ff;
}

/**
 * Text made safe as an XML element's text or as an attribute's value in either quote, in one
 * pass over its characters. Markup characters become the five predefined entities. Tab, line
 * feed and carriage return become character references, which a parser keeps where it would
 * otherwise turn them into spaces or drop the carriage return. A character XML 1.0 can't hold
 * even as a reference (another control character, a lone surrogate, U+FFFE or U+FFFF) becomes
 * U+FFFD, so a test's coloured output or a stray byte still makes a well-formed document.
 */
export function escapeXml(text: string): string {
  let out = '';
  for (const char of text) {
    const written = REFERENCES.get(char);
    if (written !== undefined) out += written;
    else out += allowed(char.codePointAt(0) ?? 0) ? char : REPLACEMENT;
  }
  return out;
}

const ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);

/** A predefined entity, or a decimal or hexadecimal character reference. */
const REFERENCE = /&(?:#(\d{1,7})|#x([\dA-Fa-f]{1,6})|([a-z]+));/g;

function character(reference: string, decimal?: string, hex?: string, name?: string): string {
  if (name !== undefined) return ENTITIES.get(name) ?? reference;
  const code = hex === undefined ? Number(decimal) : Number.parseInt(hex, 16);
  return code <= 0x10_ff_ff ? String.fromCodePoint(code) : reference;
}

/**
 * An attribute's value or an element's text as read from a document matched by text rather than
 * parsed: its entities and character references replaced by the characters they stand for, and
 * anything else that looks like one left as it is.
 */
export function unescapeXml(text: string): string {
  return text.replaceAll(REFERENCE, character);
}
