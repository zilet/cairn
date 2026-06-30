import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadSettingsData() {
  const context = { Array, Date, Math, Object, String, Uint8Array };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/settings-data-client.js"), "utf8"), context);
  return context.CairnSettingsData;
}

class FakeElement {
  constructor() {
    this.textContent = "";
    this.title = "";
    this.innerHTML = "";
    this.listeners = new Map();
  }

  addEventListener(type, handler) {
    this.listeners.set(type, handler);
  }

  async click() {
    const handler = this.listeners.get("click");
    if (handler) await handler();
  }
}

test("settings data phone access card stays hidden in installed PWA mode", () => {
  const settingsData = loadSettingsData();

  assert.equal(settingsData.phoneAccessCardHtml({ inStandaloneApp: true }), "");
  const html = settingsData.phoneAccessCardHtml({ inStandaloneApp: false });

  assert.match(html, /Phone &amp; PWA access/);
  assert.match(html, /\.\/scripts\/setup-phone\.sh/);
  assert.match(html, /tailscale serve --bg --https=443/);
  assert.match(html, /Prepare a token for phone/);
});

test("settings data phone access wiring generates token and suppresses generator when auth is set", async () => {
  const settingsData = loadSettingsData();
  const button = new FakeElement();
  const output = new FakeElement();
  const row = new FakeElement();
  const copied = [];
  const toasts = [];
  const document = {
    querySelector(selector) {
      return { "#phoneGenToken": button, "#phoneTokenOut": output, "#phoneTokenRow": row }[selector] || null;
    },
  };
  const crypto = {
    getRandomValues(bytes) {
      bytes.forEach((_, i) => { bytes[i] = i; });
      return bytes;
    },
  };

  settingsData.wirePhoneAccessCard({
    api: async () => ({ auth_required: true }),
    crypto,
    document,
    navigator: { clipboard: { writeText: async (value) => copied.push(value) } },
    toast: (message) => toasts.push(message),
  });

  await button.click();
  await Promise.resolve();

  const token = Array.from({ length: 28 }, (_, i) => i.toString(16).padStart(2, "0")).join("");
  assert.equal(output.textContent, token);
  assert.equal(output.title, "Set as CAIRN_AUTH_TOKEN=… in .env / compose, then restart");
  assert.deepEqual(copied, [token]);
  assert.deepEqual(toasts, ["Token copied. Set CAIRN_AUTH_TOKEN=… in .env / compose, then restart."]);
  assert.match(row.innerHTML, /A shared token is already set/);
});
