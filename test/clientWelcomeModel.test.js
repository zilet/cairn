// The welcome's pure shaping (welcome-model.ts) and its markup (welcome-client.ts):
// the coach's three phases, the first week Monday-first, the starting fuel as a calm
// estimate (never a score), and every caller string escaped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadClientModule } from "./_dom.mjs";

function load() {
  return loadClientModule(["html-utils", "ui-stone-model", "ui-stone", "welcome-model", "welcome-client"], { globals: {} });
}

const plain = (v) => JSON.parse(JSON.stringify(v));

test("the job's phase is read from its step first, then its words; it never invents one", () => {
  const { CairnWelcomeModel: m } = load();
  assert.equal(m.phaseIndex({ meta: { step: "understand" } }), 0);
  assert.equal(m.phaseIndex({ meta: { step: "week" }, phase: "anything" }), 1);
  assert.equal(m.phaseIndex({ phase: "setting your starting fuel" }), 2);
  assert.equal(m.phaseIndex({ phase: "queued" }), -1);
  assert.equal(m.phaseIndex(null), -1);
});

test("the first week reads Monday-first, and a week with no stated weekdays reads by day", () => {
  const { CairnWelcomeModel: m } = load();
  const rows = m.weekRows([
    { dow: 5, day_number: 3, name: "Full body" },
    { dow: 1, day_number: 1, name: "Upper" },
    { dow: 0, day_number: 4, name: "Long walk strength" },
    { dow: 3, day_number: 2, name: "" },
  ]);
  assert.deepEqual(plain(rows.map((r) => [r.day, r.name])), [
    ["Mon", "Upper"],
    ["Fri", "Full body"],
    ["Sun", "Long walk strength"],
  ]);
  assert.deepEqual(
    plain(m.weekRows([{ dow: null, day_number: 2, name: "Lower" }, { dow: null, day_number: 1, name: "Upper" }]).map((r) => r.day)),
    ["Day 1", "Day 2"]
  );
  assert.deepEqual(plain(m.weekRows(null)), []);
});

test("what became of the week is said plainly, and 'in place' is only said when something landed", () => {
  const { CairnWelcomeModel: m } = load();
  assert.equal(m.weekNote("applied", true), null);
  assert.match(m.weekNote("draft", true), /waits for your yes/);
  assert.match(m.weekNote("failed", false), /couldn't put your first week together/);
  assert.equal(m.landed("applied", "none"), true);
  assert.equal(m.landed("failed", "set"), true);
  assert.equal(m.landed("failed", "none"), false);
  assert.equal(m.landed("none", "none"), false);
});

test("the starting fuel is an estimate in words, rounded, never a score", () => {
  const { CairnWelcomeModel: m } = load();
  assert.deepEqual(plain(m.fuelLines({ target_kcal: 2384, protein_g: 148 }, "set")), {
    main: "About 2,400 kcal a day, with around 150 g of protein",
    sub: "A starting estimate. It settles as you log meals and weigh in.",
  });
  assert.equal(m.fuelLines({ target_kcal: null, protein_g: 120 }, "set").main, "Around 120 g of protein");
  assert.match(m.fuelLines({ target_kcal: 2000, protein_g: null }, "existing").sub, /already set/);
  assert.equal(m.fuelLines(null, "none"), null);
  assert.equal(m.fuelLines({ target_kcal: 0, protein_g: null }, "set"), null);
});

test("every string the coach or the server wrote is escaped into the reveal", () => {
  const { CairnWelcomeClient: c, CairnWelcomeModel: m } = load();
  const html =
    c.coachBubbleHtml("<img src=x onerror=alert(1)>\n\nSecond") +
    c.revealHtml({
      reply: "",
      week: m.weekRows([{ dow: 2, day_number: 1, name: "<b>Upper</b>" }]),
      weekNote: null,
      fuel: { main: "About <2,000> kcal", sub: "x" },
    }) +
    c.helloHtml([{ name: "evil\"", label: "<script>", plan: "<i>plan</i>", usable: false, present: false, installable: true, canLogin: true, configured: null }]);
  assert.doesNotMatch(html, /<img|<b>Upper|<script>|<i>plan/);
  assert.match(html, /&lt;b&gt;Upper&lt;\/b&gt;/);
  assert.match(html, /<p>Second<\/p>/, "paragraphs survive as paragraphs");
});

test("Hello offers each provider by its own plan line, and a connected one says so", () => {
  const { CairnWelcomeClient: c } = load();
  const html = c.helloHtml([
    { name: "claude", label: "Claude", plan: "Claude Pro or Max", usable: false, present: false, installable: true, canLogin: true, configured: null },
    { name: "codex", label: "ChatGPT", plan: "Sign in with ChatGPT", usable: true, present: true, installable: true, canLogin: true, configured: true },
  ]);
  assert.match(html, /A coach that reads your whole picture\./);
  assert.match(html, /data-wel-pick="claude"[\s\S]*Claude Pro or Max/);
  assert.match(html, /data-wel-pick="codex"[\s\S]*Connected/);
  assert.match(html, /I don't have one yet/);
  assert.match(html, /Look around first/);
  // "Settings → Agents" is the name of a place in the app, not machinery talk.
  const words = html.replace(/<[^>]*>/g, " ").replace(/Settings \u2192 Agents/g, "");
  assert.doesNotMatch(words, /\bCLI\b|\bagents?\b/i, "no machinery words in the primary copy");
});
