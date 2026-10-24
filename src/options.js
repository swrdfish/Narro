import {
  getSettings, saveSettings, OPENAI_VOICES, GEMINI_VOICES, KITTEN_VOICES, KOKORO_VOICES, SUPERTONIC_VOICES, SUPERTONIC_LANGUAGES,
} from './settings.js';
import { PAGE_SHORTCUTS, shortcutKeys } from './shortcuts.js';
import { enhanceSelects } from './select.js';

const $ = (sel) => document.querySelector(sel);
let settings;

// Network access is optional: Chrome asks only when someone selects an engine that needs it.
// This keeps a fresh install's permission prompt focused on reading the current tab. In-browser
// voices need no prompt: Hugging Face allows the model downloads from any origin.
const ENGINE_ORIGINS = {
  openai: ['https://api.openai.com/*'],
  elevenlabs: ['https://api.elevenlabs.io/*'],
  gemini: ['https://generativelanguage.googleapis.com/*'],
  openrouter: ['https://openrouter.ai/*'],
  localServer: ['http://localhost/*', 'http://127.0.0.1/*'],
};
const ENGINE_SERVICES = {
  openai: 'OpenAI',
  elevenlabs: 'ElevenLabs',
  gemini: 'Google Gemini',
  openrouter: 'OpenRouter',
  localServer: 'your local server',
};
const CLOUD_ENGINES = new Set(['openai', 'elevenlabs', 'gemini', 'openrouter']);

async function ensureEngineAccess(engine) {
  const origins = ENGINE_ORIGINS[engine];
  if (!origins) return true;
  if (await chrome.permissions.contains({ origins })) return true;
  const granted = await chrome.permissions.request({ origins });
  if (!granted) setStatus(`Narro needs access to ${ENGINE_SERVICES[engine]} to use this voice.`, true);
  return granted;
}

const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], obj)[last] = value;
}

function fillSelect(select, options, current) {
  select.replaceChildren(...Object.entries(options).map(([value, label]) => new Option(label, value)));
  if (current && !(current in options)) select.add(new Option(current, current), 0);
  select.value = current;
}

const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.6 6.6A17.4 17.4 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

// Adds a show/hide button inside each API key field.
function addRevealButtons() {
  for (const input of document.querySelectorAll('.secret input')) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'reveal';
    const render = () => {
      const shown = input.type === 'text';
      button.innerHTML = shown ? EYE_OFF : EYE;
      button.setAttribute('aria-label', shown ? 'Hide API key' : 'Show API key');
      button.setAttribute('aria-pressed', String(shown));
      button.title = button.getAttribute('aria-label');
    };
    button.addEventListener('click', () => {
      input.type = input.type === 'password' ? 'text' : 'password';
      render();
    });
    render();
    input.after(button);
  }
}

// --- Now reading: pause/resume or stop whichever tab is reading ---

const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';
const STATUS_LABELS = { playing: 'Reading', loading: 'Starting…', paused: 'Paused' };

function renderNowReading(state) {
  $('#now-reading').hidden = !state;
  if (!state) return;
  $('#now-status').textContent = STATUS_LABELS[state.status] || '';
  $('#now-status').dataset.status = state.status;
  $('#now-page').textContent = state.title || 'Untitled page';
  const paused = state.status === 'paused';
  $('#now-toggle').innerHTML = paused ? PLAY_ICON : PAUSE_ICON;
  $('#now-toggle').setAttribute('aria-label', paused ? 'Resume reading' : 'Pause reading');
  $('#now-toggle').title = $('#now-toggle').getAttribute('aria-label');
}

async function setUpNowReading() {
  const key = 'readerState';
  renderNowReading((await chrome.storage.session.get(key))[key]);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && key in changes) renderNowReading(changes[key].newValue);
  });
  const control = (action) => chrome.runtime.sendMessage({ type: 'remote-control', action });
  $('#now-toggle').onclick = () => control('toggle');
  $('#now-stop').onclick = () => control('stop');
  $('#now-title').onclick = async () => {
    const { [key]: state } = await chrome.storage.session.get(key);
    if (!state) return;
    const tab = await chrome.tabs.update(state.tabId, { active: true }).catch(() => null);
    if (tab) await chrome.windows.update(tab.windowId, { focused: true });
  };
}

// --- Keyboard shortcuts, in the platform's notation ---
// The player's keys work on the page while it shows; Chrome's own shortcuts (any page) are optional.

