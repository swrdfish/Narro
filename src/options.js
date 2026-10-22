import { getSettings, saveSettings, OPENAI_VOICES, GEMINI_VOICES, KOKORO_VOICES } from './settings.js';

const $ = (sel) => document.querySelector(sel);
let settings;

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

function setStatus(text, isError = false) {
  $('#status').textContent = text;
  $('#status').classList.toggle('error', isError);
}

function showEngine() {
  for (const el of document.querySelectorAll('.engine')) el.classList.toggle('active', el.dataset.engine === settings.engine);
  loadDynamicVoices();
}

async function loadDynamicVoices() {
  try {
    if (settings.engine === 'elevenlabs' && settings.elevenlabs.apiKey) {
      const res = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': settings.elevenlabs.apiKey } });
      if (!res.ok) throw new Error(`ElevenLabs ${res.status}`);
      const { voices } = await res.json();
      fillSelect($('#elevenlabs-voices'), Object.fromEntries(voices.map((v) => [v.voice_id, v.name])), settings.elevenlabs.voiceId);
    } else if (settings.engine === 'localServer') {
      const res = await fetch(`${settings.localServer.baseUrl.replace(/\/+$/, '')}/audio/voices`);
      if (res.ok) {
        const { voices = [] } = await res.json();
        $('#local-voices').replaceChildren(...voices.map((v) => new Option(typeof v === 'string' ? v : v.id ?? v.name)));
      }
    } else if (settings.engine === 'system') {
      const voices = await chrome.tts.getVoices();
      fillSelect($('#system-voices'), { '': 'Default', ...Object.fromEntries(voices.map((v) => [v.voiceName, `${v.voiceName}${v.lang ? ` (${v.lang})` : ''}`])) }, settings.system.voiceName);
    }
    setStatus('');
  } catch (e) {
    if (settings.engine !== 'localServer') setStatus(`Couldn't load voices: ${e.message}`, true);
  }
}

let saveTimer;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveSettings(settings), 250);
}

async function init() {
  settings = await getSettings();

  fillSelect($('#openai-voices'), Object.fromEntries(OPENAI_VOICES.map((v) => [v, v])), settings.openai.voice);
  fillSelect($('#gemini-voices'), Object.fromEntries(GEMINI_VOICES.map((v) => [v, v])), settings.gemini.voice);
  fillSelect($('#kokoro-voices'), KOKORO_VOICES, settings.kokoro.voice);
  fillSelect($('#elevenlabs-voices'), { [settings.elevenlabs.voiceId]: 'George (default) — add API key to list voices' }, settings.elevenlabs.voiceId);

  $('#engine').value = settings.engine;
  $('#engine').onchange = () => {
    settings.engine = $('#engine').value;
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
      if (key === 'rate') $('#rate-out').textContent = `${v.toFixed(1)}×`;
      scheduleSave();
    });
    // Refresh voice lists once a key or server URL is entered.
    if (/apiKey|baseUrl/.test(key)) el.addEventListener('change', loadDynamicVoices);
  }
  $('#rate-out').textContent = `${settings.rate.toFixed(1)}×`;

  // The read button only makes sense in the toolbar popup, where the active tab is the page.
  $('#read').hidden = !location.search.includes('popup');
  $('#read').onclick = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || /^(chrome|edge|about|chrome-extension):/.test(tab.url || '')) {
      setStatus("Chrome doesn't allow reading this page.", true);
      return;
    }
    clearTimeout(saveTimer);
    await saveSettings(settings);
    const res = await chrome.runtime.sendMessage({ type: 'start-reading', tabId: tab.id, mode: 'toggle' });
    if (res?.error) setStatus(res.error, true);
    else window.close();
  };

  showEngine();
}

init();
