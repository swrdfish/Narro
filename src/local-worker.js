// Runs the in-browser voices (Kokoro, Supertonic, Piper, Kitten) off the main thread, so generation never
// blocks playback or pause/stop. One model is kept loaded at a time.
import { KokoroTTS, env as kokoroEnv } from 'kokoro-js';
import { pipeline } from '@huggingface/transformers';
import * as ort from 'onnxruntime-web';
import { phonemize } from 'phonemizer';
import { downloadProgress } from './progress.js';
import { KITTEN_MODEL, KITTEN_SAMPLE_RATE, KITTEN_TRIM_SAMPLES, KITTEN_VOICE_IDS, kittenChunks, kittenSpeed, kittenStyle, kittenTokens, readNpz } from './kitten.js';

const ENGINE_NAMES = { kokoro: 'Kokoro', supertonic: 'Supertonic', piper: 'Piper', kitten: 'Kitten TTS' };

// Keep chrome://extensions → Errors for real problems. ONNX Runtime warns, for example, when a few
// model nodes run on the CPU under WebGPU (expected, "to improve perf"), and Transformers.js warns
// when a download has no Content-Length header (it grows its buffer instead). Neither affects speech.
ort.env.logLevel = 'error';
const consoleWarn = console.warn.bind(console);
console.warn = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith('Unable to determine content-length')) return;
  consoleWarn(...args);
};

const status = (text) => postMessage({ type: 'status', status: text });

async function useWebGpu(device) {
  return device === 'webgpu' || (device === 'auto' && 'gpu' in navigator && !!(await navigator.gpu.requestAdapter()));
}

const progressReporter = (label) => downloadProgress(label, status);

// --- Kokoro ---------------------------------------------------------------------------------------

async function loadKokoro({ device }) {
  const gpu = await useWebGpu(device);
  const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
    // q8 is fastest on CPU; WebGPU needs fp32 for correct output.
    dtype: gpu ? 'fp32' : 'q8',
    device: gpu ? 'webgpu' : 'wasm',
    progress_callback: progressReporter('Kokoro model'),
  });
  return async (text, { voice }) => {
    const audio = await tts.generate(text, { voice });
    return { samples: audio.audio, sampleRate: audio.sampling_rate };
  };
}

// --- Supertonic (Supertone, via the Transformers.js text-to-speech pipeline) ---------------------

const SUPERTONIC = 'onnx-community/Supertonic-TTS-2-ONNX';

async function loadSupertonic({ device }) {
  const gpu = await useWebGpu(device);
  const tts = await pipeline('text-to-speech', SUPERTONIC, {
    dtype: 'fp32',
    device: gpu ? 'webgpu' : 'wasm',
    progress_callback: progressReporter('Supertonic model'),
  });
  return async (text, { voice, language }) => {
    const out = await tts(`<${language}>${text}</${language}>`, {
      speaker_embeddings: `https://huggingface.co/${SUPERTONIC}/resolve/main/voices/${voice}.bin`,
      num_inference_steps: 5, // the model card's recommended quality/speed balance
      speed: 1, // playback speed is applied by the player
    });
    return { samples: out.audio, sampleRate: out.sampling_rate };
  };
}

// --- Piper (rhasspy/piper voices: espeak phonemes → VITS model) ----------------------------------

const PIPER_VOICES = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';

// "en_US-lessac-medium" → "en/en_US/lessac/medium/en_US-lessac-medium"
function piperPath(name) {
  const parts = name.split('-');
  const [lang, quality] = [parts[0], parts.at(-1)];
  const speaker = parts.slice(1, -1).join('-');
  return `${lang.split('_')[0]}/${lang}/${speaker}/${quality}/${name}`;
}

