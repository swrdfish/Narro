import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { webcrypto } from 'node:crypto';
import { isKindleUrl, readRenderArchive, normalizePages, validBatches } from '../src/kindle-data.js';
import { buildSpreadSentences, buildVisualSentences, continuesInto, GlyphDecoder, ocrParagraphs, orderParagraphs, visualSentenceAt } from '../src/kindle-text.js';
import { captureKindle } from '../src/kindle-capture.js';
import { findKindleSurfaces } from '../src/kindle.js';

function archive(files) {
  const chunks = [];
  for (const [name, value] of Object.entries(files)) {
    const body = Buffer.from(JSON.stringify(value));
    const header = Buffer.alloc(512);
    header.write(name);
    header.write(body.length.toString(8).padStart(11, '0'), 124);
    header.fill(32, 148, 156);
    header[156] = 48;
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    chunks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

const rect = { left: 100, top: 50, width: 400, height: 500 };
const box = (x0, y0, x1, y1) => ({ x0, y0, x1, y1 });
const word = (text, x0 = 10, y0 = 20, line = 0) => ({ text, confidence: 98, box: box(x0, y0, x0 + text.length * 10, y0 + 20), line, symbols: [...text].map((character, index) => ({ text: character, confidence: 99, box: box(x0 + index * 10, y0, x0 + index * 10 + 9, y0 + 20) })) });
// Lays words out left to right with realistic word spacing, `perLine` words per line.
const lineUp = (texts, perLine, top = 20, firstLine = 0, left = 10) => {
  let x = left;
  return texts.map((text, index) => {
    if (index % perLine === 0) x = left;
    const line = Math.floor(index / perLine);
    const placed = word(text, x, top + line * 30, firstLine + line);
    x = placed.box.x1 + 8;
    return placed;
  });
};

function calibratedPage(texts = ['the', 'cat', 'sat', 'the', 'cat', 'sat', 'the', 'cat', 'sat']) {
  const words = texts.map((text, index) => word(text, 20 + index % 3 * 70, 30 + Math.floor(index / 3) * 35, Math.floor(index / 3)));
  const glyphs = words.flatMap((entry) => [...entry.text].map((character, index) => ({ id: character.charCodeAt(0) + 1000, font: 'bookerly', x: entry.box.x0 + index * 10, baseline: entry.box.y1, size: 20 })));
  const page = { width: 400, height: 500, glyphs };
  return { paragraphs: [{ words }], page, batch: { id: 'font-subset-one', book: 'B00AK9IXXM', pages: [page] } };
}

test('Kindle URL detection is regional, HTTPS-only and does not accept lookalike domains', () => {
  assert.ok(isKindleUrl('https://read.amazon.in/?asin=B00AK9IXXM'));
  assert.ok(isKindleUrl('https://read.amazon.co.jp/'));
  for (const url of ['https://read.amazon.in.evil.test', 'https://amazon.in/', 'http://read.amazon.in/', 'invalid']) assert.equal(isKindleUrl(url), false);
});

test('TAR reader only extracts rendering JSON, including concatenated archives', () => {
  const bytes = Buffer.concat([archive({ 'page_data_0_5.json': { pages: [] }, 'metadata.json': { secret: 'ignored' } }), archive({ 'glyphs.json': { glyphs: [] } })]);
  const entries = readRenderArchive(bytes);
  assert.deepEqual([...entries.keys()], ['page_data_0_5.json', 'glyphs.json']);
  assert.equal(entries.has('metadata.json'), false);
});

test('TAR reader rejects bad checksums and truncated entries', () => {
  const bytes = archive({ 'glyphs.json': { data: 'a'.repeat(1000) } });
  assert.throws(() => readRenderArchive(bytes.subarray(0, 600)), /header/);
  bytes[0] ^= 1;
  assert.throws(() => readRenderArchive(bytes), /header/);
});

test('normalizer handles nested run transforms and retains font identity', () => {
  const data = { pages: [{ width: 400, height: 500, transform: [1, 0, 0, 1, 10, 40], children: [
    { fontKey: 'italic', fontSize: 20, glyphs: Array.from({ length: 20 }, (_, index) => index), xPosition: Array.from({ length: 20 }, (_, index) => index * 10) },
  ] }] };
  const pages = normalizePages(data);
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0].glyphs[0], { id: 0, font: 'italic', x: 10, baseline: 40, size: 20 });
  assert.ok(validBatches([{ id: 'subset', book: 'book', pages }]));
  data.pages[0].transform = [2, 0, 0, 2, 10, 40];
  assert.deepEqual(normalizePages(data), []);
});

