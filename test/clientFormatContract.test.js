// The client format contract (IA spec rule 5, "units and dates follow the athlete"):
//   - ui-format.ts (CairnFmt) is the ONLY client file with the km<->mi factor and the
//     only one that builds athlete-facing dates with toLocale*/Intl;
//   - a rendered fixture never shows a raw ISO date or a unit printed twice;
//   - the named defects ("159.6lb lb", slash-joined phase line, "NOV 17 – JAN 12, 27").
// Static scans plus deterministic renders over the shipped public/js modules. Locale is
// pinned (en-US) so the Intl-built words are stable on any host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadClientModule } from "./_dom.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const clientDir = join(root, "src/client");
const sources = readdirSync(clientDir, { recursive: true })
  .filter((f) => String(f).endsWith(".ts") && !String(f).endsWith(".d.ts"))
  .map((f) => String(f));
const read = (f) => readFileSync(join(clientDir, f), "utf8");

/** Code only: line and block comments blanked so prose that names a factor never trips a scan. */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

const ISO_IN_TEXT = /\b\d{4}-\d{2}-\d{2}\b/;
const DOUBLE_UNIT = /\b(lb|kg|km|mi)\s*\1\b|\dlb lb|\d(?:lb|kg)\s+(?:lb|kg)\b/i;

