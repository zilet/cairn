// The Changes feed's STATED row: a change that is the athlete's own word (a push stance,
// a stated session) carries `said`, and reads "You said “X”" above what the brain changed,
// with the server-labelled Undo. The server's why opens on the same quote, so the row
// prints the quote once, as its own line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadClientModule, renderHtml } from "./_dom.mjs";

function load() {
  return loadClientModule([
    "html-utils",
    "ui-components",
    "ui-actions-client",
    "decision-undo-client",
    "decision-undo-controller",
    "changes-feed-client",
  ]);
}

function stated(overrides = {}) {
  return {
    id: 41,
    day: "2026-10-06",
    state: "applied",
    domain: "training",
    title: "Pushing through Oct 31",
    why: "You said “push me until the block ends”. On clean days the room widens: up to two heavier top sets.",
    said: "push me until the block ends",
    status_line: "Landed today",
    lands_on: null,
    outcome: { key: "too_early", phrase: "we can't tell yet" },
    confidence: "tentative",
    undo: { available: true, label: "Go back to your previous drive" },
    new: false,
    ...overrides,
  };
}

function row(win, change) {
  return renderHtml(win.CairnChangesFeed.rowHtml(change), { document: win.document }).querySelector(".chfeed-row");
}

test("a stated row leads with the athlete's words, then the change, and keeps its Undo", () => {
  const win = load();
  const li = row(win, stated());
  assert.ok(li.classList.contains("is-said"));
  const said = li.querySelector(".chfeed-said");
  assert.ok(said, "the quote line is present");
  assert.equal(li.firstElementChild, said, "the quote sits above the change");
  assert.equal(said.querySelector(".chfeed-said-k").textContent, "You said");
  assert.equal(said.querySelector("q").textContent, "push me until the block ends");
  assert.equal(li.querySelector(".chfeed-title").textContent, "Pushing through Oct 31");
  // The why no longer repeats the quote; it keeps what the brain changed.
  assert.equal(li.querySelector(".chfeed-why").textContent, "On clean days the room widens: up to two heavier top sets.");
  const undo = li.querySelector("[data-chfeed-undo]");
  assert.ok(undo, "Undo is still the row's action");
  assert.match(undo.textContent, /Go back to your previous drive/);
});

test("hostile words come back as text, and stray quote marks are never doubled", () => {
  const win = load();
  const li = row(
    win,
    stated({ said: `"push <b>harder</b>"`, why: "You said “push <b>harder</b>”. More room on clean days." })
  );
  const q = li.querySelector(".chfeed-said q");
  assert.equal(q.textContent, "push <b>harder</b>");
  assert.equal(q.querySelector("b"), null, "escaped, never markup");
  assert.equal(li.querySelector(".chfeed-why").textContent, "More room on clean days.");
});

test("a stated row whose why is only the quote prints the quote once and no empty why", () => {
  const win = load();
  const li = row(win, stated({ why: "You said “back to steady”.", said: "back to steady", title: "Back to a steady drive" }));
  assert.equal(li.querySelectorAll(".chfeed-said").length, 1);
  assert.equal(li.querySelector(".chfeed-why"), null);
});

test("a why that does not open on the quote is left whole", () => {
  const win = load();
  const li = row(win, stated({ why: "A different sentence the server wrote." }));
  assert.equal(li.querySelector(".chfeed-why").textContent, "A different sentence the server wrote.");
});

test("a team change (no said) has no quote line", () => {
  const win = load();
  for (const said of [undefined, null, "", "   "]) {
    const li = row(win, stated({ said, why: "Your last three sessions hit every rep." }));
    assert.equal(li.querySelector(".chfeed-said"), null);
    assert.ok(!li.classList.contains("is-said"));
    assert.equal(li.querySelector(".chfeed-why").textContent, "Your last three sessions hit every rep.");
  }
});