test('normalizer and bridge validation fail closed on unsupported metadata', () => {
  assert.deepEqual(normalizePages({ unknown: 'schema' }), []);
  assert.equal(validBatches([{ id: 'bad', book: 'book', pages: [{ width: 400, height: 500, glyphs: [{ id: 2, x: NaN }] }] }]), false);
  assert.equal(validBatches({}), false);
});

test('OCR structured output preserves paragraph, line, symbol and scaled coordinates', () => {
  const result = ocrParagraphs({ blocks: [{ paragraphs: [{ lines: [{ words: [{ text: 'Hello.', confidence: 95, bbox: box(20, 40, 120, 80), symbols: [{ text: 'H', confidence: 99, bbox: box(20, 40, 40, 80) }] }] }] }] }] }, 2);
  assert.equal(result[0].words[0].text, 'Hello.');
  assert.deepEqual(result[0].words[0].box, box(10, 20, 60, 40));
  assert.equal(result[0].words[0].symbols[0].box.x1, 20);
  assert.deepEqual(ocrParagraphs({ blocks: null }), []);
});

test('visual sentences preserve abbreviations and map to viewport coordinates', () => {
  const paragraphs = [{ words: [word('Dr.'), word('Smith', 50), word('left.', 110), word('Next', 10, 50, 1), word('sentence.', 60, 50, 1)] }];
  const sentences = buildVisualSentences(paragraphs, rect, 800, 1000);
  assert.deepEqual(sentences.map((sentence) => sentence.text), ['Dr. Smith left.', 'Next sentence.']);
  assert.equal(sentences[0].rects[0].left, 105);
  assert.equal(sentences[0].rects[0].top, 60);
  assert.equal(visualSentenceAt(sentences, 107, 63), 0);
  assert.equal(visualSentenceAt(sentences, 0, 0), -1);
});

test('visual sentences rejoin line-break hyphenation but preserve in-line hyphens', () => {
  const paragraphs = [{ words: [word('An'), word('extraor-', 50), word('dinary', 10, 50, 1), word('well-known', 80, 50, 1), word('story.', 200, 50, 1)] }];
  const [sentence] = buildVisualSentences(paragraphs, rect, 400, 500);
  assert.equal(sentence.text, 'An extraordinary well-known story.');
  assert.equal(sentence.rects.length, 5);
});

test('visual extraction honors the incomplete-last-sentence setting', () => {
  const paragraphs = [{ words: [word('Done.'), word('Unfinished', 100)] }];
  assert.deepEqual(buildVisualSentences(paragraphs, rect, 400, 500).map((sentence) => sentence.text), ['Done.']);
  assert.equal(buildVisualSentences(paragraphs, rect, 400, 500, { skipIncompleteLast: false }).length, 2);
});

test('a sentence split across a column break is read as one sentence', () => {
  const paragraphs = [
    { words: [word('The', 10, 20), word('lamp', 60, 20), word('burned.', 120, 20), word('Then', 10, 50, 1), word('the', 70, 50, 1)] },
    { words: [word('wind', 300, 20), word('blew', 360, 20), word('it', 420, 20), word('out.', 450, 20)] },
  ];
  const sentences = buildVisualSentences(paragraphs, rect, 800, 1000);
  assert.deepEqual(sentences.map((sentence) => sentence.text), ['The lamp burned.', 'Then the wind blew it out.']);
  assert.equal(sentences[1].rects.length, 6, 'highlight covers both columns');
});