// Fetches a file once and keeps it in the browser's cache, reporting download progress.
async function cachedFetch(url, onProgress, cacheName = 'narro-piper') {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(url);
  if (hit) return hit.arrayBuffer();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`couldn't download ${url.split('/').pop()} (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.({ status: 'progress', file: url, loaded, total: total || loaded });
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  await cache.put(url, new Response(bytes)).catch(() => {});
  return bytes.buffer;
}

// Punctuation stays as-is: Piper's and Kitten's symbol tables include it and use it for pauses and intonation.
const PUNCTUATION = /(\s*[;:,.!?¡¿—…"«»“”(){}[\]]+\s*)+/g;

async function espeakPhonemes(text, espeakVoice) {
  let result = '';
  let last = 0;
  for (const match of text.matchAll(PUNCTUATION)) {
    if (match.index > last) result += (await phonemize(text.slice(last, match.index), espeakVoice)).join(' ');
    result += match[0].replace(/\s+/g, ' ');
    last = match.index + match[0].length;
  }
  if (last < text.length) result += (await phonemize(text.slice(last), espeakVoice)).join(' ');
  return result.trim();
}

async function loadPiper({ voice }) {
  const base = `${PIPER_VOICES}/${piperPath(voice)}`;
  const report = progressReporter(`Piper voice ${voice}`);
  const config = JSON.parse(new TextDecoder().decode(await cachedFetch(`${base}.onnx.json`)));
  const model = await cachedFetch(`${base}.onnx`, report);
  status('Loading Piper voice…');
  const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
  const ids = config.phoneme_id_map;
  const { noise_scale: noise = 0.667, length_scale: length = 1, noise_w: noiseW = 0.8 } = config.inference || {};
  return async (text) => {
    const phonemes = await espeakPhonemes(text, config.espeak?.voice || 'en-us');
    // Piper's encoding: ^ then each phoneme followed by the pad symbol, then $.
    const sequence = [...ids['^'], ...ids._];
    for (const symbol of phonemes) {
      if (!ids[symbol]) continue;
      sequence.push(...ids[symbol], ...ids._);
    }
    sequence.push(...ids.$);
    const feeds = {
      input: new ort.Tensor('int64', BigInt64Array.from(sequence, BigInt), [1, sequence.length]),
      input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(sequence.length)]), [1]),
      scales: new ort.Tensor('float32', Float32Array.from([noise, length, noiseW]), [3]),
    };
    if (config.num_speakers > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
    const output = await session.run(feeds);
    return { samples: Float32Array.from(output.output.data), sampleRate: config.audio.sample_rate };
  };
}

// --- Kitten TTS Nano (KittenML; espeak phonemes → StyleTTS 2-style model, see kitten.js) ----------

async function loadKitten() {
  const report = progressReporter('Kitten TTS model');
  const voices = readNpz(await cachedFetch(`${KITTEN_MODEL}/voices.npz`, null, 'narro-kitten'));
  const model = await cachedFetch(`${KITTEN_MODEL}/kitten_tts_nano_v0_8.onnx`, report, 'narro-kitten');
  status('Loading Kitten TTS…');
  const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
  return async (text, { voice }) => {
    const id = KITTEN_VOICE_IDS[voice] || voice;
    if (!voices[id]) throw new Error(`no voice named ${voice}`);
    // Like the reference: one sentence at a time, joined, each with its end silence trimmed.
    const parts = [];
    for (const chunk of kittenChunks(text)) {
      const tokens = kittenTokens(await espeakPhonemes(chunk, 'en-us'));
      const output = await session.run({
        input_ids: new ort.Tensor('int64', BigInt64Array.from(tokens, BigInt), [1, tokens.length]),
        style: new ort.Tensor('float32', Float32Array.from(kittenStyle(voices[id], chunk.length)), [1, voices[id].shape[1]]),
        speed: new ort.Tensor('float32', Float32Array.from([kittenSpeed(id)]), [1]),
      });
      const audio = output[session.outputNames[0]].data;
      parts.push(audio.subarray(0, Math.max(0, audio.length - KITTEN_TRIM_SAMPLES)));
    }
    const samples = new Float32Array(parts.reduce((n, part) => n + part.length, 0));
    let offset = 0;
    for (const part of parts) { samples.set(part, offset); offset += part.length; }
    return { samples, sampleRate: KITTEN_SAMPLE_RATE };
  };
}

// --- Dispatch -----------------------------------------------------------------------------------

const LOADERS = { kokoro: loadKokoro, supertonic: loadSupertonic, piper: loadPiper, kitten: loadKitten };
// What determines a reload: switching engine, device, or (for Piper) voice.
const modelKey = (engine, options) => JSON.stringify([engine, options.device, engine === 'piper' ? options.voice : '']);

let loaded = null; // { key, generate: Promise<fn> }
let queue = Promise.resolve(); // requests are handled one at a time

self.onmessage = ({ data }) => {
  const { id, engine, text, options, wasmPaths } = data;
  const name = ENGINE_NAMES[engine] || engine;
  queue = queue.then(async () => {
    try {
      kokoroEnv.wasmPaths = wasmPaths; // shared ONNX Runtime settings, also used by Supertonic and Piper
      ort.env.wasm.wasmPaths = wasmPaths;
      const key = modelKey(engine, options);
      if (loaded?.key !== key) {
        status(`Loading ${name}…`);
        const generate = LOADERS[engine](options);
        loaded = { key, generate };
        generate.catch(() => { if (loaded?.generate === generate) loaded = null; });
      }
      const generate = await loaded.generate;
      status('');
      const { samples, sampleRate } = await generate(text, options);
      postMessage({ type: 'result', id, samples, sampleRate }, [samples.buffer]);
    } catch (e) {
      postMessage({ type: 'result', id, error: `${name}: ${e.message}` });
    }
  });
};
