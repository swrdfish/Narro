import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const out = 'dist';

rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/ort`, { recursive: true });
mkdirSync(`${out}/ocr`, { recursive: true });

cpSync('node_modules/tesseract.js/dist/worker.min.js', `${out}/ocr/worker.min.js`);
cpSync('node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', `${out}/ocr/eng.traineddata.gz`);
for (const variant of ['lstm', 'simd-lstm', 'relaxedsimd-lstm']) {
  for (const extension of ['wasm.js', 'wasm']) {
    const file = `tesseract-core-${variant}.${extension}`;
    cpSync(`node_modules/tesseract.js-core/${file}`, `${out}/ocr/${file}`);
  }
}
cpSync('node_modules/tesseract.js/LICENSE.md', `${out}/ocr/TESSERACT-LICENSE.md`);
cpSync('node_modules/tesseract.js-core/LICENSE', `${out}/ocr/CORE-LICENSE`);

cpSync('manifest.json', `${out}/manifest.json`);
cpSync('icons', `${out}/icons`, { recursive: true });
cpSync('src/fonts', `${out}/fonts`, { recursive: true });
for (const f of ['offscreen.html', 'options.html', 'options.css']) cpSync(`src/${f}`, `${out}/${f}`);
// Read by the settings page at runtime, so dist/models.json can be edited without rebuilding.
cpSync('src/models.json', `${out}/models.json`);
// ONNX Runtime loads these at runtime; MV3 forbids fetching code from a CDN, so ship them.
for (const f of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
  cpSync(`node_modules/@huggingface/transformers/dist/${f}`, `${out}/ort/${f}`);
}

const common = { bundle: true, target: 'chrome116', logLevel: 'info', legalComments: 'none' };
const contexts = await Promise.all([
  // Content scripts can't be modules.
  esbuild.context({ ...common, entryPoints: ['src/content.js'], outfile: `${out}/content.js`, format: 'iife' }),
  esbuild.context({ ...common, entryPoints: ['src/background.js', 'src/options.js'], outdir: out, format: 'esm' }),
  esbuild.context({ ...common, entryPoints: ['src/offscreen.js'], outdir: out, format: 'esm' }),
  // The in-browser voices (Kokoro, Supertonic, Piper + transformers.js) only load when used.
  esbuild.context({ ...common, entryPoints: ['src/local-worker.js'], outdir: out, format: 'esm', minify: true }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
