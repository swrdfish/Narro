import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const bundle = (await build({ entryPoints: ['src/content.js'], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'chrome116' })).outputFiles[0].text;
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

function fixture({ store = { settings: { engine: 'system' } } } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><img id="book" src="blob:https://read.amazon.in/first-page"></body></html>', {
    url: 'https://read.amazon.in/?asin=B0EXAMPLE1', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const messages = [];
  const listeners = new Set();
  let completeExtraction;
  window.structuredClone = structuredClone;
  window.CSS = { highlights: new Map() };
  window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,fixture';
  const attachShadow = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function (options) { return attachShadow.call(this, { ...options, mode: 'open' }); };
  const page = window.document.getElementById('book');
  Object.defineProperties(page, { complete: { value: true }, naturalWidth: { value: 800 }, naturalHeight: { value: 1000 } });
  page.getBoundingClientRect = () => ({ left: 50, top: 50, width: 400, height: 500 });
  window.chrome = {
    runtime: {
      id: 'narro',
      onMessage: { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener) },
      sendMessage: async (message) => {
        messages.push(message);
        if (message.type === 'kindle-extract') return new Promise((resolve) => { completeExtraction = resolve; });
        return { ok: true };
      },
    },
    storage: {
      local: { get: async (key) => ({ [key]: store[key] }), set: async (values) => Object.assign(store, values) },
      onChanged: { addListener() {} },
    },
  };
  window.eval(bundle);
  const message = (value) => { for (const listener of listeners) listener(value, {}, () => {}); };
  const defaultWords = [{ text: 'Hello.', box: { x0: 20, y0: 40, x1: 100, y1: 80 }, line: 0 }, { text: 'Goodbye.', box: { x0: 120, y0: 40, x1: 240, y1: 80 }, line: 0 }];
  const complete = (words = defaultWords) => completeExtraction({ pages: [{ source: 'ocr', width: 800, height: 1000, paragraphs: [{ words }] }] });
  // Lets a test hide or show the tab.
  let hidden = false;
  Object.defineProperty(window.document, 'hidden', { configurable: true, get: () => hidden });
  const setHidden = (value) => {
    hidden = value;
    window.document.dispatchEvent(new window.Event('visibilitychange'));
  };
  return { dom, window, page, messages, message, complete, store, setHidden };
}

test('Kindle playback uses extracted text, overlay highlights and the existing speech engine', async () => {
  const context = fixture();
  try {
    context.message({ type: 'control', action: 'toggle' });
    await flush();
    const extract = context.messages.filter((message) => message.type === 'kindle-extract');
    assert.equal(extract.length, 1);
    context.complete();
    await flush();
    const spoken = context.messages.find((message) => message.type === 'speak');
    assert.equal(spoken.text, 'Hello.');
    assert.deepEqual(Array.from(spoken.prefetch), ['Goodbye.']);
    const overlay = context.window.document.getElementById('ai-reader-kindle-overlay');
    assert.ok(overlay);
    const highlighted = overlay.shadowRoot.children[1].firstChild;
    assert.equal(highlighted.style.left, '60px');
    assert.equal(highlighted.style.top, '70px');
    context.message({ type: 'tts-event', event: 'started', seq: spoken.seq });
    await new Promise((resolve) => setTimeout(resolve, 400)); // status text is coalesced and cross-faded
    const player = context.window.document.getElementById('ai-reader-host');
    assert.equal(player.shadowRoot.querySelector('.info').textContent, 'Kindle: local OCR');
    context.message({ type: 'tts-event', event: 'ended', seq: spoken.seq });
    await flush();
    assert.equal(context.messages.filter((message) => message.type === 'speak').at(-1).text, 'Goodbye.');
  } finally {
    context.message({ type: 'control', action: 'stop' });
    context.dom.window.close();
  }
});

