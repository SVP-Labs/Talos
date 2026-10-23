import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { absolute, componentDir, fromTool, isTestPath, phpFiles } from './paths.js';
import { type Bound, failed, jsonFrom, runPhp, vendorFile } from './run.js';
import { EngineError } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';

const MAX_DEPTH = 3;
const MAX_FILE_LINES = 400;

/**
 * Reads each file with PHP-Parser from the component's vendor (the dev tools Talos pins bring it)
 * and prints, per file: its lines of code, the blocks nested deeper than allowed, and the span of
 * every function and class. Only PHP-Parser's own classes are loaded, never the project's code.
 */
const SCRIPT = String.raw`<?php

declare(strict_types=1);

$input = json_decode((string) stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR);
$lib = $input['vendor'] . '/nikic/php-parser/lib/';
spl_autoload_register(static function (string $class) use ($lib): void {
    $path = $lib . str_replace('\\', '/', $class) . '.php';
    if (str_starts_with($class, 'PhpParser\\') && is_file($path)) {
        require $path;
    }
});

use PhpParser\Node;

final class TalosShape extends PhpParser\NodeVisitorAbstract
{
    private const BLOCKS = [Node\Stmt\If_::class, Node\Stmt\For_::class, Node\Stmt\Foreach_::class,
        Node\Stmt\While_::class, Node\Stmt\Do_::class, Node\Stmt\Switch_::class, Node\Stmt\TryCatch::class];
    private const FUNCTIONS = [Node\Stmt\Function_::class, Node\Stmt\ClassMethod::class,
        Node\Expr\Closure::class, Node\Expr\ArrowFunction::class];
    private const CLASSES = [Node\Stmt\Class_::class, Node\Stmt\Trait_::class, Node\Stmt\Enum_::class,
        Node\Stmt\Interface_::class];

    private array $depths = [0];
    public array $deep = [];
    public array $spans = [];

    public function __construct(private readonly int $maxDepth)
    {
    }

    private static function isA(Node $node, array $classes): bool
    {
        foreach ($classes as $class) {
            if ($node instanceof $class) {
                return true;
            }
        }
        return false;
    }

    private static function nests(Node $node): bool
    {
        $parent = $node->getAttribute('parent');
        $elseIf = $node instanceof Node\Stmt\If_ && $parent instanceof Node\Stmt\Else_
            && count($parent->stmts) === 1;
        return self::isA($node, self::BLOCKS) && !$elseIf;
    }

    public function enterNode(Node $node): null
    {
        $span = ['line' => $node->getStartLine(), 'endLine' => $node->getEndLine()];
        if (self::isA($node, self::CLASSES)) {
            $this->spans[] = $span + ['kind' => 'class'];
        } elseif (self::isA($node, self::FUNCTIONS)) {
            $this->spans[] = $span + ['kind' => 'function'];
            $this->depths[] = 0;
        } elseif (self::nests($node)) {
            $depth = array_pop($this->depths) + 1;
            $this->depths[] = $depth;
            if ($depth === $this->maxDepth + 1) {
                $this->deep[] = $span;
            }
        }
        return null;
    }

    public function leaveNode(Node $node): null
    {
        if (self::isA($node, self::FUNCTIONS)) {
            array_pop($this->depths);
        } elseif (self::nests($node)) {
            $this->depths[] = array_pop($this->depths) - 1;
        }
        return null;
    }
}

function codeLines(string $code): array
{
    $lines = [];
    $line = 1;
    foreach (token_get_all($code) as $token) {
        $text = is_array($token) ? $token[1] : $token;
        $breaks = substr_count($text, "\n");
        $ignored = is_array($token) && in_array($token[0], [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true);
        if (!$ignored) {
            $end = $breaks > 0 && str_ends_with($text, "\n") ? $line + $breaks - 1 : $line + $breaks;
            for ($at = $line; $at <= $end; $at++) {
                $lines[$at] = true;
            }
        }
        $line += $breaks;
    }
    ksort($lines);
    return array_keys($lines);
}

$parser = (new PhpParser\ParserFactory())->createForHostVersion();
$files = [];
foreach ($input['files'] as $file) {
    $code = (string) file_get_contents($file);
    try {
        $ast = $parser->parse($code) ?? [];
    } catch (PhpParser\Error $error) {
        $files[] = ['file' => $file, 'error' => $error->getRawMessage()];
        continue;
    }
    (new PhpParser\NodeTraverser(new PhpParser\NodeVisitor\ParentConnectingVisitor()))->traverse($ast);
    $shape = new TalosShape($input['maxDepth']);
    (new PhpParser\NodeTraverser($shape))->traverse($ast);
    $lines = codeLines($code);
    $files[] = [
        'file' => $file,
        'lines' => count($lines),
        'overFrom' => $lines[$input['maxLines']] ?? null,
        'lastLine' => substr_count($code, "\n") + (str_ends_with($code, "\n") ? 0 : 1),
        'deep' => $shape->deep,
        'spans' => $shape->spans,
    ];
}
echo json_encode(['format' => 'talos-php-shape/1', 'files' => $files], JSON_THROW_ON_ERROR);
`;

