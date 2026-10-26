import { describe, expect, it } from 'vitest';
import { bustedArgs, luacovConfig, selectSpecs, specOf, withFiles } from './busted.js';

// Trimmed from busted 2.3.0's `-o junit -Xoutput <file>` over three spec files.
const RECORDED = `
<testsuites skip='1' tests='4' errors='1' failures='1' time='0.02'>
	<testsuite skip='1' tests='4' name='Run 1 of 1' timestamp='2026-10-23T12:35:11' time='0.01' failures='1' errors='1'>
		<testcase time='0.00' classname='spec.calc_spec_lua:4' name='calc adds'/>
		<testcase time='0.00' classname='spec.calc_spec_lua:7' name='calc fails'>
			<failure>spec/calc_spec.lua:8: Expected objects to be equal.</failure>
		</testcase>
		<testcase time='0.00' classname='spec/unit.name_other_spec_lua:2' name='dotted errors'>
			<error>spec/unit/name.other_spec.lua:3: boom</error>
		</testcase>
		<testcase name='a &gt; b x &lt; y' time='0.00' classname='spec2.esc_spec_lua:2'/>
	</testsuite>
</testsuites>
`;

const SPECS = ['spec/calc_spec.lua', 'spec/unit/name.other_spec.lua'];

describe('selectSpecs', () => {
  const ctx = {
    root: 'game',
    specs: ['spec/a_spec.lua', 'spec/slow/b_spec.lua'],
    full: ['game/spec/slow'],
  };

  it('leaves tests.full out of the per-commit suite', () => {
    expect(selectSpecs({ suite: 'commit', coverage: false }, ctx)).toEqual(['spec/a_spec.lua']);
    expect(selectSpecs({ suite: 'all', coverage: true }, ctx)).toEqual(ctx.specs);
  });

  it("reruns the files it's given, made relative to the component", () => {
    const request = {
      suite: 'commit',
      coverage: false,
      files: ['game/spec/a_spec.lua', 'other/x.lua'],
    } as const;
    expect(selectSpecs(request, ctx)).toEqual(['spec/a_spec.lua']);
  });
});

describe('bustedArgs', () => {
  it("uses Talos's settings, writes JUnit to a file and measures coverage on request", () => {
    expect(
      bustedArgs({
        config: '/s/b.lua',
        junit: '/s/j.xml',
        coverage: '/s/c.lua',
        specs: ['spec/a_spec.lua'],
      }),
    ).toEqual([
      '--config-file=/s/b.lua',
      '--output=junit',
      '-Xoutput',
      '/s/j.xml',
      '--coverage',
      '--coverage-config-file=/s/c.lua',
      '--',
      'spec/a_spec.lua',
    ]);
    expect(bustedArgs({ config: 'b', junit: 'j', specs: [] })).not.toContain('--coverage');
  });
});

describe('JUnit files', () => {
  it('reads a class name back to the spec file it came from', () => {
    expect(specOf('spec.calc_spec_lua:7', SPECS)).toBe('spec/calc_spec.lua');
    expect(specOf('spec/unit.name_other_spec_lua:2', SPECS)).toBe('spec/unit/name.other_spec.lua');
    expect(specOf('calc_spec_lua:1', ['calc_spec.lua'])).toBe('calc_spec.lua');
    expect(specOf('spec.other_spec_lua:1', SPECS)).toBeUndefined();
  });

  it('adds each test case its file and leaves unknown ones alone', () => {
    const xml = withFiles(RECORDED, SPECS);
    expect(xml).toContain(
      "<testcase time='0.00' classname='spec.calc_spec_lua:4' name='calc adds' file='spec/calc_spec.lua'/>",
    );
    expect(xml).toContain(
      "<testcase time='0.00' classname='spec/unit.name_other_spec_lua:2' name='dotted errors' file='spec/unit/name.other_spec.lua'>",
    );
    expect(xml).toContain("classname='spec2.esc_spec_lua:2'/>");
    expect(withFiles(xml, SPECS)).toBe(xml);
  });

  it('reads a class name busted escaped, and escapes the file it writes', () => {
    const tag = "<testcase classname='spec.it&apos;s &amp; co_spec_lua:3' name='x'/>";
    expect(withFiles(tag, ["spec/it's & co_spec.lua"])).toBe(
      "<testcase classname='spec.it&apos;s &amp; co_spec_lua:3' name='x' " +
        "file='spec/it&apos;s &amp; co_spec.lua'/>",
    );
  });
});

describe('luacovConfig', () => {
  it('writes statistics where Talos reads them, with no report of its own', () => {
    expect(luacovConfig('C:\\s\\luacov.stats.out')).toBe(
      'return { statsfile = "C:\\\\s\\\\luacov.stats.out", runreport = false, deletestats = false }\n',
    );
  });
});
