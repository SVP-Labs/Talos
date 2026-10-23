import { describe, expect, it } from 'vitest';
import { commentsIn } from './index.js';

const texts = (file: string, source: string): string[] =>
  commentsIn(file, source).map((comment) => comment.text);

describe('PHP here-documents', () => {
  it('end at their label alone, not at a longer name that starts with it', () => {
    const source = [
      '<?php',
      '$a = <<<"END"',
      'ENDS # no',
      '  END_1 # no',
      '  END; # one',
      '$b = <<<EOT',
      '# no, and never closed',
    ].join('\n');
    expect(texts('a.php', source)).toEqual(['one']);
  });

  it('end at a label on a line of its own after a carriage return', () => {
    expect(texts('a.php', '<?php\r\n$a = <<<EOT\r\n# no\r\nEOT;\r\n// two')).toEqual(['two']);
  });
});
