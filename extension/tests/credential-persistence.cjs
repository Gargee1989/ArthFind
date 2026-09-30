const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

(async () => {
  const browser = await chromium.launch({
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
    headless: true,
  });
  const stored = {};
  let registrations = 0;
  let failCredentialSave = false;
  let failDelete = false;
  const extensionRoot = path.resolve(__dirname, "..");

  async function openSession() {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.exposeFunction("getStored", (keys) => {
      const names =
        typeof keys === "string"
          ? [keys]
          : Array.isArray(keys)
            ? keys
            : Object.keys(keys);
      return Object.fromEntries(
        names.map((key) => [
          key,
          stored[key] ??
            (typeof keys === "object" && !Array.isArray(keys)
              ? keys[key]
              : undefined),
        ]),
      );
    });
    await page.exposeFunction("setStored", (values) => {
      if (failCredentialSave && values.contentCoreCredentialId)
        throw new Error("Storage unavailable");
      Object.assign(stored, values);
    });
    await page.exposeFunction("removeStored", (keys) =>
      keys.forEach((key) => delete stored[key]),
    );
    await page.addInitScript(() => {
      window.chrome = {
        storage: {
          local: {
            get: async (keys, callback) => {
              const values = await window.getStored(keys);
              callback?.(values);
              return values;
            },
            set: (values) => window.setStored(values),
            remove: (keys) => window.removeStored(keys),
          },
        },
        runtime: { getURL: (value) => new URL(value, location.origin).href },
      };
    });
    await page.route(
      "https://arthfind-backend.onrender.com/credentials**",
      async (route) => {
        if (route.request().method() === "DELETE") {
          return route.fulfill({
            status: failDelete ? 503 : 200,
            contentType: "application/json",
            body: JSON.stringify({ status: "deleted" }),
          });
        }
        const request = route.request().postDataJSON();
        assert.equal(request.api_key, "sk-disposable-browser-test");
        registrations += 1;
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            credential_id: "persistent-test-id",
            credential_token: "opaque-test-access-token",
            provider: "OpenAI",
            model: "test-model",
          }),
        });
      },
    );
    await page.route("http://localhost/**", async (route) => {
      const relative = new URL(route.request().url()).pathname.slice(1);
      const file = path.resolve(extensionRoot, relative);
      if (!file.startsWith(extensionRoot + path.sep) || !fs.existsSync(file))
        return route.fulfill({ status: 404, body: "" });
      await route.fulfill({ path: file });
    });
    await page.goto("http://localhost/popup.html");
    await page.waitForFunction(
      () =>
        document
          .querySelector("#connection-status-text")
          ?.textContent.trim() !== "",
    );
    return { page, context };
  }

  try {
    let session = await openSession();
    await session.page.locator("#provider").selectOption("OpenAI");
    await session.page
      .locator("#llm-api-key")
      .fill("sk-disposable-browser-test");
    await session.page.locator("#llm-model").fill("test-model");
    failCredentialSave = true;
    await session.page.locator('#settings-form button[type="submit"]').click();
    await session.page.waitForFunction(
      () => document.querySelector("#status").className === "error",
    );
    assert.equal(
      await session.page.locator("#llm-api-key").isDisabled(),
      false,
      "failed local save must not lock the form",
    );
    assert.equal(stored.contentCoreCredentialId, undefined);
    failCredentialSave = false;
    await session.page.locator('#settings-form button[type="submit"]').click();
    await session.page.waitForFunction(
      () => document.querySelector("#status").className === "success",
    );
    assert.equal(await session.page.locator("#llm-api-key").inputValue(), "");
    assert.equal(stored.contentCoreCredentialId, "persistent-test-id");
    assert.ok(
      !JSON.stringify(stored).includes("sk-disposable-browser-test"),
      "provider key must not remain in browser storage",
    );
    assert.ok(
      !JSON.stringify(stored).includes("opaque-test-access-token"),
      "token should be encrypted locally",
    );
    await session.context.close();

    session = await openSession();
    await session.page.waitForFunction(
      () =>
        document.querySelector("#connection-status-text").textContent ===
        "Connected",
    );
    const restored = await session.page.evaluate(() =>
      ContentCoreCrypto.readSettings(),
    );
    assert.equal(
      restored.contentCoreCredentialToken,
      "opaque-test-access-token",
    );
    assert.equal(restored.contentCoreCredentialId, "persistent-test-id");
    assert.equal(
      registrations,
      2,
      "opening a fresh session must not register again",
    );
    failDelete = true;
    await session.page.locator("#clear-credential").click();
    await session.page.waitForFunction(
      () => document.querySelector("#status").className === "error",
    );
    assert.equal(
      stored.contentCoreCredentialId,
      "persistent-test-id",
      "network failure must preserve the saved reference",
    );
    failDelete = false;
    await session.page.locator("#clear-credential").click();
    await session.page.waitForFunction(
      () => document.querySelector("#status").className === "success",
    );
    assert.equal(stored.contentCoreCredentialId, undefined);
    await session.context.close();
    console.log(
      "PASS: encrypted saved credentials survive new browser contexts; failed saves/deletions do not falsely report success or lose the connection",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
