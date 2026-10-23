import { markerFields } from '../status/markers.js';
import { clip } from '../ticket/payload.js';

/**
 * The reviewer's review body. Its first line is `talos-review/1`, which Thea's hub turns into an
 * event; the rest lists the findings, so the event carries enough to start the next round.
 */

const REVIEW_MARKER = 'talos-review/1';

export type Verdict = 'APPROVE' | 'REQUEST_CHANGES';

/** A finding: an inline comment's place and text, or a remark on the whole PR. */
export type Finding = {
  readonly path?: string;
  readonly line?: number;
  readonly body: string;
};

export type ReviewHeader = {
  readonly verdict: Verdict;
  readonly round: number;
  readonly findings: number;
};

/** Breaks a mention without changing how it reads. */
const ZERO_WIDTH_SPACE = '\u200B';

const SUMMARY_MAX = 400;
const FINDING_MAX = 200;
const LISTED = 20;

export function headerLine(header: ReviewHeader): string {
  return `${REVIEW_MARKER} verdict=${header.verdict} round=${header.round} findings=${header.findings}`;
}

const COUNT = /^\d{1,4}$/;

/**
 * The header of a reviewer review, or `undefined` when its first line is no such header: a
 * `talos-review/1` line whose verdict, round and count of findings are all there.
 */
export function parseHeader(body: string): ReviewHeader | undefined {
  const fields = markerFields(body, REVIEW_MARKER);
  const verdict = fields?.verdict;
  const round = fields?.round ?? '';
  const findings = fields?.findings ?? '';
  if (verdict !== 'APPROVE' && verdict !== 'REQUEST_CHANGES') return undefined;
  if (!COUNT.test(round) || !COUNT.test(findings)) return undefined;
  return { verdict, round: Number(round), findings: Number(findings) };
}

/**
 * The model's words, made safe to post: no mentions that would notify anyone, no approval
 * marker for anything to mistake, no control characters.
 */
export function defused(text: string): string {
  return text
    .replaceAll(/[^\P{Cc}\t\n\r]/gu, '')
    .replaceAll(/talos-approve/gi, 'talos approve')
    .replaceAll(/(^|[^\w`])@(?=[A-Za-z0-9])/g, `$1@${ZERO_WIDTH_SPACE}`);
}

function oneLine(text: string, max: number): string {
  return clip(defused(text).replaceAll(/\s+/g, ' ').trim(), max);
}

function place(finding: Finding): string {
  if (finding.path === undefined) return '';
  const where = finding.line === undefined ? finding.path : `${finding.path}:${finding.line}`;
  return `\`${where.replaceAll('`', "'")}\` `;
}

/** The whole review body: the header line, the summary, and the findings, capped. */
export function reviewBody(
  header: ReviewHeader,
  summary: string,
  findings: readonly Finding[],
): string {
  const lines = [headerLine(header), '', oneLine(summary, SUMMARY_MAX)];
  if (findings.length > 0) {
    lines.push(
      '',
      ...findings.slice(0, LISTED).map((f) => `- ${place(f)}${oneLine(f.body, FINDING_MAX)}`),
    );
    if (findings.length > LISTED) lines.push(`- and ${findings.length - LISTED} more`);
  }
  return lines.join('\n');
}
