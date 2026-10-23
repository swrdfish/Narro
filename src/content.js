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
    picking: false, // choosing a start sentence with the mouse
  };

  // --- Highlighting -----------------------------------------------------------------------------

  const style = document.createElement('style');
  style.textContent = `
    ::highlight(ai-reader-sentence) { background-color: #ffe066; color: #111; }
    ::highlight(ai-reader-block) { background-color: rgba(255, 224, 102, 0.22); }
    ::highlight(ai-reader-pick) { background-color: rgba(96, 165, 250, 0.35); }
    html.ai-reader-picking, html.ai-reader-picking * { cursor: crosshair !important; }
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

  async function prepare() {
    state.settings = await getSettings();
    state.rate = state.settings.rate;
    build();
    if (state.sentences.length) return true;
    fail('No readable text found on this page.');
    return false;
  }

  async function start(fromSelection = false) {
    if (!(await prepare())) return;
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

  // --- Choosing where to start -----------------------------------------------------------------

  let hoverFrame = 0; // pending requestAnimationFrame for the hover preview

  async function startPick() {
    if (state.picking) return cancelPick();
    // Keep the current reading list while reading so the position stays valid.
    if (state.status === 'idle' && !(await prepare())) return;
    state.picking = true;
    document.documentElement.classList.add('ai-reader-picking');
    ui.show();
    ui.setInfo('Click a sentence to start reading · Esc to cancel');
  }

  function cancelPick() {
    state.picking = false;
    cancelAnimationFrame(hoverFrame);
    hoverFrame = 0;
    document.documentElement.classList.remove('ai-reader-picking');
    CSS.highlights?.delete('ai-reader-pick');
    ui.setInfo('');
    ui.render();
  }

  function sentenceAtPoint(x, y) {
    const pos = document.caretPositionFromPoint?.(x, y);
    let node = pos?.offsetNode;
    let offset = pos?.offset;
    if (!node) {
      const r = document.caretRangeFromPoint?.(x, y);
      node = r?.startContainer;
      offset = r?.startOffset;
    }
    if (!node) return -1;
    const i = sentenceAt(state.sentences, node, offset, { exact: true });
    if (i < 0) return -1;
    // The caret APIs snap to the nearest text even far away; require the pointer to be on it.
    const pad = 3;
    const onText = [...state.sentences[i].range.getClientRects()].some(
      (r) => x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad,
    );
    return onText ? i : -1;
  }

  const onPlayer = (e) => e.target?.id === 'ai-reader-host';

  document.addEventListener('mousemove', (e) => {
    if (!state.picking || hoverFrame) return;
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = 0;
      if (!state.picking) return;
      const i = onPlayer(e) ? -1 : sentenceAtPoint(e.clientX, e.clientY);
      if (i >= 0) CSS.highlights.set('ai-reader-pick', new Highlight(state.sentences[i].range));
      else CSS.highlights.delete('ai-reader-pick');
    });
  }, { passive: true });

  // While picking, swallow presses so links and page handlers don't fire.
  for (const type of ['pointerdown', 'mousedown', 'mouseup']) {
    document.addEventListener(type, (e) => {
      if (state.picking && !onPlayer(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
  }

  document.addEventListener('click', (e) => {
    if (onPlayer(e)) return;
    // Alt+click jumps while the player is open; pick mode takes a plain click.
    if (!state.picking && !(e.altKey && ui.visible)) return;
    if (!state.sentences.length) return;
    const i = sentenceAtPoint(e.clientX, e.clientY);
    if (state.picking) {
      e.preventDefault();
      e.stopPropagation();
      if (i < 0) return; // keep picking until a sentence is hit
      cancelPick();
    } else if (i < 0) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    play(i);
  }, true);

  document.addEventListener('keydown', (e) => {
    if (state.picking && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelPick();
    }
  }, true);

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
      const actions = {
        toggle, next, prev,
        pick: startPick,
        stop: () => { cancelPick(); stop(); ui.hide(); },
        'from-selection': () => { stop(); start(true); },
      };
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

  // --- Floating player --------------------------------------------------------------------------

  const ui = createPlayer({
    onToggle: toggle,
    onPrev: prev,
    onNext: next,
    onClose: () => { cancelPick(); stop(); ui.hide(); },
    onPick: startPick,
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
      button.small { width: 24px; height: 24px; }
      button.small svg { width: 14px; height: 14px; }
      button.pick.active { background: var(--accent); color: #fff; }
      svg { width: 18px; height: 18px; fill: currentColor; }
      .rate { min-width: 34px; text-align: center; font-variant-numeric: tabular-nums; }
      .pos { color: var(--muted); font-variant-numeric: tabular-nums; padding: 0 6px; min-width: 56px; text-align: center; }
      .sep { width: 1px; height: 20px; background: var(--border); margin: 0 4px; }
      .info { max-width: 280px; padding: 0 6px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .info:empty { display: none; }
      .info.error { color: #dc2626; white-space: normal; }
      .grip { display: grid; place-items: center; width: 14px; height: 32px; margin-right: -2px; color: var(--muted); cursor: grab; }
      .grip svg { width: 14px; height: 14px; }
      .bar { touch-action: none; user-select: none; }
      .bar.dragging, .bar.dragging * { cursor: grabbing !important; }
      .spin { animation: spin 1s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
    <div class="bar" role="toolbar" aria-label="AI Reader">
      <span class="grip" title="Drag to move · double-click to reset"><svg viewBox="0 0 24 24"><path d="M8 5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm8 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm-8 5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm8 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm-8 5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm8 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4z"/></svg></span>
      <button class="prev" title="Previous sentence"><svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg></button>
      <button class="play" title="Play / pause"></button>
      <button class="next" title="Next sentence"><svg viewBox="0 0 24 24"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/></svg></button>
      <span class="pos"></span>
      <span class="sep"></span>
      <button class="small slower" title="Slower"><svg viewBox="0 0 24 24"><path d="M5 11h14v2H5z"/></svg></button>
      <span class="rate"></span>
      <button class="small faster" title="Faster"><svg viewBox="0 0 24 24"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg></button>
      <span class="sep"></span>
      <span class="info"></span>
      <button class="pick" title="Choose where to start: click any sentence"><svg viewBox="0 0 24 24"><path d="M11 2h2v4h-2zm0 16h2v4h-2zM2 11h4v2H2zm16 0h4v2h-4zm-6-4a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg></button>
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
  $('.pick').onclick = h.onPick;

  // --- Position: draggable, remembered across pages and sessions ---
  // Saved as the bar's center in viewport fractions so it adapts to window size.
  const POSITION_KEY = 'playerPosition';
  let position = null; // { cx, cy } or null for the default bottom-center spot
  const margin = 8;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

  function placeAt(left, top) {
    const { width, height } = host.getBoundingClientRect();
    Object.assign(host.style, {
      left: `${clamp(left, margin, innerWidth - width - margin)}px`,
      top: `${clamp(top, margin, innerHeight - height - margin)}px`,
      bottom: 'auto',
      transform: 'none',
    });
  }

  function applyPosition() {
    if (!host.isConnected) return;
    if (!position) {
      Object.assign(host.style, { left: '50%', top: 'auto', bottom: '20px', transform: 'translateX(-50%)' });
      return;
    }
    const { width, height } = host.getBoundingClientRect();
    placeAt(position.cx * innerWidth - width / 2, position.cy * innerHeight - height / 2);
  }

  chrome.storage.local.get(POSITION_KEY).then((r) => {
    position = r[POSITION_KEY] ?? null;
    applyPosition();
  });
  addEventListener('resize', applyPosition);

  const bar = $('.bar');
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const start = host.getBoundingClientRect();
    const dx = e.clientX - start.left;
    const dy = e.clientY - start.top;
    let dragging = false;
    const move = (ev) => {
      // Start only after a small movement so clicks and double-clicks still reach their target.
      if (!dragging) {
        if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
        dragging = true;
        bar.setPointerCapture(e.pointerId);
        bar.classList.add('dragging');
      }
      placeAt(ev.clientX - dx, ev.clientY - dy);
    };
    const end = () => {
      removeEventListener('pointermove', move, true);
      removeEventListener('pointerup', end, true);
      removeEventListener('pointercancel', end, true);
      if (!dragging) return;
      bar.classList.remove('dragging');
      const r = host.getBoundingClientRect();
      position = { cx: (r.left + r.width / 2) / innerWidth, cy: (r.top + r.height / 2) / innerHeight };
      chrome.storage.local.set({ [POSITION_KEY]: position });
    };
    // On window: before capture starts, a fast first move can already be outside the bar.
    addEventListener('pointermove', move, true);
    addEventListener('pointerup', end, true);
    addEventListener('pointercancel', end, true);
  });

  $('.grip').addEventListener('dblclick', () => {
    position = null;
    chrome.storage.local.remove(POSITION_KEY);
    applyPosition();
  });

  const ui = {
    visible: false,
    show() {
      if (!host.isConnected) document.documentElement.append(host);
      ui.visible = true;
      ui.render();
      applyPosition();
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
      $('.pick').classList.toggle('active', s.picking);
      if (s.settings) $('.settings').title = `Settings — voice: ${ENGINES[s.settings.engine]?.label}`;
    },
    setInfo(text, isError = false) {
      $('.info').textContent = text || '';
      $('.info').classList.toggle('error', isError);
      $('.info').title = text || '';
      applyPosition(); // width changed; keep the bar on screen
    },
  };
  return ui;
}