const span = z.object({ line: z.number().int(), endLine: z.number().int() });

const fileShape = z.union([
  z.object({
    file: z.string(),
    lines: z.number().int(),
    overFrom: z.number().int().nullable(),
    lastLine: z.number().int(),
    deep: z.array(span),
    spans: z.array(span.extend({ kind: z.enum(['class', 'function']) })),
  }),
  z.object({ file: z.string(), error: z.string() }),
]);

const shapeReport = z.object({ format: z.literal('talos-php-shape/1'), files: z.array(fileShape) });

export type FileShape = z.infer<typeof fileShape>;
export type Span = z.infer<typeof span> & { readonly kind: 'class' | 'function' };

export function parseShapes(json: unknown): FileShape[] {
  const parsed = shapeReport.safeParse(json);
  if (!parsed.success) throw new EngineError('the PHP shape script printed an unknown shape');
  return parsed.data.files;
}

/**
 * Nesting deeper than 3 (each block nested one level too deep), and files over 400 lines of
 * code, test files exempt from the size limit. `file` in each shape is repository-relative.
 */
export function shapeFindings(shapes: readonly FileShape[]): Finding[] {
  return shapes.flatMap((shape): Finding[] => {
    if ('error' in shape) return [];
    const deep = shape.deep.map((block): Finding => ({
      rule: 'talos/max-depth',
      message: `This block is nested ${MAX_DEPTH + 1} deep; the most allowed is ${MAX_DEPTH}.`,
      location: { file: shape.file, line: block.line, endLine: block.endLine },
    }));
    if (shape.overFrom === null || isTestPath(shape.file)) return deep;
    const size: Finding = {
      rule: 'talos/max-lines',
      message: `This file has ${shape.lines} lines of code; the most allowed is ${MAX_FILE_LINES}.`,
      location: { file: shape.file, line: shape.overFrom, endLine: shape.lastLine },
    };
    return [...deep, size];
  });
}

/** A complexity finding widened to the function or class it is about. */
export function widen(finding: Finding, spans: readonly Span[]): Finding {
  const location = finding.location;
  if (location === undefined) return finding;
  const kind = finding.rule.endsWith('classLike') ? 'class' : 'function';
  const found = spans.find((s) => s.kind === kind && s.line === location.line);
  return found === undefined
    ? finding
    : { ...finding, location: { ...location, endLine: found.endLine } };
}

/** Each checked file's shape, keyed by its repository-relative path; shared within a run. */
export async function shapes(ctx: Bound): Promise<FileShape[]> {
  return ctx.memo(`php/shape:${ctx.component.root}`, async () => {
    await vendorFile(ctx, 'nikic/php-parser/lib/PhpParser/ParserFactory.php', 'nikic/php-parser');
    const script = join(ctx.scratch, 'talos_shape.php');
    await writeFile(script, SCRIPT);
    const input = JSON.stringify({
      vendor: join(componentDir(ctx), 'vendor'),
      files: phpFiles(ctx).map((file) => absolute(ctx, file)),
      maxDepth: MAX_DEPTH,
      maxLines: MAX_FILE_LINES,
    });
    const result = await runPhp(ctx, [script], { input });
    if (result.code !== 0) throw failed('the PHP shape script', result);
    return parseShapes(jsonFrom(result.stdout, 'the PHP shape script')).map((shape) => ({
      ...shape,
      file: fromTool(ctx, shape.file),
    }));
  });
}
