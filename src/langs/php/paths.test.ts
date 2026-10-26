import { describe, expect, it } from 'vitest';
import {
  fromTool,
  inComponent,
  inRepo,
  isCheckedPhp,
  isTestPath,
  phpFiles,
  shippedFiles,
} from './paths.js';
import { topLevel, unchecked } from './scope.js';
import { repoFacts } from '../../repo/facts.js';

const component = { lang: 'php' as const, root: 'app', os: ['linux' as const] };

describe('paths', () => {
  it('moves between repository and component paths', () => {
    expect(inComponent('app', 'app/src/A.php')).toBe('src/A.php');
    expect(inComponent('app', 'lib/B.php')).toBeUndefined();
    expect(inComponent('.', 'src/A.php')).toBe('src/A.php');
    expect(inRepo('app/', 'src/A.php')).toBe('app/src/A.php');
    expect(fromTool({ root: '/repo', component }, '/repo/app/src/A.php')).toBe('app/src/A.php');
    expect(fromTool({ root: '/repo', component }, './src/A.php')).toBe('app/src/A.php');
  });

  it('checks PHP but not Blade or what Composer installed', () => {
    expect(isCheckedPhp('src/A.php')).toBe(true);
    expect(isCheckedPhp('resources/views/home.blade.php')).toBe(false);
    expect(isCheckedPhp('vendor/x/y.php')).toBe(false);
    expect(isCheckedPhp('README.md')).toBe(false);
  });

  it('tells test code by its directory or its name', () => {
    expect(isTestPath('tests/Unit/AThing.php')).toBe(true);
    expect(isTestPath('src/Billing/InvoiceTest.php')).toBe(true);
    expect(isTestPath('src/Latest.php')).toBe(false);
    expect(isTestPath('src/Testing/Fake.php')).toBe(false);
  });

  it("lists a component's PHP and its shipped part", () => {
    const facts = repoFacts(
      [
        'app/src/A.php',
        'app/tests/ATest.php',
        'app/resources/x.blade.php',
        'lib/B.php',
        'app/README.md',
      ],
      [],
    );
    expect(phpFiles({ facts, component })).toEqual(['src/A.php', 'tests/ATest.php']);
    expect(shippedFiles({ facts, component })).toEqual(['src/A.php']);
  });
});

describe('scope', () => {
  it('finds the top-level directories and the root files', () => {
    expect(topLevel(['src/A.php', 'src/B/C.php', 'tests/T.php', 'index.php'])).toEqual({
      dirs: ['src', 'tests'],
      rootFiles: ['index.php'],
    });
  });

  it('leaves out PHP found on disk that Talos does not check', () => {
    expect(
      unchecked(
        ['src/A.php', 'src/Gen.php', 'src/x.txt', 'src/v.blade.php'],
        new Set(['src/A.php']),
      ),
    ).toEqual(['src/Gen.php', 'src/v.blade.php']);
  });
});
