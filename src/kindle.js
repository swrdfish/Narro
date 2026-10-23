import { isKindleUrl } from './kindle-data.js';
import { buildSpreadSentences, visualSentenceAt } from './kindle-text.js';

export { isKindleUrl, visualSentenceAt };

function viewportRect(element, offset) {
  const box = element.getBoundingClientRect();
  const rect = { left: box.left + offset.left, top: box.top + offset.top, width: box.width, height: box.height };
  if (element.tagName === 'IMG' && element.naturalWidth && element.naturalHeight) {
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    if (['contain', 'scale-down'].includes(style.objectFit)) {
      const scale = Math.min(rect.width / element.naturalWidth, rect.height / element.naturalHeight, style.objectFit === 'scale-down' ? 1 : Infinity);
      const width = element.naturalWidth * scale;
      const height = element.naturalHeight * scale;
      const position = (style.objectPosition || '50% 50%').split(' ');
      if (!position.every((part) => /^\d+(\.\d+)?%$/.test(part))) return { ...rect, width: 0 };
      rect.left += (rect.width - width) * parseFloat(position[0]) / 100;
      rect.top += (rect.height - height) * parseFloat(position[1] || position[0]) / 100;
      rect.width = width;
      rect.height = height;
    } else if (['cover', 'none'].includes(style.objectFit)) {
      // Only a crop of the image is visible unless the box matches its aspect (cover) or size (none);
      // in that case read the visible region from a screenshot instead of the full image.
      const scale = style.objectFit === 'cover' ? Math.max(rect.width / element.naturalWidth, rect.height / element.naturalHeight) : 1;
      if (Math.abs(element.naturalWidth * scale - rect.width) > 1 || Math.abs(element.naturalHeight * scale - rect.height) > 1) rect.cropped = true;
    }
  }
  return rect;
}

export function findKindleSurfaces(doc = document, viewport = { width: innerWidth, height: innerHeight }) {
  const surfaces = [];
  function collect(current, offset, depth) {
    if (depth > 3) return;
    for (const element of current.querySelectorAll('img, canvas, iframe')) {
      if (element.closest('[hidden], #ai-reader-host, #ai-reader-kindle-overlay')) continue;
      if (element.checkVisibility && !element.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
      const { cropped = false, ...rect } = viewportRect(element, offset);
      if (rect.width < 200 || rect.height < 150 || rect.width * rect.height < 40000 || rect.left < -1 || rect.top < -1 || rect.left + rect.width > viewport.width + 1 || rect.top + rect.height > viewport.height + 1) continue;
      rect.left = Math.max(0, rect.left);
      rect.top = Math.max(0, rect.top);
      if (element.tagName === 'IFRAME') {
        try {
          if (element.contentDocument?.body) {
            collect(element.contentDocument, { left: rect.left + element.clientLeft, top: rect.top + element.clientTop }, depth + 1);
            continue;
          }
        } catch {}
        if (isKindleUrl(element.src)) surfaces.push({ element, rect, cropped });
      } else if (element.tagName === 'CANVAS' || /^(blob:|data:image\/)/.test(element.currentSrc || element.src)) {
        if (element.tagName === 'IMG' && (!element.complete || !element.naturalWidth)) continue;
        surfaces.push({ element, rect, cropped });
      }
    }
  }
  collect(doc, { left: 0, top: 0 }, 0);
  const ordered = surfaces.sort((first, second) => second.rect.width * second.rect.height - first.rect.width * first.rect.height);
  const selected = [];
  for (const surface of ordered) {
    if (selected.some(({ rect }) => Math.min(rect.left + rect.width, surface.rect.left + surface.rect.width) - Math.max(rect.left, surface.rect.left) > 10
      && Math.min(rect.top + rect.height, surface.rect.top + surface.rect.height) - Math.max(rect.top, surface.rect.top) > 10)) continue;
    selected.push(surface);
  }
  return selected.slice(0, 4).sort((first, second) => first.rect.left - second.rect.left || first.rect.top - second.rect.top);
}

function imageData(surface, thumbnail = false) {
  const { element } = surface;
  if (element.tagName === 'IFRAME' || surface.cropped) return null; // read from a screenshot instead
  try {
    const width = element.naturalWidth || element.width;
    const height = element.naturalHeight || element.height;
    if (!width || !height || width * height > 16000000) return null;
    const canvas = document.createElement('canvas');
    canvas.width = thumbnail ? 32 : width;
    canvas.height = thumbnail ? 32 : height;
    canvas.getContext('2d').drawImage(element, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

function signature(surfaces) {
  return JSON.stringify([location.href, innerWidth, innerHeight, ...surfaces.map((surface) => [surface.rect, surface.element.currentSrc || surface.element.src || '', surface.element.tagName === 'CANVAS' ? imageData(surface, true) : ''])]);
}

// Kindle's own "next page" control; the label is localized on some storefronts, the id is not.
const NEXT_PAGE = '#kr-chevron-right, button[aria-label="Next page"]';

function pressNextPage() {
  const next = document.querySelector(NEXT_PAGE);
  if (next && !next.disabled && next.checkVisibility?.() !== false) return press(next);
  const key = { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39, bubbles: true, cancelable: true };
  (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', key));
  (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keyup', key));
}

/**
 * Resolves true once the page differs from `before` and has stayed the same for a moment (Kindle can
 * swap images while rendering), or false after `timeout` ms. Driven by DOM changes and image loads,
 * because Chrome slows timers in hidden tabs; a slow poll covers pages drawn on a canvas.
 */
function waitForPageChange(before, signal, timeout) {
  return new Promise((resolve, reject) => {
    let candidate = null;
    let settle = null;
    const check = () => {
      const surfaces = findKindleSurfaces();
      const current = surfaces.length ? signature(surfaces) : null;
      if (!current || current === before) {
        candidate = null;
        clearTimeout(settle);
        return;
      }
      if (current === candidate) return;
      candidate = current;
      clearTimeout(settle);
      settle = setTimeout(() => (signature(findKindleSurfaces()) === candidate ? finish(true) : check()), 200);
    };
    const observer = new MutationObserver(check);
    const poll = setInterval(check, 250);
    const deadline = setTimeout(() => finish(false), timeout);
    const abort = () => finish(undefined, signal.reason ?? new DOMException('Aborted', 'AbortError'));
    function finish(value, error) {
      observer.disconnect();
      document.removeEventListener('load', check, true);
      signal.removeEventListener('abort', abort);
      clearInterval(poll);
      clearTimeout(settle);
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(value);
    }
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'style', 'class', 'hidden'] });
    document.addEventListener('load', check, true); // image loads
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else check();
  });
}

function waitUntilVisible(signal) {
  return new Promise((resolve, reject) => {
    if (!document.hidden) return resolve();
    const abort = () => {
      document.removeEventListener('visibilitychange', changed);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const changed = () => {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', changed);
      signal.removeEventListener('abort', abort);
      resolve();
    };
    document.addEventListener('visibilitychange', changed);
    signal.addEventListener('abort', abort, { once: true });
  });
}

// Kindle's buttons react to pointer events; a bare element.click() is ignored.
function press(element) {
  const rect = element.getBoundingClientRect();
  const at = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true, composed: true, view: window, button: 0 };
  const Pointer = window.PointerEvent || MouseEvent;
  const pointer = { ...at, pointerId: 1, pointerType: 'mouse', isPrimary: true };
  element.dispatchEvent(new Pointer('pointerdown', { ...pointer, buttons: 1 }));
  element.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: 1 }));
  element.dispatchEvent(new Pointer('pointerup', pointer));
  element.dispatchEvent(new MouseEvent('mouseup', at));
  element.dispatchEvent(new MouseEvent('click', at));
}

