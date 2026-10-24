import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body></body>');
globalThis.Node = dom.window.Node;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.document = dom.window.document;
const { buildSentences, findContentRoot, isCompleteSentence, sentenceAt } = await import('../src/text.js');

function page(html) {
  document.body.innerHTML = html;
  return document.body;
}

const texts = (sentences) => sentences.map((s) => s.text);

test('splits paragraphs into sentences with ranges matching the text', () => {
  const root = page('<p>Hello <b>brave</b> new world. Second one here!</p><p>Third, in a new block?</p>');
  const s = buildSentences(root);
  assert.deepEqual(texts(s), ['Hello brave new world.', 'Second one here!', 'Third, in a new block?']);
  for (const x of s) assert.equal(x.range.toString().replace(/\s+/g, ' '), x.text);
});

test('does not split on abbreviations or initials', () => {
  const root = page('<p>Dr. Smith met J. R. R. Tolkien in St. Louis. They talked.</p>');
  assert.deepEqual(texts(buildSentences(root)), ['Dr. Smith met J. R. R. Tolkien in St. Louis.', 'They talked.']);
});

test('drops a trailing incomplete sentence', () => {
  const root = page('<p>One full sentence. Another full one. And this one is cut off at the</p>');
  assert.deepEqual(texts(buildSentences(root)), ['One full sentence.', 'Another full one.']);
});

test('drops trailing chrome after the cut-off sentence', () => {
  const root = page('<p>Complete sentence here. Then it breaks mid</p><div>Next chapter</div>');
  assert.deepEqual(texts(buildSentences(root)), ['Complete sentence here.']);
});

test('keeps the incomplete sentence when the option is off', () => {
  const root = page('<p>Complete. Incomplete tail</p>');
  assert.deepEqual(texts(buildSentences(root, { skipIncompleteLast: false })), ['Complete.', 'Incomplete tail']);
});

test('keeps closing quotes as complete', () => {
  assert.ok(isCompleteSentence('He said, “Go home.”'));
  assert.ok(isCompleteSentence('(Really?)'));
  assert.ok(!isCompleteSentence('and then she'));
});

test('never drops everything', () => {
  const root = page('<h1>Just a title</h1>');
  assert.deepEqual(texts(buildSentences(root)), ['Just a title']);
});

test('skips scripts, nav and hidden content', () => {
  const root = page('<nav>Home About</nav><p>Visible text.</p><script>var x = 1;</script><p hidden>Secret.</p><p aria-hidden="true">Also hidden.</p>');
  assert.deepEqual(texts(buildSentences(root)), ['Visible text.']);
});

test('text split around a nested block keeps reading order', () => {
  const root = page('<div>Intro text. <p>Inner para.</p> Outro text.</div>');
  assert.deepEqual(texts(buildSentences(root)), ['Intro text.', 'Inner para.', 'Outro text.']);
});

test('splits very long sentences at clause boundaries', () => {
  const clause = 'this clause goes on and on with many words in it';
  const long = Array.from({ length: 12 }, () => clause).join(', ') + '.';
  const s = buildSentences(page(`<p>${long}</p>`));
  assert.ok(s.length > 1);
  assert.ok(s.every((x) => x.text.length <= 350));
  assert.equal(s.map((x) => x.text).join(' '), long);
});

test('findContentRoot prefers the article over sidebars', () => {
  const para = '<p>' + 'Article body text that is long enough to count. '.repeat(4) + '</p>';
  page(`<div id="side"><p>short</p></div><article><h1>Title</h1>${para.repeat(5)}</article>`);
  assert.equal(findContentRoot(document).tagName, 'ARTICLE');
});

test('findContentRoot ignores a sidebar page tree and hidden text, and prefers <main>', () => {
  // Shaped like a Confluence page: a nested page tree in a complementary sidebar, a hidden dialog
  // full of text, and the article inside <main>.
  const title = (n) => `Child page number ${n} with a fairly long descriptive title`;
  const tree = '<ul>' + Array.from({ length: 6 }, (_, i) => `<li>${title(i)}<ul><li>${title(i + 10)}</li><li>${title(i + 20)}</li></ul></li>`).join('') + '</ul>';
  const hidden = '<div hidden>' + '<p>Keyboard shortcut help text that is long enough to be counted as a paragraph.</p>'.repeat(20) + '</div>';
  const article = '<p>' + 'The cluster runs three replicas behind the load balancer in each region. '.repeat(3) + '</p>';
  page(`<div role="complementary">${tree}</div>${hidden}<main id="content"><h1>Cluster</h1>${article.repeat(3)}</main>`);
  assert.equal(findContentRoot(document).id, 'content');
});

test('findContentRoot counts nested list text once', () => {
  // Without <main>: a deep nested list must not outscore a real article.
  const item = (text, children = '') => `<li>${text}${children}</li>`;
  const deep = '<ul id="tree">' + Array.from({ length: 5 }, () => item('A navigation entry with a long enough title here', '<ul>' + item('A nested navigation entry with a long title', '<ul>' + item('A deeper nested navigation entry title') + '</ul>') + '</ul>')).join('') + '</ul>';
  const article = '<p>' + 'Each paragraph of the article body is long enough to count here. '.repeat(2) + '</p>';
  page(`<div>${deep}</div><article id="story">${article.repeat(4)}</article>`);
  assert.equal(findContentRoot(document).id, 'story');
});

test('sentenceAt finds the sentence containing a point', () => {
  const root = page('<p>First sentence. Second sentence.</p>');
  const s = buildSentences(root);
  const textNode = root.querySelector('p').firstChild;
  assert.equal(sentenceAt(s, textNode, 3), 0);
  assert.equal(sentenceAt(s, textNode, 20), 1);
});

test('headings, paragraphs and list items are separate blocks, so the reader pauses between them', () => {
  const s = buildSentences(page('<h1>A title</h1><p>One sentence. Two sentence.</p><ul><li>An item.</li><li>Another item.</li></ul>'), { skipIncompleteLast: false });
  assert.deepEqual(texts(s), ['A title', 'One sentence.', 'Two sentence.', 'An item.', 'Another item.']);
  assert.deepEqual(s.map((x) => x.blockIndex), [0, 1, 1, 2, 3]);
});

test('a line break separates lines instead of joining their words', () => {
  const s = buildSentences(page('<p>First line<br>Second line<br><br>Third line.</p>'), { skipIncompleteLast: false });
  assert.deepEqual(texts(s), ['First line', 'Second line', 'Third line.']);
  assert.equal(new Set(s.map((x) => x.blockIndex)).size, 3, 'each line is its own block');
  for (const x of s) assert.equal(x.range.toString(), x.text);
});

test('reads text inside a display: contents wrapper, which checkVisibility() calls hidden', (t) => {
  // Like Chrome: an element with no box of its own, or display: none, is "not visible".
  const proto = dom.window.Element.prototype;
  proto.checkVisibility = function () {
    return !['contents', 'none'].includes(dom.window.getComputedStyle(this).display);
  };
  t.after(() => delete proto.checkVisibility);
  const s = buildSentences(page('<main><div style="display: contents"><p>Read me.</p></div><div style="display: none"><p>Not me.</p></div></main>'));
  assert.deepEqual(texts(s), ['Read me.']);
});
