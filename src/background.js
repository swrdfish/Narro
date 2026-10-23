// Service worker: routes messages between the page (content script), the offscreen audio
// player, and chrome.tts. Kept stateless apart from chrome.storage.session so it survives restarts.
import { getSettings } from './settings.js';
import { captureKindle } from './kindle-capture.js';
import { isKindleUrl } from './kindle-data.js';

let creatingOffscreen = null;
const kindleRequests = new Map();

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({ url: 'offscreen.html', reasons: ['AUDIO_PLAYBACK', 'WORKERS'], justification: 'Play synthesized speech; run local Kokoro and Kindle OCR workers; process Kindle page images' })
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
  await chrome.storage.session.set({ readerTab: tabId });
  if (readerTab != null && readerTab !== tabId) toTab(readerTab, { type: 'tts-event', event: 'preempted' });
}

async function stopSpeech() {
  chrome.tts.stop();
  await toOffscreen({ cmd: 'stop' }, { create: false });
}

// The reading page holds a port open while reading. Chrome closes it when the page is refreshed,
// navigated away or closed, so the audio stops with it instead of playing on in the background.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'reader' || !port.sender?.tab) return;
  const tabId = port.sender.tab.id;
  port.onDisconnect.addListener(async () => {
    const { readerTab } = await chrome.storage.session.get('readerTab');
    if (readerTab !== tabId) return; // another tab is reading now
    await chrome.storage.session.remove('readerTab');
    await stopSpeech();
  });
});

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
  if (['pause', 'resume', 'rate', 'stop'].includes(msg.type)) {
    const { readerTab } = await chrome.storage.session.get('readerTab');
    if (readerTab != null && readerTab !== tabId) return { ok: true, resumed: false };
  }
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
    case 'prefetch':
      if (!system && Array.isArray(msg.texts)) await toOffscreen({ cmd: 'prefetch', texts: msg.texts.slice(0, 3), settings });
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
      await stopSpeech();
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
  if (msg.type === 'kindle-extract') {
    if (!sender.tab || sender.frameId !== 0 || !isKindleUrl(sender.url) || typeof msg.requestId !== 'string' || msg.requestId.length > 80) {
      sendResponse({ error: 'Invalid Kindle extraction request.' });
      return;
    }
    const key = `${sender.tab.id}:${msg.requestId}`;
    const request = { cancelled: false };
    kindleRequests.set(key, request);
    captureKindle(msg, sender).then(async (capture) => {
      await toTab(sender.tab.id, { type: 'kindle-captured', requestId: msg.requestId });
      if (request.cancelled) throw new Error('Kindle extraction cancelled.');
      await ensureOffscreen();
      if (request.cancelled) throw new Error('Kindle extraction cancelled.');
      return chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'kindle-extract', tabId: sender.tab.id, requestId: msg.requestId, ...capture });
    }).then(sendResponse, (error) => sendResponse({ error: error.message })).finally(() => kindleRequests.delete(key));
    return true;
  }
  if (msg.type === 'kindle-cancel') {
    if (!sender.tab || sender.frameId !== 0 || !isKindleUrl(sender.url) || typeof msg.requestId !== 'string' || msg.requestId.length > 80) return;
    const request = kindleRequests.get(`${sender.tab.id}:${msg.requestId}`);
    if (request) request.cancelled = true;
    toOffscreen({ cmd: 'kindle-cancel', tabId: sender.tab.id, requestId: msg.requestId }, { create: false })
      .then(sendResponse, (error) => sendResponse({ error: error.message }));
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
