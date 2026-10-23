// models.json is edited by hand; catch mistakes before they reach the settings page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_SETTINGS } from '../src/settings.js';

const models = JSON.parse(readFileSync(new URL('../src/models.json', import.meta.url), 'utf8'));

for (const engine of ['openai', 'elevenlabs', 'gemini', 'piper']) {
  test(`models.json lists ${engine} models as { id: label }`, () => {
    const list = models[engine];
    assert.ok(list && typeof list === 'object' && !Array.isArray(list), `"${engine}" must be an object`);
    assert.ok(Object.keys(list).length > 0, `"${engine}" must list at least one model`);
    for (const [id, label] of Object.entries(list)) {
      assert.match(id, /^\S+$/, `model id "${id}" must not contain spaces`);
      assert.equal(typeof label, 'string', `label for "${id}" must be a string`);
      assert.ok(label.trim(), `label for "${id}" must not be empty`);
    }
  });

  test(`models.json includes the default ${engine} ${engine === 'piper' ? 'voice' : 'model'}`, () => {
    const id = engine === 'piper' ? DEFAULT_SETTINGS.piper.voice : DEFAULT_SETTINGS[engine].model;
    assert.ok(id in models[engine], `default "${id}" is missing`);
  });
}

test('Piper voice ids follow piper-voices naming (lang-speaker-quality)', () => {
  for (const id of Object.keys(models.piper)) assert.match(id, /^[a-z]{2,3}_[A-Z]{2}-[a-z0-9_]+-(x_low|low|medium|high)$/, id);
});
