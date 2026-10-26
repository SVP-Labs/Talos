import { XMLParser } from 'fast-xml-parser';
import { EngineError } from '../core/check.js';

/** What may come before a document's root element. */
const PROLOG = /^(?:\s|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*/;

const ROOT = /^<([A-Za-z_][\w.:-]*)/;

/**
 * Whether the document's root element is closed: a tool killed while writing its report leaves
 * it open, which the parser alone reads without complaint.
 */
export function isComplete(text: string): boolean {
  const body = text.replace(PROLOG, '').trimEnd();
  const root = ROOT.exec(body)?.[1];
  if (root === undefined) return false;
  return body.endsWith(`</${root}>`) || (body.endsWith('/>') && !body.includes('<', 1));
}

/**
 * A report's XML as objects: attributes under `@_name`, text under `#text`, the named elements
 * always as arrays. A report cut short, or not XML at all, is an engine error.
 */
export function parseXml(text: string, what: string, lists: readonly string[]): unknown {
  if (!isComplete(text)) {
    throw new EngineError(`the ${what} report is not a complete XML document`);
  }
  const names = new Set(lists);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    parseAttributeValue: false,
    htmlEntities: true,
    isArray: (name) => names.has(name),
  });
  try {
    const parsed: unknown = parser.parse(text);
    return parsed;
  } catch {
    throw new EngineError(`the ${what} report is not well-formed XML`);
  }
}