test('headings and finished paragraphs are not joined to what follows', () => {
  assert.equal(continuesInto('Chapter Four', 'Rain fell all night.'), false);
  assert.equal(continuesInto('It was over.', 'and yet'), false);
  assert.equal(continuesInto('worth more than', 'Gold ever was.'), true);
  assert.equal(continuesInto('a story about the', 'River people.'), true);
  assert.equal(continuesInto('nothing left but', 'ashes and'), true);
  // A short heading line above a justified body paragraph, as on a real page.
  const body = ['Seeds', 'grow', 'slowly', 'in', 'cold', 'soil', 'but', 'they', 'do', 'grow', 'in', 'the', 'end.'];
  const paragraphs = [
    { words: [word('Small', 10, 20), word('Beginnings', 70, 20)] },
    { words: lineUp(body, 5, 70, 1) },
  ];
  assert.deepEqual(buildVisualSentences(paragraphs, rect, 800, 1000).map((sentence) => sentence.text), ['Small Beginnings', 'Seeds grow slowly in cold soil but they do grow in the end.']);
});

test('text cut off at a page turn is carried and spoken with its continuation', () => {
  const first = [{ words: [word('Boats', 10, 20), word('left.', 70, 20), word('By', 10, 50, 1), word('noon', 40, 50, 1), word('the', 90, 50, 1)] }];
  const tail = [];
  assert.deepEqual(buildVisualSentences(first, rect, 800, 1000, { tail }).map((sentence) => sentence.text), ['Boats left.']);
  assert.deepEqual(tail, ['By noon the']);
  const second = [{ words: [word('harbor', 10, 20), word('was', 80, 20), word('empty.', 130, 20), word('Gulls', 10, 50, 1), word('circled.', 70, 50, 1)] }];
  const sentences = buildVisualSentences(second, rect, 800, 1000, { carry: tail.join(' ') });
  assert.deepEqual(sentences.map((sentence) => sentence.text), ['By noon the harbor was empty.', 'Gulls circled.']);
  assert.equal(sentences[0].rects.length, 3, 'only words visible on this page are highlighted');
});

test('a word hyphenated across a page turn is rejoined', () => {
  const second = [{ words: [word('ment', 10, 20), word('arrived.', 60, 20)] }];
  assert.deepEqual(buildVisualSentences(second, rect, 800, 1000, { carry: 'The new equip-' }).map((sentence) => sentence.text), ['The new equipment arrived.']);
});

test('carried text is not glued onto a page that starts a new sentence', () => {
  const second = [{ words: [word('Morning', 10, 20), word('came.', 90, 20)] }];
  assert.deepEqual(buildVisualSentences(second, rect, 800, 1000, { carry: 'They sang songs' }).map((sentence) => sentence.text), ['Morning came.']);
});

test('a two-page spread joins a sentence across the pages', () => {
  const pages = [
    { paragraphs: [{ words: [word('Snow', 10, 20), word('fell', 60, 20), word('on', 100, 20)] }], rect: { left: 0, top: 0, width: 400, height: 500 }, width: 400, height: 500 },
    { paragraphs: [{ words: [word('the', 10, 20), word('roofs.', 50, 20)] }], rect: { left: 400, top: 0, width: 400, height: 500 }, width: 400, height: 500 },
  ];
  assert.deepEqual(buildSpreadSentences(pages).map((sentence) => sentence.text), ['Snow fell on the roofs.']);
});

test('separate columns read left top-to-bottom, then right top-to-bottom', () => {
  const paragraphs = [
    { words: [word('Right-top.', 300, 20)] }, { words: [word('Left-bottom.', 10, 100)] },
    { words: [word('Left-top.', 10, 20)] }, { words: [word('Right-bottom.', 300, 100)] },
  ];
  assert.deepEqual(orderParagraphs(paragraphs).map((paragraph) => paragraph.words[0].text), ['Left-top.', 'Left-bottom.', 'Right-top.', 'Right-bottom.']);
});

