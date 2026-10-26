import { describe, expect, it } from 'vitest';
import {
  HADOLINT_CONFIG,
  INFRA_GENERATED,
  renderHadolint,
  renderPssaSettings,
  renderShellcheckrc,
  SHELLCHECK_RC,
} from './configs.js';
import { PSSA_SETTINGS } from './files.js';
import { parseConfig } from '../../config/load.js';
import { GENERATED_MARKER } from '../../configs/header.js';
import { repoFacts } from '../../repo/facts.js';
import { MINIMAL_CONFIG } from '../../testing/engine.js';

function applyContext(files: readonly string[]) {
  return {
    facts: repoFacts(files, []),
    config: parseConfig(MINIMAL_CONFIG),
    side: 'alone',
    tiers: ['head'],
  } as const;
}

describe('the generated bases', () => {
  it('start with the generated header and hold the settings the gate passes', () => {
    expect(renderShellcheckrc('1.2.3')).toBe(
      `# ${GENERATED_MARKER} 1.2.3. Do not edit.\nenable=all\ndisable=SC2250\n` +
        'external-sources=true\nsource-path=SCRIPTDIR\n',
    );
    expect(renderHadolint('1.2.3')).toBe(
      `# ${GENERATED_MARKER} 1.2.3. Do not edit.\nfailure-threshold: info\n`,
    );
    const pssa = renderPssaSettings('1.2.3');
    expect(pssa.startsWith(`# ${GENERATED_MARKER} 1.2.3. Do not edit.\n@{\n`)).toBe(true);
  });

  it('are written only where the repository has files for their tool', () => {
    const paths = (files: readonly string[]): string[] =>
      INFRA_GENERATED.filter((g) => g.applies(applyContext(files))).map((g) => g.path);
    expect(paths(['src/app.ts', 'README.md'])).toEqual([]);
    expect(paths(['bin/hook', 'docker/Dockerfile', 'install.ps1'])).toEqual([
      SHELLCHECK_RC,
      HADOLINT_CONFIG,
      PSSA_SETTINGS,
    ]);
    expect(paths([PSSA_SETTINGS])).toEqual([]);
  });
});
