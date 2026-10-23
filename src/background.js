// Service worker: routes messages between the page (content script), the offscreen audio
// player, and chrome.tts. Kept stateless apart from chrome.storage.session so it survives restarts.
import { getSettings } from './settings.js';

let creatingOffscreen = null;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({ url: 'offscreen.html', reasons: ['AUDIO_PLAYBACK', 'WORKERS'], justification: 'Play synthesized speech; run the local Kokoro TTS model in a worker' })
    .finally(() => (creatingOffscreen = null));
  await creatingOffscreen;
}

async function toOffscreen(msg, { create = true } = {}) {
  if (create) await ensureOffscreen();
  else if (!(await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length) return null;
  return chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
}

function toTab(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

async function claimTab(tabId) {
  const { readerTab } = await chrome.storage.session.get('readerTab');
  if (readerTab != null && readerTab !== tabId) toTab(readerTab, { type: 'tts-event', event: 'preempted' });
  await chrome.storage.session.set({ readerTab: tabId });
}

// --- System voices (chrome.tts) -----------------------------------------------------------------

function systemSpeak(tabId, seq, text, settings) {
  chrome.tts.speak(text, {
    voiceName: settings.system.voiceName || undefined,
    rate: settings.rate,
    enqueue: false,
    onEvent: (e) => {
      if (e.type === 'start') toTab(tabId, { type: 'tts-event', seq, event: 'started' });
      else if (e.type === 'end') toTab(tabId, { type: 'tts-event', seq, event: 'ended' });
      else if (e.type === 'error') toTab(tabId, { type: 'tts-event', seq, event: 'error', message: e.errorMessage });
    },
  });
}

// --- Message handling ---------------------------------------------------------------------------

async function handleFromTab(msg, tabId) {
  const settings = await getSettings();
  const system = settings.engine === 'system';
  switch (msg.type) {
    case 'speak':
      await claimTab(tabId);
      if (system) {
        await toOffscreen({ cmd: 'stop' }, { create: false });
        systemSpeak(tabId, msg.seq, msg.text, settings);
      } else {
        chrome.tts.stop();
        await toOffscreen({ cmd: 'speak', tabId, seq: msg.seq, text: msg.text, prefetch: msg.prefetch, settings });
      }
      return { ok: true };
    case 'pause':
      chrome.tts.pause();
      await toOffscreen({ cmd: 'pause' }, { create: false });
      return { ok: true };
    case 'resume':
      if (system) {
        chrome.tts.resume();
        return { resumed: await chrome.tts.isSpeaking() };
      }
      return (await toOffscreen({ cmd: 'resume', seq: msg.seq }, { create: false })) ?? { resumed: false };
    case 'rate':
      await toOffscreen({ cmd: 'rate', rate: msg.rate }, { create: false });
      return { ok: true };
    case 'stop':
      chrome.tts.stop();
      await toOffscreen({ cmd: 'stop' }, { create: false });
      return { ok: true };
    case 'open-options':
      chrome.runtime.openOptionsPage();
      return { ok: true };
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'offscreen') return; // not for us
  if (msg.target === 'background' && msg.type === 'tts-event') {
    const { tabId, target, type, ...rest } = msg;
    toTab(tabId, { type: 'tts-event', ...rest });
    return;
  }
  if (msg.type === 'start-reading') {
    startReading(msg.tabId, msg.mode).then(sendResponse, (e) => sendResponse({ error: e.message }));
    return true;
  }
  if (sender.tab) {
    handleFromTab(msg, sender.tab.id).then(sendResponse, (e) => sendResponse({ error: e.message }));
    return true;
  }
});

// --- Entry points: popup, keyboard shortcuts, context menu --------------------------------------

async function ensureContent(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'ping' });
    if (res?.pong) return;
  } catch {}
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

async function startReading(tabId, mode = 'toggle') {
  await ensureContent(tabId);
  return chrome.tabs.sendMessage(tabId, { type: 'control', action: mode });
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  const action = { 'toggle-reading': 'toggle', 'next-sentence': 'next', 'prev-sentence': 'prev', 'stop-reading': 'stop', 'pick-start': 'pick' }[command];
  if (action && tab?.id != null) startReading(tab.id, action).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'read-from-here', title: 'Read aloud from here', contexts: ['selection'] });
  chrome.contextMenus.create({ id: 'pick-start', title: 'Choose where to start reading…', contexts: ['page'] });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (tab?.id == null) return;
  const mode = { 'read-from-here': 'from-selection', 'pick-start': 'pick' }[info.menuItemId];
  if (mode) startReading(tab.id, mode).catch(() => {});
});
