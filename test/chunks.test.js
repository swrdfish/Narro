import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { chunkBounds, chunkEnd, chunkText, sentenceAtFraction, sentenceEndFraction, startsNewBlock, CHUNK_MAX_SENTENCES } from '../src/chunks.js';

const s = (...texts) => texts.map((text) => ({ text }));

test('chunks group up to the sentence limit and never split a sentence', () => {
  const sentences = s('One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Six.');
  assert.equal(chunkEnd(sentences, 0), CHUNK_MAX_SENTENCES - 1);
  assert.equal(chunkEnd(sentences, 4), 5, 'stops at the end of the list');
  assert.equal(chunkText(sentences, 0, 2), 'One. Two. Three.');
});

test('chunks respect the character limit, but always include at least one sentence', () => {
  const long = 'x'.repeat(300) + '.';
  assert.equal(chunkEnd(s(long, long, 'Short.'), 0), 0);
  assert.equal(chunkEnd(s('x'.repeat(900) + '.', 'Next.'), 0), 0);
});

test('the first chunk after starting or jumping is one sentence; single mode is always one', () => {
  const sentences = s('One.', 'Two.', 'Three.');
  assert.equal(chunkEnd(sentences, 0, { first: true }), 0);
  assert.equal(chunkEnd(sentences, 1, { single: true }), 1);
});

test('a sentence is always in the same chunk, wherever reading started', () => {
  const sentences = s('One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Six.', 'Seven.');
  assert.deepEqual(chunkBounds(sentences, 2), [0, 3]);
  assert.deepEqual(chunkBounds(sentences, 5), [4, 6]);
  // After a jump to Two (spoken alone), the next chunk ends where the regular one does, so the
  // clips from then on are the cached ones.
  assert.equal(chunkEnd(sentences, 2), 3);
  assert.equal(chunkEnd(sentences, 4), 6);
});

test('progress through a chunk maps to the sentence being spoken, by character share', () => {
  const sentences = s('Short.', 'A much longer second sentence here.', 'End.');
  assert.equal(sentenceAtFraction(sentences, 0, 2, 0), 0);
  assert.equal(sentenceAtFraction(sentences, 0, 2, 0.1), 0);
  assert.equal(sentenceAtFraction(sentences, 0, 2, 0.5), 1);
  assert.equal(sentenceAtFraction(sentences, 0, 2, 0.97), 2);
  assert.equal(sentenceAtFraction(sentences, 0, 2, 1), 2);
});

// --- In the page: OpenAI settings, a web article ---

const bundle = (await build({ entryPoints: ['src/content.js'], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'chrome116' })).outputFiles[0].text;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// `cached`: clip texts the offscreen document reports as cached.
function fixture(engine = 'openai', { cached = [] } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><p>Boats left early. Gulls stayed behind. Wind rose by noon. Rain came later.</p></body></html>', {
    url: 'https://example.com/article', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const listeners = new Set();
  const messages = [];
  window.structuredClone = structuredClone;
  window.CSS = { highlights: new Map() };
  window.Highlight = class { constructor(...ranges) { this.ranges = ranges; } };
  window.Range.prototype.getBoundingClientRect = () => ({ top: 10, bottom: 30, left: 10, right: 200, width: 190, height: 20 });
  window.Range.prototype.getClientRects = () => [window.Range.prototype.getBoundingClientRect()];
  const attachShadow = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function (options) { return attachShadow.call(this, { ...options, mode: 'open' }); };
  window.chrome = {
    runtime: {
      onMessage: { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener) },
      sendMessage: async (message) => {
        messages.push(message);
        return message.type === 'cached' ? { index: message.texts.findIndex((text) => cached.includes(text)) } : { ok: true };
      },
    },
    storage: { local: { get: async () => ({ settings: { engine } }), set: async () => {} }, onChanged: { addListener() {} } },
  };
  window.eval(bundle);
  const message = (value) => { for (const listener of listeners) listener(value, {}, () => {}); };
  const speaks = () => messages.filter((m) => m.type === 'speak');
  const pos = () => window.document.getElementById('ai-reader-host').shadowRoot.querySelector('.pos').textContent;
  const highlighted = () => window.CSS.highlights.get('ai-reader-sentence')?.ranges[0].toString();
  return { dom, window, message, speaks, pos, highlighted };
}

