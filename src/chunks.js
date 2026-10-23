// Groups consecutive sentences into one speech request, so the voice keeps its intonation across
// sentences and there are fewer gaps between clips. Highlighting still moves sentence by sentence.

export const CHUNK_MAX_SENTENCES = 4;
export const CHUNK_MAX_CHARS = 400;

/**
 * Index of the last sentence in the chunk starting at `start`.
 * `first`: the first chunk after starting or jumping is one sentence, so speech begins quickly.
 * `single`: one sentence per request (engines that don't report playback progress).
 */
export function chunkEnd(sentences, start, { first = false, single = false } = {}) {
  if (first || single) return start;
  let end = start;
  let chars = sentences[start].text.length;
  while (
    end + 1 < sentences.length
    && end + 1 - start < CHUNK_MAX_SENTENCES
    && chars + 1 + sentences[end + 1].text.length <= CHUNK_MAX_CHARS
  ) {
    end++;
    chars += 1 + sentences[end].text.length;
  }
  return end;
}

export function chunkText(sentences, start, end) {
  return sentences.slice(start, end + 1).map((sentence) => sentence.text).join(' ');
}

/** Fraction (0–1) of the way through the chunk start..end at which sentence `index` ends. */
export function sentenceEndFraction(sentences, start, end, index) {
  const total = chunkText(sentences, start, end).length;
  return Math.min(1, (chunkText(sentences, start, index).length + 1) / total);
}

/**
 * The sentence being spoken `fraction` (0–1) of the way through the chunk start..end,
 * assuming speaking time is proportional to the number of characters.
 */
export function sentenceAtFraction(sentences, start, end, fraction) {
  const total = chunkText(sentences, start, end).length;
  const position = Math.min(Math.max(fraction, 0), 1) * total;
  let offset = 0;
  for (let index = start; index < end; index++) {
    offset += sentences[index].text.length + 1;
    if (position < offset) return index;
  }
  return end;
}
