// Kitten TTS (KittenML, StyleTTS 2 architecture): text handling and the voices file, following the
// reference implementation (kittentts 0.8, onnx_model.py). The model itself runs in local-worker.js.

export const KITTEN_MODEL = 'https://huggingface.co/KittenML/kitten-tts-nano-0.8-int8/resolve/main';
export const KITTEN_SAMPLE_RATE = 24000;
// The model's output ends with a stretch of silence the reference trims.
export const KITTEN_TRIM_SAMPLES = 5000;

// Friendly names → voice ids in voices.npz, and each voice's speed prior (from the model's config.json).
export const KITTEN_VOICE_IDS = {
  Bella: 'expr-voice-2-f', Jasper: 'expr-voice-2-m', Luna: 'expr-voice-3-f', Bruno: 'expr-voice-3-m',
  Rosie: 'expr-voice-4-f', Hugo: 'expr-voice-4-m', Kiki: 'expr-voice-5-f', Leo: 'expr-voice-5-m',
};
export const KITTEN_SPEED_PRIORS = { 'expr-voice-4-m': 0.9 }; // every other voice: 0.8
export const kittenSpeed = (voiceId) => KITTEN_SPEED_PRIORS[voiceId] ?? 0.8;

// Token ids: the model's symbol table (pad, punctuation, letters, IPA letters), in order.
const SYMBOLS = [
  '$',
  ...';:,.!?¡¿—…"«»"" ',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  ..."ɑɐɒæɓʙβɔɕçɗɖðʤəɘɚɛɜɝɞɟʄɡɠɢʛɦɧħɥʜɨɪʝɭɬɫɮʟɱɯɰŋɳɲɴøɵɸθœɶʘɹɺɾɻʀʁɽʂʃʈʧʉʊʋⱱʌɣɤʍχʎʏʑʐʒʔʡʕʢǀǁǂǃˈˌːˑʼʴʰʱʲʷˠˤ˞↓↑→↗↘'̩'ᵻ",
];
// Like the reference's dict, a symbol listed twice keeps its last index.
const SYMBOL_IDS = new Map(SYMBOLS.map((symbol, index) => [symbol, index]));

/**
 * Phonemes (espeak IPA with stress and punctuation) → token ids, wrapped in pad tokens.
 * The reference splits the phonemes into words and punctuation (Python's \w+|[^\w\s]) and rejoins
 * them with spaces before looking up each character; unknown characters are dropped.
 */
export function kittenTokens(phonemes) {
  const spaced = (phonemes.match(/[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]/gu) || []).join(' ');
  const ids = [0];
  for (const char of spaced) {
    const id = SYMBOL_IDS.get(char);
    if (id !== undefined) ids.push(id);
  }
  ids.push(0);
  return ids;
}

/**
 * Splits text into the pieces the reference voices one at a time: sentences (at . ! ?), with long
 * ones split between words, each ending in punctuation (a comma if it had none).
 */
export function kittenChunks(text, maxLength = 400) {
  const withPunctuation = (piece) => (/[.!?,;:]$/.test(piece) ? piece : `${piece},`);
  const chunks = [];
  for (const raw of text.split(/[.!?]+/)) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (sentence.length <= maxLength) {
      chunks.push(withPunctuation(sentence));
      continue;
    }
    let piece = '';
    for (const word of sentence.split(/\s+/)) {
      if (piece.length + word.length + 1 <= maxLength) piece = piece ? `${piece} ${word}` : word;
      else {
        if (piece) chunks.push(withPunctuation(piece));
        piece = word;
      }
    }
    if (piece) chunks.push(withPunctuation(piece));
  }
  return chunks;
}

/**
 * Reads a NumPy .npz archive of little-endian float32 arrays stored without compression (as
 * voices.npz is) → { name: { shape, data: Float32Array } }.
 */
export function readNpz(buffer) {
  const view = new DataView(buffer);
  const decoder = new TextDecoder();
  const arrays = {};
  let offset = 0;
  while (offset + 30 <= buffer.byteLength && view.getUint32(offset, true) === 0x04034b50) { // local file header
    const method = view.getUint16(offset + 8, true);
    let size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = decoder.decode(new Uint8Array(buffer, offset + 30, nameLength));
    const start = offset + 30 + nameLength + extraLength;
    // numpy writes ZIP64 entries: the sizes are 0xFFFFFFFF here, and the real ones (uncompressed,
    // then compressed, 8 bytes each) are in the ZIP64 extra field, id 0x0001.
    if (size === 0xffffffff) {
      for (let field = offset + 30 + nameLength; field + 4 <= start; field += 4 + view.getUint16(field + 2, true)) {
        if (view.getUint16(field, true) === 0x0001) size = Number(view.getBigUint64(field + 12, true));
      }
    }
    if (method !== 0) throw new Error(`${name} in the voices file is compressed`);
    arrays[name.replace(/\.npy$/, '')] = readNpy(buffer.slice(start, start + size), name);
    offset = start + size;
  }
  return arrays;
}

function readNpy(buffer, name) {
  const view = new DataView(buffer);
  const major = view.getUint8(6);
  const headerLength = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const headerStart = major === 1 ? 10 : 12;
  const header = new TextDecoder().decode(new Uint8Array(buffer, headerStart, headerLength));
  if (!/'descr':\s*'<f4'/.test(header) || /'fortran_order':\s*True/.test(header)) throw new Error(`${name} isn't a float32 array`);
  const shape = (/'shape':\s*\(([^)]*)\)/.exec(header)?.[1] || '').split(',').map((n) => n.trim()).filter(Boolean).map(Number);
  return { shape, data: new Float32Array(buffer.slice(headerStart + headerLength)) };
}

/** The style vector for a piece of text: the reference picks row min(text length, rows - 1). */
export function kittenStyle(voice, textLength) {
  const [rows, width] = voice.shape;
  const row = Math.min(textLength, rows - 1);
  return voice.data.subarray(row * width, (row + 1) * width);
}
