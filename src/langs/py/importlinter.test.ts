import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import {
  contractTypes,
  packageRoots,
  parseImportLinter,
  UNIVERSAL,
  universalConfig,
} from './importlinter.js';

// Recorded from import-linter 2.15 (`lint-imports --no-logo`).
const LAYERS = [
  '',
  '---------',
  'Contracts',
  '---------',
  '',
  'Analyzed 8 files, 2 dependencies.',
  '---------------------------------',
  '',
  'Layers of m BROKEN',
  'Low is independent of high BROKEN',
  'Low forbids high BROKEN',
  '',
  'Contracts: 0 kept, 3 broken.',
  '',
  '',
  '----------------',
  'Broken contracts',
  '----------------',
  '',
  'Layers of m',
  '-----------',
  '',
  'm.mid is not allowed to import m.high:',
  '',
  '- m.mid.helper -> m.high.top (l.1, l.2)',
  '',
  '',
  'm.low is not allowed to import m.mid:',
  '',
  '- m.low.thing -> m.mid.helper (l.1)',
  '',
  '',
  'Low is independent of high',
  '--------------------------',
  '',
  'm.low is not allowed to import m.high:',
  '',
  '- m.low.thing -> m.mid.helper (l.1)',
  '  m.mid.helper -> m.high.top (l.1, l.2)',
  '',
  '',
  'Low forbids high',
  '----------------',
  '',
  'm.low is not allowed to import m.high:',
  '',
  '-   m.low.thing -> m.mid.helper (l.1)',
  '    m.mid.helper -> m.high.top (l.1, l.2)',
  '',
  '',
].join('\n');

const CYCLES = [
  'No import cycles between the modules of a package BROKEN',
  '',
  'Contracts: 0 kept, 1 broken.',
  '',
  '',
  '----------------',
  'Broken contracts',
  '----------------',
  '',
  'No import cycles between the modules of a package',
  '-------------------------------------------------',
  '',
  'No cycles are allowed in layered.',
  'It could be made acyclic by removing 1 dependency:',
  '',
  '- .ring_b -> .ring_a (1 import)',
  '',
].join('\n');

describe('parseImportLinter', () => {
  it('reads each broken contract with its chains and where they start', () => {
    const report = parseImportLinter(LAYERS);
    expect(report?.kept).toBe(0);
    expect(report?.broken).toEqual([
      {
        name: 'Layers of m',
        imports: [
          { importer: 'm.mid.helper', imported: 'm.high.top', target: 'm.high.top', line: 1 },
          { importer: 'm.low.thing', imported: 'm.mid.helper', target: 'm.mid.helper', line: 1 },
        ],
      },
      {
        name: 'Low is independent of high',
        imports: [
          { importer: 'm.low.thing', imported: 'm.mid.helper', target: 'm.high.top', line: 1 },
        ],
      },
      {
        name: 'Low forbids high',
        imports: [
          { importer: 'm.low.thing', imported: 'm.mid.helper', target: 'm.high.top', line: 1 },
        ],
      },
    ]);
  });

  it('reads cycle breakers relative to their package', () => {
    expect(parseImportLinter(CYCLES)?.broken).toEqual([
      {
        name: 'No import cycles between the modules of a package',
        cycleIn: 'layered',
        imports: [
          { importer: 'layered.ring_b', imported: 'layered.ring_a', target: 'layered.ring_a' },
        ],
      },
    ]);
  });

  it('reads a clean run, and nothing when no summary was printed', () => {
    expect(parseImportLinter('Contracts: 2 kept, 0 broken.\n')).toEqual({ kept: 2, broken: [] });
    expect(
      parseImportLinter("Could not find package 'nonexistent_pkg' in your Python path.\n"),
    ).toBeUndefined();
  });
});

describe('packageRoots', () => {
  it('takes packages under src/ in a src layout, and tests apart', () => {
    expect(
      packageRoots([
        'src/tally/__init__.py',
        'src/tally/count.py',
        'src/py.typed/__init__.py',
        'tests/__init__.py',
        'scripts/__init__.py',
      ]),
    ).toEqual({ shipped: ['tally'], tests: ['tests'] });
  });

  it('takes root packages in a flat layout', () => {
    expect(packageRoots(['app/__init__.py', 'lib/__init__.py', 'test/__init__.py'])).toEqual({
      shipped: ['app', 'lib'],
      tests: ['test'],
    });
    expect(packageRoots(['main.py'])).toEqual({ shipped: [], tests: [] });
  });
});

describe('universalConfig', () => {
  it('writes the cycle, test and dev-only contracts that apply', () => {
    const config = parse(
      universalConfig({ shipped: ['tally'], tests: ['tests'] }, ['pytest', 'ruff']),
    );
    expect(config).toEqual({
      tool: {
        importlinter: {
          root_packages: ['tally', 'tests'],
          include_external_packages: true,
          contracts: [
            { name: UNIVERSAL.cycles, type: 'acyclic_siblings', ancestors: ['tally'] },
            {
              name: UNIVERSAL.tests,
              type: 'forbidden',
              source_modules: ['tally'],
              forbidden_modules: ['tests'],
            },
            {
              name: UNIVERSAL.dev,
              type: 'forbidden',
              source_modules: ['tally'],
              forbidden_modules: ['pytest', 'ruff'],
            },
          ],
        },
      },
    });
  });

  it('leaves out contracts with nothing to forbid', () => {
    const config = parse(universalConfig({ shipped: ['app'], tests: [] }, []));
    expect(config).toEqual({
      tool: {
        importlinter: {
          root_packages: ['app'],
          include_external_packages: false,
          contracts: [{ name: UNIVERSAL.cycles, type: 'acyclic_siblings', ancestors: ['app'] }],
        },
      },
    });
  });
});

describe('contractTypes', () => {
  it('maps names to types and skips malformed contracts', () => {
    const types = contractTypes({
      root_packages: ['m'],
      contracts: [
        { name: 'Layers of m', type: 'layers', layers: ['m.high', 'm.low'] },
        { name: 'no type' },
      ],
    });
    expect([...types]).toEqual([['Layers of m', 'layers']]);
    expect(contractTypes(undefined).size).toBe(0);
  });
});
