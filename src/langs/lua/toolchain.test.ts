import { describe, expect, it } from 'vitest';
import { parseRockList, toolchainFindings } from './toolchain.js';

// Recorded from LuaRocks 3.13.0: `luarocks list --porcelain` in a component's tree.
const RECORDED = [
  'argparse\t0.7.2-1\tinstalled\t/work/game/.lua/lib/luarocks/rocks-5.4',
  'busted\t2.3.0-1\tinstalled\t/work/game/.lua/lib/luarocks/rocks-5.4',
  'cluacov\t1.0.0-1\tinstalled\t/work/game/.lua/lib/luarocks/rocks-5.4',
  'luacheck\t1.1.2-1\tinstalled\t/work/game/.lua/lib/luarocks/rocks-5.4',
  '',
].join('\n');

const PINS = { busted: '2.3.0-1', cluacov: '1.0.0-1', luacheck: '1.2.0-1', luacov: '0.17.0-1' };

describe('parseRockList', () => {
  it('reads each rock and its versions', () => {
    const installed = parseRockList(`${RECORDED}busted\t2.2.0-1\tinstalled\t/x\n`);
    expect(installed.get('busted')).toEqual(['2.3.0-1', '2.2.0-1']);
    expect(installed.get('argparse')).toEqual(['0.7.2-1']);
  });
});

describe('toolchainFindings', () => {
  it('reports a tool at another version and one that is missing', () => {
    expect(toolchainFindings(PINS, parseRockList(RECORDED))).toEqual([
      {
        rule: 'toolchain/mismatch',
        message:
          'luacheck 1.1.2-1 is installed but Talos runs 1.2.0-1, so the editor and the gate may disagree.',
        key: 'luarocks luacheck',
      },
      {
        rule: 'toolchain/missing',
        message: 'luacov is not installed; Talos runs luacov 0.17.0-1.',
        key: 'luarocks luacov',
      },
    ]);
  });

  it('reports a second version installed beside the pinned one', () => {
    const installed = new Map([['busted', ['2.3.0-1', '2.4.0-1']]]);
    expect(toolchainFindings({ busted: '2.3.0-1' }, installed).map((f) => f.rule)).toEqual([
      'toolchain/mismatch',
    ]);
  });

  it('is quiet when every tool matches', () => {
    const installed = new Map(Object.entries(PINS).map(([name, v]) => [name, [v]]));
    expect(toolchainFindings(PINS, installed)).toEqual([]);
  });
});