test('OpenAI: one sentence to start, then the rest in one request, with the highlight following progress', async () => {
  const context = fixture();
  try {
    context.message({ type: 'control', action: 'toggle' });
    await wait(50);
    const first = context.speaks().at(-1);
    assert.equal(first.text, 'Boats left early.');
    assert.deepEqual(Array.from(first.prefetch), ['Gulls stayed behind. Wind rose by noon. Rain came later.']);

    context.message({ type: 'tts-event', event: 'started', seq: first.seq });
    context.message({ type: 'tts-event', event: 'ended', seq: first.seq });
    await wait(20);
    const chunk = context.speaks().at(-1);
    assert.equal(chunk.text, 'Gulls stayed behind. Wind rose by noon. Rain came later.', 'matches the prefetched text, so it is cached');
    assert.equal(context.pos(), '2 / 4');
    assert.equal(context.highlighted(), 'Gulls stayed behind.');

    context.message({ type: 'tts-event', event: 'started', seq: chunk.seq });
    context.message({ type: 'tts-event', event: 'progress', seq: chunk.seq, time: 5, duration: 10 });
    assert.equal(context.pos(), '3 / 4');
    assert.equal(context.highlighted(), 'Wind rose by noon.');
    context.message({ type: 'tts-event', event: 'progress', seq: chunk.seq, time: 9.5, duration: 10 });
    assert.equal(context.pos(), '4 / 4');
    assert.equal(context.highlighted(), 'Rain came later.');

    // Previous restarts one sentence back, as its own quick request.
    context.message({ type: 'control', action: 'prev' });
    await wait(20);
    assert.equal(context.speaks().at(-1).text, 'Wind rose by noon.');
  } finally {
    context.message({ type: 'control', action: 'stop' });
    context.dom.window.close();
  }
});

test('going back into a cached clip plays it from that sentence instead of synthesizing again', async () => {
  const rest = 'Gulls stayed behind. Wind rose by noon. Rain came later.';
  const context = fixture('openai', { cached: [rest] });
  try {
    context.message({ type: 'control', action: 'toggle' });
    await wait(50);
    context.message({ type: 'tts-event', event: 'ended', seq: context.speaks().at(-1).seq });
    await wait(20);
    const chunk = context.speaks().at(-1);
    context.message({ type: 'tts-event', event: 'started', seq: chunk.seq });
    context.message({ type: 'tts-event', event: 'progress', seq: chunk.seq, time: 9.5, duration: 10 });

    context.message({ type: 'control', action: 'prev' });
    await wait(20);
    const back = context.speaks().at(-1);
    assert.equal(back.text, rest, 'the cached clip');
    const sentences = s('Boats left early.', 'Gulls stayed behind.', 'Wind rose by noon.', 'Rain came later.');
    assert.equal(back.startAt, sentenceEndFraction(sentences, 1, 3, 1), 'starts where Wind rose by noon. does');
    assert.equal(context.highlighted(), 'Wind rose by noon.');

    // Not cached: the sentence alone, for a quick start.
    context.message({ type: 'control', action: 'prev' });
    await wait(20);
    context.message({ type: 'control', action: 'prev' });
    await wait(20);
    assert.equal(context.speaks().at(-1).text, 'Boats left early.');
    assert.equal(context.speaks().at(-1).startAt, 0);
  } finally {
    context.message({ type: 'control', action: 'stop' });
    context.dom.window.close();
  }
});

test('system voices keep one sentence per request', async () => {
  const context = fixture('system');
  try {
    context.message({ type: 'control', action: 'toggle' });
    await wait(50);
    const first = context.speaks().at(-1);
    assert.equal(first.text, 'Boats left early.');
    context.message({ type: 'tts-event', event: 'ended', seq: first.seq });
    await wait(20);
    assert.equal(context.speaks().at(-1).text, 'Gulls stayed behind.');
  } finally {
    context.message({ type: 'control', action: 'stop' });
    context.dom.window.close();
  }
});

test('chunks stop at a block change, so headings and paragraphs are separate clips', () => {
  const s = [
    { text: 'A heading', blockIndex: 0 },
    { text: 'First sentence.', blockIndex: 1 },
    { text: 'Second sentence.', blockIndex: 1 },
    { text: 'Next paragraph.', blockIndex: 2 },
  ];
  assert.equal(chunkEnd(s, 0), 0);
  assert.equal(chunkEnd(s, 1), 2);
  assert.equal(startsNewBlock(s, 1), true);
  assert.equal(startsNewBlock(s, 2), false);
  assert.equal(startsNewBlock(s, 3), true);
  assert.equal(startsNewBlock(s, 0), false);
});
