import { test } from 'node:test';
import assert from 'node:assert/strict';
import { md } from '../public/js/lib/md.js';

test('headings are levels 2 to 4', () => {
  assert.equal(md('# Top'), '<h2>Top</h2>');
  assert.equal(md('## Two'), '<h2>Two</h2>');
  assert.equal(md('#### Four'), '<h4>Four</h4>');
  assert.equal(md('#nospace'), '<p>#nospace</p>');
  assert.equal(md('##### five'), '<p>##### five</p>');
});

test('paragraphs join lines and stop at blocks', () => {
  assert.equal(md('one\ntwo\n\nthree'), '<p>one two</p>\n<p>three</p>');
  assert.equal(md('text\n---'), '<p>text</p>\n<hr>');
});

test('inline markup: code, bold, emphasis, escapes', () => {
  assert.equal(md('`a*b*` **bold** *em* _em2_ snake_case_name'), '<p><code>a*b*</code> <strong>bold</strong> <em>em</em> <em>em2</em> snake_case_name</p>');
  assert.equal(md(String.raw`\*literal\*`), '<p>*literal*</p>');
});

test('lists: nesting, ordered, continuation across blank lines', () => {
  assert.equal(md('- a\n- b\n  - c\n- d'), '<ul><li>a</li><li>b<ul><li>c</li></ul></li><li>d</li></ul>');
  assert.equal(md('1. one\n2) two'), '<ol><li>one</li><li>two</li></ol>');
  assert.equal(md('- a\n\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(md('- a\n\n1. x'), '<ul><li>a</li></ul>\n<ol><li>x</li></ol>');
  assert.equal(md('- a\nlazy line'), '<ul><li>a lazy line</li></ul>');
  assert.equal(md('-   '), '<ul><li></li></ul>');
});

test('tables with and without a header row', () => {
  assert.equal(md('| a | b |\n|---|:-:|\n| 1 | 2 |'),
    '<div class="tw"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>');
  assert.equal(md('| | |\n|--|--|\n|q|w|'), '<div class="tw"><table><tbody><tr><td>q</td><td>w</td></tr></tbody></table></div>');
  assert.equal(md('| not a table'), '<p>| not a table</p>');
});

test('blockquotes nest block content', () => {
  assert.equal(md('> **Note**\n> - x'), '<blockquote><p><strong>Note</strong></p>\n<ul><li>x</li></ul></blockquote>');
});

test('HTML in the source is escaped', () => {
  const html = md('<img src=x onerror=alert(1)> & "q"');
  assert.equal(html, '<p>&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot;</p>');
});

test('links are emitted only for http(s) and in-app routes', () => {
  assert.equal(md('[site](https://example.org/a(b)c)'), '<p><a href="https://example.org/a(b)c" target="_blank" rel="noopener noreferrer">site</a></p>');
  assert.equal(md('[entry](#/manual/water)'), '<p><a href="#/manual/water">entry</a></p>');
  assert.equal(md('[x](javascript:alert(1))'), '<p>x</p>');
  assert.equal(md('[x](data:text/html,hi)'), '<p>x</p>');
});

test('figures need an image base and a plain img/ file name', () => {
  assert.equal(md('![A fig](img/fig01.png)'), '');
  assert.equal(md('![A *fig*](img/fig01.png)', { imgBase: '/content/c/' }),
    '<figure><div class="fig"><img src="/content/c/img/fig01.png" alt="A *fig*" loading="lazy"></div><figcaption>A <em>fig</em></figcaption></figure>');
  assert.equal(md('![x](img/../../etc.png)', { imgBase: '/c/' }), '');
  assert.equal(md('![x](https://evil.example/a.png)', { imgBase: '/c/' }), '');
});

test('text cannot forge the internal placeholders', () => {
  const html = md('[a](https://x.org) 0 \u00000\u0000');
  assert.ok(!html.includes(''));
  assert.equal(html.match(/<a /g).length, 1);
});

test('pathological input renders in linear time (no regex backtracking blow-up)', () => {
  const inputs = [
    '['.repeat(50_000),
    `[${'a'.repeat(50_000)}`,
    `- ${' '.repeat(50_000)}x`,
    `#${' '.repeat(50_000)}x`,
    `|${' |'.repeat(25_000)}\n|${' -|'.repeat(25_000)}x`,
    '*a'.repeat(20_000),
  ];
  for (const s of inputs) {
    const t0 = performance.now();
    md(s);
    assert.ok(performance.now() - t0 < 1000, `slow on input starting ${JSON.stringify(s.slice(0, 12))}`);
  }
});
