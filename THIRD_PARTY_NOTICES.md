# Third-party notices

Narro's own source code is released under the MIT License (see `LICENSE`). The built extension
(`dist/`) also contains the third-party components below, each under its own licence.

## Bundled in the extension

| Component | Used for | Licence |
|---|---|---|
| [Transformers.js](https://github.com/huggingface/transformers.js) (`@huggingface/transformers`) | Running the Kokoro and Supertonic models | Apache-2.0 |
| [kokoro-js](https://github.com/hexgrad/kokoro) | Kokoro text-to-speech | Apache-2.0 |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (`onnxruntime-web`, including the WebAssembly files in `dist/ort/`) | Model inference | MIT |
| [phonemizer](https://github.com/xenova/phonemizer) | Text-to-phoneme conversion for Kokoro and Piper | Apache-2.0 |
| ↳ [eSpeak NG](https://github.com/espeak-ng/espeak-ng), compiled into phonemizer, including `espeak-ng-data` | Phoneme rules and dictionaries | **GPL-3.0-or-later** |
| [Tesseract.js](https://github.com/naptha/tesseract.js) and [tesseract.js-core](https://github.com/naptha/tesseract.js-core) (`dist/ocr/`) | OCR of Kindle pages | Apache-2.0 |
| [Tesseract English data](https://github.com/tesseract-ocr/tessdata_best) (`@tesseract.js-data/eng`, `dist/ocr/eng.traineddata.gz`) | OCR language model | Apache-2.0 (data); MIT (npm package) |
| [Geist](https://github.com/vercel/geist-font) SemiBold (`src/fonts/`) | Wordmark in the popup | SIL Open Font License 1.1 (`src/fonts/Geist-OFL.txt`) |

Licence texts for Tesseract.js and tesseract.js-core are copied to `dist/ocr/` at build time, and the
Geist licence to `dist/fonts/`.

### eSpeak NG (GPL-3.0-or-later)

eSpeak NG is distributed under the GNU General Public License, version 3 or later. It reaches the
built extension through the `phonemizer` package, which is bundled into `dist/local-worker.js`. If you
redistribute a built copy of Narro, you must comply with the GPL for that component. That includes
providing its licence text and the corresponding source code, which is available at
<https://github.com/espeak-ng/espeak-ng> and, for the WebAssembly build, from the phonemizer
repository above. Narro's own code stays under the MIT License.

## Downloaded at runtime (not included in this repository or the extension)

These models are downloaded from Hugging Face the first time you use them, and cached in your browser.
Their licences apply to your use of them.

| Model | Licence |
|---|---|
| [Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) | Apache-2.0 |
| [Supertonic 2](https://huggingface.co/onnx-community/Supertonic-TTS-2-ONNX) (Supertone) | OpenRAIL; review its use restrictions before commercial use |
| [Piper voices](https://huggingface.co/rhasspy/piper-voices) | Varies by voice; see each voice's model card |

Cloud voices (OpenAI, ElevenLabs, Google Gemini, OpenRouter and the providers it routes to) are used under your own account and those providers' terms.
