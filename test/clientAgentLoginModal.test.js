// The Settings → Agents sign-in sheet (agent-login-modal-client.ts) on the shared
// overlay primitive: it hosts the friendly sign-in panel (never a terminal up front),
// and every way out (Escape, backdrop, ✕, Cancel, Try again) closes that panel —
// its socket and terminal — exactly once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fire, loadClientModule } from "./_dom.mjs";

// A stand-in panel: records how it was mounted and how often it was closed.
function fakePanel() {
  const mounts = [];
  const log = [];
  return {
    mounts,
    log,
    api: {
      pastesCode: (name) => name === "claude",
      mount(host, opts) {
        mounts.push({ host, opts });
        host.innerHTML = `<div class="alp"></div>`;
        return { close: () => log.push("panel") };
      },
    },
  };
}

function load() {
  const panel = fakePanel();
  const win = loadClientModule(["html-utils", "ui-sheet", "agent-login-model-client", "agent-login-modal-client"], {
    globals: { navigator: { maxTouchPoints: 0 }, CairnAgentLoginPanel: panel.api },
  });
  return { win, doc: win.document, modal: win.CairnAgentLoginModal, panel };
}

test("the sign-in sheet is a labelled dialog named for the provider, with the name escaped", () => {
  const { doc, modal, panel } = load();
  const handle = modal.create(`Claude <Code>`, () => {});
  const dialog = handle.overlay.querySelector(".agent-login");
  assert.equal(handle.overlay.className, "agent-login-ov");
  assert.equal(dialog.getAttribute("role"), "dialog");
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.equal(dialog.getAttribute("aria-label"), "Connect Claude <Code>");
  assert.equal(dialog.querySelector("h2").textContent, "Connect Claude <Code>");
  assert.equal(doc.querySelector(".agent-login-ov"), handle.overlay);
  assert.equal(panel.mounts.length, 1, "the friendly panel is mounted once");
  assert.ok(handle.overlay.querySelector(".agent-login-panel .alp"), "inside the sheet's panel slot");
});

test("providers read by the names people know them by", () => {
  const { modal, panel } = load();
  modal.create("codex", () => {});
  assert.equal(panel.mounts[0].opts.label, "ChatGPT");
  assert.equal(panel.mounts[0].opts.name, "codex");
  assert.equal(panel.mounts[0].opts.detailsOpen, false);
  modal.create("antigravity", () => {});
  assert.equal(panel.mounts[1].opts.detailsOpen, true, "Antigravity's own sign-in screen starts unfolded");
});

for (const [way, act] of [
  ["Escape", (doc) => fire(doc.querySelector(".agent-login-x"), "keydown", { key: "Escape" })],
  ["the backdrop", (doc) => doc.querySelector(".agent-login-ov").click()],
  ["the ✕", (doc) => doc.querySelector(".agent-login-x").click()],
  ["Cancel", (doc) => doc.querySelector(".agent-login-ft [data-close]").click()],
]) {
  test(`${way} closes the sheet and the sign-in once`, async () => {
    const { doc, modal, panel } = load();
    const handle = modal.create("codex", () => {});
    await act(doc);
    assert.equal(doc.querySelector(".agent-login-ov"), null);
    assert.deepEqual(panel.log, ["panel"]);
    modal.close(handle.overlay);
    assert.deepEqual(panel.log, ["panel"], "closing again is a no-op");
  });
}

test("a failed sign-in offers Try again, which closes this sheet before retrying", async () => {
  const { doc, modal, panel } = load();
  const retried = [];
  modal.create("grok", (name) => retried.push(name));
  panel.mounts[0].opts.onFailed("The sign-in didn't finish.", "incomplete");
  assert.equal(doc.querySelector(".agent-login-ft [data-close]").textContent, "Close");
  await doc.querySelector("[data-retry]").click();
  assert.deepEqual(panel.log, ["panel"]);
  assert.equal(doc.querySelector(".agent-login-ov"), null);
  assert.deepEqual(retried, ["grok"]);
});
