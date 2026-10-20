// The Brief's quiet questions on the client (today-brief-client.ts): painted only into
// today's Brief, under its own slot — never a toast-first push — with the server's own
// words and answers, escaped, and an answered key gone at once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDocument, createHost, flush, loadClientModule } from "./_dom.mjs";

const ASK = {
  key: "trip_lift:2026-10-23",
  kind: "trip_lift",
  question: "Lifting on the trip?",
  detail: "Friday's Lower lands on your <Clearwater> trip.",
  date: "2026-10-23",
  answers: [
    { key: "yes", label: "Yes, as planned" },
    { key: "easier", label: "Easier — bodyweight" },
    { key: "skip", label: "Skip it" },
  ],
};

function load({ answer = { ok: true, message: "Noted — the lift stays as planned." } } = {}) {
  const document = createDocument();
  const calls = [];
  const toasts = [];
  const api = async (path, opts) => {
    calls.push({ path, opts });
    if (String(path).startsWith("/today-asks/answer")) return answer;
    return { date: "2026-10-22", asks: [ASK] };
  };
  const w = loadClientModule(["html-utils", "today-brief-asks-client", "today-brief-client"], {
    document,
    globals: { api, toast: (m) => toasts.push(m), setTimeout: (fn) => fn(), apiInvalidate: () => {} },
  });
  return { w, document, calls, toasts };
}

test("the questions render as calm cards with the server's words, escaped, and an empty slot collapses", () => {
  const { w } = load();
  const html = w.CairnTodayBriefAsks.html([ASK, { key: "", question: "" }]);
  assert.match(html, /Lifting on the trip\?/);
  assert.match(html, /&lt;Clearwater&gt;/);
  assert.equal((html.match(/data-brief-ask-answer=/g) || []).length, 3);
  assert.match(html, /data-brief-ask="trip_lift:2026-10-23"/);
  assert.doesNotMatch(html, /score|grade|you must/i);
  assert.equal(w.CairnTodayBriefAsks.html([]), "");
  assert.match(
    w.CairnTodayBriefAsks.slotHtml("2026-10-22"),
    /^<div class="brief-asks-slot" data-brief-asks="2026-10-22" aria-live="off"><\/div>$/
  );
});

test("today's Brief carries the slot and fills it from /today-asks; a past day's Brief never asks", async () => {
  const { w, document, calls } = load();
  const host = createHost(document);
  host.innerHTML = w.CairnTodayBrief.briefHtml(
    { kind: "train", headline: "Lower", why: "", date: "2026-10-22" },
    { isToday: true }
  );
  await flush();
  assert.ok(calls.some((c) => c.path === "/today-asks?date=2026-10-22"));
  const slot = host.querySelector("[data-brief-asks]");
  assert.ok(slot);
  assert.match(slot.innerHTML, /Lifting on the trip\?/);

  const past = w.CairnTodayBrief.briefHtml(
    { kind: "train", headline: "Lower", why: "", date: "2026-10-20" },
    { isToday: false }
  );
  assert.doesNotMatch(past, /data-brief-asks/);
});

test("an answer posts the key and the tap, takes the card away and says the server's sentence", async () => {
  const { w, document, calls, toasts } = load();
  const host = createHost(document);
  host.innerHTML = w.CairnTodayBrief.briefHtml(
    { kind: "train", headline: "Lower", why: "", date: "2026-10-22" },
    { isToday: true }
  );
  await flush();
  const button = host.querySelector('[data-brief-ask-answer="yes"]');
  assert.ok(button);
  await button.click();
  await flush();
  const post = calls.find((c) => c.path === "/today-asks/answer");
  assert.ok(post, "the answer is posted");
  assert.deepEqual(JSON.parse(post.opts.body), { key: "trip_lift:2026-10-23", answer: "yes", date: "2026-10-22" });
  assert.equal(host.querySelector("[data-brief-ask]"), null, "the card is gone");
  assert.deepEqual(toasts, ["Noted — the lift stays as planned."]);
  // A repaint from the cache never brings an answered question back.
  assert.equal(w.CairnTodayBriefAsks.html([ASK]), "");
});

test("a refused answer puts the card back with the server's reason", async () => {
  const { w, document, toasts } = load({
    answer: { ok: false, error: "That question has already been answered, so nothing changed." },
  });
  const host = createHost(document);
  host.innerHTML = w.CairnTodayBrief.briefHtml(
    { kind: "train", headline: "Lower", why: "", date: "2026-10-22" },
    { isToday: true }
  );
  await flush();
  await host.querySelector('[data-brief-ask-answer="skip"]').click();
  await flush();
  assert.ok(host.querySelector("[data-brief-ask]"), "the question stands");
  assert.match(toasts[0], /already been answered/);
});
