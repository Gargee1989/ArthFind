# Reader regression tests

From this directory:

```sh
npm install
npx playwright install chromium
npm test
```

Alternatively, set `CHROME_PATH` to an installed Chrome executable. Set
`TEST_DPR=2` to check PDF selection on a high-DPI screen. Set
`PDF_SCREENSHOT_PATH` to save the highlighted test page as a screenshot.

The PDF test loads the real bundled PDF.js renderer and a synthetic two-page
fixture containing colored text, white text on black, multiple lines, rotated
text, and a rotated page. It verifies mouse selection, partial highlighting and
removal, long selections, search, zoom, and pointer placement while scrolling.

The theme test checks all eight rendered word-card colors, mouse and keyboard
selection, reopening cards, and the PDF toolbar. It preserves the web card's
closed Shadow DOM.

All tests stub Chrome storage and run in isolated browser contexts. They do
not contact the definition backend or change the installed extension's settings.

The credential test opens the real popup in separate browser contexts sharing
a stub of persistent Chrome storage. Registration and deletion use fake backend
responses and disposable test keys. It checks automatic credential restoration,
encryption, and recovery from browser-storage and network failures.

The definition tests check split UTF-8 and SSE messages, compatibility with JSON
backends, interrupted streams, and provider errors. Browser checks cover both
reading surfaces: early meaning display, final response fields, HTML escaping,
failure after a preview, and ignoring late responses from dismissed cards.
