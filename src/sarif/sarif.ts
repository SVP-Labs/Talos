import type { Judged } from '../core/compare.js';

type SarifResult = {
  ruleId: string;
  level: 'error' | 'warning' | 'note';
  message: { text: string };
  locations?: {
    physicalLocation: {
      artifactLocation: { uri: string };
      region: { startLine: number; endLine?: number; startColumn?: number };
    };
  }[];
  partialFingerprints: Record<string, string>;
  properties: Record<string, unknown>;
};

export type SarifLog = {
  $schema: string;
  version: '2.1.0';
  runs: {
    tool: {
      driver: {
        name: string;
        version: string;
        informationUri: string;
        rules: { id: string; helpUri?: string }[];
      };
    };
    results: SarifResult[];
  }[];
};

function level(finding: Judged): SarifResult['level'] {
  if (finding.blocking) return 'error';
  return finding.policy === 'info' ? 'note' : 'warning';
}

function toResult(finding: Judged): SarifResult {
  const location = finding.location;
  return {
    ruleId: finding.rule,
    level: level(finding),
    message: { text: finding.message },
    ...(location === undefined
      ? {}
      : {
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: location.file },
                region: {
                  startLine: location.line,
                  ...(location.endLine === undefined ? {} : { endLine: location.endLine }),
                  ...(location.column === undefined ? {} : { startColumn: location.column }),
                },
              },
            },
          ],
        }),
    partialFingerprints: { 'talos/v1': finding.fingerprint },
    properties: {
      check: finding.check,
      policy: finding.policy,
      new: finding.isNew,
      blocking: finding.blocking,
      why: finding.why,
    },
  };
}

/** One SARIF run per check, which baselines, annotations and the agent's fix loop all read. */
export function toSarif(findings: readonly Judged[], version: string): SarifLog {
  const byCheck = new Map<string, Judged[]>();
  for (const finding of findings) {
    byCheck.set(finding.check, [...(byCheck.get(finding.check) ?? []), finding]);
  }
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [...byCheck].map(([check, results]) => ({
      tool: {
        driver: {
          name: `talos ${check}`,
          version,
          informationUri: 'https://github.com/SVP-Labs/Talos',
          rules: [...new Set(results.map((r) => r.rule))].map((id) => {
            const docs = results.find((r) => r.rule === id)?.docs;
            return docs === undefined ? { id } : { id, helpUri: docs };
          }),
        },
      },
      results: results.map(toResult),
    })),
  };
}
