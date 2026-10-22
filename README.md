# AI Reader

A Chrome extension that reads web pages aloud with modern AI voices, highlighting each sentence as it's spoken.

## Features

- **Cloud voices**: OpenAI (`gpt-4o-mini-tts` with style instructions), ElevenLabs and Google Gemini TTS.
- **Local voices**:
  - **Kokoro-82M in the browser**: runs on WebGPU or WASM in a worker. No server needed, and it works offline after a one-time ~90 MB download.
  - **Local server**: any OpenAI-compatible `/v1/audio/speech` endpoint, such as [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI), Orpheus-FastAPI or LocalAI.
  - **System voices** via `chrome.tts`.
- **Navigation**: previous/next sentence, pause/resume, Alt+click any sentence to jump to it, and "Read aloud from here" on a text selection.
- **Stops before an incomplete last sentence**: if the page ends mid-sentence (paginated books, truncated articles), the reader stops after the last complete sentence. It also skips trailing UI text such as "Next chapter". You can turn this off.
- **Highlighting**: the current sentence and its paragraph are highlighted with the CSS Custom Highlight API, so the page DOM isn't modified. The page auto-scrolls to follow along.
- Speed control from 0.5× to 3× with pitch preserved.

## Develop

```sh
npm install
npm run build      # or: npm run watch
npm test           # sentence extraction tests (jsdom)
```

Load `dist/` at `chrome://extensions`. Turn on Developer mode, then choose **Load unpacked**.

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