const CHROME_SHORTCUTS = [
  ['play-pause', 'Play / pause on any page'],
  ['pick-start', 'Choose where to start'],
];
function keyCaps(keys) {
  return keys.map(({ label, name }) => {
    const kbd = document.createElement('kbd');
    kbd.textContent = label;
    if (name !== label) kbd.title = name;
    return kbd;
  });
}

async function renderShortcuts() {
  const mac = (await chrome.runtime.getPlatformInfo()).os === 'mac';
  const assigned = Object.fromEntries((await chrome.commands.getAll()).map((command) => [command.name, command.shortcut]));
  const list = $('#shortcuts');
  list.replaceChildren();
  const row = (label, content) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.append(...content);
    list.append(dt, dd);
  };
  for (const { label, keys } of PAGE_SHORTCUTS) row(label, keyCaps(shortcutKeys(keys, mac)));
  row('Jump to a sentence', keyCaps([...shortcutKeys('Alt', mac), { label: 'Click', name: 'Mouse click' }]));
  // Chrome's shortcuts work everywhere, so they're only listed once someone has set one.
  for (const [name, label] of CHROME_SHORTCUTS) {
    const keys = shortcutKeys(assigned[name], mac);
    if (keys.length) row(label, keyCaps(keys));
  }
}

function updateRangeFill(range) {
  const { min, max, value } = range;
  range.style.setProperty('--fill', `${((value - min) / (max - min)) * 100}%`);
}

// Style instructions only apply to gpt-4o speech models.
function updateStyleField() {
  $('#openai-style').hidden = !/gpt-4o/.test(settings.openai.model);
}

// --- OpenRouter: speech models and their voices, listed live (public, no key needed) ---

let openrouterModels = null; // id -> { name, voices }

async function loadOpenRouterModels() {
  if (openrouterModels) return openrouterModels;
  const res = await fetch('https://openrouter.ai/api/v1/models?output_modalities=speech');
  if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
  const { data = [] } = await res.json();
  // Models without named voices only work by cloning a reference recording, which doesn't fit here.
  openrouterModels = Object.fromEntries(data
    .filter((model) => Array.isArray(model.supported_voices) && model.supported_voices.length)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((model) => [model.id, { name: model.name, voices: model.supported_voices.map(String) }]));
  return openrouterModels;
}

function fillOpenRouterVoices() {
  const voices = openrouterModels?.[settings.openrouter.model]?.voices;
  if (!voices) {
    fillSelect($('#openrouter-voices'), { [settings.openrouter.voice]: settings.openrouter.voice }, settings.openrouter.voice);
    return;
  }
  // Keep the current voice if the model has it; otherwise switch to the model's first voice.
  if (!voices.includes(settings.openrouter.voice)) {
    settings.openrouter.voice = voices[0];
    scheduleSave();
  }
  fillSelect($('#openrouter-voices'), Object.fromEntries(voices.map((voice) => [voice, voice])), settings.openrouter.voice);
}

async function showOpenRouterModels() {
  const models = await loadOpenRouterModels();
  fillSelect($('#openrouter-models'), Object.fromEntries(Object.entries(models).map(([id, model]) => [id, model.name])), settings.openrouter.model);
  fillOpenRouterVoices();
}

// Model lists per engine ({ id: label }), from models.json. A saved model missing from a list stays selectable.
async function loadModels() {
  try {
    const res = await fetch(chrome.runtime.getURL('models.json'));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    setStatus(`Couldn't load models.json: ${e.message}`, true);
    return {};
  }
}

// --- Download size and memory of the in-browser models (models.json "local") ---

// Auto runs Kokoro and Supertonic on WebGPU when the browser offers an adapter, as the voice worker
// decides (local-worker.js useWebGpu), so the sizes shown are the ones that will download.
let webGpuAvailable = false;
async function detectWebGpu() {
  // Don't hold up the popup if the GPU is slow to answer.
  const timeout = new Promise((resolve) => setTimeout(resolve, 1000, null));
  webGpuAvailable = 'gpu' in navigator && !!(await Promise.race([navigator.gpu.requestAdapter().catch(() => null), timeout]));
}
const deviceFor = (engine) => {
  const device = settings[engine].device;
  return device === 'auto' ? (webGpuAvailable ? 'webgpu' : 'wasm') : device;
};

// The model the current settings use: the device's build for Kokoro and Supertonic, the chosen Piper
// voice, or Kitten's one model.
function localSize(local, engine) {
  const spec = local?.[engine];
  if (engine === 'piper') return spec?.[settings.piper.voice];
  return engine === 'kitten' ? spec : spec?.[deviceFor(engine)];
}

