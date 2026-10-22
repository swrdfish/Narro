// Shared settings schema. API keys live in chrome.storage.local (never synced).

export const DEFAULT_SETTINGS = {
  engine: 'openai', // openai | elevenlabs | gemini | kokoro | localServer | system
  rate: 1.0,
  skipIncompleteLast: true,
  autoScroll: true,
  openai: {
    apiKey: '',
    model: 'gpt-4o-mini-tts',
    voice: 'coral',
    instructions: 'Read in a natural, engaging audiobook narration style.',
  },
  elevenlabs: {
    apiKey: '',
    model: 'eleven_flash_v2_5',
    voiceId: 'JBFqnCBsd6RMkjVDRZzb',
  },
  gemini: {
    apiKey: '',
    model: 'gemini-2.5-flash-preview-tts',
    voice: 'Kore',
  },
  kokoro: {
    voice: 'af_heart',
    device: 'auto', // auto | webgpu | wasm
  },
  localServer: {
    // Any OpenAI-compatible /audio/speech server: Kokoro-FastAPI, Orpheus-FastAPI, LocalAI, etc.
    baseUrl: 'http://localhost:8880/v1',
    apiKey: '',
    model: 'kokoro',
    voice: 'af_heart',
  },
  system: {
    voiceName: '',
  },
};

export const ENGINES = {
  openai: { label: 'OpenAI', kind: 'cloud' },
  elevenlabs: { label: 'ElevenLabs', kind: 'cloud' },
  gemini: { label: 'Google Gemini', kind: 'cloud' },
  kokoro: { label: 'Kokoro (in-browser)', kind: 'local' },
  localServer: { label: 'Local server (OpenAI-compatible)', kind: 'local' },
  system: { label: 'System voices', kind: 'local' },
};

export const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];

export const GEMINI_VOICES = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'];

export const KOKORO_VOICES = {
  af_heart: 'Heart (US F)', af_bella: 'Bella (US F)', af_nicole: 'Nicole (US F)', af_aoede: 'Aoede (US F)',
  af_kore: 'Kore (US F)', af_sarah: 'Sarah (US F)', af_nova: 'Nova (US F)', af_sky: 'Sky (US F)', af_alloy: 'Alloy (US F)',
  am_fenrir: 'Fenrir (US M)', am_michael: 'Michael (US M)', am_puck: 'Puck (US M)', am_echo: 'Echo (US M)', am_eric: 'Eric (US M)',
  am_liam: 'Liam (US M)', am_onyx: 'Onyx (US M)', am_adam: 'Adam (US M)',
  bf_emma: 'Emma (UK F)', bf_isabella: 'Isabella (UK F)', bf_alice: 'Alice (UK F)', bf_lily: 'Lily (UK F)',
  bm_george: 'George (UK M)', bm_fable: 'Fable (UK M)', bm_lewis: 'Lewis (UK M)', bm_daniel: 'Daniel (UK M)',
};

export async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return mergeDeep(structuredClone(DEFAULT_SETTINGS), stored.settings || {});
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}

function mergeDeep(base, extra) {
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      mergeDeep(base[k], v);
    } else {
      base[k] = v;
    }
  }
  return base;
}
