const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
process.chdir(path.resolve(__dirname, "../.."));
(async () => {
  const browser = await chromium.launch({
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
    headless: true,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1400, height: 1000 },
      deviceScaleFactor: Number(process.env.TEST_DPR || 1),
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") console.log("BROWSER", m.text());
    });
    await page.route("http://pdf-test.local/**", async (r) => {
      const rel = new URL(r.request().url()).pathname.slice(1);
      const file = path.resolve("extension", rel);
      if (
        !file.startsWith(path.resolve("extension") + path.sep) ||
        !fs.existsSync(file)
      )
        return r.fulfill({ status: 404, body: "" });
      await r.fulfill({
        path: file,
        contentType: rel.endsWith(".js")
          ? "application/javascript"
          : rel.endsWith(".html")
            ? "text/html"
            : undefined,
      });
    });
    await page.addInitScript(() => {
      const values = { contentCoreTheme: "warm-calm" };
      const listeners = [];
      window.chrome = {
        runtime: { getURL: (p) => new URL(p, location.origin).href },
        storage: {
          local: {
            get: (d, cb) => {
              const v = { ...(typeof d === "object" ? d : {}), ...values };
              if (cb) setTimeout(() => cb(v), 0);
              return Promise.resolve(v);
            },
            set: async (v) => {
              Object.assign(values, v);
              const changes = Object.fromEntries(
                Object.entries(v).map(([k, newValue]) => [k, { newValue }]),
              );
              setTimeout(
                () => listeners.forEach((fn) => fn(changes, "local")),
                0,
              );
            },
          },
          onChanged: { addListener: (fn) => listeners.push(fn) },
        },
      };
    });
    await page.goto("http://pdf-test.local/pdf-viewer.html");
    await page
      .locator("#file-input")
      .setInputFiles(path.join(__dirname, "fixtures", "selection-colors.pdf"));
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".pdf-page").length === 2 &&
        !document.querySelector("#zoom-in").disabled,
    );
    const span = (text) =>
      page
        .locator(".text-layer [data-text-index]")
        .filter({ hasText: text })
        .first();
    async function select(text, start, end, lastText) {
      await span(text).scrollIntoViewIfNeeded();
      await page.evaluate(
        ({ text, start, end, lastText }) => {
          const spans = [
            ...document.querySelectorAll(".text-layer [data-text-index]"),
          ];
          const first = spans.find((s) => s.textContent.includes(text));
          const last = lastText
            ? spans.find((s) => s.textContent.includes(lastText))
            : first;
          function point(el, offset) {
            const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            while (w.nextNode()) {
              if (offset <= w.currentNode.length)
                return [w.currentNode, offset];
              offset -= w.currentNode.length;
            }
            throw Error("offset out of range");
          }
          const r = document.createRange();
          r.setStart(...point(first, start));
          r.setEnd(...point(last, end ?? last.textContent.length));
          const s = getSelection();
          s.removeAllRanges();
          s.addRange(r);
          first.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        },
        { text, start, end, lastText },
      );
      await page.locator('[data-action="highlight"]').waitFor();
    }
    async function highlight() {
      await page.locator('[data-action="highlight"]').click();
      await page
        .locator('[data-action="highlight"]')
        .waitFor({ state: "detached" });
    }
    const crimson = span("Crimson");
    const before = await crimson.boundingBox();
    assert.ok(
      Math.abs(before.width - 233.064) < 2,
      "text run should match the PDF font metrics",
    );
    await select("Crimson", 0, 7);
    await highlight();
    assert.equal(
      await crimson.locator(".cc-pdf-highlight").innerText(),
      "Crimson",
    );
    const after = await crimson.boundingBox();
    assert.ok(
      Math.abs(before.width - after.width) < 0.1,
      "highlight must not move text",
    );
    await select("Crimson", 2, 5);
    await highlight();
    assert.deepEqual(
      await crimson.locator(".cc-pdf-highlight").allTextContents(),
      ["Cr", "on"],
      "partial unhighlight preserves neighboring letters",
    );
    await select("Blue", 5, 15);
    await highlight();
    assert.equal(
      await span("Blue").locator(".cc-pdf-highlight").innerText(),
      "words alig",
    );
    await select("First line", 6, null, "Fourth line");
    assert.equal(
      await page.locator('[data-action="explain"]').isDisabled(),
      true,
    );
    await highlight();
    assert.equal(
      await span("First line").locator(".cc-pdf-highlight").innerText(),
      "line begins a precise multi-line selection.",
    );
    assert.equal(
      await span("Fourth line").locator(".cc-pdf-highlight").innerText(),
      "Fourth line completes a reliable paragraph highlight.",
    );
    await select("White text", 0, 10);
    await highlight();
    if (process.env.PDF_SCREENSHOT_PATH)
      await page.screenshot({ path: process.env.PDF_SCREENSHOT_PATH });
    const saved = await page.locator(".cc-pdf-highlight").allTextContents();
    await page.locator("#zoom-in").click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".pdf-page").length === 2 &&
        !document.querySelector("#zoom-in").disabled &&
        document.querySelector("#zoom-badge").textContent === "125%",
    );
    assert.deepEqual(
      await page.locator(".cc-pdf-highlight").allTextContents(),
      saved,
      "highlights survive zoom",
    );
    await page.locator("#find-input").fill("words");
    await page.locator("#find-btn").click();
    assert.ok((await page.locator(".cc-find-highlight").count()) > 0);
    assert.equal(
      (await crimson.locator(".cc-pdf-highlight").allTextContents()).join(""),
      "Cron",
    );
    await page.locator("#find-input").fill("");
    await page.locator("#find-btn").click();
    assert.deepEqual(
      await page.locator(".cc-pdf-highlight").allTextContents(),
      saved,
      "search preserves highlights",
    );
    await select("Rotated green", 0, 7);
    await highlight();
    assert.equal(
      await span("Rotated green").locator(".cc-pdf-highlight").innerText(),
      "Rotated",
    );
    await select("Rotated page", 0, 12);
    await highlight();
    assert.equal(
      await span("Rotated page").locator(".cc-pdf-highlight").innerText(),
      "Rotated page",
    );
    // Use a real drag across colored glyphs, then pointer mode and scrolling.
    await crimson.scrollIntoViewIfNeeded();
    const box = await crimson.boundingBox();
    await page.mouse.move(box.x + 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, {
      steps: 20,
    });
    await page.mouse.up();
    await page.locator('[data-action="highlight"]').waitFor();
    assert.equal(
      await page.evaluate(() => getSelection().toString()),
      "Crimson words stay readable",
      "native drag selects the painted text",
    );
    await page.locator('[data-action="highlight-mode"]').click();
    await page.locator('[data-mode="pointer"]').click();
    await page
      .locator('[data-action="highlight"]')
      .waitFor({ state: "detached" });
    const pointerMark = crimson.locator(".cc-pointer-only");
    assert.equal(await pointerMark.count(), 1);
    const overlay = page
      .locator('.pdf-page[data-page-number="1"] .cc-pointer-highlight-overlay')
      .first();
    const markerBox = await pointerMark.boundingBox();
    const overlayBox = await overlay.boundingBox();
    assert.ok(
      Math.abs(markerBox.x - overlayBox.x) < 1 &&
        Math.abs(markerBox.y - overlayBox.y) < 1,
      "pointer tracks text",
    );
    await page.locator("#pdf-render").evaluate((el) => (el.scrollTop += 70));
    const scrolledMark = await pointerMark.boundingBox();
    const scrolledOverlay = await overlay.boundingBox();
    assert.ok(
      Math.abs(scrolledMark.y - scrolledOverlay.y) < 1,
      "pointer remains attached during scrolling",
    );
    await page.locator("#zoom-in").click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".pdf-page").length === 2 &&
        !document.querySelector("#zoom-in").disabled &&
        document.querySelector("#zoom-badge").textContent === "150%",
    );
    assert.equal(
      await crimson.locator(".cc-pointer-only").count(),
      1,
      "pointer survives zoom",
    );
    // Element-boundary selections must work as well as text-node endpoints.
    await crimson.scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      const el = [...document.querySelectorAll("[data-text-index]")].find((s) =>
        s.textContent.startsWith("Crimson"),
      );
      const r = document.createRange();
      r.selectNodeContents(el);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await page.locator('[data-action="highlight"]').waitFor();
    await highlight();
    assert.equal(
      await crimson.locator(".cc-pdf-highlight").count(),
      0,
      "element-endpoint selection removes the full highlight",
    );
    // Backwards selections have the same normalized range as forward drags.
    await span("Blue").scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      const el = [...document.querySelectorAll("[data-text-index]")].find((s) =>
        s.textContent.startsWith("Blue"),
      );
      getSelection().setBaseAndExtent(el, el.childNodes.length, el, 0);
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await page.locator('[data-action="highlight"]').waitFor();
    await highlight();
    assert.equal(
      (await span("Blue").locator(".cc-pdf-highlight").allTextContents()).join(
        "",
      ),
      "Blue words align with selection",
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: real PDF text geometry, colored text and white-on-dark text, precise partial/multiline highlights, long selections, zoom, search, rotation, native mouse selection, pointer scrolling and element endpoints",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