function fillSpecs(list, rows) {
  list.replaceChildren(...rows.map(([term, value]) => {
    const row = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = term;
    dd.textContent = value;
    row.append(dt, dd);
    return row;
  }));
}

const PEAK = 'at its peak while reading, for all of Narro';

function renderLocalSpecs(local) {
  for (const engine of ['kokoro', 'supertonic']) {
    const size = localSize(local, engine);
    if (!size) continue;
    const device = deviceFor(engine) === 'webgpu' ? 'WebGPU' : 'CPU';
    const auto = settings[engine].device === 'auto' ? ` (Auto uses ${device} on this computer)` : '';
    const parameters = local[engine].parameters;
    fillSpecs($(`#${engine}-specs`), [
      ['Download', `${size.downloadMB} MB, the ${device} model${auto}`],
      ['Memory', `About ${size.memoryMB} MB ${PEAK}`],
      ['Model', `${parameters[0].toUpperCase()}${parameters.slice(1)} parameters`],
    ]);
  }
  const kitten = localSize(local, 'kitten');
  if (kitten) {
    fillSpecs($('#kitten-specs'), [
      ['Download', `${kitten.downloadMB} MB, all 8 voices`],
      ['Memory', `About ${kitten.memoryMB} MB ${PEAK}`],
      ['Model', `${kitten.parameters[0].toUpperCase()}${kitten.parameters.slice(1)} parameters`],
    ]);
  }
  const voice = localSize(local, 'piper');
  fillSpecs($('#piper-specs'), voice ? [
    ['Download', `${voice.downloadMB} MB for this voice`],
    ['Memory', `About ${voice.memoryMB} MB ${PEAK}`],
  ] : []);
}

// The engine list and the Piper voice list show sizes as a second line under each choice.
function labelLocalSizes(local) {
  for (const engine of ['kokoro', 'supertonic', 'piper', 'kitten']) {
    const size = localSize(local, engine);
    const option = $(`#engine option[value="${engine}"]`);
    if (size && option) option.dataset.detail = `Download ${size.downloadMB} MB · Memory about ${size.memoryMB} MB`;
  }
  for (const option of $('#piper-voices').options) {
    const size = local?.piper?.[option.value];
    if (size) option.dataset.detail = `${size.downloadMB} MB download`;
  }
}

function setStatus(text, isError = false) {
  $('#status').textContent = text;
  $('#status').classList.toggle('error', isError);
}

function showEngine() {
  for (const el of document.querySelectorAll('.engine')) el.classList.toggle('active', el.dataset.engine === settings.engine);
  $('#cloud-disclosure').hidden = !CLOUD_ENGINES.has(settings.engine);
  loadDynamicVoices();
}

let voiceErrorShown = false; // only clear the status line if this loader set it

async function loadDynamicVoices() {
  try {
    if (settings.engine === 'elevenlabs' && settings.elevenlabs.apiKey) {
      const res = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': settings.elevenlabs.apiKey } });
      if (!res.ok) throw new Error(`ElevenLabs ${res.status}`);
      const { voices } = await res.json();
      fillSelect($('#elevenlabs-voices'), Object.fromEntries(voices.map((v) => [v.voice_id, v.name])), settings.elevenlabs.voiceId);
    } else if (settings.engine === 'localServer') {
      const base = settings.localServer.baseUrl.replace(/\/+$/, '');
      const [voicesRes, modelsRes] = await Promise.all([fetch(`${base}/audio/voices`).catch(() => null), fetch(`${base}/models`).catch(() => null)]);
      if (voicesRes?.ok) {
        const { voices = [] } = await voicesRes.json();
        $('#local-voices').replaceChildren(...voices.map((v) => new Option(typeof v === 'string' ? v : v.id ?? v.name)));
      }
      if (modelsRes?.ok) {
        const { data = [] } = await modelsRes.json();
        const ids = data.map((m) => m.id).filter(Boolean);
        if (ids.length) fillSelect($('#local-models'), Object.fromEntries(ids.map((id) => [id, id])), settings.localServer.model);
      }
    } else if (settings.engine === 'openrouter') {
      await showOpenRouterModels();
    } else if (settings.engine === 'system') {
      const voices = await chrome.tts.getVoices();
      fillSelect($('#system-voices'), { '': 'Default', ...Object.fromEntries(voices.map((v) => [v.voiceName, `${v.voiceName}${v.lang ? ` (${v.lang})` : ''}`])) }, settings.system.voiceName);
    }
    if (voiceErrorShown) setStatus('');
    voiceErrorShown = false;
  } catch (e) {
    if (settings.engine !== 'localServer') {
      setStatus(`Couldn't load voices: ${e.message}`, true);
      voiceErrorShown = true;
    }
  }
}