test('a heading spanning columns does not interleave their paragraphs', () => {
  const paragraphs = [
    { words: [{ ...word('Heading.', 10, 10), box: box(10, 10, 500, 30) }] },
    { words: [word('Right-top.', 300, 70)] }, { words: [word('Left-bottom.', 10, 120)] },
    { words: [word('Left-top.', 10, 70)] }, { words: [word('Right-bottom.', 300, 120)] },
  ];
  assert.deepEqual(orderParagraphs(paragraphs).map((paragraph) => paragraph.words[0].text), ['Heading.', 'Left-top.', 'Left-bottom.', 'Right-top.', 'Right-bottom.']);
});

test('glyph decoder calibrates repeated high-confidence characters and decodes words', () => {
  const fixture = calibratedPage();
  const decoder = new GlyphDecoder();
  const result = decoder.decode([fixture.batch], fixture.paragraphs, 400, 500);
  assert.equal(result.source, 'hybrid');
  assert.deepEqual(result.paragraphs, fixture.paragraphs);
  assert.equal(decoder.tables.size, 1);
});

test('glyph decoder falls back on absent, rotated, low-confidence or ambiguous metadata', () => {
  const fixture = calibratedPage();
  const decoder = new GlyphDecoder();
  assert.equal(decoder.decode([], fixture.paragraphs, 400, 500).source, 'ocr');
  assert.equal(decoder.decode([fixture.batch], fixture.paragraphs, 1000, 500).source, 'ocr');
  const alternate = { ...fixture.batch, id: 'another-font-subset' };
  assert.equal(decoder.decode([fixture.batch, alternate], fixture.paragraphs, 400, 500).source, 'ocr');
  const lowConfidence = fixture.paragraphs.map((paragraph) => ({ words: paragraph.words.map((entry) => ({ ...entry, confidence: 40 })) }));
  assert.equal(decoder.decode([fixture.batch], lowConfidence, 400, 500).source, 'ocr');
  assert.equal(decoder.tables.size, 0);
});

test('glyph tables are scoped by book and font subset, not just glyph IDs', () => {
  const fixture = calibratedPage();
  const decoder = new GlyphDecoder();
  decoder.decode([fixture.batch], fixture.paragraphs, 400, 500);
  const changedWords = fixture.paragraphs.map((paragraph) => ({ words: paragraph.words.map((entry) => ({ ...entry, text: entry.text.replaceAll('t', 'b'), symbols: entry.symbols.map((symbol) => ({ ...symbol, text: symbol.text === 't' ? 'b' : symbol.text })) })) }));
  const changedBatch = { ...fixture.batch, id: 'rotated-font-subset' };
  const result = decoder.decode([changedBatch], changedWords, 400, 500);
  assert.equal(result.source, 'hybrid');
  assert.equal(result.paragraphs[0].words[0].text, 'bhe');
  assert.equal(decoder.tables.size, 2);
  assert.equal(decoder.decode([fixture.batch], changedWords, 400, 500).source, 'ocr');
});

test('re-reading one image does not turn a single observation into repeated calibration evidence', () => {
  const fixture = calibratedPage(['abcdef', 'ghijkl', 'mnopqr', 'stuvwx']);
  const decoder = new GlyphDecoder();
  assert.equal(decoder.decode([fixture.batch], fixture.paragraphs, 400, 500).source, 'ocr');
  assert.equal(decoder.decode([fixture.batch], fixture.paragraphs, 400, 500).source, 'ocr');
});

