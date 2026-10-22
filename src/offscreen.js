// Offscreen document: synthesizes and plays audio. Driven by the background service worker.
import { synthesize, cacheKey } from './engines.js';

const CACHE_LIMIT = 12;
const cache = new Map(); // key -> Promise<Blob>

const audio = new Audio();
audio.preservesPitch = true;

let current = null; // { tabId, seq, url }
let rate = 1;

function emit(tabId, seq, event, extra = {}) {
  chrome.runtime.sendMessage({ target: 'background', type: 'tts-event', tabId, seq, event, ...extra });
}

function getAudio(settings, text, onStatus) {
  const key = `${cacheKey(settings)}|${text}`;
  let p = cache.get(key);
  if (!p) {
    p = synthesize(settings, text, { onStatus });
    p.catch(() => cache.delete(key));
    cache.set(key, p);
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  }
  return p;
}

function stopAudio() {
  audio.onended = null;
  audio.onerror = null;
  audio.pause();
  if (current?.url) URL.revokeObjectURL(current.url);
  current = null;
}

async function speak({ tabId, seq, text, prefetch = [], settings }) {
  stopAudio();
  current = { tabId, seq };
  const token = current;
  rate = settings.rate;
  const onStatus = (status) => emit(tabId, seq, 'status', { status });
  try {
    const blob = await getAudio(settings, text, onStatus);
    if (current !== token) return; // superseded while synthesizing
    // Warm the cache for the next sentences, one at a time to stay under rate limits.
    (async () => {
      for (const t of prefetch) {
        if (current !== token) return;
        await getAudio(settings, t).catch(() => {});
      }
    })();
    token.url = URL.createObjectURL(blob);
    audio.src = token.url;
    audio.playbackRate = rate;
    audio.onended = () => current === token && emit(tabId, seq, 'ended');
    audio.onerror = () => current === token && emit(tabId, seq, 'error', { message: 'Audio playback failed.' });
    if (token.paused) return; // resume() will start it
    await audio.play();
    emit(tabId, seq, 'started');
  } catch (e) {
    if (current === token) emit(tabId, seq, 'error', { message: e.message });
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  switch (msg.cmd) {
    case 'speak':
      speak(msg);
      break;
    case 'pause':
      if (current) current.paused = true;
      audio.pause();
      break;
    case 'resume':
      // If the document was recreated (or the sentence is gone), the caller must re-speak.
      if (current && current.seq === msg.seq) {
        const c = current;
        c.paused = false;
        if (c.url) audio.play().then(() => emit(c.tabId, c.seq, 'started'));
        sendResponse({ resumed: true });
      } else {
        sendResponse({ resumed: false });
      }
      return;
    case 'rate':
      rate = msg.rate;
      audio.playbackRate = rate;
      break;
    case 'stop':
      stopAudio();
      break;
    case 'clear-cache':
      cache.clear();
      break;
  }
  sendResponse({ ok: true });
});
