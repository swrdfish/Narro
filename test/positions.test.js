import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { fingerprint, findPosition, pageKey, savePosition, loadPosition, clearPosition } from '../src/positions.js';

const s = (...texts) => texts.map((text) => ({ text }));
const memoryStorage = (initial = {}) => {
  const store = structuredClone(initial);
  return { store, get: async (key) => ({ [key]: store[key] }), set: async (values) => Object.assign(store, structuredClone(values)) };
};

test('fingerprints ignore case, spacing and punctuation, and differ for different sentences', () => {
  assert.equal(fingerprint('Boats left early.'), fingerprint('  boats LEFT early!'));
  assert.notEqual(fingerprint('Boats left early.'), fingerprint('Boats left late.'));
});

test('pages are keyed by address without the #fragment, and Kindle by book', () => {
  assert.equal(pageKey(new URL('https://example.com/a?id=1#part'), null), 'https://example.com/a?id=1');
  assert.equal(pageKey(new URL('https://read.amazon.in/?asin=B0X'), 'B0X'), 'kindle:B0X');
});

test('the saved sentence is found by fingerprint, nearest the saved index', () => {
  const sentences = s('Chorus.', 'Verse one.', 'Chorus.', 'Verse two.', 'Chorus.');
  const saved = { sentence: fingerprint('Chorus.'), index: 3 };
  assert.equal(findPosition(sentences, saved), 2);
  assert.equal(findPosition(sentences, { sentence: fingerprint('Gone.'), index: 1 }), -1);
  assert.equal(findPosition(sentences, { sentence: fingerprint('Gone.'), index: 1 }, { allowIndex: true }), 1, 'websites fall back to the index');
  assert.equal(findPosition(sentences, null), -1);
});

test('positions are saved, loaded, cleared and capped at 200 pages', async () => {
  const storage = memoryStorage();
  const sentences = s('One.', 'Two.', 'Three.');
  await savePosition(storage, 'page-a', sentences, 1);
  assert.deepEqual((({ sentence, index }) => ({ sentence, index }))(await loadPosition(storage, 'page-a')), { sentence: fingerprint('Two.'), index: 1 });
  assert.equal(JSON.stringify(storage.store).includes('Two'), false, 'sentence text is not stored');
  await clearPosition(storage, 'page-a');
  assert.equal(await loadPosition(storage, 'page-a'), null);
  for (let i = 0; i < 205; i++) await savePosition(storage, `page-${i}`, sentences, 0);
  assert.equal(Object.keys(storage.store.positions).length, 200);
});

// --- In the page: a web article ---

const bundle = (await build({ entryPoints: ['src/content.js'], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'chrome116' })).outputFiles[0].text;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function article(storage) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><p>Boats left early. Gulls stayed behind. Wind rose by noon. Rain came later.</p></body></html>', {
    url: 'https://example.com/article#intro', runScripts: 'outside-only', pretendToBeVisual: true,
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
      id: 'narro',
      onMessage: { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener) },
      sendMessage: async (message) => { messages.push(message); return { ok: true }; },
    },
    storage: { local: storage, onChanged: { addListener() {} } },
  };
  window.eval(bundle);
  const message = (value) => { for (const listener of listeners) listener(value, {}, () => {}); };
  const speaks = () => messages.filter((m) => m.type === 'speak');
  const info = () => window.document.getElementById('ai-reader-host').shadowRoot.querySelector('.info .text').textContent;
  return { dom, message, speaks, info };
}

test('reading resumes where it stopped on the page, and finishing clears it', async () => {
  const storage = memoryStorage({ settings: { engine: 'system' } });
  let page = article(storage);
  page.message({ type: 'control', action: 'toggle' });
  await wait(50);
  let spoken = page.speaks().at(-1);
  page.message({ type: 'tts-event', event: 'ended', seq: spoken.seq });
  await wait(20);
  spoken = page.speaks().at(-1);
  page.message({ type: 'tts-event', event: 'ended', seq: spoken.seq });
  await wait(20);
  assert.equal(page.speaks().at(-1).text, 'Wind rose by noon.');
  page.message({ type: 'control', action: 'stop' });
  page.dom.window.close();

  // Later: the same page (different #fragment) resumes at the saved sentence.
  page = article(storage);
  page.message({ type: 'control', action: 'toggle' });
  await wait(50);
  assert.equal(page.speaks().at(-1).text, 'Wind rose by noon.');
  await wait(400); // status text is coalesced and cross-faded
  assert.equal(page.info(), 'Resuming where you left off');

  // Read to the end: the saved position is cleared.
  for (let i = 0; i < 2; i++) {
    page.message({ type: 'tts-event', event: 'ended', seq: page.speaks().at(-1).seq });
    await wait(20);
  }
  assert.equal(storage.store.positions['https://example.com/article'], undefined);
  page.message({ type: 'control', action: 'stop' });
  page.dom.window.close();
});