test('validated glyph mappings can correct lower-confidence OCR without accepting conflicting high-confidence text', () => {
  const fixture = calibratedPage();
  const decoder = new GlyphDecoder();
  decoder.decode([fixture.batch], fixture.paragraphs, 400, 500);
  const paragraphs = structuredClone(fixture.paragraphs);
  paragraphs[0].words[0].text = 'tbe';
  paragraphs[0].words[0].confidence = 85;
  paragraphs[0].words[0].symbols[1].text = 'b';
  paragraphs[0].words[0].symbols[1].confidence = 85;
  const result = decoder.decode([fixture.batch], paragraphs, 400, 500);
  assert.equal(result.source, 'hybrid');
  assert.equal(result.paragraphs[0].words[0].text, 'the');
  paragraphs[0].words[0].confidence = 99;
  assert.equal(decoder.decode([fixture.batch], paragraphs, 400, 500).source, 'ocr');
});

const sender = { frameId: 0, url: 'https://read.amazon.in/?asin=B00AK9IXXM', tab: { id: 5, windowId: 7 } };
const captureMessage = () => ({ viewport: { width: 1000, height: 800 }, images: [{ rect }], batches: [] });

test('screenshot fallback verifies the originating tab before and after capture', async () => {
  let captures = 0;
  let active = 5;
  const chromeApi = { tabs: {
    query: async () => [{ id: active, url: sender.url }],
    captureVisibleTab: async (windowId) => { assert.equal(windowId, 7); captures++; return 'data:image/png;base64,fixture'; },
  } };
  const capture = await captureKindle(captureMessage(), sender, chromeApi);
  assert.equal(capture.screenshot, 'data:image/png;base64,fixture');
  active = 6;
  await assert.rejects(captureKindle(captureMessage(), sender, chromeApi), /active/);
  assert.equal(captures, 1);
  active = 5;
  chromeApi.tabs.captureVisibleTab = async () => { active = 6; return 'another tab'; };
  await assert.rejects(captureKindle(captureMessage(), sender, chromeApi), /active/);
});

test('capture refuses non-Kindle senders, subframes, remote image URLs and invalid crops', async () => {
  const chromeApi = { tabs: { query: () => assert.fail('must not access tabs') } };
  await assert.rejects(captureKindle(captureMessage(), { ...sender, url: 'https://example.com' }, chromeApi), /only available/);
  await assert.rejects(captureKindle(captureMessage(), { ...sender, frameId: 1 }, chromeApi), /only available/);
  const message = captureMessage();
  message.images[0].dataUrl = 'https://example.com/private';
  await assert.rejects(captureKindle(message, sender, chromeApi), /Invalid Kindle image/);
  message.images[0] = { rect: { ...rect, left: -20 } };
  await assert.rejects(captureKindle(message, sender, chromeApi), /region/);
});

test('local page images avoid screenshot permission and rendering metadata is never forwarded', async () => {
  const message = captureMessage();
  message.images[0].dataUrl = 'data:image/png;base64,fixture';
  message.batches = [calibratedPage().batch];
  const capture = await captureKindle(message, sender, {});
  assert.equal(capture.screenshot, undefined);
  assert.equal('batches' in capture, false);
});

test('Kindle surface detection excludes toolbars, hidden prefetch pages and network images', () => {
  const dom = new JSDOM('<img id="page" src="blob:https://read.amazon.in/page"><canvas id="hidden" hidden></canvas><img id="cover" src="https://example.com/cover.png"><canvas id="small"></canvas>');
  const doc = dom.window.document;
  for (const element of doc.querySelectorAll('img, canvas')) {
    element.getBoundingClientRect = () => ({ left: 50, top: 50, width: element.id === 'small' ? 50 : 400, height: 500 });
    if (element.tagName === 'IMG') {
      Object.defineProperties(element, { complete: { value: true }, naturalWidth: { value: 800 } });
    }
  }
  assert.deepEqual(findKindleSurfaces(doc, { width: 1000, height: 800 }).map((surface) => surface.element.id), ['page']);
  dom.window.close();
});

