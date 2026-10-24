// Content script: builds the reading list, drives sentence-by-sentence playback,
// highlights the current sentence and shows the floating player.
import { buildSentences, findContentRoot, sentenceAt } from './text.js';
import { getSettings, saveSettings, ENGINES, KOKORO_VOICES, SUPERTONIC_VOICES } from './settings.js';
import { createKindleReader, isKindleUrl, visualSentenceAt } from './kindle.js';
import { chunkEnd, chunkText, sentenceAtFraction, sentenceEndFraction, startsNewBlock } from './chunks.js';
import { pageKey, loadPosition, savePosition, clearPosition, findPosition } from './positions.js';
import { PAGE_SHORTCUTS } from './shortcuts.js';

// Seconds of the second-to-last sentence left when a Kindle page is turned early (as in offscreen.js).
const EARLY_TURN_LEAD = 1.5;

if (!window.__aiReader) {
  window.__aiReader = true;
  main();
}

function main() {
  const state = {
    sentences: [],
    idx: 0,
    seq: 0,
    chunk: null, // { start, end }: sentences in the clip being spoken
    status: 'idle', // idle | loading | playing | paused
    rate: 1,
    settings: null,
    picking: false, // choosing a start sentence with the mouse
    preparing: false,
    sourceInfo: '',
  };
  let preparation;
  // The user turned the page (or resized the window) themselves. The reader's own page turn is
  // handled by nextKindlePage(), which clears this monitor before pressing Next.
  const kindle = isKindleUrl(location.href) ? createKindleReader(() => {
    cancelPick();
    const reading = state.status === 'playing' || state.status === 'loading' || state.preparing || newPageTimer !== null;
    stop({ report: false }); // carrying on with the new page isn't a stop for the badge or popup
    if (reading) readNewPage();
    else {
      ui.setInfo('Kindle page changed — press Play to read it.'); // paused: stay quiet
      reportStatus();
    }
  }) : null;

  // Starts reading the page now showing, after a short pause so rapid page flips settle on the
  // last one. Resumes at the remembered sentence if it's the same page (e.g. after a resize).
  let newPageTimer = null;
  let newPageRetries = 0;
  function readNewPage() {
    clearTimeout(newPageTimer);
    ui.show();
    ui.setInfo('Reading the new page…');
    newPageTimer = setTimeout(() => {
      newPageTimer = null;
      start();
    }, 400);
    reportStatus();
  }

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
    if (kindle) return kindle.highlight(upcoming ? null : s);
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
    kindle?.clear();
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
    if (kindle) return 0;
    for (let i = 0; i < state.sentences.length; i++) {
      const r = state.sentences[i].range.getBoundingClientRect();
      if (r.bottom > 0 && r.top < innerHeight && r.width > 0) return i;
    }
    return 0;
  }

  function selectionStart() {
    if (kindle) return -1;
    const sel = getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return -1;
    const r = sel.getRangeAt(0);
    return sentenceAt(state.sentences, r.startContainer, r.startOffset);
  }

  // --- Playback ---------------------------------------------------------------------------------

  function send(msg) {
    return chrome.runtime.sendMessage(msg).catch((e) => ({ error: e.message }));
  }

  // --- Where reading left off on this page ---
  const positionKey = () => pageKey(location, kindle ? new URL(location.href).searchParams.get('asin') : null);

  function rememberPosition() {
    // On Kindle the page may already have turned under the old page's last sentence; the new
    // page's first sentence is saved when it starts.
    if (!state.sentences[state.idx] || (kindle && upcoming)) return;
    savePosition(chrome.storage.local, positionKey(), state.sentences, state.idx).catch(() => {});
  }

  function forgetPosition() {
    clearPosition(chrome.storage.local, positionKey()).catch(() => {});
  }

  const BLOCK_PAUSE_MS = 250; // silence between blocks of text

  // System voices don't report playback progress, so they get one sentence per request.
  const singleSentence = () => state.settings?.engine === 'system';

  // The next `count` chunks starting at sentence `from`, as text.
  function chunksFrom(sentences, from, count) {
    const texts = [];
    for (let start = from; texts.length < count && start < sentences.length;) {
      const end = chunkEnd(sentences, start, { single: singleSentence() });
      texts.push(chunkText(sentences, start, end));
      start = end + 1;
    }
    return texts;
  }

  // Speaks sentences from `i` as one clip (a chunk); the highlight follows playback progress.
  // `first`: starting or jumping, so begin with a single sentence for a quick start.
  // Open while reading: when this page is refreshed or closed, Chrome closes the port and the
  // background stops the audio. Reconnects if the background restarted in the meantime.
  let lifeline = null;
  function holdLifeline() {
    if (lifeline) return;
    try {
      lifeline = chrome.runtime.connect({ name: 'reader' });
    } catch {
      return; // extension reloaded; nothing to keep alive
    }
    lifeline.onDisconnect.addListener(() => {
      lifeline = null;
      if (state.status !== 'idle' || state.preparing) holdLifeline();
    });
  }

  async function play(i, { first = true } = {}) {
    if (state.preparing) return;
    holdLifeline();
    if (kindle && i === state.sentences.length && i > 0 && state.settings?.autoTurnPages) return nextKindlePage();
    if (i < 0 || i >= state.sentences.length) return finish();
    state.idx = i;
    rememberPosition();
    const end = chunkEnd(state.sentences, i, { first, single: singleSentence() });
    state.chunk = { start: i, end };
    const seq = ++state.seq;
    setStatus('loading');
    highlight(i);
    const prefetch = chunksFrom(state.sentences, end + 1, 2);
    const res = await send({ type: 'speak', seq, text: chunkText(state.sentences, i, end), prefetch });
    if (res?.error && seq === state.seq) fail(res.error);
  }

  function followProgress(time, duration) {
    const { chunk } = state;
    if (!chunk || chunk.start === chunk.end || !(duration > 0)) return;
    const i = sentenceAtFraction(state.sentences, chunk.start, chunk.end, time / duration);
    if (i !== state.idx) {
      state.idx = i;
      highlight(i);
      ui.render();
      rememberPosition();
    }
    // When the page's last two sentences share this clip there is no clip boundary between them:
    // turn the page when the second-to-last sentence has about EARLY_TURN_LEAD seconds left.
    const last = state.sentences.length - 1;
    if (kindle && chunk.end === last && chunk.start < last) {
      const secondLastEnds = sentenceEndFraction(state.sentences, chunk.start, chunk.end, last - 1) * duration;
      if ((secondLastEnds - time) / (state.rate || 1) <= EARLY_TURN_LEAD) turnEarly();
    }
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

  // End of a Kindle page: turn it and keep reading. Text cut off at the turn is carried over.
  // Next Kindle page, possibly started early while the last sentence was still playing.
  let upcoming = null; // { controller, promise }

  function kindleStatus(message) {
    if (message.startsWith('Kindle:')) state.sourceInfo = message;
    ui.setInfo(message);
  }

  // Turns the page and reads it without touching the current reading list.
  // Resolves { sentences } | { end: true } | { error } | null if aborted.
  async function loadNextKindlePage(signal) {
    try {
      kindle.highlight(null);
      ui.setInfo('Turning page…');
      const turned = await kindle.turnPage(signal, { onWaiting: () => ui.setInfo('Turning the page when the Kindle tab is visible again…') });
      if (!turned) return { end: true };
      const sentences = await kindle.read({ lang: 'en', skipIncompleteLast: state.settings.skipIncompleteLast }, signal,
        kindleStatus, (hidden) => ui.captureHidden(hidden));
      signal.throwIfAborted();
      if (!sentences.length) return { error: 'No readable English text found. Try a larger font and a text page rather than the cover.' };
      // Have the voice ready for the new page by the time the current sentence ends.
      send({ type: 'prefetch', texts: chunksFrom(sentences, 0, 2) });
      return { sentences };
    } catch (error) {
      return signal.aborted ? null : { error: error.message, pageChanged: !!error.pageChanged };
    }
  }

  function startNextKindlePage() {
    if (!upcoming) {
      const controller = new AbortController();
      upcoming = { controller, promise: loadNextKindlePage(controller.signal) };
    }
    return upcoming;
  }

  // Turn the page while the page's last sentence is still to be heard, so turning, OCR and voice
  // prefetch overlap playback. Called when a clip nearly ends, and (via followProgress) when the
  // second-to-last sentence nearly ends inside a clip that also holds the last one. Only clips
  // that reach the second-to-last sentence qualify; a one-sentence page turns on that one.
  function turnEarly() {
    if (!kindle || upcoming || state.preparing || !state.settings?.autoTurnPages || !state.settings.earlyPageTurn) return;
    if (state.chunk && state.chunk.end >= Math.max(0, state.sentences.length - 2)) startNextKindlePage();
  }

  // End of a Kindle page: continue on the next one. Text cut off at the turn is carried over.
  async function nextKindlePage() {
    const seq = ++state.seq; // ignore late events from the last sentence
    const pending = startNextKindlePage();
    preparation = pending.controller;
    state.preparing = true;
    setStatus('loading');
    const result = await pending.promise;
    if (upcoming === pending) upcoming = null;
    if (preparation === pending.controller) {
      preparation = null;
      state.preparing = false;
    }
    if (seq !== state.seq || !result) return; // stopped meanwhile
    if (result.end) {
      setStatus('idle');
      clearHighlight();
      forgetPosition();
      ui.setInfo('Reached the end of the book.');
      return;
    }
    if (result.pageChanged) return readNewPage(); // the user turned the page during our own turn
    if (result.error) return fail(result.error);
    state.sentences = result.sentences;
    play(0, { first: false }); // its first chunk was prefetched while the last page finished
  }

  async function prepare() {
    preparation?.abort();
    const controller = new AbortController();
    preparation = controller;
    state.preparing = true;
    reportStatus();
    let prepared = false;
    try {
      state.settings = await getSettings();
      controller.signal.throwIfAborted();
      state.rate = state.settings.rate;
      if (kindle) {
        state.sentences = [];
        state.sourceInfo = '';
        kindle.clear();
        ui.show();
        state.sentences = await kindle.read({ lang: 'en', skipIncompleteLast: state.settings.skipIncompleteLast }, controller.signal,
          kindleStatus, (hidden) => ui.captureHidden(hidden));
      } else build();
      controller.signal.throwIfAborted();
      if (state.sentences.length) {
        newPageRetries = 0;
        prepared = true;
        return true;
      }
      fail(kindle ? 'No readable English text found. Try a larger font and a text page rather than the cover.' : 'No readable text found on this page.');
      return false;
    } catch (error) {
      if (controller.signal.aborted) return false;
      // The page changed again while it was being recognized: read the latest one instead.
      if (error.pageChanged && newPageRetries++ < 3) {
        kindle.clear(); // stop the old page's change monitor; the new read starts its own
        readNewPage();
        return false;
      }
      fail(error.message);
      return false;
    } finally {
      if (preparation === controller) {
        state.preparing = false;
        preparation = null;
        ui.render();
        if (!prepared) reportStatus(); // on success, playing starts next: no "stopped" in between
      }
    }
  }

  async function start(fromSelection = false) {
    if (!(await prepare())) return;
    let i = selectionStart();
    let resumed = false;
    if (i < 0 && !fromSelection) {
      // Resume where reading stopped on this page. Websites can fall back to the saved position;
      // Kindle needs the same sentence on the page that's open.
      const saved = await loadPosition(chrome.storage.local, positionKey()).catch(() => null);
      i = findPosition(state.sentences, saved, { allowIndex: !kindle });
      resumed = i >= 0;
    }
    if (i < 0) i = fromSelection ? 0 : firstVisibleSentence();
    ui.show();
    play(i);
    if (resumed && i > 0) ui.setInfo('Resuming where you left off');
  }

  function stop({ report = true } = {}) {
    clearTimeout(newPageTimer);
    newPageTimer = null;
    preparation?.abort();
    upcoming?.controller.abort();
    upcoming = null;
    state.preparing = false;
    state.seq++;
    state.chunk = null;
    if (!kindle || state.status !== 'idle') send({ type: 'stop' });
    if (kindle) state.sentences = [];
    setStatus('idle', { report });
    clearHighlight();
  }

  function finish() {
    stop();
    state.idx = 0;
    forgetPosition(); // read to the end: next time starts afresh
    ui.setInfo('Finished');
  }

  function fail(message, detail) {
    stop();
    ui.show();
    ui.setInfo(message, true, detail);
  }

  function toggle() {
    if (state.preparing) stop();
    else if (state.status === 'playing' || state.status === 'loading') pause();
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
    if (state.preparing) return;
    if (state.picking) return cancelPick();
    // Keep the current reading list while reading so the position stays valid.
    if (state.status === 'idle' && !(await prepare())) return;
    state.picking = true;
    kindle?.picking(true);
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
    kindle?.picking(false);
    ui.setInfo('');
    ui.render();
  }

  function sentenceAtPoint(x, y) {
    if (kindle) return visualSentenceAt(state.sentences, x, y);
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
      if (kindle) kindle.preview(state.sentences[i]);
      else if (i >= 0) CSS.highlights.set('ai-reader-pick', new Highlight(state.sentences[i].range));
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

  // Typing in a field keeps its own keys (⌥⇧← / ⌥⇧→ select by word on macOS).
  const isEditable = (target) => target?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]') || target?.isContentEditable;

  // The player's shortcuts, only while it's showing on this page.
  document.addEventListener('keydown', (e) => {
    if (!ui.visible || !e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || e.repeat) return;
    const shortcut = PAGE_SHORTCUTS.find((s) => s.code === e.code);
    if (!shortcut || isEditable(e.composedPath()[0])) return;
    e.preventDefault();
    e.stopPropagation();
    controls[shortcut.action]();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (kindle && (state.preparing || state.status !== 'idle') && !state.picking && !e.altKey && !onPlayer(e)
      && ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) stop();
    if (state.picking && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelPick();
    }
  }, true);

  document.addEventListener('wheel', (event) => {
    if (kindle && (state.preparing || state.status !== 'idle') && !state.picking && !onPlayer(event)) stop();
  }, { capture: true, passive: true });

  function setStatus(status, { report = true } = {}) {
    state.status = status;
    ui.render();
    if (report) reportStatus();
  }

  // Tells the background (toolbar badge, popup controls) how this tab is reading.
  let reportedStatus = 'idle';
  function reportStatus() {
    const status = state.preparing || newPageTimer !== null ? 'loading' : state.status;
    if (status === reportedStatus) return;
    reportedStatus = status;
    send({ type: 'reader-state', status });
  }

  // --- Messages ---------------------------------------------------------------------------------

  // Controls from the popup, context menu, Chrome shortcuts and the page shortcuts.
  const controls = {
    toggle, next, prev,
    pick: startPick,
    stop: () => { cancelPick(); stop(); ui.hide(); },
    'from-selection': () => { stop(); start(true); },
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'ping') {
      sendResponse({ pong: true });
      return;
    }
    if (msg.type === 'control') {
      controls[msg.action]?.();
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
        ui.setInfo(state.sourceInfo);
        break;
      case 'nearly-ended':
        if (state.status === 'playing') turnEarly();
        break;
      case 'progress':
        followProgress(msg.time, msg.duration);
        break;
      case 'ended': {
        if (state.status === 'paused') break;
        const next = state.chunk.end + 1;
        if (!startsNewBlock(state.sentences, next)) {
          play(next, { first: false });
          break;
        }
        // A short pause between blocks (heading to paragraph, paragraph to paragraph…), like a reader takes.
        const seq = state.seq;
        setTimeout(() => {
          if (seq === state.seq && state.status !== 'paused' && state.status !== 'idle') play(next, { first: false });
        }, BLOCK_PAUSE_MS);
        break;
      }
      case 'status':
        ui.setInfo(msg.status);
        break;
      case 'error':
        fail(msg.message, msg.detail);
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
    // Try again from the sentence that failed (a Kindle page is recognised again).
    onRetry: () => (state.sentences.length ? play(state.idx) : start()),
    getState: () => state,
  });
}

