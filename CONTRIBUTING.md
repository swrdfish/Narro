# Contributing to Narro

Thanks for helping! Bug reports, fixes and new voice engines are all welcome.

## Getting started

```sh
npm install
npm run build      # builds the extension into dist/ (or: npm run watch)
npm test           # runs the test suite (Node's test runner + jsdom)
```

Load `dist/` at `chrome://extensions` with **Developer mode** on, then **Load unpacked**. After a
rebuild, click the reload icon on Narro's card, then reload the tab you're testing on.

## Making changes

- Keep changes focused, and include tests for behaviour changes (`test/*.test.js`). Pure logic
  lives in small modules (for example `src/chunks.js`, `src/positions.js`, `src/progress.js`) so it
  can be tested without a browser.
- Match the existing code style: plain ES modules, no framework, comments explaining *why*.
- Never commit API keys. Keys are entered in the extension's settings and stay in
  `chrome.storage.local`.
- Model and voice lists live in `src/models.json`. Adding a model or Piper voice there needs no code
  change; `test/models.test.js` checks the format.
- Run `npm test` and `npm run build` before opening a pull request. CI runs both.

## Reporting bugs

Open an issue with your Chrome version, the voice engine, what you expected and what happened. If
the player showed an error, click it and use **Copy** to include the details. Please don't paste API
keys, and don't paste text from paid or copyrighted books.
