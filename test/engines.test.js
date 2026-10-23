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

// --- Time limits and retries for cloud requests ---------------------------------------------------

const openai = { engine: 'openai', openai: { apiKey: 'sk-test', model: 'tts-1', voice: 'nova', instructions: '' } };
const mp3 = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });

// Never answers, like a stalled connection; rejects when the request is aborted, as fetch does.
const stall = (_url, init) => new Promise((_resolve, reject) => {
  init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
});

// Starts sending audio, then stops partway.
const stallMidBody = (_url, init) => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(new Uint8Array([1]));
    init.signal.addEventListener('abort', () => controller.error(new DOMException('The operation was aborted.', 'AbortError')));
  },
}), { status: 200 });

// Runs `promise` to completion with mocked timers, moving the clock forward a second at a time.
async function withClock(t, start) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const promise = start().finally(() => { settled = true; });
  promise.catch(() => {});
  try {
    for (let i = 0; i < 1000 && !settled; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(1000);
    }
    return await promise;
  } finally {
    t.mock.timers.reset();
  }
}

test('Cloud requests: a request that never responds is retried, then fails instead of waiting forever', async (t) => {
  const calls = fakeFetch(stall);
  const statuses = [];
  await assert.rejects(
    withClock(t, () => synthesize(openai, 'Hello.', { onStatus: (s) => statuses.push(s) })),
    /OpenAI: no response for 40 seconds/,
  );
  assert.equal(calls.length, 3, 'one try plus two retries');
  assert.deepEqual(statuses, ["OpenAI didn't respond, retrying…", "OpenAI didn't respond, retrying…"]);
});

test('Cloud requests: audio that stops arriving is retried, and the retry succeeds', async (t) => {
  let n = 0;
  const calls = fakeFetch((url, init) => (n++ === 0 ? stallMidBody(url, init) : mp3()));
  const blob = await withClock(t, () => synthesize(openai, 'Hello.'));
  assert.equal(blob.size, 3);
  assert.equal(calls.length, 2);
});

test('Cloud requests: 5xx and rate limits are retried, honouring Retry-After', async (t) => {
  let n = 0;
  const calls = fakeFetch(() => (n++ === 0
    ? new Response(JSON.stringify({ error: { message: 'Rate limit reached' } }), { status: 429, headers: { 'retry-after': '2' } })
    : mp3()));
  const blob = await withClock(t, () => synthesize(openai, 'Hello.'));
  assert.equal(blob.size, 3);
  assert.equal(calls.length, 2);

  n = 0;
  fakeFetch(() => (n++ === 0 ? new Response('Bad gateway', { status: 502 }) : mp3()));
  assert.equal((await withClock(t, () => synthesize(openai, 'Hello.'))).size, 3);
});

test("Cloud requests: errors that a retry can't fix fail at once", async (t) => {
  let calls = fakeFetch(() => new Response(JSON.stringify({ error: { message: 'You exceeded your current quota.' } }), { status: 429 }));
  await assert.rejects(withClock(t, () => synthesize(openai, 'Hello.')), /OpenAI 429: You exceeded your current quota/);
  assert.equal(calls.length, 1);

  calls = fakeFetch(() => new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), { status: 401 }));
  await assert.rejects(withClock(t, () => synthesize(openai, 'Hello.')), /OpenAI 401: Incorrect API key/);
  assert.equal(calls.length, 1);
});

test('Cloud requests: a slow response that keeps sending is not cut off', async (t) => {
  // Five chunks, 15 seconds apart: 75 seconds in all, but never idle for 20.
  fakeFetch(() => new Response(new ReadableStream({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      controller.enqueue(new Uint8Array([1]));
      if (++this.sent === 5) controller.close();
    },
    sent: 0,
  }), { status: 200 }));
  const blob = await withClock(t, () => synthesize(openai, 'Hello.'));
  assert.equal(blob.size, 5);
});

test('Gemini: the JSON response is read through the same time limits', async (t) => {
  const pcm = btoa(String.fromCharCode(0, 0, 1, 0));
  fakeFetch(() => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: pcm } }] } }] }), { status: 200 }));
  const blob = await withClock(t, () => synthesize({ engine: 'gemini', gemini: { apiKey: 'k', model: 'm', voice: 'Kore' } }, 'Hello.'));
  assert.equal(blob.type, 'audio/wav');
  assert.equal(blob.size, 44 + 4);
});