function voiceLabel(settings) {
  if (!settings) return '';
  const engine = settings.engine;
  const name = { openai: 'OpenAI', elevenlabs: 'ElevenLabs', gemini: 'Gemini', openrouter: 'OpenRouter', kokoro: 'Kokoro', supertonic: 'Supertonic', piper: 'Piper', localServer: 'Local server', system: 'System voice' }[engine] || engine;
  const voice = {
    openai: settings.openai?.voice,
    gemini: settings.gemini?.voice,
    openrouter: settings.openrouter?.voice,
    kokoro: KOKORO_VOICES[settings.kokoro?.voice]?.replace(/ \(.*\)$/, ''),
    supertonic: SUPERTONIC_VOICES[settings.supertonic?.voice],
    piper: settings.piper?.voice?.split('-').slice(1, -1).join(' ').replace(/_/g, ' '),
    localServer: settings.localServer?.voice,
    system: settings.system?.voiceName,
  }[engine];
  return voice ? `${name} · ${voice}` : name;
}

function createPlayer(h) {
  const host = document.createElement('div');
  host.id = 'ai-reader-host';
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; left: 50%; bottom: 20px; transform: translateX(-50%);';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { color-scheme: light dark; }
      .bar, .details {
        --bg: #ffffff; --fg: #1d1d1f; --muted: #6e6e73; --hover: #f0f0f2; --accent: #2563eb; --border: rgba(0,0,0,.1); --error: #dc2626;
      }
      .bar {
        display: flex; align-items: center; gap: 4px; padding: 6px 8px;
        font: 13px/1.2 system-ui, -apple-system, sans-serif; color: var(--fg);
        background: var(--bg); border: 1px solid var(--border); border-radius: 999px;
        box-shadow: 0 8px 30px rgba(0,0,0,.18);
      }
      @media (prefers-color-scheme: dark) {
        .bar, .details { --bg: #1f1f22; --fg: #f2f2f4; --muted: #a1a1a8; --hover: #2c2c30; --accent: #60a5fa; --border: rgba(255,255,255,.12); --error: #f87171; }
      }
      button {
        all: unset; cursor: pointer; display: grid; place-items: center;
        width: 32px; height: 32px; border-radius: 50%; color: inherit;
      }
      button:hover { background: var(--hover); }
      button:focus-visible { outline: 2px solid var(--accent); }
      /* The Narro logo's colours: green with ink (white on this green would be too low-contrast). */
      button.play { width: 38px; height: 38px; background: #4fb56e; color: #1a1917; }
      button.play:hover { filter: brightness(1.08); background: #4fb56e; }
      button.small { width: 24px; height: 24px; }
      button.small svg { width: 14px; height: 14px; }
      /* Choosing where to start is the main thing to do besides play, so it shares the play button's green. */
      button.pick { background: #4fb56e; color: #1a1917; }
      button.pick:hover { filter: brightness(1.08); background: #4fb56e; }
      button.pick.active { box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px #4fb56e; }
      svg { width: 18px; height: 18px; fill: currentColor; }
      .rate { min-width: 34px; text-align: center; font-variant-numeric: tabular-nums; }
      .pos { color: var(--muted); font-variant-numeric: tabular-nums; padding: 0 6px; width: 72px; text-align: center; white-space: nowrap; }
      .sep { width: 1px; height: 20px; background: var(--border); margin: 0 4px; }
      /* Fixed size so status changes never resize (and re-center) the bar. */
      .info { width: 240px; height: 32px; padding: 0 6px; display: flex; align-items: center; color: var(--muted); font-size: 12px; line-height: 1.3; transition: opacity .14s ease; }
      .info .text { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; }
      .info.fading { opacity: 0; }
      .info.placeholder { opacity: .75; }
      .info.placeholder.fading { opacity: 0; }
      .info.error { color: var(--error); cursor: pointer; border-radius: 6px; }
      .info.error:hover .text { text-decoration: underline; text-underline-offset: 2px; }
      .info:focus-visible { outline: 2px solid var(--accent); }
      /* Error details panel, above the bar (below it when the bar is near the top). */
      .details {
        position: absolute; left: 50%; bottom: calc(100% + 8px); transform: translateX(-50%);
        width: min(380px, calc(100vw - 24px)); max-height: min(320px, 60vh); overflow: auto;
        padding: 12px 14px 12px; box-sizing: border-box;
        font: 13px/1.45 system-ui, -apple-system, sans-serif; color: var(--fg);
        background: var(--bg); border: 1px solid var(--border); border-radius: 14px;
        box-shadow: 0 12px 32px rgba(0,0,0,.22);
      }
      .details.below { bottom: auto; top: calc(100% + 8px); }
      .details[hidden] { display: none; }
      .details-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
      .details-head strong { color: var(--error); font-size: 13px; }
      .details-message { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
      .details a { color: var(--accent); text-underline-offset: 2px; }
      .details-raw { margin-top: 10px; }
      .details-raw summary { cursor: pointer; color: var(--muted); font-size: 12px; }
      .details-raw pre {
        margin: 6px 0 0; padding: 8px 10px; max-height: 140px; overflow: auto; border-radius: 8px;
        background: var(--hover); font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
        white-space: pre-wrap; overflow-wrap: anywhere; user-select: text;
      }
      .details-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
      .details button.text-button {
        width: auto; height: auto; display: inline-block; padding: 4px 12px; border-radius: 8px;
        border: 1px solid var(--border); font-weight: 600; font-size: 12px;
      }
      .details button.text-button.primary { background: var(--accent); border-color: var(--accent); color: var(--bg); }
      .details button.text-button.primary:hover { filter: brightness(1.08); }
      .details button.icon { width: 26px; height: 26px; }
      .details button.icon svg { width: 14px; height: 14px; }
      .grip { display: grid; place-items: center; width: 14px; height: 32px; margin-right: -2px; color: var(--muted); cursor: grab; }
      .grip svg { width: 14px; height: 14px; }
      .bar { touch-action: none; user-select: none; }
      .bar.dragging, .bar.dragging * { cursor: grabbing !important; }
      .spin { animation: spin 1s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
    <div class="bar" role="toolbar" aria-label="Narro">
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
      <span class="info"><span class="text"></span></span>
      <button class="pick" title="Choose where to start: click any sentence"><svg viewBox="0 0 24 24"><path d="M11 2h2v4h-2zm0 16h2v4h-2zM2 11h4v2H2zm16 0h4v2h-4zm-6-4a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg></button>
      <button class="settings" title="Settings"><svg viewBox="0 0 24 24"><path d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.4-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3.3h-4l-.4 2.7c-.6.3-1.2.6-1.7 1l-2.5-1-2 3.4L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.4 2.5-1c.5.4 1.1.7 1.7 1l.4 2.7h4l.4-2.7c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.4zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)"/></svg></button>
      <button class="close" title="Stop and close"><svg viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7l-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z" transform="translate(1.4 0)"/></svg></button>
    </div>
    <div class="details" role="dialog" aria-label="Error details" hidden>
      <div class="details-head">
        <strong>Error</strong>
        <button class="icon details-close" aria-label="Close error details" title="Close"><svg viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7l-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z" transform="translate(1.4 0)"/></svg></button>
      </div>
      <p class="details-message"></p>
      <details class="details-raw" hidden><summary>Server response</summary><pre></pre></details>
      <div class="details-actions"><button class="text-button details-copy">Copy</button><button class="text-button primary details-retry">Retry</button></div>
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

  let shownIcon = 'play';
  let spinnerTimer = null;
  function setIcon(name) {
    shownIcon = name;
    const button = $('.play');
    if (button.dataset.icon === name) return; // re-creating the SVG would restart the spinner
    button.dataset.icon = name;
    button.innerHTML = icons[name];
    button.title = name === 'pause' ? 'Pause' : 'Play';
  }

  let info = { text: '', isError: false, detail: '' };

  // --- Error details ---
  // Text becomes nodes and only http(s) addresses become links: nothing from a server is parsed as HTML.
  function linkify(target, text) {
    target.replaceChildren();
    const pattern = /https?:\/\/[^\s<>"'`]+/g;
    let last = 0;
    for (let match; (match = pattern.exec(text));) {
      const url = match[0].replace(/[.,;:!?)\]]+$/, ''); // sentence punctuation isn't part of the URL
      target.append(text.slice(last, match.index));
      const link = document.createElement('a');
      link.href = url;
      link.textContent = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      target.append(link);
      last = match.index + url.length;
      pattern.lastIndex = last;
    }
    target.append(text.slice(last));
  }

  let detailsOpen = false;
  function openDetails() {
    if (!info.isError) return;
    linkify($('.details-message'), info.text);
    $('.details-raw').hidden = !info.detail;
    $('.details-raw').open = false;
    $('.details-raw pre').textContent = info.detail || '';
    $('.details-copy').textContent = 'Copy';
    $('.details').classList.toggle('below', host.getBoundingClientRect().top < 340);
    $('.details').hidden = false;
    detailsOpen = true;
    $('.details-close').focus();
  }
  function closeDetails({ restoreFocus = false } = {}) {
    if (!detailsOpen) return;
    $('.details').hidden = true;
    detailsOpen = false;
    if (restoreFocus && info.isError) $('.info').focus();
  }
  $('.info').addEventListener('click', () => (detailsOpen ? closeDetails() : openDetails()));
  $('.info').addEventListener('keydown', (e) => {
    if (info.isError && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      openDetails();
    }
  });
  $('.details-close').addEventListener('click', () => closeDetails({ restoreFocus: true }));
  $('.details').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeDetails({ restoreFocus: true });
    }
  });
  $('.details-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(info.detail ? `${info.text}\n\n${info.detail}` : info.text);
      $('.details-copy').textContent = 'Copied';
    } catch {
      $('.details-copy').textContent = 'Copy failed';
    }
  });
  $('.details-retry').addEventListener('click', () => {
    closeDetails();
    $('.play').focus();
    h.onRetry();
  });
  document.addEventListener('pointerdown', (e) => {
    if (detailsOpen && !e.composedPath().includes(host)) closeDetails();
  }, true);
  let infoTimer = null;
  let fadeTimer = null;
  function placeholder() {
    const s = h.getState();
    if (s.sourceInfo && s.status !== 'idle') return s.sourceInfo;
    return voiceLabel(s.settings) || 'Ready';
  }
  // Cross-fades the status text to the latest message (or the placeholder).
  function paintInfo() {
    const box = $('.info');
    const text = info.text || placeholder();
    const classes = { error: info.isError, placeholder: !info.text };
    if (box.dataset.shown === text && Object.entries(classes).every(([name, on]) => box.classList.contains(name) === on)) return;
    box.dataset.shown = text;
    const apply = () => {
      box.querySelector('.text').textContent = text;
      for (const [name, on] of Object.entries(classes)) box.classList.toggle(name, on);
      box.classList.remove('fading');
      if (info.isError) {
        box.setAttribute('role', 'button');
        box.setAttribute('aria-haspopup', 'dialog');
        box.tabIndex = 0;
        box.title = 'Show error details';
      } else {
        box.removeAttribute('role');
        box.removeAttribute('aria-haspopup');
        box.removeAttribute('tabindex');
        box.title = text;
      }
    };
    if (!info.isError) closeDetails();
    clearTimeout(fadeTimer);
    const shown = box.querySelector('.text').textContent;
    if (!shown || info.isError) return apply(); // first paint and errors: no fade
    // A progress update ("…41%" → "…42%") changes in place; fading every step would flicker.
    const shape = (value) => value.replace(/\d+/g, '#');
    if (shape(shown) === shape(text) && !box.classList.contains('placeholder') === !classes.placeholder) return apply();
    box.classList.add('fading');
    fadeTimer = setTimeout(apply, 140);
  }

  const ui = {
    visible: false,
    show() {
      if (!host.isConnected) document.documentElement.append(host);
      ui.visible = true;
      ui.render();
      applyPosition();
    },
    hide() {
      closeDetails();
      host.remove();
      ui.visible = false;
    },
    captureHidden(hidden) {
      host.style.visibility = hidden ? 'hidden' : '';
    },
    render() {
      const s = h.getState();
      // Show the spinner only if loading lasts; between prefetched sentences it would just flash.
      const loading = s.preparing || s.status === 'loading';
      if (!loading) {
        clearTimeout(spinnerTimer);
        spinnerTimer = null;
        shownIcon = s.status === 'playing' ? 'pause' : 'play';
      } else if (!spinnerTimer && shownIcon !== 'loading') {
        spinnerTimer = setTimeout(() => {
          spinnerTimer = null;
          const now = h.getState();
          if (now.preparing || now.status === 'loading') setIcon('loading');
        }, 250);
      }
      setIcon(shownIcon);
      $('.pos').textContent = s.sentences.length ? `${s.idx + 1} / ${s.sentences.length}` : '– / –';
      $('.rate').textContent = `${s.rate.toFixed(1)}×`;
      $('.pick').classList.toggle('active', s.picking);
      if (s.settings) $('.settings').title = `Settings — voice: ${ENGINES[s.settings.engine]?.label}`;
      if (!info.text) paintInfo(); // the placeholder may have changed
    },
    setInfo(text, isError = false, detail = '') {
      info = { text: text || '', isError, detail: detail || '' };
      // Coalesce bursts of status updates; errors show right away.
      if (isError) {
        clearTimeout(infoTimer);
        infoTimer = null;
        paintInfo();
      } else if (!infoTimer) {
        infoTimer = setTimeout(() => {
          infoTimer = null;
          paintInfo();
        }, 120);
      }
    },
  };
  return ui;
}
