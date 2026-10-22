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

test('sentenceAt finds the sentence containing a point', () => {
  const root = page('<p>First sentence. Second sentence.</p>');
  const s = buildSentences(root);
  const textNode = root.querySelector('p').firstChild;
  assert.equal(sentenceAt(s, textNode, 3), 0);
  assert.equal(sentenceAt(s, textNode, 20), 1);
});
