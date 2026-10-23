import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortcutKeys } from '../src/shortcuts.js';

const labels = (keys) => keys.map((key) => key.label);
const names = (keys) => keys.map((key) => key.name);

test('macOS symbol shortcuts become separate key caps', () => {
  assert.deepEqual(labels(shortcutKeys('⌥⇧R', true)), ['⌥', '⇧', 'R']);
  assert.deepEqual(names(shortcutKeys('⌥⇧R', true)), ['Option', 'Shift', 'R']);
  assert.deepEqual(labels(shortcutKeys('⌥⇧→', true)), ['⌥', '⇧', '→']);
  assert.deepEqual(names(shortcutKeys('⌥⇧→', true)), ['Option', 'Shift', 'Right arrow']);
});

test('a macOS key that is a word stays one key', () => {
  assert.deepEqual(labels(shortcutKeys('⌘⇧Space', true)), ['⌘', '⇧', 'Space']);
  assert.deepEqual(labels(shortcutKeys('⌃⌥Comma', true)), ['⌃', '⌥', ',']);
});

test('Windows/Linux shortcuts use key names', () => {
  assert.deepEqual(labels(shortcutKeys('Alt+Shift+R', false)), ['Alt', 'Shift', 'R']);
  assert.deepEqual(names(shortcutKeys('Alt+Shift+Left', false)), ['Alt', 'Shift', 'Left arrow']);
  assert.deepEqual(labels(shortcutKeys('Ctrl+Shift+Period', false)), ['Ctrl', 'Shift', '.']);
});

test('a single key name is not split into letters', () => {
  assert.deepEqual(labels(shortcutKeys('Alt', true)), ['⌥']);
  assert.deepEqual(labels(shortcutKeys('Alt', false)), ['Alt']);
});

test('an unassigned shortcut has no keys', () => {
  assert.deepEqual(shortcutKeys('', true), []);
  assert.deepEqual(shortcutKeys(undefined, false), []);
});