test('closing the player during OCR prevents late results from starting speech', async () => {
  const context = fixture();
  try {
    context.message({ type: 'control', action: 'toggle' });
    await flush();
    context.message({ type: 'control', action: 'stop' });
    context.complete();
    await flush();
    assert.equal(context.messages.some((message) => message.type === 'speak'), false);
    assert.equal(context.window.document.getElementById('ai-reader-host'), null);
    assert.equal(context.window.document.getElementById('ai-reader-kindle-overlay'), null);
  } finally { context.dom.window.close(); }
});

test('turning the Kindle page while reading stops the old page and reads the new one', async () => {
  const context = fixture();
  try {
    context.message({ type: 'control', action: 'toggle' });
    await flush();
    context.complete(line('Boats', 'left.', 'Gulls', 'stayed.'));
    await flush();
    const spoken = speaks(context).at(-1);
    context.message({ type: 'tts-event', event: 'started', seq: spoken.seq });
    context.page.src = 'blob:https://read.amazon.in/second-page'; // the user turns the page
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.ok(context.messages.some((message) => message.type === 'stop'), 'old page audio stopped');
    context.message({ type: 'tts-event', event: 'ended', seq: spoken.seq }); // late event from the old page
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(extracts(context).length, 2, 'new page recognized automatically');
    context.complete(line('Morning', 'came.', 'Rain', 'fell.'));
    await flush();
    assert.equal(speaks(context).at(-1).text, 'Morning came.');
    assert.equal(speaks(context).filter((message) => message.text === 'Gulls stayed.').length, 0, 'old page not continued');
  } finally {
    context.message({ type: 'control', action: 'stop' });
    context.dom.window.close();
  }
});

test('turning the page while paused does not start reading', async () => {
  const context = fixture();
  try {
    context.message({ type: 'control', action: 'toggle' });
    await flush();
    context.complete(line('Boats', 'left.', 'Gulls', 'stayed.'));
    await flush();
    context.message({ type: 'tts-event', event: 'started', seq: speaks(context).at(-1).seq });
    context.message({ type: 'control', action: 'toggle' }); // pause
    context.page.src = 'blob:https://read.amazon.in/second-page';
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(extracts(context).length, 1);
    const player = context.window.document.getElementById('ai-reader-host');
    assert.equal(player.shadowRoot.querySelector('.info').textContent, 'Kindle page changed — press Play to read it.');
  } finally {
    context.message({ type: 'control', action: 'stop' });
    context.dom.window.close();
  }
});

test('if the page changes again while it is being recognized, the latest page is read', async () => {
  const context = fixture();
  try {
    context.message({ type: 'control', action: 'toggle' });
    await flush();
    context.complete(line('Boats', 'left.', 'Gulls', 'stayed.'));
    await flush();
    context.message({ type: 'tts-event', event: 'started', seq: speaks(context).at(-1).seq });
    context.page.src = 'blob:https://read.amazon.in/second-page';
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(extracts(context).length, 2);
    context.page.src = 'blob:https://read.amazon.in/third-page'; // flipped again during recognition
    context.complete(line('Old', 'page.'));
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(extracts(context).length, 3, 'recognized the latest page instead of reporting an error');
    context.complete(line('Latest', 'page.'));
    await flush();
    assert.equal(speaks(context).at(-1).text, 'Latest page.');
    const info = context.window.document.getElementById('ai-reader-host').shadowRoot.querySelector('.info');
    assert.equal(info.classList.contains('error'), false);
  } finally {
    context.message({ type: 'control', action: 'stop' });
    context.dom.window.close();
  }
});

test('Kindle pick mode jumps using visual word boxes instead of DOM caret APIs', async () => {
  const context = fixture();
  try {
    context.message({ type: 'control', action: 'pick' });
    await flush();
    context.complete();
    await flush();
    assert.equal(context.messages.some((message) => message.type === 'speak'), false);
    const overlay = context.window.document.getElementById('ai-reader-kindle-overlay');
    assert.equal(overlay.style.pointerEvents, 'auto');
    const event = new context.window.MouseEvent('click', { clientX: 120, clientY: 75, bubbles: true, cancelable: true });
    overlay.dispatchEvent(event);
    await flush();
    assert.equal(event.defaultPrevented, true);
    assert.equal(context.messages.find((message) => message.type === 'speak').text, 'Goodbye.');
    assert.equal(overlay.style.pointerEvents, 'none');
  } finally {
    context.message({ type: 'control', action: 'stop' });
    context.dom.window.close();
  }
});

