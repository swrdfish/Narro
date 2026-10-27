// Offscreen document: synthesizes and plays audio. Driven by the background service worker.
import { synthesize, cacheKey } from './engines.js';
import { recognizeKindle, cancelKindle } from './kindle-ocr.js';
import { LEVEL_BANDS, bandLevels, quietestTime } from './levels.js';

// Clips kept so going back (or reading on after a jump) replays them instead of synthesizing
// again: a few pages' worth, and at most CACHE_BYTES of audio (in-browser voices make WAV, about
// 3 MB a minute). The least recently played go first.
const CACHE_LIMIT = 80;
const CACHE_BYTES = 64 * 1024 * 1024;
// Seconds of audio (at the current speed) left when 'nearly-ended' is sent, so the reader can
// prepare what comes next (e.g. turn a Kindle page) while the sentence finishes.
const NEARLY_ENDED_LEAD = 1.5;
const cache = new Map(); // key -> Promise<Blob>, least recently used first
const sizes = new Map(); // key -> bytes, once the clip is ready
const durations = new Map(); // key -> seconds, once the clip is decoded
const keyOf = (settings, text) => `${cacheKey(settings)}|${text}`;

const audio = new Audio();
audio.preservesPitch = true;

// Chrome gives the media keys only to audio at least 5 s long, and a one-sentence clip is often
// shorter. A silent loop that plays and pauses with the speech keeps the keys with Narro.
const keysHolder = new Audio(URL.createObjectURL(silence(10)));
keysHolder.loop = true;

function silence(seconds, sampleRate = 8000) {
  const length = seconds * sampleRate;
  const wav = new DataView(new ArrayBuffer(44 + length));
  const text = (offset, value) => [...value].forEach((c, i) => wav.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  wav.setUint32(4, 36 + length, true);
  text(8, 'WAVEfmt ');
  wav.setUint32(16, 16, true);
  wav.setUint16(20, 1, true); // PCM
  wav.setUint16(22, 1, true); // mono
  wav.setUint32(24, sampleRate, true);
  wav.setUint32(28, sampleRate, true); // bytes per second
  wav.setUint16(32, 1, true); // bytes per frame
  wav.setUint16(34, 8, true); // bits per sample
  text(36, 'data');
  wav.setUint32(40, length, true);
  for (let i = 0; i < length; i++) wav.setUint8(44 + i, 128); // 8-bit silence
  return new Blob([wav], { type: 'audio/wav' });
}

// Chrome takes artwork only from http(s), data and blob URLs, not chrome-extension:// ones.
let artwork = null;
fetch('icons/icon-128.png')
  .then((response) => response.blob())
  .then((blob) => (artwork = URL.createObjectURL(blob)), () => {});

// What macOS's Now Playing (and other system media controls) show: the page being read, rather
// than this document's address and the silent loop's progress.
function showNowPlaying(title) {
  navigator.mediaSession.metadata = new MediaMetadata({
    title: title ? `Narro: ${title}` : 'Narro',
    artist: 'Narro',
    artwork: artwork ? [{ src: artwork, sizes: '128x128', type: 'image/png' }] : [],
  });
}

function showPosition() {
  if (!Number.isFinite(audio.duration)) return;
  try {
    navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate, position: Math.min(audio.currentTime, audio.duration) });
  } catch {}
}

let current = null; // { tabId, seq, url, ahead: keys of the clips that follow }
let rate = 1;

function emit(tabId, seq, event, extra = {}) {
  chrome.runtime.sendMessage({ target: 'background', type: 'tts-event', tabId, seq, event, ...extra });
}

// Media keys (and Chrome's media controls) act on this document's audio. Left to Chrome they'd
// pause it behind the reader's back, so hand them to the reading tab like its own buttons.
const MEDIA_ACTIONS = { play: 'toggle', pause: 'toggle', stop: 'stop', previoustrack: 'prev', nexttrack: 'next' };
for (const [key, action] of Object.entries(MEDIA_ACTIONS)) {
  navigator.mediaSession?.setActionHandler(key, () => {
    if (current) chrome.runtime.sendMessage({ type: 'remote-control', action });
  });
}

function getAudio(settings, text, onStatus) {
  const key = keyOf(settings, text);
  let p = cache.get(key);
  if (p) {
    cache.delete(key); // move to the most recent end
  } else {
    p = synthesize(settings, text, { onStatus });
    p.then((blob) => {
      if (cache.get(key) !== p) return;
      sizes.set(key, blob.size);
      trimCache();
      reportBuffer();
      // Its length, for the buffer gauge; the levels are kept for when it plays.
      clipLevels(blob).then((levels) => {
        if (cache.get(key) !== p) return;
        durations.set(key, levels.data.length / levels.bands / levels.fps);
        reportBuffer();
      }, () => {});
    }, () => cache.get(key) === p && forget(key));
  }
  cache.set(key, p);
  trimCache();
  return p;
}

function forget(key) {
  cache.delete(key);
  sizes.delete(key);
  durations.delete(key);
}

// Tells the reader how much of what follows the playing clip is ready: clips in a row from the
// next one, and their seconds of speech.
function reportBuffer() {
  const token = current;
  if (!token?.ahead) return;
  let ready = 0;
  let seconds = 0;
  for (const key of token.ahead) {
    if (!sizes.has(key)) break;
    ready++;
    seconds += durations.get(key) || 0;
  }
  emit(token.tabId, token.seq, 'buffer', { ready, total: token.ahead.length, seconds });
}

function trimCache() {
  let bytes = 0;
  for (const size of sizes.values()) bytes += size;
  for (const key of cache.keys()) {
    if (cache.size <= CACHE_LIMIT && bytes <= CACHE_BYTES) break;
    if (cache.size === 1) break; // the clip just asked for stays, however large
    bytes -= sizes.get(key) || 0;
    forget(key);
  }
}

