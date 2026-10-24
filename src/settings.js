// Shared settings schema. API keys live in chrome.storage.local (never synced).

export const DEFAULT_SETTINGS = {
  // Kokoro by default: it runs in the browser, so a new install reads aloud with no API key.
  engine: 'kokoro', // openai | elevenlabs | gemini | kokoro | localServer | system
  rate: 1.0,
  skipIncompleteLast: true,
  autoScroll: true,
  autoTurnPages: true, // Kindle: turn the page and keep reading at the end of a page
  earlyPageTurn: true, // Kindle: turn near the end of the second-to-last sentence, to hide OCR time
  openai: {
    apiKey: '',
    model: 'gpt-4o-mini-tts',
    voice: 'nova',
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
  openrouter: {
    // One key for many providers' speech models; the popup lists them live from OpenRouter.
    apiKey: '',
    model: 'google/gemini-3.8-flash-tts',
    voice: 'Kore',
    instructions: '', // honored by some models (e.g. OpenAI, Gemini), ignored by others
  },
  kokoro: {
    voice: 'af_heart',
    device: 'auto', // auto | webgpu | wasm
  },
  supertonic: {
    voice: 'F1', // F1–F5, M1–M5
    language: 'en', // en | es | fr | pt | ko
    device: 'auto',
  },
  piper: {
    voice: 'en_US-lessac-medium', // see models.json "piper"
  },
  kitten: {
    voice: 'Jasper', // see KITTEN_VOICES
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
  openrouter: { label: 'OpenRouter', kind: 'cloud' },
  kokoro: { label: 'Kokoro (in-browser)', kind: 'local' },
  supertonic: { label: 'Supertonic (in-browser)', kind: 'local' },
  piper: { label: 'Piper (in-browser)', kind: 'local' },
  kitten: { label: 'Kitten TTS Nano (in-browser)', kind: 'local' },
  localServer: { label: 'Local server (OpenAI-compatible)', kind: 'local' },
  system: { label: 'System voices', kind: 'local' },
};

export const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];

export const GEMINI_VOICES = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'];

export const SUPERTONIC_VOICES = {
  F1: 'Female 1', F2: 'Female 2', F3: 'Female 3', F4: 'Female 4', F5: 'Female 5',
  M1: 'Male 1', M2: 'Male 2', M3: 'Male 3', M4: 'Male 4', M5: 'Male 5',
};

export const SUPERTONIC_LANGUAGES = { en: 'English', es: 'Spanish', fr: 'French', pt: 'Portuguese', ko: 'Korean' };

// Kitten TTS Nano 0.8's voices (US English).
export const KITTEN_VOICES = {
  Jasper: 'Jasper (M)', Bella: 'Bella (F)', Luna: 'Luna (F)', Bruno: 'Bruno (M)',
  Rosie: 'Rosie (F)', Hugo: 'Hugo (M)', Kiki: 'Kiki (F)', Leo: 'Leo (M)',
};

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
