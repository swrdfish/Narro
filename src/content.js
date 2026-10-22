// Content script: builds the reading list, drives sentence-by-sentence playback,
// highlights the current sentence and shows the floating player.
import { buildSentences, findContentRoot, sentenceAt } from './text.js';
import { getSettings, saveSettings, ENGINES } from './settings.js';

if (!window.__aiReader) {
  window.__aiReader = true;
  main();
}

function main() {
  const state = {
    sentences: [],
    idx: 0,
    seq: 0,
    status: 'idle', // idle | loading | playing | paused
    rate: 1,
    settings: null,
  };

  // --- Highlighting -----------------------------------------------------------------------------

  const style = document.createElement('style');
  style.textContent = `
    ::highlight(ai-reader-sentence) { background-color: #ffe066; color: #111; }
    ::highlight(ai-reader-block) { background-color: rgba(255, 224, 102, 0.22); }
  `;
  document.head.append(style);

  function highlight(i) {
    const s = state.sentences[i];
    if (!s || !globalThis.CSS?.highlights) return;
    const block = document.createRange();
    block.selectNodeContents(s.el);
    const blockHl = new Highlight(block);
    const sentenceHl = new Highlight(s.range);
    sentenceHl.priority = 1;
    CSS.highlights.set('ai-reader-block', blockHl);
    CSS.highlights.set('ai-reader-sentence', sentenceHl);
    if (state.settings?.autoScroll) scrollToRange(s.range);
  }

  function clearHighlight() {
    CSS.highlights?.delete('ai-reader-sentence');
    CSS.highlights?.delete('ai-reader-block');
  }

  function scrollToRange(range) {
    const rect = range.getBoundingClientRect();
    const margin = 80;
    if (rect.top < margin || rect.bottom > innerHeight - margin - 80) {
      scrollBy({ top: rect.top - innerHeight / 3, behavior: 'smooth' });
    }
  }

  // --- Reading list -----------------------------------------------------------------------------

  function build() {
    const root = findContentRoot();
    state.sentences = buildSentences(root, {
      lang: document.documentElement.lang || navigator.language || 'en',
      skipIncompleteLast: state.settings.skipIncompleteLast,
    });
  }

  function firstVisibleSentence() {
    for (let i = 0; i < state.sentences.length; i++) {
      const r = state.sentences[i].range.getBoundingClientRect();
      if (r.bottom > 0 && r.top < innerHeight && r.width > 0) return i;
    }
    return 0;
  }

  function selectionStart() {
    const sel = getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return -1;
    const r = sel.getRangeAt(0);
    return sentenceAt(state.sentences, r.startContainer, r.startOffset);
  }

  // --- Playback ---------------------------------------------------------------------------------

  function send(msg) {
    return chrome.runtime.sendMessage(msg).catch((e) => ({ error: e.message }));
  }

  async function play(i) {
    if (i < 0 || i >= state.sentences.length) return finish();
    state.idx = i;
    const seq = ++state.seq;
    setStatus('loading');
    highlight(i);
    const prefetch = state.sentences.slice(i + 1, i + 3).map((s) => s.text);
    const res = await send({ type: 'speak', seq, text: state.sentences[i].text, prefetch });
    if (res?.error && seq === state.seq) fail(res.error);
  }

  function pause() {
    if (state.status !== 'playing' && state.status !== 'loading') return;
    setStatus('paused');
    send({ type: 'pause' });
  }

  async function resume() {
    if (state.status !== 'paused') return;
    setStatus('loading');
    const res = await send({ type: 'resume', seq: state.seq });
    if (!res?.resumed) play(state.idx); // audio was lost (e.g. offscreen page closed while paused)
  }

  async function start(fromSelection = false) {
    state.settings = await getSettings();
    state.rate = state.settings.rate;
    build();
    if (!state.sentences.length) return fail('No readable text found on this page.');
    let i = selectionStart();
    if (i < 0) i = fromSelection ? 0 : firstVisibleSentence();
    ui.show();
    play(i);
  }

  function stop() {
    state.seq++;
    send({ type: 'stop' });
    setStatus('idle');
    clearHighlight();
  }

  function finish() {
    stop();
    state.idx = 0;
    ui.setInfo('Finished');
  }

  function fail(message) {
    state.seq++;
    send({ type: 'stop' });
    setStatus('idle');
    ui.show();
    ui.setInfo(message, true);
  }

  function toggle() {
    if (state.status === 'playing' || state.status === 'loading') pause();
    else if (state.status === 'paused') resume();
    else if (state.sentences.length && ui.visible) play(state.idx);
    else start();
  }

  function next() {
    if (state.idx + 1 < state.sentences.length) play(state.idx + 1);
  }

  function prev() {
    play(Math.max(0, state.idx - 1));
  }

  function setRate(rate) {
    state.rate = Math.round(Math.min(3, Math.max(0.5, rate)) * 10) / 10;
    ui.render();
    send({ type: 'rate', rate: state.rate });
    getSettings().then((s) => saveSettings({ ...s, rate: state.rate }));
  }

  function setStatus(status) {
    state.status = status;
    ui.render();
  }

  // --- Messages ---------------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'ping') {
      sendResponse({ pong: true });
      return;
    }
    if (msg.type === 'control') {
      const actions = { toggle, next, prev, stop: () => { stop(); ui.hide(); }, 'from-selection': () => { stop(); start(true); } };
      actions[msg.action]?.();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type !== 'tts-event') return;
    if (msg.event === 'preempted') {
      if (state.status !== 'idle') stop();
      return;
    }
    if (msg.seq !== state.seq) return; // stale event from an earlier sentence
    switch (msg.event) {
      case 'started':
        if (state.status !== 'paused') setStatus('playing');
        ui.setInfo('');
        break;
      case 'ended':
        if (state.status !== 'paused') play(state.idx + 1);
        break;
      case 'status':
        ui.setInfo(msg.status);
        break;
      case 'error':
        fail(msg.message);
        break;
    }
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (!changes.settings) return;
    const prevEngine = state.settings?.engine;
    getSettings().then((s) => {
      state.settings = s;
      if (s.rate !== state.rate) {
        state.rate = s.rate;
        send({ type: 'rate', rate: s.rate });
      }
      // Switching voice/engine mid-read takes effect from the current sentence.
      if (state.status === 'playing' || state.status === 'loading') {
        const voiceChanged = JSON.stringify(changes.settings.newValue?.[s.engine]) !== JSON.stringify(changes.settings.oldValue?.[s.engine]);
        if (prevEngine !== s.engine || voiceChanged) play(state.idx);
      }
      ui.render();
    });
  });

  // Alt+click any sentence to jump there.
  document.addEventListener('click', (e) => {
    if (!e.altKey || !ui.visible || !state.sentences.length) return;
    const pos = document.caretPositionFromPoint?.(e.clientX, e.clientY);
    const node = pos?.offsetNode ?? document.caretRangeFromPoint?.(e.clientX, e.clientY)?.startContainer;
    const offset = pos?.offset ?? 0;
    if (!node) return;
    const i = sentenceAt(state.sentences, node, offset);
    if (i >= 0) {
      e.preventDefault();
      e.stopPropagation();
      play(i);
    }
  }, true);

  // --- Floating player --------------------------------------------------------------------------

  const ui = createPlayer({
    onToggle: toggle,
    onPrev: prev,
    onNext: next,
    onClose: () => { stop(); ui.hide(); },
    onSlower: () => setRate(state.rate - 0.1),
    onFaster: () => setRate(state.rate + 0.1),
    onSettings: () => send({ type: 'open-options' }),
    getState: () => state,
  });
}

