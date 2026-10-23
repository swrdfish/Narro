// Which tab is reading and how, for the toolbar badge and the popup's "Now reading" controls.
// Kept in chrome.storage.session as `readerState`: { tabId, status, title } or absent.

export const READER_STATE_KEY = 'readerState';

/** Applies a status report from a tab ('playing' | 'loading' | 'paused' | 'idle'). */
export function nextReaderState(current, { tabId, status, title }) {
  if (status === 'idle') return current?.tabId === tabId ? null : current; // another tab may be reading
  return { tabId, status, title: title || (current?.tabId === tabId ? current.title : '') || '' };
}

// A play triangle; U+FE0E asks for the plain text glyph rather than a coloured emoji.
export const PLAYING_BADGE = '\u25B6\uFE0E';

/** The toolbar badge: red with a white play symbol while speech is playing or about to. */
export function badgeFor(state) {
  const active = !!state && (state.status === 'playing' || state.status === 'loading');
  return active ? { text: PLAYING_BADGE, color: '#e5484d', textColor: '#ffffff' } : { text: '', color: null, textColor: null };
}
