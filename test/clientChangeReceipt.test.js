// The change receipt (change-receipt-client.ts): under a coach reply and on a Changes feed
// row, one compact line per change that landed — what, how long, and the way back. The
// server's words print verbatim and escaped; a receipt missing its key or words draws
// nothing; Undo puts a brain decision back through the one decision-undo path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHost, flush, loadClientModule, renderHtml } from "./_dom.mjs";

const receipt = (over = {}) => ({
  key: "decision:27849",
  what: "Fri Lower — legs lighter",
  when: "2026-10-23",
  until: "2026-11-01",
  until_words: "Ends after the race (Nov 1)",
  undo: { kind: "brain_decision", id: 27849 },
  status: "applied",
  ...over,
});

function load(globals = {}) {
  return loadClientModule(["html-utils", "ui-components", "ui-actions-client", "decision-undo-client", "decision-undo-controller", "change-receipt-client"], { globals });
}

test("an applied receipt reads what · until · Undo; scheduled, undone and not-landed say their state", () => {
  const win = load();
  const R = win.CairnChangeReceipt;
  const applied = renderHtml(R.listHtml([receipt()]), { document: win.document });
  assert.equal(applied.querySelector(".rcpt-what").textContent, "Fri Lower — legs lighter");
  assert.equal(applied.querySelector(".rcpt-until").textContent, " · Ends after the race (Nov 1)");
  const undo = applied.querySelector("button[data-rcpt-undo]");
  assert.equal(undo.textContent, "Undo");
  assert.equal(undo.getAttribute("aria-label"), "Undo: Fri Lower — legs lighter");
  // Scheduled: the server's landing words (the feed's), and the Hold the server attached.
  const scheduled = renderHtml(R.listHtml([receipt({ status: "scheduled", key: "w", status_words: "Lands Thursday" })]), {
    document: win.document,
  });
  assert.equal(scheduled.querySelector(".rcpt-state").textContent, "Lands Thursday");
  const hold = scheduled.querySelector("button[data-rcpt-undo]");
  assert.ok(hold, "the server's Undo is drawn while it waits to land");
  assert.equal(hold.textContent, "Hold");
  assert.doesNotMatch(scheduled.outerHTML, /Waiting on you/);
  const soon = renderHtml(R.listHtml([receipt({ status: "scheduled", key: "s", undo: null })]), { document: win.document });
  assert.equal(soon.querySelector(".rcpt-state").textContent, "Lands soon", "no words from the server: the feed's default");
  assert.equal(soon.querySelector("button"), null, "no Undo from the server, no button");
  const undone = renderHtml(R.listHtml([receipt({ status: "undone", key: "u" })]), { document: win.document });
  assert.equal(undone.querySelector(".rcpt-state").textContent, "Put back");
  assert.equal(undone.querySelector("button"), null);
  const ended = renderHtml(R.listHtml([receipt({ status: "undone", key: "e", status_words: "Ended" })]), { document: win.document });
  assert.equal(ended.querySelector(".rcpt-state").textContent, "Ended");
  const missed = renderHtml(R.listHtml([receipt({ status: "not_landed", key: "n" })]), { document: win.document });
  assert.equal(missed.querySelector(".rcpt-state").textContent, "Didn't land");
  assert.equal(missed.querySelector("button"), null);
});

test("nothing or something malformed draws nothing; a read-only row has no Undo; strings are escaped", () => {
  const R = load().CairnChangeReceipt;
  assert.equal(R.listHtml(undefined), "");
  assert.equal(R.listHtml([]), "");
  assert.equal(R.listHtml([{ key: "k" }, { what: "no key" }, null]), "");
  assert.doesNotMatch(R.listHtml([receipt()], { readonly: true }), /<button/);
  assert.doesNotMatch(R.listHtml([receipt({ what: "<img onerror=x>", until_words: "<b>x</b>" })]), /<img|<b>/);
  assert.doesNotMatch(R.listHtml([receipt({ undo: null })]), /<button/, "no undo from the server, no button");
});