function createPlayer(h) {
  const host = document.createElement('div');
  host.id = 'ai-reader-host';
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; left: 50%; bottom: 20px; transform: translateX(-50%);';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { color-scheme: light dark; }
      .bar {
        --bg: #ffffff; --fg: #1d1d1f; --muted: #6e6e73; --hover: #f0f0f2; --accent: #2563eb; --border: rgba(0,0,0,.1);
        display: flex; align-items: center; gap: 4px; padding: 6px 8px;
        font: 13px/1.2 system-ui, -apple-system, sans-serif; color: var(--fg);
        background: var(--bg); border: 1px solid var(--border); border-radius: 999px;
        box-shadow: 0 8px 30px rgba(0,0,0,.18);
      }
      @media (prefers-color-scheme: dark) {
        .bar { --bg: #1f1f22; --fg: #f2f2f4; --muted: #a1a1a8; --hover: #2c2c30; --accent: #60a5fa; --border: rgba(255,255,255,.12); }
      }
      button {
        all: unset; cursor: pointer; display: grid; place-items: center;
        width: 32px; height: 32px; border-radius: 50%; color: inherit;
      }
      button:hover { background: var(--hover); }
      button:focus-visible { outline: 2px solid var(--accent); }
      button.play { width: 38px; height: 38px; background: var(--accent); color: #fff; }
      button.play:hover { filter: brightness(1.1); background: var(--accent); }
      button.small { width: 24px; height: 24px; font-size: 15px; }
      svg { width: 18px; height: 18px; fill: currentColor; }
      .rate { min-width: 34px; text-align: center; font-variant-numeric: tabular-nums; }
      .pos { color: var(--muted); font-variant-numeric: tabular-nums; padding: 0 6px; min-width: 56px; text-align: center; }
      .sep { width: 1px; height: 20px; background: var(--border); margin: 0 4px; }
      .info { max-width: 280px; padding: 0 6px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .info:empty { display: none; }
      .info.error { color: #dc2626; white-space: normal; }
      .spin { animation: spin 1s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
    <div class="bar" role="toolbar" aria-label="AI Reader">
      <button class="prev" title="Previous sentence"><svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg></button>
      <button class="play" title="Play / pause"></button>
      <button class="next" title="Next sentence"><svg viewBox="0 0 24 24"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/></svg></button>
      <span class="pos"></span>
      <span class="sep"></span>
      <button class="small slower" title="Slower">−</button>
      <span class="rate"></span>
      <button class="small faster" title="Faster">+</button>
      <span class="sep"></span>
      <span class="info"></span>
      <button class="settings" title="Settings"><svg viewBox="0 0 24 24"><path d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.4-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3.3h-4l-.4 2.7c-.6.3-1.2.6-1.7 1l-2.5-1-2 3.4L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.4 2.5-1c.5.4 1.1.7 1.7 1l.4 2.7h4l.4-2.7c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.4zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)"/></svg></button>
      <button class="close" title="Stop and close"><svg viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7l-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z" transform="translate(1.4 0)"/></svg></button>
    </div>`;

  const $ = (sel) => root.querySelector(sel);
  const icons = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
    loading: '<svg class="spin" viewBox="0 0 24 24"><path d="M12 4a8 8 0 1 0 8 8h-2a6 6 0 1 1-6-6z"/></svg>',
  };

  $('.play').onclick = h.onToggle;
  $('.prev').onclick = h.onPrev;
  $('.next').onclick = h.onNext;
  $('.close').onclick = h.onClose;
  $('.slower').onclick = h.onSlower;
  $('.faster').onclick = h.onFaster;
  $('.settings').onclick = h.onSettings;

  const ui = {
    visible: false,
    show() {
      if (!host.isConnected) document.documentElement.append(host);
      ui.visible = true;
      ui.render();
    },
    hide() {
      host.remove();
      ui.visible = false;
    },
    render() {
      const s = h.getState();
      const icon = s.status === 'loading' ? 'loading' : s.status === 'playing' ? 'pause' : 'play';
      $('.play').innerHTML = icons[icon];
      $('.play').title = icon === 'pause' ? 'Pause' : 'Play';
      $('.pos').textContent = s.sentences.length ? `${s.idx + 1} / ${s.sentences.length}` : '';
      $('.rate').textContent = `${s.rate.toFixed(1)}×`;
      if (s.settings) $('.settings').title = `Settings — voice: ${ENGINES[s.settings.engine]?.label}`;
    },
    setInfo(text, isError = false) {
      $('.info').textContent = text || '';
      $('.info').classList.toggle('error', isError);
      $('.info').title = text || '';
    },
  };
  return ui;
}
