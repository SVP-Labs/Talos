import { describe, expect, it } from 'vitest';
import { infectionConfig, pestBridge, phpString, sourceDirs } from './infection.js';

describe('infectionConfig', () => {
  it('points Infection at the sources, its log and the Pest bridge', () => {
    const json: unknown = JSON.parse(
      infectionConfig({
        sources: ['/repo/src'],
        scratch: '/s',
        log: '/s/infection.json',
        componentDir: '/repo',
        bridge: '/s/pest-for-infection.php',
      }),
    );
    expect(json).toEqual({
      source: { directories: ['/repo/src'] },
      tmpDir: '/s/infection-tmp',
      logs: { json: '/s/infection.json' },
      phpUnit: { configDir: '/repo', customPath: '/s/pest-for-infection.php' },
      mutators: { '@default': true },
    });
  });
});

describe('sourceDirs', () => {
  it('takes the top-level directories, or the root when a file sits there', () => {
    expect(sourceDirs(['src/A.php', 'src/Deep/B.php', 'lib/C.php'])).toEqual(['lib', 'src']);
    expect(sourceDirs(['index.php', 'src/A.php'])).toEqual(['.']);
  });
});

describe('pestBridge', () => {
  it('writes the component directory as a PHP string literal', () => {
    expect(phpString("C:\\it's")).toBe("'C:\\\\it\\'s'");
    const script = pestBridge('/repo/$app');
    expect(script).toContain("$root = '/repo/$app';");
    expect(script).toContain("require $root . '/vendor/autoload.php';");
    expect(script).toContain("echo PHP_EOL . 'OK (the Pest run passed)' . PHP_EOL;");
  });
});