// One OCR line of words laid out left to right.
const line = (...texts) => {
  let x = 20;
  return texts.map((text) => {
    const word = { text, box: { x0: x, y0: 40, x1: x + text.length * 12, y1: 80 }, line: 0 };
    x = word.box.x1 + 10;
    return word;
  });
};
const speaks = (context) => context.messages.filter((message) => message.type === 'speak');
const extracts = (context) => context.messages.filter((message) => message.type === 'kindle-extract');

test('at the end of a Kindle page the reader turns the page and continues the cut-off sentence', async () => {
  const context = fixture();
  const next = context.window.document.createElement('button');
  next.id = 'kr-chevron-right';
  next.setAttribute('aria-label', 'Next page');
  let clicks = 0;
  // Like Kindle's button: reacts to the pointer sequence, not to a bare click().
  let pressed = false;
  next.addEventListener('pointerdown', () => { pressed = true; });
  next.addEventListener('click', () => {
    if (!pressed) return;
    pressed = false;
    clicks++;
    context.page.src = 'blob:https://read.amazon.in/second-page';
  });
  context.window.document.body.append(next);
  try {
    context.message({ type: 'control', action: 'toggle' });
    await flush();
    context.complete(line('Boats', 'left.', 'By', 'noon', 'the'));
    await flush();
    assert.equal(speaks(context).at(-1).text, 'Boats left.');
    context.message({ type: 'tts-event', event: 'ended', seq: speaks(context).at(-1).seq });
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(clicks, 1, 'Next page clicked once');
    assert.equal(extracts(context).length, 2, 'new page recognized');
    assert.equal(context.messages.some((message) => message.type === 'stop'), false, 'own page turn is not treated as a manual change');
    context.complete(line('harbor', 'was', 'empty.'));
    await flush();
    assert.equal(speaks(context).at(-1).text, 'By noon the harbor was empty.');
  } finally {
    context.message({ type: 'control', action: 'stop' });
    context.dom.window.close();
  }
});

test('when the page does not change the reader stops at the end of the book', async () => {
  const context = fixture();
  const next = context.window.document.createElement('button');
  next.id = 'kr-chevron-right';
  context.window.document.body.append(next); // clicking does nothing: last page
  try {
    context.message({ type: 'control', action: 'toggle' });
    await flush();
    context.complete(line('The', 'end.'));
    await flush();
    context.message({ type: 'tts-event', event: 'ended', seq: speaks(context).at(-1).seq });
    await new Promise((resolve) => setTimeout(resolve, 10600));
    assert.equal(extracts(context).length, 1);
    const player = context.window.document.getElementById('ai-reader-host');
    assert.equal(player.shadowRoot.querySelector('.info').textContent, 'Reached the end of the book.');
    assert.equal(speaks(context).length, 1);
  } finally {
    context.message({ type: 'control', action: 'stop' });
    context.dom.window.close();
  }
});

