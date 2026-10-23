// Offscreen document: synthesizes and plays audio. Driven by the background service worker.
import { synthesize, cacheKey } from './engines.js';
import { recognizeKindle, cancelKindle } from './kindle-ocr.js';

const CACHE_LIMIT = 12;
// Seconds of audio (at the current speed) left when 'nearly-ended' is sent, so the reader can
// prepare what comes next (e.g. turn a Kindle page) while the sentence finishes.
const NEARLY_ENDED_LEAD = 1.5;
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
  audio.ontimeupdate = null;
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
    audio.ontimeupdate = () => {
      if (current !== token || token.nearlyEnded || !Number.isFinite(audio.duration)) return;
      if ((audio.duration - audio.currentTime) / audio.playbackRate <= NEARLY_ENDED_LEAD) {
        token.nearlyEnded = true;
        emit(tabId, seq, 'nearly-ended');
      }
    };
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
    case 'kindle-cancel':
      cancelKindle(msg);
      break;
    case 'kindle-extract':
      recognizeKindle(msg).then(sendResponse, (error) => sendResponse({ error: error.message }));
      return true;
    case 'speak':
      speak(msg);
      break;
    case 'prefetch':
      // Warm the cache, one at a time, without interrupting what's playing.
      (async () => {
        for (const text of msg.texts) await getAudio(msg.settings, text).catch(() => {});
      })();
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
