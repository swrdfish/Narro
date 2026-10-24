// Text-to-speech engines. Each synthesize() returns a playable audio Blob.

// Cloud requests occasionally stall: no response, or audio that stops arriving partway. Without a
// limit the sentence would wait forever (and stay cached as a pending request), so give up after
// these times and retry. A slow response that's still sending isn't cut off.
const CLOUD_TIMEOUTS = { response: 40_000, idle: 20_000 };
const LOCAL_SERVER_TIMEOUTS = { response: 120_000, idle: 60_000 }; // CPU speech servers can be slow
const RETRY_DELAYS = [1000, 3000];
const MAX_RETRY_AFTER = 10_000;

/**
 * POSTs to a speech API and reads the whole response as a Blob or JSON, with time limits and up to
 * two retries for network errors, time-outs, 408, 429 (except quota errors) and 5xx.
 */
async function request(url, init, label, { as = 'blob', onStatus, timeouts = CLOUD_TIMEOUTS } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestOnce(url, init, label, as, timeouts);
    } catch (error) {
      if (!error.retryable || attempt >= RETRY_DELAYS.length) throw error;
      onStatus?.(`${label} ${error.timedOut ? "didn't respond" : 'had a problem'}, retrying…`);
      await new Promise((resolve) => setTimeout(resolve, error.retryAfter ?? RETRY_DELAYS[attempt]));
    }
  }
}

async function requestOnce(url, init, label, as, timeouts) {
  const controller = new AbortController();
  let phase = 'response'; // waiting for the response to start, then 'idle' between body chunks
  let timedOut = false;
  let timer;
  const startTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeouts[phase]);
  };
  const timeoutError = () => Object.assign(
    new Error(`${label}: no response for ${Math.round(timeouts[phase] / 1000)} seconds. Press Play to try again.`),
    { retryable: true, timedOut: true },
  );
  startTimer();

  try {
    let res;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } catch (e) {
      if (timedOut) throw timeoutError();
      throw Object.assign(new Error(`${label}: network error (${e.message}). Is the server reachable?`), { retryable: true });
    }

    // Read the body in chunks, giving up if it stops arriving.
    const readBody = async () => {
      phase = 'idle';
      startTimer();
      const chunks = [];
      try {
        if (!res.body) return new Blob([await res.arrayBuffer()]);
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          startTimer();
        }
      } catch (e) {
        if (timedOut) throw timeoutError();
        throw Object.assign(new Error(`${label}: the connection dropped (${e.message}).`), { retryable: true });
      }
      return new Blob(chunks, { type: res.headers.get('content-type') || '' });
    };

    if (!res.ok) {
      // The player shows the message; the raw response is available in its error details.
      let message = '';
      let raw = '';
      try {
        const body = await (await readBody()).text();
        raw = body;
        try {
          const json = JSON.parse(body);
          message = String(json.error?.message ?? json.detail?.message ?? json.message ?? '');
          raw = JSON.stringify(json, null, 2);
        } catch {
          message = body;
        }
      } catch {}
      const error = new Error(`${label} ${res.status}: ${(message || res.statusText).slice(0, 1000)}`);
      if (raw && raw.trim() !== message.trim()) error.detail = raw.slice(0, 4000);
      error.status = res.status;
      error.retryable = [408, 429, 500, 502, 503, 504].includes(res.status) && !/quota/i.test(message);
      const retryAfter = Number(res.headers.get('retry-after'));
      if (retryAfter > 0) error.retryAfter = Math.min(retryAfter * 1000, MAX_RETRY_AFTER);
      throw error;
    }

    const blob = await readBody();
    if (as === 'json') {
      try {
        return JSON.parse(await blob.text());
      } catch {
        throw new Error(`${label}: the response wasn't valid JSON.`);
      }
    }
    return blob;
  } finally {
    clearTimeout(timer);
  }
}

function requireKey(key, label) {
  if (!key) throw new Error(`${label}: add an API key in the extension settings.`);
}

async function openaiSpeech({ baseUrl, apiKey, model, voice, instructions }, text, label, options) {
  const body = { model, voice, input: text, response_format: 'mp3' };
  if (instructions && /gpt-4o/.test(model)) body.instructions = instructions;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return request(`${baseUrl.replace(/\/+$/, '')}/audio/speech`, {
    method: 'POST', headers, body: JSON.stringify(body),
  }, label, options);
}

