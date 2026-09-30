const { chromium } = require("playwright");
const fs = require("fs");
const assert = require("assert/strict");
const path = require("path");
process.chdir(path.resolve(__dirname, "../.."));
const colors = {
  "warm-calm": "rgb(248, 244, 232)",
  "fresh-calm": "rgb(241, 248, 243)",
  "soft-natural": "rgb(234, 244, 255)",
  "warm-friendly": "rgb(255, 247, 230)",
  "warm-calm-dark": "rgb(42, 39, 35)",
  "fresh-calm-dark": "rgb(31, 39, 35)",
  "soft-natural-dark": "rgb(30, 38, 46)",
  "warm-friendly-dark": "rgb(43, 37, 32)",
};
// Run with Playwright installed; CHROME_PATH can select a local Chrome binary.
// Storage is stubbed; browser layout, pointer events and the closed shadow root are real.
(async () => {
  const browser = await chromium.launch({
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
    headless: true,
  });
  try {
    for (const kind of ["web", "pdf"]) {
      const page = await browser.newPage({
        viewport: { width: 1400, height: 1000 },
      });
      await page.route("http://theme-test.local/**", (r) =>
        r.fulfill({
          contentType: "text/html",
          body: "<html><body></body></html>",
        }),
      );
      await page.goto("http://theme-test.local/");
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.evaluate(() => {
        window.saved = { contentCoreTheme: "warm-calm" };
        const listeners = [];
        window.chrome = {
          runtime: { getURL: (p) => p },
          storage: {
            local: {
              get: (defaults, cb) => {
                const result = {
                  ...(typeof defaults === "object" ? defaults : {}),
                  ...window.saved,
                };
                if (cb) setTimeout(() => cb(result), 0);
                return Promise.resolve(result);
              },
              set: async (values) => {
                const changes = {};
                for (const [k, v] of Object.entries(values)) {
                  changes[k] = { oldValue: window.saved[k], newValue: v };
                }
                Object.assign(window.saved, values);
                setTimeout(
                  () => listeners.forEach((fn) => fn(changes, "local")),
                  0,
                );
              },
            },
            onChanged: { addListener: (fn) => listeners.push(fn) },
          },
        };
        const attach = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function (opts) {
          const root = attach.call(this, opts);
          window.testRoot = root;
          return root;
        };
      });
      if (kind === "pdf")
        await page.setContent(
          fs
            .readFileSync("extension/pdf-viewer.html", "utf8")
            .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ""),
        );
      await page.evaluate((kind) => {
        const p = document.createElement("p");
        p.id = "sample";
        p.textContent = "Theme selection sample";
        p.style = "position:fixed;top:450px;left:500px;z-index:10";
        document.body.append(p);
        if (kind === "pdf") {
          const layer = document.createElement("div");
          layer.className = "text-layer";
          layer.style.cssText = "position:fixed;inset:0;pointer-events:none";
          const wrapper = document.createElement("section");
          wrapper.className = "pdf-page";
          wrapper.dataset.pageNumber = "1";
          p.dataset.textIndex = "0";
          p.style.pointerEvents = "auto";
          layer.append(p);
          wrapper.append(layer);
          document.querySelector("#pdf-render").append(wrapper);
        }
      }, kind);
      await page.addScriptTag({
        content: fs.readFileSync(
          kind === "web" ? "extension/content.js" : "extension/pdf-reader.js",
          "utf8",
        ),
      });
      async function select() {
        await page.evaluate(() => {
          const el = document.querySelector("#sample");
          const r = document.createRange();
          r.selectNodeContents(el);
          const s = getSelection();
          s.removeAllRanges();
          s.addRange(r);
          el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        });
        await page.locator('[data-action="theme"]').waitFor();
      }
      // Retain the closed root only for test access; do not change its mode.
      if (kind === "web")
        page.locator = (selector) => ({
          click: async () => {
            const h = await page.evaluateHandle(
              (s) => window.testRoot.querySelector(s),
              selector,
            );
            await h.asElement().click();
          },
          press: async (key) => {
            const h = await page.evaluateHandle(
              (s) => window.testRoot.querySelector(s),
              selector,
            );
            await h.asElement().press(key);
          },
          hover: async () => {
            const h = await page.evaluateHandle(
              (s) => window.testRoot.querySelector(s),
              selector,
            );
            await h.asElement().hover();
          },
          waitFor: async () =>
            page.waitForFunction(
              (s) =>
                document.querySelector("[data-thesis-host]") &&
                window.testRoot?.querySelector(s),
              selector,
            ),
          count: async () =>
            page.evaluate(
              (s) =>
                document.querySelector("[data-thesis-host]")
                  ? window.testRoot.querySelectorAll(s).length
                  : 0,
              selector,
            ),
          evaluate: async (fn) => {
            const h = await page.evaluateHandle(
              (s) => window.testRoot.querySelector(s),
              selector,
            );
            return h.asElement().evaluate(fn);
          },
        });
      const applied = () =>
        page.evaluate(
          (kind) =>
            kind === "web"
              ? document
                  .querySelector("[data-thesis-host]")
                  ?.getAttribute("data-theme")
              : document.documentElement.dataset.theme,
          kind,
        );
      await select();
      await page.locator('[data-action="explain"]').click();
      for (const id of [
        "fresh-calm",
        "soft-natural",
        "warm-friendly",
        "warm-calm-dark",
        "fresh-calm-dark",
        "soft-natural-dark",
        "warm-friendly-dark",
        "warm-calm",
      ]) {
        await page.locator('[data-action="theme"]').click();
        const swatch = page.locator(
          '.cc-theme-swatch[data-theme-id="' + id + '"]',
        );
        const before = await applied();
        await swatch.hover();
        assert.equal(
          await applied(),
          before,
          kind + " hover must not change theme",
        );
        await swatch.click();
        await page.mouse.move(1200, 900);
        assert.equal(await applied(), id, kind + " committed theme");
        assert.equal(
          await page
            .locator(".cc-dropdown-card")
            .evaluate((el) => getComputedStyle(el).backgroundColor),
          colors[id],
          kind + " rendered card color",
        );
        assert.equal(
          await page.evaluate(() => window.saved.contentCoreTheme),
          id,
          kind + " saved theme",
        );
        assert.equal(
          await page.evaluate(() => getSelection().toString()),
          "Theme selection sample",
          kind + " selection retained",
        );
      }
      await page.locator('[data-action="theme"]').click();
      await page
        .locator('.cc-theme-swatch[data-theme-id="fresh-calm"]')
        .hover();
      await page.mouse.move(1200, 900);
      assert.equal(await applied(), "warm-calm", kind + " preview canceled");
      await page.mouse.click(1200, 900);
      assert.equal(
        await page.locator('[data-action="theme"]').count(),
        0,
        kind + " outside dismissal",
      );
      await select();
      assert.equal(await applied(), "warm-calm", kind + " reopened theme");
      await page.locator('[data-action="explain"]').click();
      await page.locator('[data-action="theme"]').click();
      await page
        .locator('.cc-theme-swatch[data-theme-id="soft-natural-dark"]')
        .press("Enter");
      assert.equal(
        await applied(),
        "soft-natural-dark",
        kind + " keyboard theme",
      );
      assert.equal(
        await page
          .locator(".cc-dropdown-card")
          .evaluate((el) => getComputedStyle(el).backgroundColor),
        colors["soft-natural-dark"],
      );
      await page.mouse.click(1200, 900);
      await select();
      await page.locator('[data-action="explain"]').click();
      assert.equal(
        await applied(),
        "soft-natural-dark",
        kind + " chosen theme survives reopening",
      );
      assert.equal(
        await page
          .locator(".cc-dropdown-card")
          .evaluate((el) => getComputedStyle(el).backgroundColor),
        colors["soft-natural-dark"],
      );
      if (kind === "pdf") {
        await page.mouse.click(1200, 900);
        await page.locator("#tb-theme-btn").click();
        await page
          .locator('.tb-theme-swatch[data-theme-id="fresh-calm-dark"]')
          .click();
        await page.mouse.move(1200, 900);
        assert.equal(await applied(), "fresh-calm-dark");
        assert.equal(
          await page.evaluate(() => window.saved.contentCoreTheme),
          "fresh-calm-dark",
        );
      }
      assert.deepEqual(errors, []);
      console.log(
        "PASS " +
          kind +
          ": all 8 themes commit and save, rendered word-card colors, hover stability, keyboard selection, selection retention, outside dismissal, reopen" +
          (kind === "pdf" ? ", toolbar theme" : ""),
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
