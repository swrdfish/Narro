import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bandLevels, levelsAt } from '../src/levels.js';

test('levels follow each band loudness per frame, scaled to the loudest', () => {
  const rate = 300; // 10 samples per frame at 30 fps
  const loud = new Float32Array(30).fill(0.5); // 3 frames
  const quiet = new Float32Array(30);
  quiet.fill(0.5, 10, 20); // only the middle frame
  const levels = bandLevels([loud, quiet], rate);
  assert.equal(levels.bands, 2);
  assert.equal(levels.data.length, 6);
  assert.deepEqual(levelsAt(levels, 0), [1, 0]);
  assert.deepEqual(levelsAt(levels, 1 / 30 + 0.001), [1, 1]);
});

test('a quieter sound sits lower on the 45 dB scale, silence at the bottom', () => {
  const rate = 300;
  const half = new Float32Array(10).fill(0.5);
  const tenth = new Float32Array(10).fill(0.05); // 20 dB below
  const silent = new Float32Array(10);
  const [a, b, c] = levelsAt(bandLevels([half, tenth, silent], rate), 0);
  assert.equal(a, 1);
  assert.ok(Math.abs(b - (1 - 20 / 45)) < 0.01, `got ${b}`);
  assert.equal(c, 0);
});

test('no levels outside the clip', () => {
  const levels = bandLevels([new Float32Array(30).fill(0.1)], 300);
  assert.deepEqual(levelsAt(levels, 5), [0]);
  assert.deepEqual(levelsAt(levels, -1), [0]);
});