test('Kindle surface detection accepts an aria-hidden page image that is visible', () => {
  // Kindle's reader marks the visible page image aria-hidden="true" (hidden from screen readers only).
  const dom = new JSDOM('<div aria-hidden="true"><img id="page" src="blob:https://read.amazon.in/page"></div>');
  const page = dom.window.document.getElementById('page');
  page.getBoundingClientRect = () => ({ left: 174, top: 60, width: 1400, height: 660 });
  Object.defineProperties(page, { complete: { value: true }, naturalWidth: { value: 2800 }, naturalHeight: { value: 1320 } });
  assert.deepEqual(findKindleSurfaces(dom.window.document, { width: 1748, height: 810 }).map((surface) => surface.element.id), ['page']);
  dom.window.close();
});

test('object-fit cover reads the image directly when uncropped and via screenshot when cropped', () => {
  const dom = new JSDOM('<img id="exact" src="blob:https://read.amazon.in/a" style="object-fit:cover"><img id="cropped" src="blob:https://read.amazon.in/b" style="object-fit:cover">');
  const doc = dom.window.document;
  const boxes = { exact: { left: 0, top: 0, width: 1400, height: 660 }, cropped: { left: 0, top: 700, width: 600, height: 300 } };
  for (const img of doc.querySelectorAll('img')) {
    img.getBoundingClientRect = () => boxes[img.id];
    Object.defineProperties(img, { complete: { value: true }, naturalWidth: { value: 2800 }, naturalHeight: { value: 1320 } });
  }
  const surfaces = Object.fromEntries(findKindleSurfaces(doc, { width: 1600, height: 1100 }).map((surface) => [surface.element.id, surface]));
  assert.equal(surfaces.exact.cropped, false);
  assert.equal(surfaces.cropped.cropped, true);
  assert.deepEqual(surfaces.exact.rect, boxes.exact);
  dom.window.close();
});

test('render hook preserves original fetch responses and bridges only normalized current-book metadata', async () => {
  const bundle = (await build({ entryPoints: ['src/kindle-intercept.js'], bundle: true, write: false, format: 'iife', platform: 'browser' })).outputFiles[0].text;
  const dom = new JSDOM('', { url: sender.url, runScripts: 'outside-only' });
  try {
    const { window } = dom;
    const responses = [];
    const bytes = archive({
      'glyphs.json': { subset: 1 },
      'page_data_0_5.json': { pages: [{ width: 400, height: 500, children: [{ fontKey: 'body', fontSize: 20, transform: [1, 0, 0, 1, 10, 40], glyphs: Array.from({ length: 24 }, (_, index) => index), xPosition: Array.from({ length: 24 }, (_, index) => index * 10) }] }] },
      'metadata.json': { token: 'not exposed to the bridge' },
    });
    window.Request = Request;
    window.TextEncoder = TextEncoder;
    window.TextDecoder = TextDecoder;
    Object.defineProperty(window.crypto, 'subtle', { value: webcrypto.subtle });
    window.fetch = async () => new Response(bytes);
    window.postMessage = (message) => responses.push(message);
    window.eval(bundle);
    const response = await window.fetch('https://read.amazon.in/renderer/render?asin=B00AK9IXXM');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    const snapshot = () => window.dispatchEvent(new window.MessageEvent('message', {
      source: window, origin: window.location.origin, data: { type: 'ai-reader-kindle-request', requestId: 'test-request' },
    }));
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      snapshot();
      if (responses.at(-1)?.batches.length) break;
    }
    const payload = responses.at(-1);
    assert.equal(payload.batches.length, 1);
    assert.equal(payload.batches[0].pages[0].glyphs.length, 24);
    assert.ok(/^[a-f0-9]{64}$/.test(payload.batches[0].id));
    assert.equal(JSON.stringify(payload).includes('not exposed'), false);
    window.history.replaceState(null, '', '/?asin=OTHERBOOK');
    snapshot();
    assert.equal(responses.at(-1).batches.length, 0);
  } finally { dom.window.close(); }
});