test("Undo puts a brain decision back through the shared revert and settles the row to 'Put back'", async () => {
  const calls = [];
  const toasts = [];
  const win = load({
    api: async (path, init) => {
      calls.push([path, init?.method]);
      return { ok: true };
    },
    toast: (m) => toasts.push(m),
  });
  const host = createHost(win.document, { html: win.CairnChangeReceipt.listHtml([receipt()]) });
  win.CairnChangeReceipt.mount(host);
  await host.querySelector("[data-rcpt-undo]").click();
  await flush();
  assert.deepEqual(calls, [["/brain/decisions/27849/revert", "POST"]]);
  assert.equal(host.querySelector(".rcpt").classList.contains("is-undone"), true);
  assert.equal(host.querySelector(".rcpt-state").textContent, "Put back");
  assert.equal(host.querySelector("button"), null);
  assert.ok(toasts.includes("Put back"));
});

test("Hold on a scheduled receipt holds the change through the same revert and says it won't land", async () => {
  const calls = [];
  const toasts = [];
  const win = load({
    api: async (path, init) => {
      calls.push([path, init?.method]);
      return { ok: true };
    },
    toast: (m) => toasts.push(m),
  });
  const html = win.CairnChangeReceipt.listHtml([receipt({ status: "scheduled", status_words: "Lands Thursday" })]);
  const host = createHost(win.document, { html });
  win.CairnChangeReceipt.mount(host);
  await host.querySelector("[data-rcpt-undo]").click();
  await flush();
  assert.deepEqual(calls, [["/brain/decisions/27849/revert", "POST"]]);
  assert.equal(host.querySelectorAll(".rcpt-state").length, 1, "one state, the new one");
  assert.equal(host.querySelector(".rcpt-state").textContent, "Held before it landed");
  assert.ok(toasts.includes("Held — it won't land"));
});

test("a refused Undo says so calmly and leaves the row as it was", async () => {
  const toasts = [];
  const win = load({ api: async () => ({ ok: false, error: "That change can no longer be undone." }), toast: (m) => toasts.push(m) });
  const host = createHost(win.document, { html: win.CairnChangeReceipt.listHtml([receipt()]) });
  win.CairnChangeReceipt.mount(host);
  await host.querySelector("[data-rcpt-undo]").click();
  await flush();
  assert.deepEqual(toasts, ["That change can no longer be undone."]);
  assert.ok(host.querySelector("[data-rcpt-undo]"), "the Undo stays");
});

test("a Changes feed row carries its receipt, without a second Undo beside the row's own", () => {
  const win = loadClientModule(
    ["html-utils", "ui-components", "ui-actions-client", "decision-undo-client", "change-receipt-client", "changes-feed-client"],
    {}
  );
  const row = {
    id: 27849,
    day: "2026-10-20",
    state: "applied",
    domain: "training",
    title: "Lowered Friday's leg work",
    why: null,
    status_line: "Landed today",
    lands_on: null,
    outcome: { key: "too_early", phrase: "we can't tell yet" },
    confidence: "tentative",
    undo: { available: true, label: "Restore Friday's Lower" },
    new: false,
    receipt: receipt(),
  };
  const li = renderHtml(win.CairnChangesFeed.rowHtml(row), { document: win.document, tag: "ul" });
  assert.equal(li.querySelector(".rcpt-what").textContent, "Fri Lower — legs lighter");
  assert.equal(li.querySelector("[data-rcpt-undo]"), null);
  assert.equal(li.querySelectorAll("[data-chfeed-undo]").length, 1, "the feed's own server-labelled Undo is the one way back");
  const plain = renderHtml(win.CairnChangesFeed.rowHtml({ ...row, receipt: undefined }), { document: win.document, tag: "ul" });
  assert.equal(plain.querySelector(".rcpt"), null);
});
