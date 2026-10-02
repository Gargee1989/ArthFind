const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const kind of ["web", "pdf"]) {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
      const errors = [];
      page.on("pageerror", e => errors.push(e.message));
      await page.route("http://stream-test.local/**", r => r.fulfill({ contentType: "text/html", body: "<html><body></body></html>" }));
      await page.goto("http://stream-test.local/");
      if (kind === "pdf") await page.setContent(fs.readFileSync(path.join(root, "pdf-viewer.html"), "utf8").replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ""));
      await page.evaluate(kind => {
        const values = { contentCoreTheme: "warm-calm" };
        window.chrome = {
          runtime: { getURL: p => p },
          storage: {
            local: {
              get: async (keys, cb) => { const result = { ...(typeof keys === "object" ? keys : {}), ...values }; cb?.(result); return result; },
              set: async data => Object.assign(values, data),
            },
            onChanged: { addListener() {} },
          },
        };
        window.ContentCoreCrypto = {
          BACKEND_ENDPOINT: "http://stream-test.local/define",
          readSettings: async () => ({ contentCoreCredentialId: "test-id", contentCoreCredentialToken: "test-token" }),
        };
        const attach = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function (options) { window.testRoot = attach.call(this, options); return window.testRoot; };
        window.getCardRoot = () => kind === "web" ? window.testRoot : document;
        const sample = document.createElement("p");
        sample.id = "sample";
        sample.textContent = "They rested on the river bank.";
        sample.style = "position:fixed;top:450px;left:500px;z-index:10";
        document.body.append(sample);
        if (kind === "pdf") {
          const layer = document.createElement("div");
          layer.className = "text-layer";
          const wrapper = document.createElement("section");
          wrapper.className = "pdf-page";
          wrapper.dataset.pageNumber = "1";
          sample.dataset.textIndex = "0";
          layer.append(sample);
          wrapper.append(layer);
          document.querySelector("#pdf-render").append(wrapper);
        }
        window.fetch = async (_, options) => {
          if (options.headers.Accept !== "text/event-stream") throw new Error("Missing streaming request");
          return new Response(new ReadableStream({ start(c) { window.streamController = c; } }), { headers: { "content-type": "text/event-stream" } });
        };
        window.emit = (event, data) => window.streamController.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }, kind);
      await page.addScriptTag({ path: path.join(root, "definition-response.js") });
      await page.addScriptTag({ path: path.join(root, kind === "web" ? "content.js" : "pdf-reader.js") });
      async function selectAndExplain() {
        await page.evaluate(() => {
          const sample = document.querySelector("#sample");
          const range = document.createRange();
          range.selectNodeContents(sample);
          getSelection().removeAllRanges();
          getSelection().addRange(range);
          sample.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        });
        await page.waitForFunction(() => window.getCardRoot()?.querySelector('[data-action="explain"]'));
        await page.evaluate(() => window.getCardRoot().querySelector('[data-action="explain"]').click());
        await page.waitForFunction(() => window.streamController);
      }
      await selectAndExplain();
      await page.evaluate(() => window.emit("meaning", { meaning: 'A river bank. <script>bad()</script>' }));
      await page.waitForFunction(() => window.getCardRoot()?.querySelector(".cc-card-definition")?.textContent.includes("A river bank."));
      assert.equal(await page.evaluate(() => window.getCardRoot().querySelector(".cc-card-definition script")), null);
      await page.evaluate(() => {
        window.emit("result", { status: "success", meaning: "The land beside a river.", tone: "", synonym: "riverside", example: "", simplified_passage: "" });
        window.streamController.close();
      });
      await page.waitForFunction(() => window.getCardRoot()?.querySelector(".cc-card-definition")?.textContent === "The land beside a river.");
      assert.ok(await page.evaluate(() => window.getCardRoot().querySelector(".cc-card-meta").textContent.includes("riverside")));
      // A new lookup that fails after preview must replace it with an error.
      await page.evaluate(() => {
        window.streamController = null;
        const button = window.getCardRoot().querySelector('[data-action="explain"]');
        button.click(); // close the existing explanation
        button.click(); // request it again
      });
      await page.waitForFunction(() => window.streamController);
      await page.evaluate(() => { window.emit("meaning", { meaning: "Temporary preview" }); window.emit("error", { message: "Rate limit exceeded" }); window.streamController.close(); });
      await page.waitForFunction(() => window.getCardRoot()?.querySelector(".cc-error-desc")?.textContent === "Rate limit exceeded");
      // Closing/reopening while a request is pending must ignore its late answer.
      await page.evaluate(() => {
        window.streamController = null;
        const button = window.getCardRoot().querySelector('[data-action="explain"]');
        button.click(); button.click();
      });
      await page.waitForFunction(() => window.streamController);
      await page.evaluate(() => {
        window.oldStream = window.streamController;
        window.streamController = null;
        const button = window.getCardRoot().querySelector('[data-action="explain"]');
        button.click(); button.click();
      });
      await page.waitForFunction(() => window.streamController);
      await page.evaluate(() => {
        window.emit("result", { status: "success", meaning: "New answer", tone: "", synonym: "", example: "", simplified_passage: "" });
        window.streamController.close();
      });
      await page.waitForFunction(() => window.getCardRoot()?.querySelector(".cc-card-definition")?.textContent === "New answer");
      await page.evaluate(async () => {
        window.oldStream.enqueue(new TextEncoder().encode('event: result\ndata: {"status":"success","meaning":"Stale answer"}\n\n'));
        window.oldStream.close();
        await new Promise(resolve => setTimeout(resolve, 0));
      });
      assert.equal(await page.evaluate(() => window.getCardRoot().querySelector(".cc-card-definition").textContent), "New answer");
      assert.deepEqual(errors, [], kind + " browser errors");
      console.log(kind + ": early meaning, final fields, safe text rendering, stream failure and stale response checks passed");
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
