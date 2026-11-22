// "The whole picture" (src/client/standing-model.ts, standing-client.ts): GET /api/week
// `standing[]` as one calm row per area on Horizon's Week. Built public/js modules in a vm
// context, fixtures shaped exactly like WeekReadStandingRow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadClientModule, renderHtml } from "./_dom.mjs";

const win = () => loadClientModule(["html-utils", "standing-model", "standing-client"]);

const line = (over = {}) => ({
  id: "squat",
  label: "Squat",
  now_text: "234 lb",
  direction: "better",
  direction_words: "Building",
  move_words: "3 lb up since Oct 25",
  note: "led by Back Squat",
  ...over,
});

const FIXTURE = [
  {
    key: "strength",
    stone: "strength",
    label: "Strength",
    direction: "better",
    direction_words: "Building",
    words: "Most lifts are climbing.",
    since_words: "since Oct 25",
    lines: [line(), line({ id: "dl", label: "Deadlift", now_text: "300 lb", direction: "holding", direction_words: "Holding", note: null })],
    invite: null,
    href: "/app/train",
  },
  {
    key: "mobility",
    stone: "recovery",
    label: "Mobility",
    direction: null,
    direction_words: null,
    words: "Not read yet.",
    since_words: null,
    lines: [],
    invite: "Four short checks would let this speak.",
    href: null,
  },
  {
    key: "recovery",
    stone: "recovery",
    label: "Recovery",
    direction: "holding",
    direction_words: "Holding",
    words: "Sleep and heart rate sit where they usually do.",
    since_words: "since Nov 1",
    lines: [],
    invite: null,
    href: null,
  },
];

const html = (standing) => win().CairnStanding.listHtml(standing);

test("no standing, no section", () => {
  const w = win();
  assert.equal(w.CairnStanding.listHtml(undefined), "");
  assert.equal(w.CairnStanding.listHtml([]), "");
  assert.equal(w.CairnStanding.listHtml([{ key: "body", stone: "body", label: "", words: "", lines: [] }]), "");
});

test("one collapsed line per row, the stone's class on each, disclosure only with lines", () => {
  const w = win();
  const host = renderHtml(w.CairnStanding.listHtml(FIXTURE), { document: w.document });
  const rows = host.querySelectorAll("li.standing");
  assert.equal(rows.length, 3);
  assert.ok(rows[0].classList.contains("stone-strength"));
  assert.ok(rows[1].classList.contains("stone-recovery"));
  assert.equal(host.querySelectorAll("details").length, 1);
  assert.equal(rows[1].querySelector("details"), null);
  assert.equal(rows[2].querySelector("details"), null);
  const head = rows[0].querySelector(".standing-main").textContent;
  assert.match(head, /Strength/);
  assert.match(head, /Building/);
  assert.match(head, /since Oct 25/);
  assert.match(head, /Most lifts are climbing\./);
});

test("lines and the invite render", () => {
  const w = win();
  const host = renderHtml(w.CairnStanding.listHtml(FIXTURE), { document: w.document });
  const lines = host.querySelectorAll(".standing-line");
  assert.equal(lines.length, 2);
  assert.match(lines[0].textContent, /Squat/);
  assert.match(lines[0].textContent, /234 lb/);
  assert.match(lines[0].textContent, /Building/);
  assert.equal(lines[0].querySelector(".standing-tail").textContent, "3 lb up since Oct 25 · led by Back Squat");
  assert.equal(lines[1].querySelector(".standing-tail").textContent, "3 lb up since Oct 25");
  assert.equal(host.querySelector(".standing-invite").textContent, "Four short checks would let this speak.");
  assert.equal(host.querySelectorAll(".standing-invite").length, 1);
});

test("a row with a page links by its label", () => {
  const w = win();
  const host = renderHtml(w.CairnStanding.listHtml(FIXTURE), { document: w.document });
  const link = host.querySelector("li.standing a.standing-label");
  assert.equal(link.getAttribute("href"), "/app/train");
  assert.equal(link.textContent, "Strength");
  assert.equal(host.querySelectorAll("a").length, 1);
});

test("every word is escaped", () => {
  const evil = "<script>alert(1)</script>";
  const out = html([
    { ...FIXTURE[0], label: evil, words: evil, invite: evil, href: '/x"><img>', lines: [line({ label: evil, now_text: evil, note: evil })] },
  ]);
  assert.ok(!out.includes("<script>"));
  assert.ok(!out.includes("<img>"));
  assert.ok(out.includes("&lt;script&gt;"));
});

test("each row has one spoken sentence; drawn text is hidden from assistive tech", () => {
  const w = win();
  const said = w.CairnStandingModel.rows(FIXTURE).map((r) => r.said);
  assert.equal(said[0], "Strength, building since Oct 25. Most lifts are climbing.");
  assert.equal(said[1], "Mobility. Not read yet.");
  const host = renderHtml(w.CairnStanding.listHtml(FIXTURE), { document: w.document });
  const row = host.querySelectorAll("li.standing")[2];
  assert.equal(row.querySelector(".sr-only").textContent.trim(), "Recovery, holding since Nov 1. Sleep and heart rate sit where they usually do.");
  assert.equal(row.querySelector(".standing-main").getAttribute("aria-hidden"), "true");
  assert.equal(row.querySelector(".goalrow-dot").getAttribute("aria-hidden"), "true");
});

test("no percent, no meter, no inline style, no score markup", () => {
  const out = html(FIXTURE);
  assert.ok(!out.includes("%"));
  assert.ok(!/style=|<svg|role="meter"|role="progressbar"|<progress|<meter/i.test(out));
  assert.ok(!/score|grade|percent/i.test(out));
});

test("an unknown stone or direction falls back quietly", () => {
  const w = win();
  const [row] = w.CairnStandingModel.rows([{ ...FIXTURE[0], stone: "gold", direction: "amazing", lines: [] }]);
  assert.equal(row.stone, "body");
  assert.equal(row.direction, null);
});
