import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const bundle = (await build({ entryPoints: ['src/content.js'], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'chrome116' })).outputFiles[0].text;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture() {
  const dom = new JSDOM('<!doctype html><html><head></head><body><p>One sentence here. Another one here.</p></body></html>', {
    url: 'https://example.com/article', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const listeners = new Set();
  const messages = [];
  window.structuredClone = structuredClone;
  window.CSS = { highlights: new Map() };
  window.Highlight = class { constructor(...ranges) { this.ranges = ranges; } };
  // jsdom has no layout for text ranges.
  window.Range.prototype.getBoundingClientRect = () => ({ top: 10, bottom: 30, left: 10, right: 200, width: 190, height: 20 });
  window.Range.prototype.getClientRects = () => [window.Range.prototype.getBoundingClientRect()];
  const attachShadow = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function (options) { return attachShadow.call(this, { ...options, mode: 'open' }); };
  window.chrome = {
    runtime: {
      onMessage: { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener) },
      sendMessage: async (message) => { messages.push(message); return { ok: true }; },
    },
    storage: {
      local: { get: async () => ({ settings: { engine: 'openai' } }), set: async () => {} },
      onChanged: { addListener() {} },
    },
  };
  window.eval(bundle);
  const message = (value) => { for (const listener of listeners) listener(value, {}, () => {}); };
  const root = () => window.document.getElementById('ai-reader-host').shadowRoot;
  return { dom, window, messages, message, root };
}

test('clicking an error opens details with clickable links and the raw response', async () => {
  const context = fixture();
  try {
    context.message({ type: 'control', action: 'toggle' });
    await wait(50);
    const spoken = context.messages.find((m) => m.type === 'speak');
    const text = 'OpenAI 429: You exceeded your current quota. Read the docs: https://platform.openai.com/docs/guides/error-codes. <b>not html</b>';
    context.message({ type: 'tts-event', event: 'error', seq: spoken.seq, message: text, detail: '{\n  "error": { "code": "insufficient_quota" }\n}' });
    await wait(50);
    const root = context.root();
    const info = root.querySelector('.info');
    assert.ok(info.classList.contains('error'));
    assert.equal(info.getAttribute('role'), 'button');
    assert.equal(info.tabIndex, 0);
    assert.equal(root.querySelector('.details').hidden, true);

    info.dispatchEvent(new context.window.MouseEvent('click', { bubbles: true }));
    const details = root.querySelector('.details');
    assert.equal(details.hidden, false);
    const message = root.querySelector('.details-message');
    assert.equal(message.textContent, text, 'full, untruncated message');
    const links = message.querySelectorAll('a');
    assert.equal(links.length, 1);
    assert.equal(links[0].href, 'https://platform.openai.com/docs/guides/error-codes', 'trailing full stop is not part of the link');
    assert.equal(links[0].target, '_blank');
    assert.equal(links[0].rel, 'noopener noreferrer');
    assert.equal(message.querySelector('b'), null, 'server text is never parsed as HTML');
    assert.equal(root.querySelector('.details-raw').hidden, false);
    assert.match(root.querySelector('.details-raw pre').textContent, /insufficient_quota/);

    details.dispatchEvent(new context.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(details.hidden, true, 'Esc closes');

    info.dispatchEvent(new context.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(details.hidden, false, 'Enter opens');
    context.window.document.body.dispatchEvent(new context.window.MouseEvent('pointerdown', { bubbles: true }));
    assert.equal(details.hidden, true, 'clicking outside closes');
  } finally {
    context.message({ type: 'control', action: 'stop' });
    context.dom.window.close();
  }
});

test('non-error status text is not clickable and has no details', async () => {
  const context = fixture();
  try {
    context.message({ type: 'control', action: 'toggle' });
    await wait(400);
    const info = context.root().querySelector('.info');
    assert.equal(info.classList.contains('error'), false);
    assert.equal(info.getAttribute('role'), null);
    info.dispatchEvent(new context.window.MouseEvent('click', { bubbles: true }));
    assert.equal(context.root().querySelector('.details').hidden, true);
  } finally {
    context.message({ type: 'control', action: 'stop' });
    context.dom.window.close();
  }
});
