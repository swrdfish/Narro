<div align="center">

<img src="icons/narro.svg" width="88" height="88" alt="">

# Narro

**Read any web page aloud with natural AI voices, in the cloud or entirely in your browser.**

[Install](#install-from-source) · [Features](#features) · [Privacy](#privacy) · [Report an issue](https://github.com/swrdfish/Narro/issues)

[![Tests](https://github.com/swrdfish/Narro/actions/workflows/test.yml/badge.svg)](https://github.com/swrdfish/Narro/actions/workflows/test.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-4fb56e.svg)](LICENSE)

</div>

Narro is a Chrome extension that reads the page you're on and highlights each sentence as it's
spoken. Use a cloud voice with your own API key, or a voice that runs entirely in your browser,
with no account and no server.

<table>
  <tr>
    <td width="68%"><img src="docs/player.png" alt="Narro reading an article: the current sentence is highlighted and a floating player sits at the bottom of the page"></td>
    <td width="32%"><img src="docs/popup.png" alt="Narro's popup: what's being read, with pause and stop buttons, then the voice engine and reading settings"></td>
  </tr>
  <tr>
    <td align="center"><sub>Sentence highlighting and the floating player</sub></td>
    <td align="center"><sub>The popup: controls and settings</sub></td>
  </tr>
</table>

## Features

### Voices

| | Engine | Notes |
|---|---|---|
| **Cloud** | OpenAI | `gpt-4o-mini-tts` with style instructions, `tts-1`, `tts-1-hd` |
| | ElevenLabs | Your own voices, listed with your key |
| | Google Gemini | Gemini TTS voices |
| | [OpenRouter](https://openrouter.ai) | One key for speech models from many providers |
| **In your browser** | Kokoro-82M | The default. A one-time ~90 MB download, then works offline |
| | Supertonic 2 | 10 voices in English, Spanish, French, Portuguese and Korean, ~260 MB |
| | Piper | Popular [piper-voices](https://huggingface.co/rhasspy/piper-voices) in several languages, ~60 MB each |
| **Other** | Local server | Any OpenAI-compatible `/v1/audio/speech` server, e.g. [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) |
| | System voices | Your computer's built-in voices |

### Reading

- **Sentence highlighting**, without changing the page. The page scrolls to follow along.
- **Natural speech:** consecutive sentences are sent as one request, so the voice keeps its intonation. The first sentence is sent on its own, so speech starts quickly.
- **Play/pause, previous/next sentence**, and speed from 0.5× to 3× with pitch preserved.
- **Start anywhere:** use **Start from…**, Alt/⌥+click a sentence, or select text and right-click → *Read aloud from here*.
- **Resumes where you left off** on each page.
- **Control it from any tab:** the popup shows what's being read, with pause and stop. The toolbar icon shows a red ▶︎ while it plays.
- **Kindle Cloud Reader:** reads book pages with on-device OCR and turns pages automatically ([details](#kindle-cloud-reader)).
- **Readable errors:** click an error in the player to see the full message and the server's response.

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

Narro is a Manifest V3 extension with no framework and no build-time code generation: plain ES
modules bundled by esbuild.

```mermaid
flowchart LR
  UI["Popup and settings<br/>(options.html)"] -->|start, pause, stop| BG
  KEYS["Shortcuts and<br/>context menu"] --> BG
  BG["background.js<br/>service worker"] <-->|sentences, playback events| CS
  subgraph TAB["The tab being read"]
    CS["content.js<br/>text, highlighting, player"]
  end
  BG <-->|speech requests, audio events| OFF["offscreen.js<br/>synthesizes and plays audio"]
  OFF --> LW["local-worker.js<br/>Kokoro, Supertonic, Piper"]
  OFF --> CLOUD[("Cloud speech APIs<br/>OpenAI, ElevenLabs, Gemini, OpenRouter")]
  OFF --> OCR["Tesseract OCR<br/>Kindle pages"]
```

**What happens when you press Play**

1. The background injects `content.js` into the tab. It's only injected when you start reading, using the `activeTab` permission.
2. `content.js` finds the page's main content (`text.js`) and splits it into sentences, each mapped to a DOM range for highlighting. On Kindle, the page image is recognized with OCR instead (`kindle*.js`).
3. It sends a group of sentences (`chunks.js`) to the background, which passes it to the offscreen document. System voices are spoken by the background with `chrome.tts`.
4. `offscreen.js` synthesizes the audio with the chosen engine (`engines.js`), plays it, and prepares the next groups in advance.
5. Playback progress flows back to the page, which moves the highlight sentence by sentence. At the end of a group it requests the next one; on Kindle it turns the page.
6. The tab reports whether it's playing or paused (`reader-state.js`). That drives the toolbar badge and the popup's "Now reading" card.

**Source files**

| File | What it does |
|---|---|
| `background.js` | Service worker: injects the page script, routes messages, keeps the reading state and badge |
| `content.js` | In the page: reading list, playback control, highlighting, the floating player |
| `text.js` | Main-content detection and sentence segmentation, mapped to DOM ranges |
| `chunks.js` | Groups sentences into speech requests; maps playback progress to the current sentence |
| `offscreen.js`, `engines.js` | Audio playback and the speech engines; caching and prefetching |
| `local-worker.js`, `progress.js` | In-browser voices on ONNX Runtime Web, and their download progress |
| `kindle.js`, `kindle-ocr.js`, `kindle-text.js`, `kindle-capture.js` | Kindle: finding the page image, OCR, reading order, page turning |
| `positions.js` | Remembers where reading stopped on each page |
| `reader-state.js` | Which tab is reading, for the badge and the popup |
| `options.html`, `options.js`, `select.js`, `shortcuts.js` | The popup and settings page, its dropdowns and shortcut display |
| `settings.js`, `models.json` | Default settings, and the model and voice lists |

**Design notes**

- Audio plays in an offscreen document, so a page's security policy can't block it, and cloud APIs are called from the extension's own origin.
- Each speech request carries a sequence number, so the page ignores events from requests it has already replaced.
- While reading, the page holds a connection to the background. Refreshing or closing the page stops playback.

## Licence

Narro's source code is released under the [MIT License](LICENSE).

The built extension also includes third-party components under their own licences, including
**eSpeak NG (GPL-3.0-or-later)** through the phonemizer used by Kokoro and Piper. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for details, including the licences of models that
are downloaded at runtime.