/** Wraps mono 16-bit PCM or Float32 samples in a WAV container. */
export function toWav(samples, sampleRate) {
  const pcm = samples instanceof Int16Array ? samples : floatToInt16(samples);
  const buf = new ArrayBuffer(44 + pcm.byteLength);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + pcm.byteLength, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, pcm.byteLength, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: 'audio/wav' });
}

function floatToInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// --- In-browser voices (Kokoro, Supertonic, Piper, Kitten) via ONNX Runtime Web, in a worker --------------

let worker = null;
let nextId = 0;
const pending = new Map(); // id -> { resolve, reject, onStatus }

function getWorker() {
  if (worker) return worker;
  worker = new Worker(chrome.runtime.getURL('local-worker.js'), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.type === 'status') {
      for (const p of pending.values()) p.onStatus?.(data.status);
      return;
    }
    const p = pending.get(data.id);
    pending.delete(data.id);
    if (!p) return;
    if (data.error) p.reject(new Error(data.error));
    else p.resolve(toWav(data.samples, data.sampleRate));
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(`Local voice worker failed: ${e.message}`));
    pending.clear();
    worker = null;
  };
  return worker;
}

function localSpeech(engine, options, text, onStatus) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject, onStatus });
    getWorker().postMessage({ id, engine, text, options, wasmPaths: chrome.runtime.getURL('ort/') });
  });
}

// --- Engine dispatch ----------------------------------------------------------------------------

export function cacheKey(settings) {
  const e = settings.engine;
  const s = settings[e];
  return `${e}|${JSON.stringify({ ...s, apiKey: undefined })}`;
}

export async function synthesize(settings, text, { onStatus } = {}) {
  switch (settings.engine) {
    case 'openai': {
      const s = settings.openai;
      requireKey(s.apiKey, 'OpenAI');
      return openaiSpeech({ ...s, baseUrl: 'https://api.openai.com/v1' }, text, 'OpenAI', { onStatus });
    }
    case 'localServer': {
      return openaiSpeech({ ...settings.localServer, instructions: '' }, text, 'Local server', { onStatus, timeouts: LOCAL_SERVER_TIMEOUTS });
    }
    case 'elevenlabs': {
      const s = settings.elevenlabs;
      requireKey(s.apiKey, 'ElevenLabs');
      return request(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(s.voiceId)}?output_format=mp3_44100_128`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'xi-api-key': s.apiKey },
          body: JSON.stringify({ text, model_id: s.model }),
        },
        'ElevenLabs',
        { onStatus },
      );
    }
    case 'openrouter': {
      const s = settings.openrouter;
      requireKey(s.apiKey, 'OpenRouter');
      // OpenAI-compatible, but defaults to raw PCM: always ask for MP3. `speed` isn't sent because
      // some providers reject it; the player applies the speed.
      const body = { model: s.model, input: text, voice: s.voice, response_format: 'mp3' };
      if (s.instructions) body.instructions = s.instructions;
      try {
        return await request('https://openrouter.ai/api/v1/audio/speech', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}`, 'X-Title': 'Narro' },
          body: JSON.stringify(body),
        }, 'OpenRouter', { onStatus });
      } catch (error) {
        // OpenRouter answers an unrecognized key with "Missing Authentication header".
        if (/^OpenRouter 401\b/.test(error.message)) error.message = 'OpenRouter 401: the API key wasn\'t accepted. Check it in the extension settings (keys start with sk-or-).';
        throw error;
      }
    }
    case 'gemini': {
      const s = settings.gemini;
      requireKey(s.apiKey, 'Gemini');
      const json = await request(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(s.model)}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': s.apiKey },
          body: JSON.stringify({
            contents: [{ parts: [{ text }] }],
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: s.voice } } },
            },
          }),
        },
        'Gemini',
        { as: 'json', onStatus },
      );
      const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
      if (!part) throw new Error('Gemini returned no audio.');
      const bytes = Uint8Array.from(atob(part.inlineData.data), (c) => c.charCodeAt(0));
      const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType)?.[1] || 24000);
      return toWav(new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1), rate);
    }
    case 'kokoro':
    case 'supertonic':
    case 'piper':
    case 'kitten':
      return localSpeech(settings.engine, settings[settings.engine], text, onStatus);
    default:
      throw new Error(`Unknown engine: ${settings.engine}`);
  }
}
