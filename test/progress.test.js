import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadProgress } from '../src/progress.js';

const MB = 1024 * 1024;
const run = (events) => {
  const shown = [];
  const report = downloadProgress('model', (text) => shown.push(text));
  for (const event of events) report(event);
  return shown;
};

test('small files finishing first do not read as almost done', () => {
  // Kokoro-style: the tokenizer finishes before the model file is even announced.
  const shown = run([
    { status: 'progress', file: 'tokenizer.json', loaded: 1 * MB, total: 1 * MB },
    { status: 'done', file: 'tokenizer.json' },
    { status: 'progress', file: 'model.onnx', loaded: 9 * MB, total: 90 * MB },
    { status: 'progress', file: 'model.onnx', loaded: 45 * MB, total: 90 * MB },
  ]);
  assert.deepEqual(shown, ['Downloading model…', 'Downloading model… 11%', 'Downloading model… 51%']); // (1 + 45) / (1 + 90)
});

test('files that announce but never report a size do not block the percentage', () => {
  const shown = run([
    { status: 'initiate', file: 'optional.json' }, // never completes
    { status: 'initiate', file: 'weights.onnx_data' },
    { status: 'progress', file: 'weights.onnx_data', loaded: 25 * MB, total: 100 * MB },
  ]);
  assert.deepEqual(shown, ['Downloading model… 25%']);
});

test('the percentage only goes up within a set of files, and stays below 100%', () => {
  const shown = run([
    { status: 'progress', file: 'a', loaded: 60 * MB, total: 100 * MB },
    { status: 'progress', file: 'a', loaded: 50 * MB, total: 100 * MB }, // out of order: ignored
    { status: 'progress', file: 'a', loaded: 100 * MB, total: 100 * MB },
    { status: 'done', file: 'a' },
  ]);
  assert.deepEqual(shown, ['Downloading model… 60%', 'Downloading model… 99%']);
});

test('a new large file joining lets the percentage drop once instead of sticking at 99%', () => {
  const shown = run([
    { status: 'progress', file: 'a', loaded: 10 * MB, total: 10 * MB },
    { status: 'progress', file: 'b', loaded: 0, total: 90 * MB },
    { status: 'progress', file: 'b', loaded: 45 * MB, total: 90 * MB },
  ]);
  assert.deepEqual(shown, ['Downloading model… 99%', 'Downloading model… 10%', 'Downloading model… 55%']);
});
