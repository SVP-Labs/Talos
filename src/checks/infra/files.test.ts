import { describe, expect, it } from 'vitest';
import {
  actionFiles,
  batches,
  dependabotFiles,
  dockerfiles,
  firstLine,
  isDockerfile,
  powershellFiles,
  shebangCandidates,
  shellOf,
  shellScripts,
  workflowFiles,
} from './files.js';
import { sentence } from './report.js';
import { tempRepo } from '../../testing/engine.js';

describe('shellOf', () => {
  it.each([
    ['#!/bin/sh', 'sh'],
    ['#!/bin/bash -e', 'bash'],
    ['#! /usr/bin/env bash', 'bash'],
    ['#!/usr/bin/env -S bash -euo pipefail', 'bash'],
    ['#!/usr/bin/env LC_ALL=C dash', 'dash'],
    ['#!/bin/ksh', 'ksh'],
  ])('reads %s as %s', (line, shell) => {
    expect(shellOf(line)).toBe(shell);
  });

  it.each(['#!/usr/bin/env node', '#!/usr/bin/env zsh', '#!/usr/bin/python3', 'echo hi', ''])(
    'leaves %j alone',
    (line) => {
      expect(shellOf(line)).toBeUndefined();
    },
  );
});

describe('isDockerfile', () => {
  it.each([
    'Dockerfile',
    'dockerfile',
    'Containerfile',
    'docker/Dockerfile.prod',
    'Containerfile.dev',
    'images/api.Dockerfile',
    'images/api.dockerfile',
    'api.Containerfile',
    'api.containerfile',
  ])('takes %s, named as Docker or Podman names a container file', (path) => {
    expect(isDockerfile(path)).toBe(true);
  });

  it.each([
    'src/checks/infra/dockerfile.ts',
    'src/checks/runtime/dockerfile.test.ts',
    'containerfile.go',
    'docker/dockerfile.prod',
    'containerfile',
    'DOCKERFILE',
    'my-Dockerfile',
    'Dockerfiles',
    '.Dockerfile',
    'docs/dockerfile.md',
    'Dockerfile/README.md',
    'Dockerfile.dockerignore',
    'images/api.Dockerfile.dockerignore',
    '.dockerignore',
  ])('leaves %s alone', (path) => {
    expect(isDockerfile(path)).toBe(false);
  });
});

describe('finding files', () => {
  const files = [
    'scripts/deploy.sh',
    'scripts/build.bash',
    'bin/tool',
    '.githooks/pre-commit',
    'LICENSE',
    'Makefile',
    '.gitignore',
    'src/app.ts',
    'Dockerfile',
    'docker/Dockerfile.prod',
    'images/api.dockerfile',
    'Containerfile',
    'Dockerfile.dockerignore',
    'install/setup.ps1',
    'install/Module.psm1',
    'install/Module.psd1',
    'PSScriptAnalyzerSettings.psd1',
    '.github/workflows/ci.yml',
    '.github/workflows/release.yaml',
    '.github/workflows/nested/x.yml',
    '.github/actions/setup/action.yml',
    'action.yaml',
    '.github/dependabot.yml',
  ];

  it('takes extensionless files but known names as possible scripts', () => {
    expect(shebangCandidates(files)).toEqual(['bin/tool', '.githooks/pre-commit']);
  });

  it('finds Dockerfiles and Containerfiles by name, not their ignore files', () => {
    expect(dockerfiles(files)).toEqual([
      'Dockerfile',
      'docker/Dockerfile.prod',
      'images/api.dockerfile',
      'Containerfile',
    ]);
  });

  it('leaves out TypeScript sources named after Dockerfiles', () => {
    expect(dockerfiles(['src/infra/dockerfile.ts', 'src/infra/dockerfile.test.ts'])).toEqual([]);
  });

  it("finds PowerShell files but Talos's own settings", () => {
    expect(powershellFiles(files)).toEqual([
      'install/setup.ps1',
      'install/Module.psm1',
      'install/Module.psd1',
    ]);
  });

  it('finds the workflows GitHub runs, action definitions and Dependabot config', () => {
    expect(workflowFiles(files)).toEqual([
      '.github/workflows/ci.yml',
      '.github/workflows/release.yaml',
    ]);
    expect(actionFiles(files)).toEqual(['.github/actions/setup/action.yml', 'action.yaml']);
    expect(dependabotFiles(files)).toEqual(['.github/dependabot.yml']);
  });

  it('reads first lines to keep only scripts in a shell', async () => {
    const root = await tempRepo({
      'a.sh': 'echo a\n',
      'bin/hook': '#!/bin/sh\nexit 0\n',
      'bin/cli': '#!/usr/bin/env node\n',
      'data/blob': '\u0000\u0001',
    });
    expect(await shellScripts(root, ['a.sh', 'bin/hook', 'bin/cli', 'data/blob', 'gone'])).toEqual([
      'a.sh',
      'bin/hook',
    ]);
    expect(await firstLine(root, 'gone')).toBe('');
  });

  it('splits long lists into batches', () => {
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(batches([], 2)).toEqual([]);
  });
});

describe('sentence', () => {
  it.each([
    [
      '"github.event.pull_request.title" is potentially untrusted. avoid using it directly',
      '"github.event.pull_request.title" is potentially untrusted.',
    ],
    [
      'Double quote to prevent globbing and word splitting',
      'Double quote to prevent globbing and word splitting.',
    ],
    ["unexpected 'N'\nexpecting '#', '\\', ADD", "Unexpected 'N'."],
    ['File uses Write-Host. Avoid using Write-Host because', 'File uses Write-Host.'],
    ['label "x" is unknown. available labels are "a"', 'Label "x" is unknown.'],
    ['Done!', 'Done!'],
    [
      "Use 'cd ... || exit' or 'cd ... || return' in case cd fails.",
      "Use 'cd ... || exit' or 'cd ... || return' in case cd fails.",
    ],
  ])('makes %j one sentence', (text, expected) => {
    expect(sentence(text)).toBe(expected);
  });
});
