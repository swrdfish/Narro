# Narro — Chrome Web Store submission copy

## Store listing

**Category:** Productivity (Accessibility is also a reasonable alternative)

**Short description**

Read the current webpage aloud with natural AI or on-device voices, with sentence highlighting and resume.

**Detailed description**

Narro reads the webpage you are on aloud and highlights each sentence as it speaks. Choose a private voice that runs in your browser, a built-in system voice, or a cloud voice using your own API key.

Features:

- Follow along with sentence highlighting and automatic scrolling.
- Start from any sentence, selected text, or where you last stopped.
- Control playback from the toolbar or keyboard shortcuts.
- Choose on-device Kokoro, Supertonic, Piper, or system voices. On-device voices work offline after their one-time model download.
- Use your own OpenAI, ElevenLabs, Google Gemini, or OpenRouter API key.
- Read Kindle Cloud Reader pages with on-device OCR.

Privacy: on-device voices keep text on your computer. If you choose a cloud voice, Narro sends only the text you ask it to read to that provider using your API key. Narro has no accounts, analytics, or servers of its own. Full policy: https://swrdfish.github.io/Narro/privacy.html

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
