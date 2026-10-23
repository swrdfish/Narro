import { isCompleteSentence, splitSentences } from './text.js';

export function validBox(box) {
  return box && ['x0', 'y0', 'x1', 'y1'].every((key) => Number.isFinite(box[key]))
    && box.x0 >= 0 && box.y0 >= 0 && box.x1 > box.x0 && box.y1 > box.y0;
}

export function ocrParagraphs(data, scale = 1) {
  const box = (value) => Object.fromEntries(['x0', 'y0', 'x1', 'y1'].map((key) => [key, value[key] / scale]));
  return (data.blocks || []).flatMap((block) => (block.paragraphs || []).map((paragraph) => ({
    words: (paragraph.lines || []).flatMap((line, lineIndex) => (line.words || []).filter((word) => validBox(word.bbox) && /\S/u.test(word.text)).map((word) => ({
      text: word.text.trim(), confidence: word.confidence, box: box(word.bbox), line: lineIndex,
      symbols: (word.symbols || []).filter((symbol) => validBox(symbol.bbox)).map((symbol) => ({ text: symbol.text, confidence: symbol.confidence, box: box(symbol.bbox) })),
    }))),
  }))).filter((paragraph) => paragraph.words.length);
}

export function orderParagraphs(paragraphs) {
  if (paragraphs.length < 2) return paragraphs;
  const bounds = (paragraph) => ({
    left: Math.min(...paragraph.words.map((word) => word.box.x0)),
    right: Math.max(...paragraph.words.map((word) => word.box.x1)),
    top: Math.min(...paragraph.words.map((word) => word.box.y0)),
    bottom: Math.max(...paragraph.words.map((word) => word.box.y1)),
  });
  const items = paragraphs.map((paragraph) => ({ paragraph, ...bounds(paragraph) })).sort((first, second) => first.left - second.left);
  let right = items[0].right;
  for (let index = 1; index < items.length; index++) {
    if (items[index].left - right > 24) {
      return [...orderParagraphs(items.slice(0, index).map((item) => item.paragraph)), ...orderParagraphs(items.slice(index).map((item) => item.paragraph))];
    }
    right = Math.max(right, items[index].right);
  }
  items.sort((first, second) => first.top - second.top || first.left - second.left);
  let bottom = items[0].bottom;
  for (let index = 1; index < items.length; index++) {
    if (items[index].top - bottom > 8) {
      return [...orderParagraphs(items.slice(0, index).map((item) => item.paragraph)), ...orderParagraphs(items.slice(index).map((item) => item.paragraph))];
    }
    bottom = Math.max(bottom, items[index].bottom);
  }
  return items.map((item) => item.paragraph);
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[sorted.length >> 1] : 0;
};

/**
 * Rebuilds reading-order paragraphs from OCR word boxes. Tesseract's own paragraphs can run across
 * a column gutter (pairing rows of both columns), so lines are split at gutter-sized gaps, ordered
 * column by column, and regrouped into paragraphs by vertical spacing and first-line indents.
 */
export function layoutParagraphs(paragraphs) {
  const words = paragraphs.flatMap((paragraph) => paragraph.words);
  if (!words.length) return [];
  const textHeight = median(words.map((word) => word.box.y1 - word.box.y0)) || 1;

  // 1. OCR lines, split wherever the gap between words is far wider than a word space.
  const pieces = [];
  paragraphs.forEach((paragraph, paragraphIndex) => {
    const lines = new Map();
    for (const word of paragraph.words) {
      const key = `${paragraphIndex}:${word.line}`;
      if (!lines.has(key)) lines.set(key, []);
      lines.get(key).push(word);
    }
    for (const line of lines.values()) {
      line.sort((a, b) => a.box.x0 - b.box.x0);
      let current = [line[0]];
      for (let index = 1; index < line.length; index++) {
        if (line[index].box.x0 - line[index - 1].box.x1 > textHeight * 1.8) {
          pieces.push({ words: current });
          current = [];
        }
        current.push(line[index]);
      }
      pieces.push({ words: current });
    }
  });

  // 2. Columns left to right, top to bottom within each (headings spanning columns come first).
  const ordered = orderParagraphs(pieces).map((piece, index) => ({
    words: piece.words.map((word) => ({ ...word, line: index })),
    left: Math.min(...piece.words.map((word) => word.box.x0)),
    right: Math.max(...piece.words.map((word) => word.box.x1)),
    top: Math.min(...piece.words.map((word) => word.box.y0)),
    bottom: Math.max(...piece.words.map((word) => word.box.y1)),
  }));

  // 3. Regroup lines into paragraphs. Over-splitting is harmless: sentences that carry on across
  // a paragraph boundary are rejoined by continuesInto().
  const sameColumn = (a, b) => b.top >= a.top && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0;
  const columns = [];
  ordered.forEach((line, index) => {
    if (!index || !sameColumn(ordered[index - 1], line)) columns.push([]);
    columns.at(-1).push(line);
  });
  const gaps = columns.flatMap((column) => column.slice(1).map((line, index) => line.top - column[index].bottom));
  const lineGap = Math.max(0, median(gaps));
  const result = [];
  for (const column of columns) {
    const left = Math.min(...column.map((line) => line.left));
    const right = Math.max(...column.map((line) => line.right));
    column.forEach((line, index) => {
      const previous = column[index - 1];
      const fresh = !previous
        || line.top - previous.bottom > lineGap + textHeight * 0.6 // extra space above
        || line.left - left > textHeight * 0.8 // first-line indent
        || right - previous.right > textHeight * 3; // previous line ended short: heading or paragraph end
      if (fresh) result.push({ words: [] });
      result.at(-1).words.push(...line.words);
    });
  }
  return result;
}