test('early page turn: the page turns during the second-to-last sentence and the next voice is prefetched', async () => {
  const context = fixture();
  const next = context.window.document.createElement('button');
  next.id = 'kr-chevron-right';
  let pressed = false;
  let clicks = 0;
  next.addEventListener('pointerdown', () => { pressed = true; });
  next.addEventListener('click', () => {
    if (!pressed) return;
    pressed = false;
    clicks++;
    context.page.src = 'blob:https://read.amazon.in/second-page';
  });
  context.window.document.body.append(next);
  const finish = async (spoken, { nearly = true } = {}) => {
    context.message({ type: 'tts-event', event: 'started', seq: spoken.seq });
    if (nearly) context.message({ type: 'tts-event', event: 'nearly-ended', seq: spoken.seq });
    await new Promise((resolve) => setTimeout(resolve, 600));
  };
  try {
    context.message({ type: 'control', action: 'toggle' });
    await flush();
    context.complete(line('Boats', 'left.', 'Gulls', 'stayed.', 'Wind', 'rose.', 'By', 'noon', 'the'));
    await flush();
    const first = speaks(context).at(-1);
    assert.equal(first.text, 'Boats left.');
    await finish(first);
    assert.equal(clicks, 0, 'third-to-last sentence: no turn yet');
    context.message({ type: 'tts-event', event: 'ended', seq: first.seq });
    await flush();
    const secondLast = speaks(context).at(-1);
    assert.equal(secondLast.text, 'Gulls stayed.');
    await finish(secondLast);
    assert.equal(clicks, 1, 'page turned while the second-to-last sentence finished');
    assert.equal(extracts(context).length, 2, 'new page recognized early');
    assert.equal(context.messages.some((message) => message.type === 'stop'), false);
    context.complete(line('harbor', 'was', 'empty.', 'Rain', 'came.'));
    await flush();
    const prefetch = context.messages.find((message) => message.type === 'prefetch');
    assert.deepEqual(Array.from(prefetch.texts), ['By noon the harbor was empty.', 'Rain came.']);
    context.message({ type: 'tts-event', event: 'ended', seq: secondLast.seq });
    await flush();
    const last = speaks(context).at(-1);
    assert.equal(last.text, 'Wind rose.', 'the old page\'s last sentence still plays');
    await finish(last);
    assert.equal(clicks, 1, 'no second turn');
    context.message({ type: 'tts-event', event: 'ended', seq: last.seq });
    await flush();
    assert.equal(speaks(context).at(-1).text, 'By noon the harbor was empty.');
    assert.equal(extracts(context).length, 2, 'no second OCR when the early page is ready');
  } finally {
    context.message({ type: 'control', action: 'stop' });
    context.dom.window.close();
  }
});

test('early page turn on a one-sentence page triggers on that sentence', async () => {
  const context = fixture();
  const next = context.window.document.createElement('button');
  next.id = 'kr-chevron-right';
  let pressed = false;
  let clicks = 0;
  next.addEventListener('pointerdown', () => { pressed = true; });
  next.addEventListener('click', () => { if (pressed) { pressed = false; clicks++; context.page.src = 'blob:https://read.amazon.in/second-page'; } });
  context.window.document.body.append(next);
  try {
    context.message({ type: 'control', action: 'toggle' });
    await flush();
    context.complete(line('Only', 'this.'));
    await flush();
    const only = speaks(context).at(-1);
    context.message({ type: 'tts-event', event: 'started', seq: only.seq });
    context.message({ type: 'tts-event', event: 'nearly-ended', seq: only.seq });
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(clicks, 1);
  } finally {
    context.message({ type: 'control', action: 'stop' });
    context.dom.window.close();
  }
});

test('after a stop, re-reading the new page still starts with the sentence carried from the previous page', async () => {
  const context = fixture();
  const next = context.window.document.createElement('button');
  next.id = 'kr-chevron-right';
  let pressed = false;
  next.addEventListener('pointerdown', () => { pressed = true; });
  next.addEventListener('click', () => { if (pressed) { pressed = false; context.page.src = 'blob:https://read.amazon.in/second-page'; } });
  context.window.document.body.append(next);
  try {
    context.message({ type: 'control', action: 'toggle' });
    await flush();
    context.complete(line('Boats', 'left.', 'By', 'noon', 'the'));
    await flush();
    context.message({ type: 'tts-event', event: 'ended', seq: speaks(context).at(-1).seq });
    await new Promise((resolve) => setTimeout(resolve, 900));
    context.complete(line('harbor', 'was', 'empty.', 'Rain', 'came.'));
    await flush();
    assert.equal(speaks(context).at(-1).text, 'By noon the harbor was empty.');

    context.message({ type: 'control', action: 'stop' });
    await flush();
    context.message({ type: 'control', action: 'toggle' });
    await flush();
    context.complete(line('harbor', 'was', 'empty.', 'Rain', 'came.'));
    await flush();
    assert.equal(speaks(context).at(-1).text, 'By noon the harbor was empty.', 'not the bare fragment "harbor was empty."');
  } finally {
    context.message({ type: 'control', action: 'stop' });
    context.dom.window.close();
  }
});

