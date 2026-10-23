// Remembers where reading stopped on each page, so pressing Play there again resumes from it.
// Only a short fingerprint of the sentence is stored, not its text.

const STORAGE_KEY = 'positions';
const MAX_PAGES = 200;

/** The page a position belongs to: the book on Kindle, otherwise the address without its #fragment. */
export function pageKey(location, kindleBook) {
  return kindleBook ? `kindle:${kindleBook}` : `${location.origin}${location.pathname}${location.search}`;
}

/** Short, stable fingerprint of a sentence that ignores case, spacing and punctuation. */
export function fingerprint(text) {
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  // cyrb53: a small, fast 53-bit string hash.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * Index of the saved sentence in `sentences`, or -1. Matches the fingerprint, preferring the
 * occurrence nearest the saved index; with `allowIndex`, falls back to the saved index itself.
 */
export function findPosition(sentences, saved, { allowIndex = false } = {}) {
  if (!saved) return -1;
  let best = -1;
  sentences.forEach((sentence, index) => {
    if (fingerprint(sentence.text) !== saved.sentence) return;
    if (best < 0 || Math.abs(index - saved.index) < Math.abs(best - saved.index)) best = index;
  });
  if (best >= 0) return best;
  return allowIndex && saved.index < sentences.length ? saved.index : -1;
}

async function readAll(storage) {
  return (await storage.get(STORAGE_KEY))[STORAGE_KEY] || {};
}

export async function loadPosition(storage, key) {
  return (await readAll(storage))[key] || null;
}

export async function savePosition(storage, key, sentences, index) {
  const all = await readAll(storage);
  all[key] = { sentence: fingerprint(sentences[index].text), index, time: Date.now() };
  // Keep the most recently read pages.
  const keys = Object.keys(all).sort((a, b) => all[b].time - all[a].time);
  for (const old of keys.slice(MAX_PAGES)) delete all[old];
  await storage.set({ [STORAGE_KEY]: all });
}

export async function clearPosition(storage, key) {
  const all = await readAll(storage);
  if (!(key in all)) return;
  delete all[key];
  await storage.set({ [STORAGE_KEY]: all });
}
