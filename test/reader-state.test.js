import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { nextReaderState, badgeFor, PLAYING_BADGE } from '../src/reader-state.js';

test('a tab reading sets the state; stopping clears it only for that tab', () => {
  let state = nextReaderState(null, { tabId: 1, status: 'loading', title: 'Article' });
  assert.deepEqual(state, { tabId: 1, status: 'loading', title: 'Article' });
  state = nextReaderState(state, { tabId: 1, status: 'playing' });
  assert.deepEqual(state, { tabId: 1, status: 'playing', title: 'Article' }, 'keeps the title');
  assert.equal(nextReaderState(state, { tabId: 2, status: 'idle' }), state, 'another tab stopping changes nothing');
  assert.equal(nextReaderState(state, { tabId: 1, status: 'idle' }), null);
  assert.deepEqual(nextReaderState(state, { tabId: 3, status: 'playing', title: 'Other' }), { tabId: 3, status: 'playing', title: 'Other' }, 'a new tab takes over');
});

test('the badge shows a play symbol while playing or starting, and is empty otherwise', () => {
  assert.equal(PLAYING_BADGE, '\u25B6\uFE0E', 'text-style triangle, not an emoji');
  const playing = { text: PLAYING_BADGE, color: '#e5484d', textColor: '#ffffff' };
  assert.deepEqual(badgeFor({ status: 'playing' }), playing);
  assert.deepEqual(badgeFor({ status: 'loading' }), playing);
  assert.equal(badgeFor({ status: 'paused' }).text, '');
  assert.equal(badgeFor(null).text, '');
});

// --- In the page: status reports for the background ---

const bundle = (await build({ entryPoints: ['src/content.js'], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'chrome116' })).outputFiles[0].text;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the page reports starting, reading, paused and stopped, without repeats', async () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body><p>Boats left early. Gulls stayed behind.</p></body></html>', { url: 'https://example.com/a', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const listeners = new Set();
  const messages = [];
  window.structuredClone = structuredClone;
  window.CSS = { highlights: new Map() };
  window.Highlight = class { constructor(...ranges) { this.ranges = ranges; } };
  window.Range.prototype.getBoundingClientRect = () => ({ top: 10, bottom: 30, left: 10, right: 200, width: 190, height: 20 });
  window.Range.prototype.getClientRects = () => [window.Range.prototype.getBoundingClientRect()];
  window.chrome = {
    runtime: {
      id: 'narro',
      onMessage: { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener) },
      sendMessage: async (message) => { messages.push(message); return { ok: true, resumed: true }; },
    },
    storage: { local: { get: async (key) => (key === 'settings' ? { settings: { engine: 'system' } } : {}), set: async () => {} }, onChanged: { addListener() {} } },
  };
  window.eval(bundle);
  const message = (value) => { for (const listener of listeners) listener(value, {}, () => {}); };
  const reported = () => messages.filter((m) => m.type === 'reader-state').map((m) => m.status);
  try {
    message({ type: 'control', action: 'toggle' });
    await wait(50);
    const spoken = messages.find((m) => m.type === 'speak');
    message({ type: 'tts-event', event: 'started', seq: spoken.seq });
    message({ type: 'control', action: 'toggle' }); // pause
    await wait(10);
    message({ type: 'control', action: 'stop' });
    await wait(10);
    assert.deepEqual(reported(), ['loading', 'playing', 'paused', 'idle']);
  } finally {
    dom.window.close();
  }
});
