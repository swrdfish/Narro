import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kittenChunks, kittenStyle, kittenTokens, readNpz } from '../src/kitten.js';

// Expected ids computed with the reference implementation's tokenizer (kittentts 0.8).
test('turns phonemes into the model token ids, like the reference', () => {
  assert.deepEqual(kittenTokens('həlˈoʊ wˈɜːld!'), [0, 50, 83, 54, 156, 57, 135, 16, 65, 156, 87, 158, 54, 46, 16, 5, 0]);
  assert.deepEqual(kittenTokens('ðə kˈæt, sˈæt.'), [0, 81, 83, 16, 53, 156, 72, 62, 16, 3, 16, 61, 156, 72, 62, 16, 4, 0]);
  assert.deepEqual(kittenTokens('ɹˈiːdɪŋ ɐlˈaʊd—nˈaʊ?'), [0, 123, 156, 51, 158, 46, 102, 112, 16, 70, 54, 156, 43, 135, 46, 16, 9, 16, 56, 156, 43, 135, 16, 6, 0]);
});

test('drops characters the model has no symbol for', () => {
  // The reference splits at ¶ too ("a ¶ b"), so the spaces either side stay.
  assert.deepEqual(kittenTokens('a¶b'), [0, 43, 16, 16, 44, 0]);
});

test('splits text into sentences ending in punctuation, like the reference', () => {
  assert.deepEqual(kittenChunks('Hello there. How are you?! Fine; thanks...'), ['Hello there,', 'How are you,', 'Fine; thanks,']);
  assert.deepEqual(kittenChunks('one two three four five six', 10), ['one two,', 'three four,', 'five six,']);
});

// A stored (uncompressed) zip holding one float32 .npy, as numpy.savez writes it.
function npz(name, shape, values) {
  // numpy pads the header so the data starts at a multiple of 64 bytes.
  const header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${shape.join(', ')}), }`.padEnd(117) + '\n';
  const npy = new Uint8Array(10 + header.length + values.length * 4);
  npy.set([0x93, ...new TextEncoder().encode('NUMPY'), 1, 0]);
  new DataView(npy.buffer).setUint16(8, header.length, true);
  npy.set(new TextEncoder().encode(header), 10);
  new Float32Array(npy.buffer, 10 + header.length).set(values);
  // Like numpy, a ZIP64 entry: sizes 0xFFFFFFFF in the header, the real ones in the extra field.
  const fileName = new TextEncoder().encode(`${name}.npy`);
  const extra = 20;
  const zip = new Uint8Array(30 + fileName.length + extra + npy.length);
  const view = new DataView(zip.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint32(18, 0xffffffff, true);
  view.setUint32(22, 0xffffffff, true);
  view.setUint16(26, fileName.length, true);
  view.setUint16(28, extra, true);
  zip.set(fileName, 30);
  const field = 30 + fileName.length;
  view.setUint16(field, 0x0001, true);
  view.setUint16(field + 2, 16, true);
  view.setBigUint64(field + 4, BigInt(npy.length), true);
  view.setBigUint64(field + 12, BigInt(npy.length), true);
  zip.set(npy, field + extra);
  return zip.buffer;
}

test('reads voice styles from a .npz file and picks the row by text length', () => {
  const voices = readNpz(npz('expr-voice-2-m', [3, 2], [1, 2, 3, 4, 5, 6]));
  const voice = voices['expr-voice-2-m'];
  assert.deepEqual(voice.shape, [3, 2]);
  assert.deepEqual([...kittenStyle(voice, 1)], [3, 4]);
  assert.deepEqual([...kittenStyle(voice, 50)], [5, 6], 'long text uses the last row');
});