export function createKindleReader(onChange) {
  let monitor;
  let currentSignature;
  let currentElements = [];
  let picking = false;
  // Text cut off at the end of the last page read, spoken with its continuation on the next page.
  let carry = null; // { text, book, page }
  // What was carried onto each page, so re-reading a page (after a stop) still starts with the full sentence.
  const carriedOnto = new Map(); // page key -> carried text
  const host = document.createElement('div');
  host.id = 'ai-reader-kindle-overlay';
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
  const root = host.attachShadow({ mode: 'closed' });
  const layers = {};
  for (const name of ['block', 'sentence', 'pick']) {
    layers[name] = document.createElement('div');
    root.append(layers[name]);
  }
  const guards = document.createElement('div');
  root.append(guards);
  guards.addEventListener('pointerdown', (event) => {
    if (!picking && !event.altKey) changed();
  });

  function paint(name, rects = []) {
    if (rects.length && !host.isConnected) document.documentElement.append(host);
    const boxes = rects.map((rect) => {
      const box = document.createElement('div');
      box.style.cssText = `position:absolute;left:${rect.left}px;top:${rect.top}px;width:${rect.right - rect.left}px;height:${rect.bottom - rect.top}px;background:${name === 'pick' ? '#60a5fa' : '#ffe066'};opacity:${name === 'block' ? 0.12 : 0.4};pointer-events:none;`;
      return box;
    });
    layers[name].replaceChildren(...boxes);
  }

  function changed() {
    clearInterval(monitor);
    monitor = null;
    onChange();
  }

  function check() {
    const surfaces = findKindleSurfaces();
    // Only a real page change stops reading; a hidden tab (another window on top) doesn't.
    if (currentSignature !== signature(surfaces) || currentElements.some((element, index) => element !== surfaces[index]?.element)) changed();
  }

  return {
    /**
     * Turns to the next page and waits until a different page has settled. Resolves false if
     * nothing changed (end of the book). If the tab is hidden and Kindle doesn't draw the new page
     * meanwhile, waits until the tab is visible again (reporting it via `onWaiting`).
     */
    async turnPage(signal, { onWaiting } = {}) {
      // This is our own page change; don't report it as the user's.
      clearInterval(monitor);
      monitor = null;
      const before = signature(findKindleSurfaces());
      pressNextPage();
      if (await waitForPageChange(before, signal, 10000)) return true;
      if (!document.hidden) return false;
      onWaiting?.();
      await waitUntilVisible(signal);
      // The turn may have been queued and drawn now; only press again if it wasn't.
      if (await waitForPageChange(before, signal, 3000)) return true;
      pressNextPage();
      return waitForPageChange(before, signal, 10000);
    },
    async read(options, signal, onStatus, hidePlayer) {
      let surfaces = findKindleSurfaces();
      // Kindle briefly swaps page images while rendering; give it a moment before giving up.
      for (let attempt = 0; !surfaces.length && attempt < 8; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        signal.throwIfAborted();
        surfaces = findKindleSurfaces();
      }
      if (!surfaces.length) throw new Error('No visible Kindle book page found. Open the book, wait for it to load, and fit the page in the window.');
      const initial = signature(surfaces);
      currentSignature = initial;
      currentElements = surfaces.map((surface) => surface.element);
      clearInterval(monitor);
      monitor = setInterval(check, 500);
      onStatus('Reading Kindle page locally…');
      const images = surfaces.map((surface) => ({ rect: surface.rect, dataUrl: imageData(surface) }));
      const requestId = crypto.randomUUID();
      let sent = false;
      const abort = () => {
        hidePlayer(false);
        if (sent) chrome.runtime.sendMessage({ type: 'kindle-cancel', requestId }).catch(() => {});
      };
      const captured = (message) => {
        if (message.type === 'kindle-captured' && message.requestId === requestId) hidePlayer(false);
      };
      chrome.runtime.onMessage.addListener(captured);
      signal.addEventListener('abort', abort, { once: true });
      try {
        if (images.some((image) => !image.dataUrl)) {
          hidePlayer(true);
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }
        signal.throwIfAborted();
        sent = true;
        const result = await chrome.runtime.sendMessage({ type: 'kindle-extract', requestId, images, viewport: { width: innerWidth, height: innerHeight } });
        signal.throwIfAborted();
        if (initial !== signature(findKindleSurfaces())) throw new Error('The Kindle page changed while reading. Press Play to read the new page.');
        if (result?.error) throw new Error(result.error);
        if (!Array.isArray(result?.pages) || result.pages.length !== surfaces.length) throw new Error('Kindle extraction returned no pages.');
        guards.replaceChildren(...images.filter((image) => !image.dataUrl).map(({ rect }) => {
          const guard = document.createElement('div');
          guard.tabIndex = 0;
          guard.title = 'Click to stop reading before interacting with this viewer';
          guard.style.cssText = `position:absolute;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;pointer-events:auto;outline:none;`;
          return guard;
        }));
        if (guards.children.length) {
          if (!host.isConnected) document.documentElement.append(host);
          guards.firstChild.focus({ preventScroll: true });
        }
        const book = new URL(location.href).searchParams.get('asin');
        // Identify the page by its images, not the window size, so resizing can't look like a new page.
        const page = `${book}|${surfaces.map((surface) => surface.element.currentSrc || surface.element.src || initial).join('|')}`;
        const tail = [];
        // A different page of the same book continues the carried text; a re-read reuses what it got before.
        let carried = carriedOnto.get(page) ?? '';
        if (carry && carry.book === book && carry.page !== page) {
          carried = carry.text;
          carriedOnto.set(page, carried);
          while (carriedOnto.size > 20) carriedOnto.delete(carriedOnto.keys().next().value);
        }
        const sentences = buildSpreadSentences(
          result.pages.map((page, index) => ({ paragraphs: page.paragraphs, rect: surfaces[index].rect, width: page.width, height: page.height })),
          { ...options, carry: carried, tail },
        );
        carry = tail.length ? { text: tail.join(' '), book, page } : null;
        onStatus('Kindle: local OCR');
        return sentences;
      } finally {
        chrome.runtime.onMessage.removeListener(captured);
        signal.removeEventListener('abort', abort);
        hidePlayer(false);
      }
    },
    highlight(sentence) {
      paint('block', sentence?.blockRects);
      paint('sentence', sentence?.rects);
    },
    preview(sentence) { paint('pick', sentence?.rects); },
    picking(active) {
      picking = active;
      host.style.pointerEvents = active ? 'auto' : 'none';
      host.style.cursor = active ? 'crosshair' : '';
      if (active && !host.isConnected) document.documentElement.append(host);
      if (!active) paint('pick');
    },
    clear() {
      guards.replaceChildren();
      for (const name of Object.keys(layers)) paint(name);
      host.remove();
      clearInterval(monitor);
      monitor = null;
    },
  };
}
