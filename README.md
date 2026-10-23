# Narro

A Chrome extension that reads web pages aloud with modern AI voices, highlighting each sentence as it's spoken.

## Features

- **Cloud voices**: OpenAI (`gpt-4o-mini-tts` with style instructions), ElevenLabs and Google Gemini TTS.
- **Local voices**:
  - **Kokoro-82M in the browser**: runs on WebGPU or WASM in a worker. No server needed, and it works offline after a one-time ~90 MB download.
  - **Local server**: any OpenAI-compatible `/v1/audio/speech` endpoint, such as [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI), Orpheus-FastAPI or LocalAI.
  - **System voices** via `chrome.tts`.
- **Navigation**: previous/next sentence and pause/resume.
- **Choose where to start**: use the crosshair button in the player, **Start from…** in the popup, or right-click → *Choose where to start reading…*. Hover to preview a sentence, click it to start reading from there, or press Esc to cancel. Clicks are captured while choosing, so clicking a sentence inside a link doesn't follow the link. You can also Alt+click any sentence while the player is open, or select text and pick *Read aloud from here*.
- **Stops before an incomplete last sentence**: if the page ends mid-sentence (paginated books, truncated articles), the reader stops after the last complete sentence. It also skips trailing UI text such as "Next chapter". You can turn this off.
- **Highlighting**: the current sentence and its paragraph are highlighted with the CSS Custom Highlight API, so the page DOM isn't modified. The page auto-scrolls to follow along.
- Speed control from 0.5× to 3× with pitch preserved.
- **Movable player**: drag it by the grip or any empty area. The position is remembered across pages and sessions. Double-click the grip to reset it.

## Develop

```sh
npm install
npm run build      # or: npm run watch
npm test           # sentence extraction tests (jsdom)
```

Load `dist/` at `chrome://extensions`. Turn on Developer mode, then choose **Load unpacked**.

## Kindle Cloud Reader

Kindle Cloud Reader draws book pages as images rather than DOM text, so the ordinary website extractor finds nothing to read. On Kindle, Narro instead runs **local OCR on the page you can see**. Ordinary websites keep using the DOM reader.

After building, reload Narro in `chrome://extensions`, then reload your Kindle tab. Open a text page of your book and press Play. Keep the whole page visible while it's being recognized.

- Tesseract runs locally in the extension's offscreen document. The worker, WebAssembly and **English** recognition data are bundled in `dist/ocr/`, so there's no CDN and no extra API key. Other OCR languages aren't bundled yet.
- Page images are read directly when possible. Otherwise the extension captures the active Kindle tab and crops it to the book region. Images stay on your machine. The recognized text goes to your selected speech provider, as on any other site.
- Sentence and paragraph highlights are drawn over the page image using OCR word boxes. **Start from…** works by clicking a sentence on the image.
- Screenshot-only viewers get a transparent guard during playback. Click the book once to stop reading before interacting with it.
- At the end of a page the reader clicks Kindle's **Next page** button (or presses →), waits for the new page to settle, recognizes it and keeps reading. It stops with "Reached the end of the book." when the page doesn't change. You can turn this off with **Turn Kindle pages automatically** in the settings.
- A sentence cut off by a column break or a page turn is spoken once, in full: the unread tail of a page is carried over to the next one. Turning the page yourself, resizing or switching tabs while reading stops playback, so stale text is never spoken.
- Decorative fonts, illustrations, small text and partly offscreen pages reduce OCR accuracy.

`src/kindle-intercept.js` and the `GlyphDecoder` in `src/kindle-text.js` are **not wired up**. Nothing in the manifest, build or shipped bundles references them, and `test/ocr-only.test.js` fails if anything starts to.

Shortcuts (change them at `chrome://extensions/shortcuts`):
- Alt+Shift+R: play/pause
- Alt+Shift+←/→: previous/next sentence
- Alt+Shift+S: stop

## Architecture

```
popup / shortcuts / context menu
          │
   background.js (service worker): injects content.js on demand and routes messages
      │                                   │
content.js                          offscreen.html/js: synthesizes and plays audio,
 - text.js: main-content detection,   prefetches the next 2 sentences, caches results
   sentence segmentation, DOM Ranges     └─ kokoro-worker.js: Kokoro via ONNX Runtime Web
 - highlighting and the floating player
```

- Audio plays in an offscreen document, so page CSP can't block it and cloud APIs are called from the extension origin.
- Each `speak` carries a sequence number, and the content script ignores events from superseded sentences.
- Chrome closes idle offscreen documents (roughly 30s without audio). Resuming after a long pause re-synthesizes the current sentence. For Kokoro, this reloads the model from the browser cache.
- API keys are stored in `chrome.storage.local` and are never synced.
