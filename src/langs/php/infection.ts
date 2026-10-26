import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { absolute, componentDir, fileExists, inComponent } from './paths.js';
import { bind, type Bound, runVendorTool, tail, vendorBin } from './run.js';
import { topLevel } from './scope.js';
import type { CheckContext } from '../../core/check.js';
import { EngineError } from '../../core/check.js';
import type { MutationFormat, MutationRunner, Report } from '../../quality/protocol.js';

/**
 * Infection has no Pest adapter, so it runs Pest through its PHPUnit one, by way of this
 * script, which runs Pest and makes what it says read the way PHPUnit's would:
 * - asked its version, it answers with the installed PHPUnit's, not Pest's;
 * - Pest prints its own summary, and Infection takes a run without PHPUnit's `OK (` for a
 *   failure, so a passing run gets that line;
 * - Infection finds each covering test's file in the JUnit report by the test's class, with
 *   PHPUnit's absolute path; Pest writes the path relative to the project and names the class
 *   it makes of a test file `P\Tests\X` in coverage but `Tests\X` in the report, so each path is
 *   made absolute and an entry is added under the `P\` name, the original kept for test classes.
 */
const BRIDGE = String.raw`<?php

declare(strict_types=1);

$root = __ROOT__;
$args = array_slice($argv, 1);
if (in_array('--version', $args, true)) {
    require $root . '/vendor/autoload.php';
    echo 'PHPUnit ' . \PHPUnit\Runner\Version::id() . PHP_EOL;
    exit(0);
}

function talos_junit(array $args): ?string
{
    foreach ($args as $index => $arg) {
        if (str_starts_with($arg, '--log-junit=')) {
            return substr($arg, strlen('--log-junit='));
        }
        if ($arg === '--log-junit') {
            return $args[$index + 1] ?? null;
        }
    }
    return null;
}

function talos_fix_junit(string $junit, string $root): void
{
    $extra = '';
    $xml = preg_replace_callback(
        '/<testsuite name="([^"]+)" file="([^"]+)"/',
        static function (array $match) use ($root, &$extra): string {
            $file = $match[2];
            if (!str_starts_with($file, '/') && preg_match('/^[A-Za-z]:/', $file) !== 1) {
                $file = $root . '/' . $file;
            }
            if (!str_starts_with($match[1], 'P\\')) {
                $extra .= '<testsuite name="P\\' . $match[1] . '" file="' . $file . '" tests="0" time="0"/>';
            }
            return '<testsuite name="' . $match[1] . '" file="' . $file . '"';
        },
        (string) file_get_contents($junit),
    );
    file_put_contents($junit, str_replace('</testsuites>', $extra . '</testsuites>', (string) $xml));
}

$ini = [];
foreach (['memory_limit', 'pcov.enabled', 'pcov.directory', 'pcov.exclude'] as $name) {
    $value = ini_get($name);
    if ($value !== false) {
        $ini[] = '-d';
        $ini[] = $name . '=' . $value;
    }
}
$process = proc_open(
    array_merge([PHP_BINARY], $ini, [$root . '/vendor/bin/pest'], $args),
    [0 => STDIN, 1 => ['pipe', 'w'], 2 => STDERR],
    $pipes,
);
if ($process === false) {
    exit(255);
}
$output = (string) stream_get_contents($pipes[1]);
fclose($pipes[1]);
$code = proc_close($process);
echo $output;
$junit = talos_junit($args);
if ($junit !== null && is_file($junit)) {
    talos_fix_junit($junit, $root);
}
if ($code === 0) {
    echo PHP_EOL . 'OK (the Pest run passed)' . PHP_EOL;
}
exit($code);
`;

/** A PHP single-quoted string literal. */
export function phpString(text: string): string {
  const escaped = text.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
  return `'${escaped}'`;
}

export function pestBridge(root: string): string {
  return BRIDGE.replace('__ROOT__', () => phpString(root));
}

export type InfectionConfig = {
  readonly sources: readonly string[];
  readonly scratch: string;
  readonly log: string;
  readonly componentDir: string;
  readonly bridge: string;
};

/** Infection's config, as JSON (which JSON5 is a superset of), every path absolute. */
export function infectionConfig(config: InfectionConfig): string {
  const json = {
    source: { directories: [...config.sources] },
    tmpDir: join(config.scratch, 'infection-tmp'),
    logs: { json: config.log },
    phpUnit: { configDir: config.componentDir, customPath: config.bridge },
    mutators: { '@default': true },
  };
  return `${JSON.stringify(json, null, 2)}\n`;
}

/** The source directories that hold the files: their top-level directories, `.` for root files. */
export function sourceDirs(files: readonly string[]): string[] {
  const { dirs, rootFiles } = topLevel(files);
  return rootFiles.length > 0 ? ['.'] : dirs;
}

async function mutate(ctx: Bound, files: readonly string[]): Promise<string> {
  const local = files
    .map((file) => inComponent(ctx.component.root, file))
    .filter((file): file is string => file !== undefined);
  const dir = componentDir(ctx);
  const bridge = join(ctx.scratch, 'pest-for-infection.php');
  await vendorBin(ctx, 'pest');
  await writeFile(bridge, pestBridge(dir));
  const log = join(ctx.scratch, 'infection.json');
  const config = join(ctx.scratch, 'infection.json5');
  const sources = sourceDirs(local).map((source) => absolute(ctx, source));
  await writeFile(
    config,
    infectionConfig({ sources, scratch: ctx.scratch, log, componentDir: dir, bridge }),
  );
  const result = await runVendorTool(
    ctx,
    'infection',
    [
      `--configuration=${config}`,
      `--filter=${local.join(',')}`,
      '--threads=max',
      '--no-progress',
      '--min-msi=0',
      '--with-uncovered',
      `--initial-tests-php-options=-d pcov.enabled=1 -d pcov.directory=${dir}`,
    ],
    { env: { XDEBUG_MODE: 'coverage' }, timeoutMs: 2 * 60 * 60 * 1000 },
  );
  if (!(await fileExists(log))) {
    throw new EngineError(`infection wrote no report (exit ${result.code}):\n${tail(result)}`);
  }
  return log;
}

const FORMAT: MutationFormat = 'infection';

/** Infection over the requested files, its JSON log as the report. */
export const infectionRunner: MutationRunner = {
  async run(
    ctx: CheckContext,
    files: readonly string[],
  ): Promise<Report & { readonly format: MutationFormat }> {
    const bound = bind(ctx);
    const path = await mutate(bound, files);
    return { path, base: componentDir(bound), format: FORMAT };
  },
};
