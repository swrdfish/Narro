import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthesize } from '../src/engines.js';

// Records requests and answers with a fixed response.
function fakeFetch(respond) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    return respond(url, init);
  };
  return calls;
}

const openrouter = (overrides = {}) => ({
  engine: 'openrouter',
  openrouter: { apiKey: 'sk-or-test', model: 'google/gemini-3.8-flash-tts', voice: 'Kore', instructions: '', ...overrides },
});

test('OpenRouter: posts to the speech endpoint, asks for MP3 and never sends speed', async () => {
  const calls = fakeFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } }));
  const blob = await synthesize(openrouter(), 'Boats left early.');
  assert.equal(blob.size, 3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/audio/speech');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-or-test');
  assert.deepEqual(calls[0].body, { model: 'google/gemini-3.8-flash-tts', input: 'Boats left early.', voice: 'Kore', response_format: 'mp3' });
});

test('OpenRouter: style instructions are sent only when set', async () => {
  const calls = fakeFetch(() => new Response(new Uint8Array([1]), { status: 200 }));
  await synthesize(openrouter({ instructions: 'Calm narration' }), 'Hello.');
  assert.equal(calls[0].body.instructions, 'Calm narration');
});

test('OpenRouter: a missing key and API errors produce readable messages', async () => {
  fakeFetch(() => { throw new Error('should not be called'); });
  await assert.rejects(synthesize(openrouter({ apiKey: '' }), 'Hello.'), /OpenRouter: add an API key/);

  fakeFetch(() => new Response(JSON.stringify({ error: { message: 'Missing Authentication header', code: 401 } }), { status: 401 }));
  await assert.rejects(synthesize(openrouter(), 'Hello.'), (error) => {
    assert.match(error.message, /OpenRouter 401: the API key wasn't accepted/);
    assert.match(error.detail, /Missing Authentication header/, 'the server response stays in the details');
    return true;
  });

  fakeFetch(() => new Response(JSON.stringify({ error: { code: 402, message: 'Insufficient credits. Add more at https://openrouter.ai/settings/credits' } }), { status: 402 }));
  await assert.rejects(synthesize(openrouter(), 'Hello.'), (error) => {
    assert.match(error.message, /^OpenRouter 402: Insufficient credits/);
    assert.match(error.detail, /"code": 402/);
    return true;
  });
});
