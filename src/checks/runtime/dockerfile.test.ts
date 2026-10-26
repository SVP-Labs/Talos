import { describe, expect, it } from 'vitest';
import { declaredRuntimes, isDeclaringFile } from './declarations.js';
import {
  dockerfileDeclarations,
  globalArgs,
  instructions,
  officialName,
  parseFrom,
  splitReference,
  substitute,
  tagVersion,
} from './dockerfile.js';

describe('instructions', () => {
  it('joins continuations and drops comments, blank lines and heredoc bodies', () => {
    const text = [
      '# syntax=docker/dockerfile:1',
      'FROM --platform=linux/amd64 \\',
      '  # a comment inside the continuation',
      '  node:22.12.0-slim AS build',
      '',
      'RUN <<EOF',
      'FROM php:7.4.0',
      'EOF',
      'from python:3.13.1',
    ].join('\n');
    expect(instructions(text)).toEqual([
      {
        keyword: 'FROM',
        args: '--platform=linux/amd64    node:22.12.0-slim AS build',
        line: 2,
        endLine: 4,
      },
      { keyword: 'RUN', args: '<<EOF', line: 6, endLine: 6 },
      { keyword: 'FROM', args: 'python:3.13.1', line: 9, endLine: 9 },
    ]);
  });

  it('honours a backtick escape directive and a final line without a newline', () => {
    const text = '# escape=`\nFROM `\n  php:8.4.26-fpm\nRUN echo \\';
    expect(instructions(text)).toEqual([
      { keyword: 'FROM', args: 'php:8.4.26-fpm', line: 2, endLine: 3 },
      { keyword: 'RUN', args: 'echo \\', line: 4, endLine: 4 },
    ]);
  });

  it('opens no heredoc for a here-string, a shift or another instruction', () => {
    const text = [
      'RUN cat <<< "x" && echo $((1 << y))',
      'LABEL note="<<EOF"',
      'FROM php:8.4.26',
    ].join('\n');
    expect(instructions(text).map((i) => i.keyword)).toEqual(['RUN', 'LABEL', 'FROM']);
  });

  it('keeps an instruction the file ends in the middle of, and reads a file of directives', () => {
    expect(instructions('FROM \\\n  php:8.4.26 \\')).toEqual([
      { keyword: 'FROM', args: 'php:8.4.26', line: 1, endLine: 2 },
    ]);
    expect(instructions('# syntax=docker/dockerfile:1')).toEqual([]);
  });

  it('ends a heredoc at its delimiter, tabs stripped', () => {
    const text = 'RUN <<-"END" cat\n\tFROM ruby:2.0.0\n\tEND\nFROM ruby:3.3.6';
    expect(instructions(text).map((i) => i.args)).toEqual(['<<-"END" cat', 'ruby:3.3.6']);
  });
});

describe('build arguments', () => {
  it('reads the arguments before the first FROM only', () => {
    const list = instructions('ARG A=1 B="2" C\nFROM x\nARG D=4\n');
    expect([...globalArgs(list)]).toEqual([
      ['A', { value: '1', line: 1 }],
      ['B', { value: '2', line: 1 }],
      ['C', { line: 1 }],
    ]);
  });

  it('substitutes as Docker does and keeps what has no value', () => {
    const args = globalArgs(instructions("ARG V=8.4.26\nARG EMPTY=''\nARG UNSET\n"));
    expect(substitute('php:${V}-fpm', args)).toEqual({ text: 'php:8.4.26-fpm', used: ['V'] });
    expect(substitute('php:$V', args).text).toBe('php:8.4.26');
    expect(substitute('${EMPTY:-8.3.1}|${V:-x}|${V:+set}|${UNSET:+set}', args).text).toBe(
      '8.3.1|8.4.26|set|',
    );
    expect(substitute('php:${UNSET}-fpm', args)).toEqual({ text: 'php:${UNSET}-fpm', used: [] });
    expect(substitute('php:${NEVER-8.2.0}', args).text).toBe('php:8.2.0');
  });
});

