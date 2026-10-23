<p align="center">
  <img src="icons/narro.svg" width="96" height="96" alt="Narro logo">
</p>

# Narro

Narro is a Chrome extension that reads web pages aloud with modern AI voices and highlights each
sentence as it's spoken. You can use cloud voices with your own API key, or voices that run entirely
in your browser with no account and no server.

## Features

- **Cloud voices**: OpenAI (including `gpt-4o-mini-tts` with style instructions), ElevenLabs, Google Gemini, and [OpenRouter](https://openrouter.ai), where one key gives you speech models from many providers. Bring your own API key.
- **Voices that run in your browser** (offline after a one-time download):
  - **Kokoro-82M**, the default: about 90 MB.
  - **Supertonic 2** (Supertone): 10 voices in English, Spanish, French, Portuguese and Korean, about 260 MB.
  - **Piper**: popular voices from [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) in several languages, about 60 MB per voice.
- **Other local options**: any OpenAI-compatible `/v1/audio/speech` server, such as [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) or LocalAI. You can also use your system's built-in voices.
- **Sentence highlighting** with the CSS Custom Highlight API. The page's content isn't modified, and the page scrolls to follow along.
- **Natural speech**: consecutive sentences are sent as one request (up to 4 sentences or ~400 characters), so the voice keeps its intonation. The first request after you press Play is a single sentence, so speech starts quickly.
- **Navigation**: play/pause, previous/next sentence, and speed from 0.5× to 3× with pitch preserved.
- **Choose where to start**: use **Start from…**, the crosshair in the player, Alt/⌥+click on a sentence, or select text and right-click → *Read aloud from here*.
- **Resumes where you left off**: Narro remembers the sentence you stopped at on each page.
- **Skips cut-off sentences** at the start or end of a page, for example in paginated books. You can turn this off.
- **Movable player**: drag it anywhere. Its position is remembered. Double-click the grip to reset it.
- **Readable errors**: click an error in the player to see the full message and the server's response, with clickable links.

## Install from source

Narro isn't on the Chrome Web Store yet. To install it:

```sh
git clone https://github.com/swrdfish/Narro.git
cd Narro
npm install
npm run build
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Choose **Load unpacked** and select the `dist/` folder.
3. Click the Narro icon, choose a voice engine, then **Read this page**.

Keyboard shortcuts are shown in the popup and can be changed at `chrome://extensions/shortcuts`.
The defaults are Alt/⌥+Shift+R (play/pause), Alt/⌥+Shift+←/→ (previous/next) and Alt/⌥+Shift+S (stop).

## Privacy

- **Text you have read aloud**: with a cloud voice, the text is sent to that provider (OpenAI, ElevenLabs or Google) under your account and their terms. With OpenRouter, it goes to OpenRouter and the model's provider. With Kokoro, Supertonic, Piper or system voices, nothing leaves your computer. A local server receives the text at the address you configure.
- **API keys** are stored in `chrome.storage.local` on your computer. They're never synced and never sent anywhere except to the provider they belong to.
- **Model downloads**: in-browser voices download their model files from Hugging Face on first use, then cache them in your browser.
- **Reading positions**: Narro stores a short fingerprint of the last sentence you heard on each page, plus its position, for up to 200 pages. These stay on your computer and don't include the text itself.
- Narro has no analytics, accounts or servers of its own.

## Kindle Cloud Reader

Kindle Cloud Reader shows book pages as images rather than text, so on `read.amazon.*` Narro runs
**OCR (text recognition) on the page you can see**, entirely on your computer, using Tesseract. It
then reads the recognized text with your chosen voice.

- At the end of a page, Narro presses Kindle's **Next page** button and keeps reading. It can turn the page slightly early, while the page's last sentence is still playing, so there's no pause. Both behaviours can be switched off in the settings.
- A sentence split across a page turn or a column break is spoken once, in full.
- Reading continues if the Kindle tab is hidden behind another window. If Kindle doesn't draw the next page while hidden, Narro waits until the tab is visible again.
- OCR currently supports English only. Decorative fonts, very small text and illustrations reduce accuracy.

> Narro is an independent project. It isn't affiliated with or endorsed by Amazon. Kindle is a
> trademark of Amazon.com, Inc. Narro only reads pages you have open yourself, but automated use of
> Kindle Cloud Reader may be restricted by Amazon's terms. Check that your use complies with them.

## Model and voice lists

The **Model** dropdowns for OpenAI, ElevenLabs and Gemini, and the **Piper** voice list, come from
`src/models.json`. Each list maps an ID to the label shown in the dropdown:

```json
{ "openai": { "tts-1": "tts-1 · fastest" }, "piper": { "en_US-lessac-medium": "Lessac · US English, female" } }
```

- To make a permanent change, edit `src/models.json` and run `npm run build`.
- To make a quick change without rebuilding, edit `dist/models.json` and reload the extension. The next build overwrites this copy.

A saved model that's missing from a list stays selectable. The local server's model list comes from
its own `/v1/models` endpoint.

## Development

```sh
npm run watch      # rebuild on changes
npm test           # test suite (Node's test runner + jsdom)
```

After a rebuild, reload Narro at `chrome://extensions`, then reload the tab you're testing on. See
[CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Found a bug or have an idea? [Open an issue](https://github.com/swrdfish/Narro/issues). You can also use the
**Send feedback or report an issue** link at the bottom of Narro's popup.

### Architecture

```
popup / shortcuts / context menu
          │
   background.js (service worker): injects content.js on demand and routes messages
      │                                   │
content.js                          offscreen.html/js: synthesizes and plays audio, reports
 - text.js: main-content detection,   playback progress, prefetches upcoming sentence groups
   sentence segmentation, DOM Ranges     └─ local-worker.js: Kokoro, Supertonic, Piper (ONNX Runtime Web)
 - chunks.js: sentence groups per request
 - kindle*.js: Kindle OCR, layout, page turning
 - the floating player and highlighting
```

- Audio plays in an offscreen document, so a page's security policy can't block it, and cloud APIs are called from the extension's own origin.
- Each speech request carries a sequence number, so the page ignores events from requests it has already replaced.
- While reading, the page holds a connection to the background. Refreshing or closing the page stops playback.

## Licence

Narro's source code is released under the [MIT License](LICENSE).

The built extension also includes third-party components under their own licences, including
**eSpeak NG (GPL-3.0-or-later)** through the phonemizer used by Kokoro and Piper. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for details, including the licences of models that
are downloaded at runtime.