/** Text nodes only: tags dropped, attributes (hrefs, data-*, titles) never read. */
function textOf(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function assertCleanText(html, label) {
  const text = textOf(html);
  assert.doesNotMatch(text, ISO_IN_TEXT, `${label}: a raw ISO date reached a text node: ${text.match(ISO_IN_TEXT)?.[0]}`);
  assert.doesNotMatch(text, DOUBLE_UNIT, `${label}: a unit is printed twice: ${text.match(DOUBLE_UNIT)?.[0]}`);
}

test("the km<->mi factor appears in exactly one src/client file: ui-format.ts", () => {
  const holders = sources.filter((f) => /1\.609\d*/.test(code(read(f))));
  assert.deepEqual(holders, ["ui-format.ts"]);
  // The mirror ban: no hand-rolled "/ 1.6" or "* 0.62" conversion either.
  const rough = sources.filter((f) => f !== "ui-format.ts" && /[*/]\s*(1\.6\b|0\.6214)/.test(code(read(f))));
  assert.deepEqual(rough, []);
});

// Athlete-facing dates are built in ui-format.ts. What is allowed elsewhere is a CLOCK
// time or a device timestamp (a moment, not a calendar day) and the time-zone probe;
// each file below is listed with its reason, so a new date formatter cannot slip in.
const DATE_BUILDER = /toLocale(?:Date|Time)String|Intl\.DateTimeFormat|\b(?:dateStyle|timeStyle)\b/;
const TIMESTAMP_ALLOWLIST = {
  "today-lately-client.ts": "a clock time on a device timestamp (the last-sync line)",
  "today-brief-client.ts": "the Brief's 'Updated 6:12 AM' device timestamp",
  "chat-message-client.ts": "a chat bubble's clock time",
  "settings-client.ts": "operator diagnostics timestamps (absolute + relative)",
  "settings-agents-client.ts": "an agent job's device timestamp",
  "outbox-ui.ts": "a queued write's device timestamp",
  "client-diagnostics.ts": "the IANA time-zone probe, not a date word",
  "api-core.ts": "the IANA time-zone probe, not a date word",
};

test("no src/client file but ui-format builds athlete-facing dates with toLocale*/Intl", () => {
  const offenders = sources.filter((f) => f !== "ui-format.ts" && DATE_BUILDER.test(code(read(f))));
  const unexpected = offenders.filter((f) => !(f in TIMESTAMP_ALLOWLIST));
  assert.deepEqual(unexpected, [], "route a calendar-day word through CairnFmt.date()");
  for (const f of Object.keys(TIMESTAMP_ALLOWLIST)) {
    assert.ok(sources.includes(f), `${f} is allowlisted but no longer exists: drop it from the list`);
    assert.ok(offenders.includes(f), `${f} no longer builds a date by hand: drop it from the allowlist`);
  }
});

test("static twin: no escHtml(<expr>.since|.date|.until) without CairnFmt", () => {
  const bad = [];
  for (const f of sources) {
    for (const line of code(read(f)).split("\n")) {
      if (/escHtml\(\s*[\w.?]*\.(?:since|until)\s*\)/.test(line) && !/CairnFmt|shortDate|dateLabel|relAge|humanDate/.test(line)) {
        bad.push(`${f}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

function fmtContext(globals = {}) {
  return loadClientModule(["html-utils", "date-utils", "format-utils", "ui-format"], {
    globals: { Intl, ...globals },
  });
}

test("CairnFmt: distance, pace, weight and dates follow the athlete's units", () => {
  const ctx = fmtContext();
  const F = ctx.CairnFmt;
  assert.deepEqual({ ...F.units() }, { distance: "km", weight: "lb" }, "km and lb until settings are read");
  assert.equal(F.distance(16.09344, "mi"), "10 mi");
  assert.equal(F.distance(16.09344, "km"), "16.1 km");
  assert.equal(F.distance(16.09344, "mi", true), "10");
  assert.equal(F.pace(373, "km"), "6:13");
  assert.equal(F.pace(373, "mi"), "10:00");
  assert.equal(F.weight(159.6, "lb"), "159.6 lb");
  assert.equal(F.weight(159.6, "kg"), "72.4 kg");
  assert.equal(F.weight(null, "lb"), "—");
  F.set({ run_units: "mi", weight_units: "kg" });
  assert.deepEqual({ ...F.units() }, { distance: "mi", weight: "kg" });
  assert.equal(F.distance(16.09344), "10 mi", "units default to the athlete's");
  assert.equal(F.weight(159.6), "72.4 kg");
  F.set({ run_units: "km" });
  assert.equal(F.units().weight, "lb", "a missing weight_units is lb");
  // Dates: words, never ISO.
  assert.equal(F.date("2026-09-25", { today: "2026-10-06" }), "Sep 25");
  assert.equal(F.date("2027-01-12", { today: "2026-10-06" }), "Jan 12, 2027");
  assert.equal(F.date("2026-09-25", { style: "long" }), "September 25, 2026");
  assert.equal(F.relDay("2026-10-07", "2026-10-06"), "Tomorrow");
  assert.equal(F.relDay("2026-09-25", "2026-10-06"), "11 days ago");
  assert.equal(F.relDay("2026-10-27", "2026-10-06"), "In 3 weeks");
  assert.equal(F.daysBetween("2026-10-06", "2026-09-29"), 7);
});

test("noDoubleUnit + noRawIso: the Body & recovery tile prints its unit once, in the athlete's units", () => {
  const ctx = loadClientModule(["html-utils", "date-utils", "format-utils", "ui-format", "today-main-shell-client"], {
    globals: { Intl },
  });
  const week = (options) =>
    ctx.CairnTodayMainShell.weekFoldHtml({ planned: 5, done: 4, weekKm: 22.3 }, { escapeHtml: ctx.escHtml }, options);
  const lb = week({ currentWeight: 159.6, trendLbWk: -0.9, runs: true });
  assertCleanText(lb, "weight tile (lb)");
  assert.match(textOf(lb), /159\.6 lb −0\.9\/wk/, "the number carries its unit once; the trend does not repeat it");
  ctx.CairnFmt.set({ weight_units: "kg" });
  const kg = week({ currentWeight: 159.6, trendLbWk: -0.9, runs: true });
  assertCleanText(kg, "weight tile (kg)");
  assert.match(textOf(kg), /72\.4 kg −0\.4\/wk/);
  assert.doesNotMatch(textOf(kg), /\blb\b/);
});

test("the Season/Journey phase line says its parts with dots and words, never slashes or ISO", () => {
  const ctx = loadClientModule(["html-utils", "date-utils", "format-utils", "ui-format", "journey-progress-client"], {
    globals: { Intl, stagger: (i) => `--i:${i}` },
  });
  const read = {
    profile: { goal_mode: "lose", goal_weight_lb: 154 },
    active_phase: { kind: "cut", start_date: "2026-09-25", target_weight_lb: 154 },
    milestones: [],
  };
  const line = ctx.CairnProgressJourney.phaseSummary(read, []);
  assert.match(line, /since Sep 25/);
  assert.match(line, /toward 154 lb/);
  assert.doesNotMatch(line, /\s\/\s/, `raw slash separators: ${line}`);
  assertCleanText(ctx.CairnProgressJourney.journeyCardHtml(read, []), "journey card");
  ctx.CairnFmt.set({ weight_units: "kg" });
  assert.match(ctx.CairnProgressJourney.phaseSummary(read, []), /toward 69\.9 kg/);
});

test("a date range never wears a two-digit year ('NOV 17 – JAN 12, 27')", () => {
  const ctx = loadClientModule(["html-utils", "date-utils", "format-utils", "ui-format", "ui-chart"], {
    globals: { Intl },
  });
  const label = ctx.CairnUiChart.dateLabel("2027-01-12", { year: true });
  assert.equal(label, "Jan 12, 2027");
  assert.doesNotMatch(label, /, \d{2}$/);
  assert.equal(ctx.CairnUiChart.dateLabel("2026-11-17"), "Nov 17");
});

test("run words in the athlete's units: day-detail model prints one unit per figure", () => {
  const ctx = loadClientModule(["html-utils", "date-utils", "format-utils", "ui-format", "day-detail-model"], {
    globals: { Intl },
  });
  const M = ctx.CairnDayDetailModel;
  assert.equal(M.distText(16.09344, "mi"), "10 mi");
  assert.equal(M.distText(5, "km"), "5 km");
  assert.equal(M.paceText({ fast_sec_per_km: 373, slow_sec_per_km: 403 }, "mi"), "10:00–10:49 /mi");
  assert.equal(M.paceText({ fast_sec_per_km: 373, slow_sec_per_km: 403 }, "km"), "6:13–6:43 /km");
  assert.equal(M.kicker({ date: "2026-10-07", today: "2026-10-06", status: "upcoming" }), "Tomorrow · Planned");
  for (const text of [M.distText(8, "mi"), M.paceText({ fast_sec_per_km: 300, slow_sec_per_km: 330 }, "mi")]) {
    assert.doesNotMatch(text, DOUBLE_UNIT);
    assert.doesNotMatch(text, /\bkm\b|\/km/, "a miles athlete never reads km");
  }
});
