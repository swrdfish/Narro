// Kindle reading is OCR-only: the renderer hook and glyph decoder stay in the tree but must not be
// reachable from anything the extension ships.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const ENTRY_POINTS = ['src/background.js', 'src/content.js', 'src/offscreen.js', 'src/options.js', 'src/kokoro-worker.js'];
const DECODER_MARKERS = ['GlyphDecoder', 'ai-reader-kindle-request', '/renderer/render', 'readRenderArchive', 'normalizePages'];

test('manifest does not inject the Kindle renderer hook', () => {
  const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
  assert.equal(manifest.content_scripts, undefined);
  assert.ok(!JSON.stringify(manifest).includes('kindle-intercept'));
});

test('build script does not bundle the Kindle renderer hook', () => {
  assert.ok(!readFileSync('build.mjs', 'utf8').includes('kindle-intercept'));
});

for (const entry of ENTRY_POINTS) {
  test(`${entry} bundle contains no glyph-decoding code`, async () => {
    const result = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'chrome116', metafile: true, logLevel: 'silent' });
    const text = result.outputFiles.map((file) => file.text).join('\n');
    for (const marker of DECODER_MARKERS) assert.ok(!text.includes(marker), `${entry} includes ${marker}`);
    assert.ok(!Object.keys(result.metafile.inputs).some((input) => input.endsWith('kindle-intercept.js')));
  });
}