/** Index of the first of `texts` that is cached (or being synthesized), or -1. */
function firstCached(settings, texts) {
  return texts.findIndex((text) => cache.has(keyOf(settings, text)));
}

// The visualizer's levels for a clip: decoded and band-pass filtered offline, so the audio element
// plays as before. Kept per clip, since cached clips are played again (previous sentence, resume).
const levelCache = new WeakMap(); // Blob -> Promise<levels>
function clipLevels(blob) {
  let p = levelCache.get(blob);
  if (!p) {
    p = (async () => {
      const decoded = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(await blob.arrayBuffer());
      const context = new OfflineAudioContext(LEVEL_BANDS.length, decoded.length, decoded.sampleRate);
      const source = context.createBufferSource();
      source.buffer = decoded;
      const merger = context.createChannelMerger(LEVEL_BANDS.length);
      LEVEL_BANDS.forEach((frequency, band) => {
        const filter = context.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = Math.min(frequency, decoded.sampleRate / 2 - 100);
        filter.Q.value = 1.2;
        source.connect(filter).connect(merger, 0, band);
      });
      merger.connect(context.destination);
      source.start();
      const rendered = await context.startRendering();
      return bandLevels(LEVEL_BANDS.map((_, band) => rendered.getChannelData(band)), rendered.sampleRate);
    })();
    p.catch(() => levelCache.delete(blob));
    levelCache.set(blob, p);
  }
  return p;
}

function stopAudio() {
  audio.onended = null;
  audio.onerror = null;
  audio.ontimeupdate = null;
  audio.pause();
  keysHolder.pause();
  if (current?.url) URL.revokeObjectURL(current.url);
  current = null;
}

// `startAt` (0–1): start partway into the clip, at the pause nearest that point, when a jump lands
// on a sentence inside a cached clip.
async function speak({ tabId, seq, text, prefetch = [], settings, startAt = 0, title }) {
  stopAudio();
  current = { tabId, seq, ahead: prefetch.map((t) => keyOf(settings, t)) };
  const token = current;
  rate = settings.rate;
  const onStatus = (status) => emit(tabId, seq, 'status', { status });
  reportBuffer();
  // Not ready yet (starting, or synthesis fell behind): buffer before playing, below.
  const buffering = !sizes.has(keyOf(settings, text)) && prefetch.length > 0;
  if (buffering) onStatus('Buffering…');
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
    // Wait for the clip after this one too, so playback doesn't stop again as soon as this ends.
    if (buffering) {
      await getAudio(settings, prefetch[0]).catch(() => {});
      if (current !== token) return;
    }
    token.url = URL.createObjectURL(blob);
    audio.src = token.url;
    // Usually ready before the clip starts; if not, the bars join in when it is.
    clipLevels(blob).then((levels) => current === token && emit(tabId, seq, 'levels', { levels }), () => {});
    audio.playbackRate = rate;
    audio.onended = () => current === token && emit(tabId, seq, 'ended');
    audio.onerror = () => current === token && emit(tabId, seq, 'error', { message: 'Audio playback failed.' });
    audio.ontimeupdate = () => {
      if (current !== token || !Number.isFinite(audio.duration)) return;
      // Lets the reader move the highlight through a clip that holds several sentences.
      emit(tabId, seq, 'progress', { time: audio.currentTime, duration: audio.duration });
      showPosition();
      if (token.nearlyEnded) return;
      if ((audio.duration - audio.currentTime) / audio.playbackRate <= NEARLY_ENDED_LEAD) {
        token.nearlyEnded = true;
        emit(tabId, seq, 'nearly-ended');
      }
    };
    if (startAt > 0) {
      await new Promise((resolve) => {
        audio.addEventListener('loadedmetadata', resolve, { once: true });
        audio.addEventListener('error', resolve, { once: true });
      });
      const levels = await clipLevels(blob).catch(() => null);
      if (current !== token) return;
      const time = startAt * audio.duration;
      if (Number.isFinite(time)) audio.currentTime = levels ? quietestTime(levels, time) : time;
    }
    if (token.paused) return; // resume() will start it
    // The silent loop first: started after a short clip, Chrome takes the pair for a short sound.
    await keysHolder.play().catch(() => {});
    await audio.play();
    showNowPlaying(title);
    showPosition();
    emit(tabId, seq, 'started');
  } catch (e) {
    if (current === token) emit(tabId, seq, 'error', { message: e.message, detail: e.detail });
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
    case 'cached':
      sendResponse({ index: firstCached(msg.settings, msg.texts) });
      return;
    case 'prefetch':
      // Warm the cache, one at a time, without interrupting what's playing.
      (async () => {
        for (const text of msg.texts) await getAudio(msg.settings, text).catch(() => {});
      })();
      break;
    case 'pause':
      if (current) current.paused = true;
      audio.pause();
      keysHolder.pause();
      break;
    case 'resume':
      // If the document was recreated (or the sentence is gone), the caller must re-speak.
      if (current && current.seq === msg.seq) {
        const c = current;
        c.paused = false;
        if (c.url) {
          keysHolder.play().catch(() => {})
            .then(() => audio.play())
            .then(() => emit(c.tabId, c.seq, 'started'));
        }
        sendResponse({ resumed: true });
      } else {
        sendResponse({ resumed: false });
      }
      return;
    case 'rate':
      rate = msg.rate;
      audio.playbackRate = rate;
      showPosition();
      break;
    case 'stop':
      stopAudio();
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.setPositionState();
      break;
    case 'clear-cache':
      cache.clear();
      break;
  }
  sendResponse({ ok: true });
});
