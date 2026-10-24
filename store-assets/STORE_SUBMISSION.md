# Narro — Chrome Web Store submission copy

## Store listing

**Category:** Productivity (Accessibility is also a reasonable alternative)

**Short description**

Read the current webpage aloud with natural AI or on-device voices, with sentence highlighting and resume.

**Detailed description** (plain text; paste as is)

```text
Narro reads the web page you're on aloud in a natural voice and highlights each sentence as it's spoken, so you can listen, follow along, or look away and keep going. Use a voice that runs entirely in your browser, with no account and nothing sent anywhere, or a cloud voice with your own API key.

LISTEN TO ANY PAGE
• Click the Narro icon and press Read this page. Narro finds the article and skips menus, sidebars and footers.
• Each sentence is highlighted as it's read, and the page scrolls to keep it in view.
• Sentences are voiced together, with short pauses between headings and paragraphs, so it sounds like someone reading rather than a list of sentences.
• Pick where to start: click Start from… and choose a sentence, select text and right-click Read aloud from here, or Alt-click (Option-click on a Mac) any sentence while reading.
• Narro remembers your place on each page and picks up where you left off.

EASY TO CONTROL
• A small player on the page: play/pause, previous and next sentence, and speed from 0.5× to 3× without changing the voice's pitch. Drag it anywhere; it remembers where you put it.
• Keyboard keys while the player is showing: Alt+Shift+R to play or pause, Alt+Shift+← and → to move between sentences, Alt+Shift+S to stop. Narro takes no keys from other pages or apps.
• Control reading from any tab with the toolbar popup. A red ▶︎ on the icon shows which tab is reading, and it keeps reading when that tab is in the background.
• If a voice service fails, the player says what went wrong, with a Retry button.

VOICES THAT RUN IN YOUR BROWSER
No account, no API key, and the text never leaves your computer. Each model downloads once and then works offline.
• Kokoro: natural English voices, the default (92 MB download on CPU, 326 MB with WebGPU).
• Supertonic 2: 10 voices in English, Spanish, French, Portuguese and Korean (263 MB).
• Piper: voices in many languages, including German, French, Spanish, Italian, Portuguese and Hindi (63–121 MB per voice).
They use about 700 MB to 1 GB of memory while reading. Kokoro and Supertonic use your graphics card through WebGPU when it's available. The settings show the exact download and memory for your choice.

CLOUD VOICES, WITH YOUR OWN KEY
• OpenAI, including gpt-4o-mini-tts with style instructions such as "calm audiobook narration".
• ElevenLabs, with the voices in your own library.
• Google Gemini text-to-speech voices.
• OpenRouter: one key for speech models from many providers.
• Or any OpenAI-compatible speech server on your own computer, such as Kokoro-FastAPI.
• Your computer's built-in system voices work too.

LISTEN TO KINDLE BOOKS
Kindle Cloud Reader shows pages as images, so most read-aloud tools can't read them. Narro recognises the text on the page you have open, on your computer, then reads it with your chosen voice and turns the page for you. A sentence split across two pages is read once, in full. English only for now. Narro is not affiliated with or endorsed by Amazon; check that your use complies with Amazon's terms.

PRIVATE BY DEFAULT
• With an in-browser voice, nothing you read leaves your computer.
• With a cloud voice, only the text you ask Narro to read is sent, and only to the provider you chose, using your own key.
• API keys stay in your browser and are never synced.
• No accounts, no analytics, no servers of our own.
Privacy policy: https://swrdfish.github.io/Narro/privacy.html

FREE AND OPEN SOURCE
Narro is free and MIT-licensed. Source code, issues and ideas: https://github.com/swrdfish/Narro
```

## Assets to upload

- `narro-promo-440x280.png` — required small promo tile (440×280).
- `narro-reading-1280x800.png` — product screenshot 1 (1280×800): reading with sentence highlighting.
- `narro-voices-1280x800.png` — product screenshot 2 (1280×800): the popup and voice choices.
- `narro-marquee-1400x560.png` — marquee promo tile (1400×560).
- `../icons/icon-128.png` — store icon (128×128).

## Privacy tab

**Single purpose**

Read the user-selected current webpage aloud, with sentence highlighting and playback controls.

**Permission justifications**

- `storage`: save voice settings, locally stored API keys, playback state, and up to 200 local reading positions.
- `activeTab`: access only the tab the user explicitly chooses to read.
- `scripting`: inject Narro's reader and highlighting code into that user-selected tab.
- `offscreen`: synthesize and play audio while the extension service worker is inactive.
- `tts`: offer Chrome's installed system voices.
- `contextMenus`: let the user start reading from selected text.
- Optional host access: make speech requests only to the cloud voice provider selected by the user, or contact the user-configured localhost speech server. Requested only when the user selects that engine. (On-device voice models download from Hugging Face, which needs no host permission.)

**Remote code**

Select **No, I am not using remote code**. All executable extension logic is packaged in the ZIP. Narro downloads voice-model data from Hugging Face only after the user selects an on-device voice; model data is not executed as extension code.

**Data disclosure**

Declare the website content that Narro sends to a user-selected cloud speech provider as necessary to provide the read-aloud feature. Keep the dashboard disclosure consistent with the privacy policy. API keys and reading positions are stored locally; Narro does not operate analytics or an account service.

## Test instructions for reviewers

1. Install Narro and open any ordinary article webpage.
2. Click the toolbar icon and choose **Read this page**. The default Kokoro voice may download its model on first use, then it reads and highlights the article.
3. Test with **System voices** for an immediate, network-free option.
4. Cloud providers require the reviewer's own API key; select an engine, grant the optional host permission prompt, enter a key, and click **Read this page**.
5. Select text, right-click, and choose **Read aloud from here** to test the context-menu flow.

## Release checklist

- Upload `../narro-0.1.0.zip`.
- Publish the `site/` changes to GitHub Pages before submission so the privacy URL is live.
- Confirm the package version and every listing claim match the uploaded ZIP.