let saveTimer;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveSettings(settings), 250);
}

async function init() {
  // Styled dropdowns over the native selects; they follow the options and values set below.
  enhanceSelects(document);
  settings = await getSettings();

  fillSelect($('#openai-voices'), Object.fromEntries(OPENAI_VOICES.map((v) => [v, v])), settings.openai.voice);
  fillSelect($('#gemini-voices'), Object.fromEntries(GEMINI_VOICES.map((v) => [v, v])), settings.gemini.voice);
  fillSelect($('#kokoro-voices'), KOKORO_VOICES, settings.kokoro.voice);
  fillSelect($('#supertonic-voices'), SUPERTONIC_VOICES, settings.supertonic.voice);
  fillSelect($('#kitten-voices'), KITTEN_VOICES, settings.kitten.voice);
  fillSelect($('#supertonic-languages'), SUPERTONIC_LANGUAGES, settings.supertonic.language);
  fillSelect($('#elevenlabs-voices'), { [settings.elevenlabs.voiceId]: 'George (default) — add API key to list voices' }, settings.elevenlabs.voiceId);
  const models = await loadModels();
  fillSelect($('#openai-models'), models.openai || {}, settings.openai.model);
  fillSelect($('#elevenlabs-models'), models.elevenlabs || {}, settings.elevenlabs.model);
  fillSelect($('#gemini-models'), models.gemini || {}, settings.gemini.model);
  // Until OpenRouter's list loads, show the saved choices.
  fillSelect($('#openrouter-models'), { [settings.openrouter.model]: settings.openrouter.model }, settings.openrouter.model);
  fillOpenRouterVoices();
  fillSelect($('#piper-voices'), models.piper || {}, settings.piper.voice);
  await detectWebGpu();
  labelLocalSizes(models.local);
  renderLocalSpecs(models.local);
  // The local server's own model list is loaded once it's reachable (see loadDynamicVoices).
  fillSelect($('#local-models'), { [settings.localServer.model]: settings.localServer.model }, settings.localServer.model);
  addRevealButtons();

  $('#engine').value = settings.engine;
  $('#engine').onchange = async () => {
    const previous = settings.engine;
    const next = $('#engine').value;
    if (!await ensureEngineAccess(next)) {
      $('#engine').value = previous;
      return;
    }
    settings.engine = next;
    showEngine();
    scheduleSave();
  };

  for (const el of document.querySelectorAll('[data-key]')) {
    const key = el.dataset.key;
    const value = getPath(settings, key);
    if (el.type === 'checkbox') el.checked = value;
    else el.value = value;
    el.addEventListener('input', () => {
      const v = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value.trim();
      setPath(settings, key, v);
      if (key === 'rate') {
        $('#rate-out').textContent = `${v.toFixed(1)}×`;
        updateRangeFill(el);
      }
      if (key === 'openai.model') updateStyleField();
      if (key === 'openrouter.model') fillOpenRouterVoices();
      if (/^(kokoro|supertonic)\.device$|^piper\.voice$/.test(key)) {
        labelLocalSizes(models.local);
        renderLocalSpecs(models.local);
      }
      scheduleSave();
    });
    // Refresh voice lists once a key or server URL is entered.
    if (/apiKey|baseUrl/.test(key)) el.addEventListener('change', loadDynamicVoices);
  }
  $('#rate-out').textContent = `${settings.rate.toFixed(1)}×`;
  updateRangeFill($('input[type=range]'));
  updateStyleField();

  // The read buttons only make sense in the toolbar popup, where the active tab is the page.
  $('.actions').hidden = !location.search.includes('popup');
  $('#read').onclick = () => startOnPage('toggle');
  $('#pick').onclick = () => startOnPage('pick');

  async function startOnPage(mode) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || /^(chrome|edge|about|chrome-extension):/.test(tab.url || '')) {
      setStatus("Chrome doesn't allow reading this page.", true);
      return;
    }
    if (!await ensureEngineAccess(settings.engine)) return;
    clearTimeout(saveTimer);
    await saveSettings(settings);
    const res = await chrome.runtime.sendMessage({ type: 'start-reading', tabId: tab.id, mode });
    if (res?.error) setStatus(res.error, true);
    else window.close();
  }

  renderShortcuts();
  setUpNowReading();
  $('#change-shortcuts').onclick = () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });

  showEngine();
}

init();
