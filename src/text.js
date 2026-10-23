// Extracts readable text from the page as a list of sentences, each mapped back to a DOM Range
// so it can be highlighted while it is spoken.

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME',
  'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'LABEL',
  'NAV', 'ASIDE', 'FOOTER', 'PRE', 'SUP', 'RP', 'RT',
]);

const SKIP_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'search', 'menu', 'menubar', 'toolbar', 'dialog', 'alert']);

const INLINE_DISPLAYS = new Set(['inline', 'inline-block', 'inline-flex', 'inline-grid', 'contents', 'ruby', 'ruby-text']);

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'vs', 'etc', 'e.g', 'i.e', 'cf', 'al', 'fig', 'no', 'vol',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'inc', 'ltd', 'co', 'corp', 'gen', 'gov', 'sen', 'rep', 'lt', 'col', 'capt',
]);

// Terminal punctuation, optionally followed by closing quotes/brackets.
const COMPLETE_RE = /[.!?…。！？‼⁇][\s"'”’»)\]]*$/;
const MAX_CHUNK = 350;

export function isCompleteSentence(text) {
  return COMPLETE_RE.test(text.trim());
}

/** Picks the element that most likely holds the main article text. */
export function findContentRoot(doc = document) {
  const scores = new Map();
  for (const p of doc.body.querySelectorAll('p, blockquote, li, dd')) {
    const len = p.textContent.trim().length;
    if (len < 40) continue;
    let el = p.parentElement;
    for (let depth = 0; el && depth < 3; depth++, el = el.parentElement) {
      scores.set(el, (scores.get(el) || 0) + len / (depth + 1));
    }
  }
  let best = null;
  let bestScore = 0;
  for (const [el, score] of scores) {
    if (score > bestScore) [best, bestScore] = [el, score];
  }
  // Prefer a semantic container that wraps the best candidate (keeps the article title).
  const semantic = best?.closest('article, main, [role="main"]');
  if (semantic) return semantic;
  return best && bestScore > 500 ? best : doc.body;
}

function isSkipped(el, cache) {
  if (cache.has(el)) return cache.get(el);
  let skip = false;
  if (SKIP_TAGS.has(el.tagName.toUpperCase())) skip = true;
  else if (el.getAttribute('aria-hidden') === 'true' || el.hidden) skip = true;
  else if (SKIP_ROLES.has(el.getAttribute('role'))) skip = true;
  else if (el.id === 'ai-reader-host') skip = true;
  else if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) skip = true;
  cache.set(el, skip);
  return skip;
}

function blockAncestor(node, root, cache) {
  let el = node.parentElement;
  while (el && el !== root) {
    let display = cache.get(el);
    if (display === undefined) {
      display = el.ownerDocument.defaultView.getComputedStyle(el).display;
      cache.set(el, display);
    }
    if (!INLINE_DISPLAYS.has(display)) return el;
    el = el.parentElement;
  }
  return root;
}

/**
 * Collects runs of text nodes that belong to the same block element.
 * Returns [{ el, text, pieces: [{ node, start }] }] in document order.
 */
export function extractBlocks(root) {
  const skipCache = new Map();
  const displayCache = new Map();
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (n.nodeType === Node.ELEMENT_NODE) {
        // Skipping an element rejects its whole subtree.
        return n !== root && isSkipped(n, skipCache) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      }
      return n.data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });

  const blocks = [];
  let current = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = blockAncestor(node, root, displayCache);
    if (!current || current.el !== el) {
      current = { el, text: '', pieces: [] };
      blocks.push(current);
    }
    current.pieces.push({ node, start: current.text.length });
    current.text += node.data;
  }
  return blocks.filter((b) => /[\p{L}\p{N}]/u.test(b.text));
}

