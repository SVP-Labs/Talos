import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { MARKDOWN_GLOBS, readOwnTexts, readText } from './files.js';
import { APPLIES, type Check, type CheckContext, skip } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';
import type { DocText } from '../../docs/decisions.js';
import { type Link, markdownLinks, resolveLink } from '../../docs/links.js';
import { anchors } from '../../docs/markdown.js';

const MARKDOWN = /\.(?:md|markdown)$/;
/** GitHub's line anchors on a code file, `#L10` or `#L10-L20`. */
const LINE_ANCHOR = /^L\d+(?:-L\d+)?$/;

type Lookup = {
  exists(path: string): Promise<boolean>;
  anchorsOf(path: string): Promise<Set<string> | undefined>;
};

function lookup(ctx: CheckContext, docs: readonly DocText[]): Lookup {
  const own = new Map(docs.map((doc) => [doc.file, doc.text]));
  const known = new Map<string, Promise<boolean>>();
  const found = new Map<string, Promise<Set<string> | undefined>>();
  return {
    exists: (path) => {
      let result = known.get(path);
      if (result === undefined) {
        result = stat(join(ctx.root, path)).then(
          () => true,
          () => false,
        );
        known.set(path, result);
      }
      return result;
    },
    anchorsOf: (path) => {
      let result = found.get(path);
      if (result === undefined) {
        const text = own.get(path);
        const read = text === undefined ? readText(ctx, path) : Promise.resolve(text);
        result = read.then((value) =>
          value === undefined
            ? undefined
            : new Set([...anchors(value)].map((a) => a.toLowerCase())),
        );
        found.set(path, result);
      }
      return result;
    },
  };
}

function broken(file: string, link: Link, message: string): Finding {
  return {
    rule: 'docs/broken-link',
    message,
    location: { file, line: link.line, column: link.column },
  };
}

async function judgeLink(doc: DocText, link: Link, look: Lookup): Promise<Finding[]> {
  if (/\{\{|\$\{/.test(link.target)) return [];
  const target = resolveLink(doc.file, link.target);
  if (target.kind !== 'local') return [];
  const path = target.path === '' ? doc.file : target.path;
  if (target.path !== '' && !(await look.exists(path))) {
    return [broken(doc.file, link, `The link to ${link.target} names no file in the repository.`)];
  }
  const anchor = target.anchor;
  if (anchor === undefined || !MARKDOWN.test(path) || LINE_ANCHOR.test(anchor)) return [];
  const known = await look.anchorsOf(path);
  if (known === undefined || known.has(anchor.toLowerCase())) return [];
  return [broken(doc.file, link, `The link to ${link.target} names no heading in ${path}.`)];
}

async function brokenLinks(ctx: CheckContext): Promise<Finding[]> {
  const docs = await readOwnTexts(ctx, ctx.facts.matching(...MARKDOWN_GLOBS));
  const look = lookup(ctx, docs);
  const findings: Finding[] = [];
  for (const doc of docs) {
    for (const link of markdownLinks(doc.text)) {
      findings.push(...(await judgeLink(doc, link, look)));
    }
  }
  return findings;
}

/** Markdown links to files and headings of the repository resolve. */
export const referencesCheck: Check = {
  id: 'docs/references',
  tier: 'head',
  scope: 'repo',
  title: 'links to files and headings',
  applies: (ctx) =>
    ctx.facts.has(...MARKDOWN_GLOBS) ? APPLIES : skip('the repository has no Markdown'),
  run: brokenLinks,
};
