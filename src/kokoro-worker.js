// Runs Kokoro-82M off the main thread so generation never blocks playback or pause/stop.
import { KokoroTTS, env } from 'kokoro-js';

let ttsPromise = null;
let loadedDevice = null;

async function load(device, wasmPaths) {
  env.wasmPaths = wasmPaths;
  const useGpu = device === 'webgpu' || (device === 'auto' && 'gpu' in navigator && !!(await navigator.gpu.requestAdapter()));
  const files = new Map();
  let lastPct = -1;
  return KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
    // q8 is fastest on CPU; WebGPU needs fp32 for correct output.
    dtype: useGpu ? 'fp32' : 'q8',
    device: useGpu ? 'webgpu' : 'wasm',
    progress_callback: (p) => {
      if (p.status !== 'progress' || !p.total) return;
      files.set(p.file, p);
      let loaded = 0, total = 0;
      for (const f of files.values()) { loaded += f.loaded; total += f.total; }
      const pct = Math.round((loaded / total) * 100);
      if (pct !== lastPct) postMessage({ type: 'status', status: `Downloading Kokoro model… ${(lastPct = pct)}%` });
    },
  });
}

// Requests arrive in order and are handled one at a time.
let queue = Promise.resolve();

self.onmessage = ({ data }) => {
  const { id, text, voice, device, wasmPaths } = data;
  queue = queue.then(async () => {
    try {
      if (!ttsPromise || loadedDevice !== device) {
        loadedDevice = device;
        postMessage({ type: 'status', status: 'Loading Kokoro model…' });
        ttsPromise = load(device, wasmPaths);
        ttsPromise.catch(() => (ttsPromise = null));
      }
      const tts = await ttsPromise;
      postMessage({ type: 'status', status: '' });
      const audio = await tts.generate(text, { voice });
      postMessage({ type: 'result', id, samples: audio.audio, sampleRate: audio.sampling_rate }, [audio.audio.buffer]);
    } catch (e) {
      postMessage({ type: 'result', id, error: `Kokoro: ${e.message}` });
    }
  });
};