function locate(block, offset, preferEnd) {
  const { pieces } = block;
  for (let i = 0; i < pieces.length; i++) {
    const { node, start } = pieces[i];
    const end = start + node.data.length;
    if (offset < end || (preferEnd && offset === end) || i === pieces.length - 1) {
      return { node, offset: Math.min(Math.max(offset - start, 0), node.data.length) };
    }
  }
  return null;
}

export function splitSentences(text, lang) {
  const out = [];
  let segmenter;
  try {
    segmenter = new Intl.Segmenter(lang, { granularity: 'sentence' });
  } catch {
    segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  }
  for (const { segment, index } of segmenter.segment(text)) {
    out.push({ start: index, end: index + segment.length });
  }

  // Re-join splits after common abbreviations ("Dr. Smith") and initials ("J. R. R. Tolkien").
  const merged = [];
  for (const s of out) {
    const prev = merged[merged.length - 1];
    if (prev) {
      const prevText = text.slice(prev.start, prev.end).trimEnd();
      const lastWord = (prevText.match(/(\S+)\.$/) || [])[1];
      if (lastWord && (ABBREVIATIONS.has(lastWord.toLowerCase()) || /^\p{Lu}$/u.test(lastWord))) {
        prev.end = s.end;
        continue;
      }
    }
    merged.push({ ...s });
  }

  // Very long sentences delay the first audio and bloat requests; split them at clause boundaries.
  const result = [];
  for (const s of merged) {
    let { start } = s;
    while (s.end - start > MAX_CHUNK) {
      const window = text.slice(start, start + MAX_CHUNK);
      const cut = Math.max(window.lastIndexOf('; '), window.lastIndexOf(': '), window.lastIndexOf(' — '), window.lastIndexOf(', '));
      const at = cut > MAX_CHUNK / 3 ? cut + 1 : window.lastIndexOf(' ');
      if (at <= 0) break;
      result.push({ start, end: start + at });
      start += at;
    }
    result.push({ start, end: s.end });
  }
  return result;
}

/**
 * Builds the reading list for the page.
 * Returns [{ text, range, blockIndex, el }].
 */
export function buildSentences(root, { lang = 'en', skipIncompleteLast = true } = {}) {
  const doc = root.ownerDocument;
  const blocks = extractBlocks(root);
  const sentences = [];
  blocks.forEach((block, blockIndex) => {
    for (let { start, end } of splitSentences(block.text, lang)) {
      // Trim whitespace so the highlight hugs the words.
      while (start < end && /\s/.test(block.text[start])) start++;
      while (end > start && /\s/.test(block.text[end - 1])) end--;
      const text = block.text.slice(start, end).replace(/\s+/g, ' ');
      if (!/[\p{L}\p{N}]/u.test(text)) continue;
      const a = locate(block, start, false);
      const b = locate(block, end, true);
      const range = doc.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      sentences.push({ text, range, blockIndex, el: block.el });
    }
  });

  if (skipIncompleteLast) {
    // Drop the trailing run of sentences without terminal punctuation: a sentence cut off at the
    // page boundary, plus any trailing chrome ("Next chapter") after it. Never drop everything.
    let keep = sentences.length;
    while (keep > 0 && !isCompleteSentence(sentences[keep - 1].text)) keep--;
    if (keep > 0) sentences.length = keep;
  }
  return sentences;
}

/**
 * Index of the sentence containing (node, offset), or -1.
 * Unless `exact`, falls back to the first sentence after the point.
 */
export function sentenceAt(sentences, node, offset, { exact = false } = {}) {
  for (let i = 0; i < sentences.length; i++) {
    const r = sentences[i].range;
    try {
      if (r.comparePoint(node, offset) === 0) return i;
    } catch {
      // Different document/detached node.
    }
  }
  if (exact) return -1;
  // Fall back to the first sentence that starts after the point.
  for (let i = 0; i < sentences.length; i++) {
    try {
      if (sentences[i].range.comparePoint(node, offset) < 0) return i;
    } catch {}
  }
  return -1;
}
