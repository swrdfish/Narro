// Text-to-speech engines. Each synthesize() returns a playable audio Blob.

async function checkedFetch(url, init, label) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new Error(`${label}: network error (${e.message}). Is the server reachable?`);
  }
  if (!res.ok) {
    // The player shows the message; the raw response is available in its error details.
    let message = '';
    let raw = '';
    try {
      const body = await res.text();
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
    throw error;
  }
  return res;
}

function requireKey(key, label) {
  if (!key) throw new Error(`${label}: add an API key in the extension settings.`);
}

async function openaiSpeech({ baseUrl, apiKey, model, voice, instructions }, text, label) {
  const body = { model, voice, input: text, response_format: 'mp3' };
  if (instructions && /gpt-4o/.test(model)) body.instructions = instructions;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await checkedFetch(`${baseUrl.replace(/\/+$/, '')}/audio/speech`, {
    method: 'POST', headers, body: JSON.stringify(body),
  }, label);
  return res.blob();
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

// --- Kokoro, fully in-browser via ONNX Runtime Web (in a worker) ------------------------------

let worker = null;
let nextId = 0;
const pending = new Map(); // id -> { resolve, reject, onStatus }

function getWorker() {
  if (worker) return worker;
  worker = new Worker(chrome.runtime.getURL('kokoro-worker.js'), { type: 'module' });
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
    for (const p of pending.values()) p.reject(new Error(`Kokoro worker failed: ${e.message}`));
    pending.clear();
    worker = null;
  };
  return worker;
}

function kokoroSpeech({ voice, device }, text, onStatus) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject, onStatus });
    getWorker().postMessage({ id, text, voice, device, wasmPaths: chrome.runtime.getURL('ort/') });
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
      return openaiSpeech({ ...s, baseUrl: 'https://api.openai.com/v1' }, text, 'OpenAI');
    }
    case 'localServer': {
      return openaiSpeech({ ...settings.localServer, instructions: '' }, text, 'Local server');
    }
    case 'elevenlabs': {
      const s = settings.elevenlabs;
      requireKey(s.apiKey, 'ElevenLabs');
      const res = await checkedFetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(s.voiceId)}?output_format=mp3_44100_128`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'xi-api-key': s.apiKey },
          body: JSON.stringify({ text, model_id: s.model }),
        },
        'ElevenLabs',
      );
      return res.blob();
    }
    case 'gemini': {
      const s = settings.gemini;
      requireKey(s.apiKey, 'Gemini');
      const res = await checkedFetch(
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
      );
      const json = await res.json();
      const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
      if (!part) throw new Error('Gemini returned no audio.');
      const bytes = Uint8Array.from(atob(part.inlineData.data), (c) => c.charCodeAt(0));
      const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType)?.[1] || 24000);
      return toWav(new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1), rate);
    }
    case 'kokoro':
      return kokoroSpeech(settings.kokoro, text, onStatus);
    default:
      throw new Error(`Unknown engine: ${settings.engine}`);
  }
}
