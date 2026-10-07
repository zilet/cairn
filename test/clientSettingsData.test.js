import { test } from "node:test";
import assert from "node:assert/strict";
import { loadClientModule, renderHtml } from "./_dom.mjs";

function loadSettingsData() {
  const win = loadClientModule("settings-data-client");
  return { settingsData: win.CairnSettingsData, document: win.document };
}

test("settings data phone access card stays hidden in installed PWA mode", () => {
  const { settingsData } = loadSettingsData();

  assert.equal(settingsData.phoneAccessCardHtml({ inStandaloneApp: true }), "");
  const html = settingsData.phoneAccessCardHtml({ inStandaloneApp: false });

  assert.match(html, /Phone &amp; PWA access/);
  assert.match(html, /\.\/scripts\/setup-phone\.sh/);
  assert.match(html, /tailscale serve --bg --https=443/);
  assert.match(html, /Prepare a token for phone/);
});

test("settings data phone access wiring generates token and suppresses generator when auth is set", async () => {
  const { settingsData, document } = loadSettingsData();
  renderHtml(settingsData.phoneAccessCardHtml({ inStandaloneApp: false }), { document });
  const button = document.querySelector("#phoneGenToken");
  const output = document.querySelector("#phoneTokenOut");
  const row = document.querySelector("#phoneTokenRow");
  const copied = [];
  const toasts = [];
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
  assert.match(row.innerHTML, /Sign-in is on\. Sign your phone in with a pairing code/);
  assert.doesNotMatch(row.innerHTML, /asked for it/, "a phone is never asked for the token any more");
});
