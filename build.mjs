import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const out = 'dist';

rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/ort`, { recursive: true });

cpSync('manifest.json', `${out}/manifest.json`);
for (const f of ['offscreen.html', 'options.html', 'options.css']) cpSync(`src/${f}`, `${out}/${f}`);
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
  // Kokoro + transformers.js (~2 MB) only load when that engine is used.
  esbuild.context({ ...common, entryPoints: ['src/kokoro-worker.js'], outdir: out, format: 'esm', minify: true }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