// Words that almost never end a sentence: a paragraph ending in one continues in the next.
const CONTINUING_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'onto', 'upon',
  'as', 'than', 'that', 'which', 'who', 'whom', 'whose', 'if', 'because', 'while', 'although', 'though', 'whether', 'when', 'where',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had', 'will', 'would', 'can', 'could', 'shall', 'should', 'may', 'might', 'must',
  'its', 'their', 'his', 'her', 'our', 'your', 'my', 'this', 'these', 'those', 'such', 'very', 'more', 'most', 'not', 'no',
]);

/**
 * Whether text that ends with `before` (a paragraph, column or page) carries on into `after`:
 * a sentence split across a column break or a page turn.
 */
export function continuesInto(before, after) {
  const prev = before.trimEnd();
  const next = after.trimStart();
  if (!prev || !next || isCompleteSentence(prev)) return false;
  if (/^[\p{Ll}\d,;:)\]’”—–-]/u.test(next)) return true;
  return CONTINUING_WORDS.has(prev.split(/\s+/).pop().toLowerCase());
}

/**
 * Builds the reading list for one or more page images shown side by side.
 * pages: [{ paragraphs, rect, width, height }] in reading order.
 * `carry`: unspoken text cut off at the end of the previous page; it is spoken with its continuation.
 * `tail`: if given, receives the text dropped by `skipIncompleteLast`, to carry onto the next page.
 */
export function buildSpreadSentences(pages, { lang = 'en', skipIncompleteLast = true, carry = '', tail } = {}) {
  // Ordered paragraphs as lists of words with viewport rects.
  const paragraphs = [];
  for (const { paragraphs: found, rect, width, height } of pages) {
    const toRect = (box) => ({
      left: rect.left + box.x0 * rect.width / width,
      top: rect.top + box.y0 * rect.height / height,
      right: rect.left + box.x1 * rect.width / width,
      bottom: rect.top + box.y1 * rect.height / height,
    });
    for (const paragraph of layoutParagraphs(found)) {
      paragraphs.push(paragraph.words.map((word) => ({ text: word.text, line: word.line, rect: toRect(word.box) })));
    }
  }

  // Runs of text that sentences are split from; a run spans paragraphs that continue each other.
  const runs = [];
  let run = null;
  const append = (words, index) => {
    for (const word of words) {
      const previous = run.pieces.at(-1);
      if (run.text) {
        // Rejoin a word hyphenated across a line, column or page break.
        if (previous && (previous.line !== word.line || previous.paragraph !== index) && /[\p{L}][-\u00ad]$/u.test(run.text) && /^\p{Ll}/u.test(word.text)) {
          run.text = run.text.slice(0, -1);
          previous.end--;
        } else run.text += ' ';
      }
      const start = run.text.length;
      run.text += word.text;
      run.pieces.push({ start, end: run.text.length, rect: word.rect, line: word.line, paragraph: index });
    }
  };
  const textOf = (words) => words.map((word) => word.text).join(' ');
  paragraphs.forEach((words, index) => {
    if (!run) {
      run = { text: '', pieces: [] };
      if (index === 0 && carry && continuesInto(carry, textOf(words))) {
        run.text = carry.trim();
        run.pieces.push({ start: 0, end: run.text.length, rect: null, line: -1, paragraph: -1 });
      }
    } else if (!continuesInto(run.text, textOf(words))) {
      runs.push(run);
      run = { text: '', pieces: [] };
    }
    append(words, index);
  });
  if (run) runs.push(run);

  const sentences = [];
  for (const { text, pieces } of runs) {
    for (const { start, end } of splitSentences(text, lang)) {
      const sentence = text.slice(start, end).trim();
      if (!/[\p{L}\p{N}]/u.test(sentence)) continue;
      const touched = pieces.filter((piece) => piece.end > start && piece.start < end);
      const blocks = new Set(touched.map((piece) => piece.paragraph).filter((index) => index >= 0));
      sentences.push({
        text: sentence,
        blockIndex: Math.min(...blocks, Infinity),
        rects: touched.filter((piece) => piece.rect).map((piece) => piece.rect),
        blockRects: pieces.filter((piece) => piece.rect && blocks.has(piece.paragraph)).map((piece) => piece.rect),
      });
    }
  }
  if (skipIncompleteLast) {
    let keep = sentences.length;
    while (keep > 0 && !isCompleteSentence(sentences[keep - 1].text)) keep--;
    if (keep > 0) {
      const dropped = sentences.splice(keep);
      tail?.push(...dropped.map((sentence) => sentence.text));
    }
  }
  return sentences;
}

