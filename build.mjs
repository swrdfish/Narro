import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const out = 'dist';

rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/ort`, { recursive: true });
mkdirSync(`${out}/ocr`, { recursive: true });

// The libraries fall back to loading their code from a CDN when no path is set. Narro always sets
// local paths, but the Chrome Web Store rejects any remotely hosted code URL in the package, so the
// fallbacks are rewritten to the copies shipped in the extension.
const CDN = /https:\/\/(cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com)\//;
const LOCAL_FALLBACKS = [
  // transformers.js: ONNX Runtime's wasm files
  [/node_modules\/@huggingface\/transformers\//, /`https:\/\/cdn\.jsdelivr\.net\/npm\/@huggingface\/transformers@\$\{[^}]+\}\/dist\/`/g, "'/ort/'"],
  // tesseract.js: its worker script
  [/node_modules\/tesseract\.js\//, /`https:\/\/cdn\.jsdelivr\.net\/npm\/tesseract\.js@v\$\{[^}]+\}\/dist\/worker\.min\.js`/g, "'/ocr/worker.min.js'"],
];
const localFallbacks = {
  name: 'local-fallbacks',
  setup(build) {
    build.onLoad({ filter: /node_modules\/(@huggingface\/transformers|tesseract\.js)\/.*\.js$/ }, (args) => {
      let contents = readFileSync(args.path, 'utf8');
      for (const [file, url, local] of LOCAL_FALLBACKS) if (file.test(args.path)) contents = contents.replace(url, local);
      return { contents, loader: 'js' };
    });
  },
};

// The OCR worker's fallbacks: tesseract.js-core and the language data.
const ocrWorker = readFileSync('node_modules/tesseract.js/dist/worker.min.js', 'utf8')
  .replace(/"https:\/\/cdn\.jsdelivr\.net\/npm\/[^"]*"\.concat\((?:[^()]|\([^()]*\))*\)/g, '"/ocr"');
writeFileSync(`${out}/ocr/worker.min.js`, ocrWorker);
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
for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) cpSync(f, `${out}/${f}`);
cpSync('icons', `${out}/icons`, { recursive: true });
cpSync('src/fonts', `${out}/fonts`, { recursive: true });
for (const f of ['offscreen.html', 'options.html', 'options.css']) cpSync(`src/${f}`, `${out}/${f}`);
// Read by the settings page at runtime, so dist/models.json can be edited without rebuilding.
cpSync('src/models.json', `${out}/models.json`);
// ONNX Runtime loads these at runtime; MV3 forbids fetching code from a CDN, so ship them.
for (const f of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
  cpSync(`node_modules/@huggingface/transformers/dist/${f}`, `${out}/ort/${f}`);
}

const common = { bundle: true, target: 'chrome116', logLevel: 'info', legalComments: 'none', plugins: [localFallbacks] };
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
  const remote = readdirSync(out, { recursive: true })
    .filter((f) => /\.(m?js|html)$/.test(f) && CDN.test(readFileSync(`${out}/${f}`, 'utf8')));
  if (remote.length) {
    console.error(`Remotely hosted code URLs left in ${remote.join(', ')}; the Chrome Web Store rejects these.`);
    process.exit(1);
  }
}
