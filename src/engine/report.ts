import { type Located, statusOf, type Verdict } from './verdict.js';

function where(finding: Located): string {
  const location = finding.location;
  if (location === undefined) return '';
  return `${location.file}:${location.line}`;
}

function short(sha: string): string {
  return sha.slice(0, 12);
}

/** The plain-text report a person reads in a terminal. */
export function textReport(verdict: Verdict): string {
  const lines: string[] = [];
  for (const fault of verdict.faults) {
    lines.push(
      `ENGINE ERROR ${fault.check} at ${short(fault.sha)} (${fault.os}): ${fault.reason ?? ''}`,
    );
  }
  for (const finding of verdict.blocking) {
    const why = finding.why === 'new' ? '' : ` (${finding.why})`;
    lines.push(
      `${short(finding.sha)} ${where(finding)} ${finding.rule}${why}: ${finding.message}`.trim(),
    );
  }
  const existing = verdict.findings.length - verdict.blocking.length;
  lines.push(
    `${verdict.blocking.length} blocking finding(s), ${existing} existing or informational, ` +
      `${verdict.faults.length} engine error(s)`,
  );
  return `${lines.join('\n')}\n`;
}

function escapeData(text: string): string {
  return text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function escapeProperty(text: string): string {
  return escapeData(text).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

/** GitHub workflow commands: one annotation per blocking finding, up to GitHub's display limit. */
export function annotations(verdict: Verdict, limit = 50): string {
  return verdict.blocking
    .slice(0, limit)
    .map((finding) => {
      const location = finding.location;
      const props = [
        ...(location ? [`file=${escapeProperty(location.file)}`, `line=${location.line}`] : []),
        ...(location?.endLine === undefined ? [] : [`endLine=${location.endLine}`]),
        `title=${escapeProperty(finding.rule)}`,
      ];
      return `::error ${props.join(',')}::${escapeData(finding.message)}\n`;
    })
    .join('');
}

function cell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

/** The Markdown job summary. */
export function markdownSummary(verdict: Verdict): string {
  const head = statusOf(verdict);
  const rows = verdict.blocking.map(
    (f) =>
      `| ${short(f.sha)} | ${cell(where(f))} | ${cell(f.rule)} | ${f.why} | ${cell(f.message)} |`,
  );
  const faults = verdict.faults.map(
    (f) => `- **${f.check}** at ${short(f.sha)} (${f.os}): ${cell(f.reason ?? '')}`,
  );
  return [
    `## Talos: ${head}`,
    '',
    ...(faults.length > 0 ? ['### Engine errors', '', ...faults, ''] : []),
    ...(rows.length > 0
      ? [
          '| commit | where | rule | why | message |',
          '| --- | --- | --- | --- | --- |',
          ...rows,
          '',
        ]
      : []),
    `${verdict.blocking.length} blocking, ${verdict.findings.length - verdict.blocking.length} existing or informational.`,
    '',
  ].join('\n');
}
