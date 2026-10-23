import { describe, expect, it } from 'vitest';
import { commentsIn } from './index.js';

const texts = (file: string, source: string): string[] =>
  commentsIn(file, source).map((comment) => comment.text);

describe('shell here-documents', () => {
  it('skip every body opened on a line, each up to its own delimiter', () => {
    const source = ["cat <<A <<'B' # one", '# no', 'AX', 'A', '# no', 'B \t', 'echo # two'].join(
      '\n',
    );
    expect(texts('a.sh', source)).toEqual(['one', 'two']);
  });

  it('end at a delimiter after tabs, never after spaces', () => {
    const source = ['cat <<-EOF', '  EOF', '# no', '\t\tEOF', '# three'].join('\n');
    expect(texts('a.sh', source)).toEqual(['three']);
  });

  it('run to the end when the delimiter never comes', () => {
    expect(texts('a.sh', 'cat <<STOP\n# no\nSTOPS\n')).toEqual([]);
  });
});
