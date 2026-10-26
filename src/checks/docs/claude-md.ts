import { readText } from './files.js';
import { type Check, type CheckContext, APPLIES } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';
import {
  claudeBlocks,
  type ClaudeBlocks,
  kitBlock,
  loadKitTemplate,
  PROJECT_BLOCK_CAP,
  sameKitBlock,
} from '../../docs/claude.js';

const CLAUDE_MD = 'CLAUDE.md';

function staleBlock(blocks: ClaudeBlocks, rendered: string): Finding[] {
  const { kit } = blocks;
  if (kit === undefined) {
    return [
      {
        rule: 'claude/stale-block',
        message: 'CLAUDE.md has no Talos block; regenerate it rather than writing one by hand.',
        location: { file: CLAUDE_MD, line: 1 },
      },
    ];
  }
  if (sameKitBlock(kit.text, rendered)) return [];
  return [
    {
      rule: 'claude/stale-block',
      message:
        "CLAUDE.md's Talos block differs from the one this release renders; regenerate it " +
        'rather than editing it.',
      location: { file: CLAUDE_MD, line: kit.line, endLine: kit.endLine },
    },
  ];
}

function tooLong(file: string, blocks: ClaudeBlocks): Finding[] {
  const { project } = blocks;
  if (project === undefined || project.lines <= PROJECT_BLOCK_CAP) return [];
  return [
    {
      rule: 'claude/too-long',
      message:
        `${file} holds ${String(project.lines)} lines of its own, over the cap of ` +
        `${String(PROJECT_BLOCK_CAP)}; keep instructions there and move the rest into docs/.`,
      location: { file, line: project.line, endLine: project.endLine },
    },
  ];
}

async function claudeMd(ctx: CheckContext): Promise<Finding[]> {
  const findings: Finding[] = [];
  const root = await readText(ctx, CLAUDE_MD);
  if (root === undefined) {
    findings.push({
      rule: 'claude/stale-block',
      message: 'The repository has no CLAUDE.md; Talos writes it with its block.',
      key: CLAUDE_MD,
    });
  } else {
    const blocks = claudeBlocks(root);
    findings.push(...staleBlock(blocks, kitBlock(loadKitTemplate(), ctx.config)));
    findings.push(...tooLong(CLAUDE_MD, blocks));
  }
  for (const file of ctx.facts.matching('**/CLAUDE.md').filter((f) => f !== CLAUDE_MD)) {
    const text = await readText(ctx, file);
    if (text !== undefined) findings.push(...tooLong(file, claudeBlocks(text)));
  }
  return findings;
}

/** `CLAUDE.md`: Talos's block as this release renders it, and a capped block of the project's. */
export const claudeMdCheck: Check = {
  id: 'docs/claude-md',
  tier: 'head',
  scope: 'repo',
  title: "CLAUDE.md's Talos block and length",
  applies: () => APPLIES,
  run: claudeMd,
};