export function buildVisualSentences(paragraphs, rect, width, height, options) {
  return buildSpreadSentences([{ paragraphs, rect, width, height }], options);
}

export function visualSentenceAt(sentences, x, y) {
  return sentences.findIndex((sentence) => sentence.rects?.some((rect) => x >= rect.left - 2 && x <= rect.right + 2 && y >= rect.top - 2 && y <= rect.bottom + 2));
}

const glyphKey = (glyph) => JSON.stringify([glyph.font, glyph.id]);

function align(page, words, width, height) {
  if (Math.abs(page.width / page.height - width / height) > 0.02) return null;
  const scaleX = width / page.width;
  const scaleY = height / page.height;
  const glyphs = page.glyphs.map((glyph) => ({ ...glyph, x: glyph.x * scaleX, baseline: glyph.baseline * scaleY, size: glyph.size * scaleY }));
  const matches = [];
  let matched = 0;
  let total = 0;
  for (const word of words) {
    if (!Number.isFinite(word.confidence) || word.confidence < 80 || !word.symbols.length) continue;
    total += word.symbols.length;
    const { box } = word;
    const lineHeight = box.y1 - box.y0;
    const selected = glyphs.filter((glyph) => glyph.x >= box.x0 - lineHeight * 0.25 && glyph.x < box.x1
      && glyph.baseline >= box.y0 + lineHeight * 0.5 && glyph.baseline <= box.y1 + lineHeight * 0.5).sort((first, second) => first.x - second.x);
    if (selected.length !== word.symbols.length || selected.length !== [...word.text].length) continue;
    if (!selected.every((glyph, index) => Math.abs(glyph.x - word.symbols[index].box.x0) < glyph.size * 0.35)) continue;
    matched += selected.length;
    matches.push({ word, glyphs: selected });
  }
  return total >= 24 && matched / total >= 0.85 ? { matches, score: matched / total, matched } : null;
}

export class GlyphDecoder {
  constructor() {
    this.tables = new Map();
  }

  decode(batches, paragraphs, width, height) {
    const words = paragraphs.flatMap((paragraph) => paragraph.words);
    const candidates = [];
    const seen = new Set();
    for (const batch of batches) {
      for (const page of batch.pages) {
        const identity = `${batch.id}:${JSON.stringify(page)}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        const alignment = align(page, words, width, height);
        if (alignment) candidates.push({ ...alignment, id: `${batch.book}:${batch.id}`, identity });
      }
    }
    candidates.sort((first, second) => second.score - first.score);
    const best = candidates[0];
    if (!best || (candidates[1] && best.score - candidates[1].score < 0.08)) return { paragraphs, source: 'ocr' };
    const previous = this.tables.get(best.id);
    const table = new Map([...(previous?.votes || [])].map(([key, votes]) => [key, new Map(votes)]));
    const calibrated = new Set(previous?.calibrated);
    let conflicts = 0;
    let observations = 0;
    for (const { word, glyphs } of best.matches) {
      if (calibrated.has(best.identity) || word.confidence < 90) continue;
      glyphs.forEach((glyph, index) => {
        const symbol = word.symbols[index];
        if (!Number.isFinite(symbol.confidence) || symbol.confidence < 90 || [...symbol.text].length !== 1) return;
        const key = glyphKey(glyph);
        const votes = table.get(key) || new Map();
        if (votes.size && !votes.has(symbol.text)) conflicts++;
        observations++;
        votes.set(symbol.text, (votes.get(symbol.text) || 0) + 1);
        table.set(key, votes);
      });
    }
    if ((!observations && !calibrated.has(best.identity)) || conflicts / observations > 0.02) return { paragraphs, source: 'ocr' };
    calibrated.add(best.identity);
    while (calibrated.size > 24) calibrated.delete(calibrated.values().next().value);
    this.tables.set(best.id, { votes: table, calibrated });
    while (this.tables.size > 6) this.tables.delete(this.tables.keys().next().value);
    const replacements = new Map();
    for (const { word, glyphs } of best.matches) {
      const characters = glyphs.map((glyph) => {
        const votes = table.get(glyphKey(glyph));
        if (votes?.size !== 1) return null;
        const [character, count] = [...votes][0];
        return count >= 2 ? character : null;
      });
      if (characters.every((character) => character !== null)) {
        const decoded = characters.join('');
        if (word.confidence >= 90 && decoded !== word.text) return { paragraphs, source: 'ocr' };
        replacements.set(word, decoded);
      }
    }
    return {
      paragraphs: paragraphs.map((paragraph) => ({ words: paragraph.words.map((word) => ({ ...word, text: replacements.get(word) ?? word.text })) })),
      source: replacements.size ? 'hybrid' : 'ocr',
    };
  }
}