describe('image references', () => {
  it('splits path, tag and digest', () => {
    expect(splitReference('php:8.4.26-fpm@sha256:abc')).toEqual({
      path: 'php',
      tag: '8.4.26-fpm',
      digest: 'sha256:abc',
    });
    expect(splitReference('localhost:5000/node')).toEqual({ path: 'localhost:5000/node' });
    expect(splitReference('python@sha256:abc')).toEqual({ path: 'python', digest: 'sha256:abc' });
  });

  it('names an image as Docker Hub does, whatever registry serves it', () => {
    expect(officialName('docker.io/library/PHP')).toBe('php');
    expect(officialName('public.ecr.aws/docker/library/node')).toBe('node');
    expect(officialName('mirror.gcr.io/library/python')).toBe('python');
    expect(officialName('oven/bun')).toBe('oven/bun');
    expect(officialName('ghcr.io/acme/php')).toBe('acme/php');
  });

  it("reads the release from a tag's first part that starts with a digit", () => {
    expect(tagVersion('8.4.26-fpm-alpine3.21')).toBe('8.4.26');
    expect(tagVersion('alpine-2.1.4')).toBe('2.1.4');
    expect(tagVersion('8.5.0RC2-cli')).toBe('8.5.0RC2');
    expect(tagVersion('fpm-alpine3.21')).toBeUndefined();
  });

  it('reads FROM flags and stage names', () => {
    expect(parseFrom('--platform=linux/amd64 php:8.4 AS Base')).toEqual({
      image: 'php:8.4',
      stage: 'base',
    });
    expect(parseFrom('')).toEqual({});
  });
});

describe('dockerfileDeclarations', () => {
  it('reads every stage, skipping earlier stages, scratch and other images', () => {
    const text = [
      'FROM php:8.4.26-fpm-alpine AS app',
      'FROM node:22-alpine AS assets',
      'FROM app AS final',
      'FROM scratch',
      'FROM nginx:1.27.3',
      'FROM docker.io/library/python:3.13.1-slim@sha256:0123456789abcdef0123',
    ].join('\n');
    expect(dockerfileDeclarations('docker/Dockerfile', text)).toEqual([
      {
        runtime: 'php',
        file: 'docker/Dockerfile',
        line: 1,
        written: 'php:8.4.26-fpm-alpine',
        version: '8.4.26',
        exactness: 'exact',
      },
      {
        runtime: 'node',
        file: 'docker/Dockerfile',
        line: 2,
        written: 'node:22-alpine',
        version: '22',
        exactness: 'floating',
      },
      {
        runtime: 'python',
        file: 'docker/Dockerfile',
        line: 6,
        written: 'docker.io/library/python:3.13.1-slim@sha256:01234567…',
        version: '3.13.1',
        exactness: 'exact',
      },
    ]);
  });

  it('places a version from a build argument on the ARG line', () => {
    const text =
      'ARG PHP_VERSION=8.3.35\nARG REGISTRY=docker.io\nFROM ${REGISTRY}/php:${PHP_VERSION}-cli\n';
    expect(dockerfileDeclarations('Dockerfile', text)).toEqual([
      {
        runtime: 'php',
        file: 'Dockerfile',
        line: 1,
        written: 'docker.io/php:8.3.35-cli',
        version: '8.3.35',
        exactness: 'exact',
      },
    ]);
  });

  it('floats an image with no tag, a digest alone or an unset argument', () => {
    const text = 'ARG V\nFROM golang\nFROM rust@sha256:abc\nFROM ruby:${V}-slim\nFROM ${BASE}\n';
    expect(dockerfileDeclarations('Dockerfile', text)).toEqual([
      { runtime: 'go', file: 'Dockerfile', line: 2, written: 'golang', exactness: 'floating' },
      {
        runtime: 'rust',
        file: 'Dockerfile',
        line: 3,
        written: 'rust@sha256:abc…',
        exactness: 'floating',
      },
      {
        runtime: 'ruby',
        file: 'Dockerfile',
        line: 4,
        written: 'ruby:${V}-slim',
        exactness: 'floating',
      },
    ]);
  });

  it('spans a FROM written over several lines', () => {
    const [first] = dockerfileDeclarations('Dockerfile', 'FROM \\\n  denoland/deno:alpine-2.1.4\n');
    expect(first).toMatchObject({ runtime: 'deno', line: 1, endLine: 2, version: '2.1.4' });
  });
});

describe('which files are Dockerfiles', () => {
  it('reads the container files Docker and Podman name, in their case', () => {
    const named = ['dockerfile', 'ops/Containerfile.dev', 'api.Containerfile', 'web.dockerfile'];
    expect(named.filter((path) => !isDeclaringFile(path))).toEqual([]);
  });

  it('never reads a source file named after one', () => {
    const files = new Map([
      ['src/checks/runtime/dockerfile.ts', "const text = 'FROM php:5.6.0';\n"],
      ['src/checks/runtime/dockerfile.test.ts', 'FROM node:0.10.0\n'],
      ['Containerfile', 'FROM php:8.4.26-fpm\n'],
    ]);
    expect([...files.keys()].map((path) => isDeclaringFile(path))).toEqual([false, false, true]);
    expect(declaredRuntimes(files).map((d) => `${d.file}:${d.runtime}`)).toEqual([
      'Containerfile:php',
    ]);
  });
});