test('a hidden tab does not stop Kindle reading', async () => {
  const context = fixture();
  try {
    context.message({ type: 'control', action: 'toggle' });
    await flush();
    context.complete(line('Boats', 'left.', 'Gulls', 'stayed.'));
    await flush();
    context.setHidden(true);
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(context.messages.some((message) => message.type === 'stop'), false);
    context.message({ type: 'tts-event', event: 'ended', seq: speaks(context).at(-1).seq });
    await flush();
    assert.equal(speaks(context).at(-1).text, 'Gulls stayed.');
  } finally {
    context.message({ type: 'control', action: 'stop' });
    context.dom.window.close();
  }
});

test('a page turn while the tab is hidden waits for it to be visible, then continues', async () => {
  const context = fixture();
  const next = context.window.document.createElement('button');
  next.id = 'kr-chevron-right';
  let pressed = false;
  let queued = false;
  next.addEventListener('pointerdown', () => { pressed = true; });
  // Like a page that doesn't draw while hidden: the turn happens once the tab is visible.
  next.addEventListener('click', () => { if (pressed) { pressed = false; queued = true; } });
  context.window.document.addEventListener('visibilitychange', () => {
    if (!context.window.document.hidden && queued) context.page.src = 'blob:https://read.amazon.in/second-page';
  });
  context.window.document.body.append(next);
  try {
    context.message({ type: 'control', action: 'toggle' });
    await flush();
    context.complete(line('Boats', 'left.', 'By', 'noon', 'the'));
    await flush();
    context.setHidden(true);
    context.message({ type: 'tts-event', event: 'ended', seq: speaks(context).at(-1).seq });
    await new Promise((resolve) => setTimeout(resolve, 10600));
    const player = context.window.document.getElementById('ai-reader-host');
    assert.equal(player.shadowRoot.querySelector('.info').textContent, 'Turning the page when the Kindle tab is visible again…');
    assert.equal(extracts(context).length, 1);
    context.setHidden(false);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(extracts(context).length, 2, 'new page recognized after becoming visible');
    context.complete(line('harbor', 'was', 'empty.'));
    await flush();
    assert.equal(speaks(context).at(-1).text, 'By noon the harbor was empty.');
  } finally {
    context.message({ type: 'control', action: 'stop' });
    context.dom.window.close();
  }
});

test('on Kindle, reading resumes at the saved sentence on the reopened page', async () => {
  const store = { settings: { engine: 'system' } };
  let context = fixture({ store });
  try {
    context.message({ type: 'control', action: 'toggle' });
    await flush();
    context.complete(line('Boats', 'left.', 'Gulls', 'stayed.', 'Wind', 'rose.'));
    await flush();
    context.message({ type: 'tts-event', event: 'ended', seq: speaks(context).at(-1).seq });
    await flush();
    assert.equal(speaks(context).at(-1).text, 'Gulls stayed.');
    context.message({ type: 'control', action: 'stop' });
  } finally { context.dom.window.close(); }

  context = fixture({ store });
  try {
    context.message({ type: 'control', action: 'toggle' });
    await flush();
    context.complete(line('Boats', 'left.', 'Gulls', 'stayed.', 'Wind', 'rose.'));
    await flush();
    assert.equal(speaks(context).at(-1).text, 'Gulls stayed.');
  } finally {
    context.message({ type: 'control', action: 'stop' });
    context.dom.window.close();
  }
});
