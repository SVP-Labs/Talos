import { describe, expect, it } from 'vitest';
import { escapeXml, unescapeXml } from './xml.js';
import { parseXml } from '../quality/xml.js';

/** What Talos's own reader takes back out of an attribute and an element holding `written`. */
function readBack(written: string): { readonly attribute: unknown; readonly text: unknown } {
  const document = `<r><e a="${written}" b='${written}'>${written}</e></r>`;
  const parsed = parseXml(document, 'test', []) as {
    r: { e: { '@_a': unknown; '@_b': unknown; '#text': unknown } };
  };
  expect(parsed.r.e['@_b']).toBe(parsed.r.e['@_a']);
  return { attribute: parsed.r.e['@_a'], text: parsed.r.e['#text'] };
}

describe('escapeXml', () => {
  it('writes the five markup characters as the predefined entities', () => {
    expect(escapeXml(`<a href="x">Tom & Jerry's</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&apos;s&lt;/a&gt;',
    );
  });

  it('escapes each character once, entities in the text included', () => {
    expect(escapeXml('&amp; &lt; &#38;')).toBe('&amp;amp; &amp;lt; &amp;#38;');
    expect(escapeXml(']]>')).toBe(']]&gt;');
  });

  it('keeps tab and line breaks as references, which attributes would otherwise lose', () => {
    expect(escapeXml('a\tb\nc\r\nd')).toBe('a&#9;b&#10;c&#13;&#10;d');
  });

  it('replaces what XML 1.0 cannot hold, and keeps every other character', () => {
    expect(escapeXml('\u0000\u0008\u000B\u000C\u001B[31m red\u001F')).toBe('�����[31m red�');
    expect(escapeXml('lone \uD800 and \uDFFF, then ￾￿')).toBe('lone � and �, then ��');
    const kept = ' ~\u007F\u0085é퟿�\u{1F600}\u{10FFFF}';
    expect(escapeXml(kept)).toBe(kept);
    expect(escapeXml('')).toBe('');
  });

  it('reads back as the same text from an attribute in either quote and from an element', () => {
    const hostile = `a <b> & "c" 'd' ]]> &amp; \t tab\nline\r\nend   spaced`;
    expect(readBack(escapeXml(hostile))).toEqual({ attribute: hostile, text: hostile });
  });
});

describe('unescapeXml', () => {
  it('reads the predefined entities and character references back', () => {
    expect(unescapeXml('&lt;a&gt; &amp;amp; &quot;b&quot; &apos;c&apos;')).toBe(
      `<a> &amp; "b" 'c'`,
    );
    expect(unescapeXml('&#9;&#10;&#x41;&#x1F600;&#38;lt;')).toBe('\t\nA\u{1F600}&lt;');
  });

  it('leaves what only looks like a reference as it is', () => {
    const odd = '& &nbsp; &AMP; &#X41; &#xFFFFFF; &#; &amp';
    expect(unescapeXml(odd)).toBe(odd);
  });

  it('undoes escapeXml', () => {
    const text = `a <b> & "c" 'd' &amp; \t\r\n \u{1F600}`;
    expect(unescapeXml(escapeXml(text))).toBe(text);
  });
});
