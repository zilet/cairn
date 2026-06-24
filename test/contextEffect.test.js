// context-effect.ts — the active-context effect engine. A one-mention life event
// (late concert, travel, illness, hard week) shapes the day + guards the labs, then
// fades. DETERMINISTIC + PURE: classification, windowing/fade, aggregate flags, the
// transient-inflammation marker window, and the silent path for a non-matching event.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeContextEffect,
  markerInTransientWindow,
  isAcuteMarker,
} from "../dist/repo/context-effect.js";

// A context_event-shaped object as classifyEvent reads it (we pass events in via the
// second arg, so these never touch the DB — fully offline + deterministic).
const ev = (over = {}) => ({
  kind: "life_event",
  title: null,
  detail: null,
  start_date: null,
  end_date: null,
  meta: null,
  archived: 0,
  ...over,
});

const TODAY = "2026-06-24";
const ago = (n) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 864e5).toISOString().slice(0, 10);

test("classifies a late loud concert → worse sleep + transient inflammation", () => {
  const eff = activeContextEffect(TODAY, [ev({ title: "Late loud concert", start_date: ago(1) })]);
  assert.equal(eff.any, true);
  assert.equal(eff.active.length, 1);
  const it = eff.active[0];
  assert.equal(it.expect_worse_sleep, true);
  assert.equal(it.transient_inflammation, true);
  assert.equal(it.reduce_load, false);
  assert.equal(it.fueling_disrupted, false);
  // aggregate flags mirror the single item
  assert.equal(eff.expect_worse_sleep, true);
  assert.equal(eff.transient_inflammation, true);
  assert.equal(eff.reduce_load, false);
  assert.equal(eff.fueling_disrupted, false);
});

test("classifies a hard/stressful week → worse sleep only", () => {
  const eff = activeContextEffect(TODAY, [ev({ title: "Brutal week at work, barely slept", start_date: ago(2) })]);
  assert.equal(eff.expect_worse_sleep, true);
  assert.equal(eff.transient_inflammation, false);
  assert.equal(eff.reduce_load, false);
  assert.equal(eff.fueling_disrupted, false);
});

test("classifies illness → reduce load + transient inflammation + fueling disrupted", () => {
  const eff = activeContextEffect(TODAY, [ev({ title: "Fighting a cold", start_date: ago(1) })]);
  assert.equal(eff.reduce_load, true);
  assert.equal(eff.transient_inflammation, true);
  assert.equal(eff.fueling_disrupted, true);
  assert.equal(eff.expect_worse_sleep, false);
});

test("classifies travel/trip → fueling disrupted (trip kind alone is enough)", () => {
  const eff = activeContextEffect(TODAY, [ev({ kind: "trip", title: "Conference", start_date: ago(1), end_date: ago(-3) })]);
  assert.equal(eff.fueling_disrupted, true);
  assert.equal(eff.reduce_load, false);
  assert.equal(eff.transient_inflammation, false);
  // and a plain "travelling this week" life_event also fires on the word
  const eff2 = activeContextEffect(TODAY, [ev({ title: "Travelling this week", start_date: ago(1) })]);
  assert.equal(eff2.fueling_disrupted, true);
});

test("non-matching event stays silent (any=false, all flags false)", () => {
  const eff = activeContextEffect(TODAY, [ev({ kind: "family_event", title: "Kid's recital" })]);
  assert.equal(eff.any, false);
  assert.equal(eff.active.length, 0);
  assert.equal(eff.expect_worse_sleep, false);
  assert.equal(eff.transient_inflammation, false);
  assert.equal(eff.reduce_load, false);
  assert.equal(eff.fueling_disrupted, false);
});

test("no events at all → empty effect", () => {
  const eff = activeContextEffect(TODAY, []);
  assert.equal(eff.any, false);
  assert.deepEqual(eff.active, []);
});

test("windowing / fade: a stressful week decays after ~5 days", () => {
  // Drawn fresh (2 days ago) → active.
  assert.equal(activeContextEffect(TODAY, [ev({ title: "Stressful crunch, barely slept", start_date: ago(2) })]).any, true);
  // 9 days ago, no end_date → past the ~5-day stress horizon → faded.
  const faded = activeContextEffect(TODAY, [ev({ title: "Stressful crunch, barely slept", start_date: ago(9) })]);
  assert.equal(faded.any, false);
});

test("windowing: a concert's transient-inflammation tail outlives its sleep window", () => {
  // A concert raises BOTH worse-sleep (~2d) and transient inflammation (~14d). The
  // window is the LONGER of the matched effects, so it's STILL active at 5 days
  // (the inflammation tail aligns to the acute-marker horizon by design)…
  const stillActive = activeContextEffect(TODAY, [ev({ title: "Late loud concert", start_date: ago(5) })]);
  assert.equal(stillActive.any, true);
  assert.equal(stillActive.transient_inflammation, true);
  // …but well past the ~14-day horizon it's gone.
  const faded = activeContextEffect(TODAY, [ev({ title: "Late loud concert", start_date: ago(20) })]);
  assert.equal(faded.any, false);
});

test("windowing: a future event hasn't started yet → silent", () => {
  const future = activeContextEffect(TODAY, [ev({ kind: "trip", title: "Trip", start_date: ago(-3), end_date: ago(-1) })]);
  assert.equal(future.any, false);
});

test("an explicit end_date bounds the window (illness resolved last week)", () => {
  // Started 12d ago, ended 8d ago → faded by the end_date even though illness's
  // default decay would otherwise be longer than its start window.
  const eff = activeContextEffect(TODAY, [ev({ title: "Had the flu", start_date: ago(12), end_date: ago(8) })]);
  assert.equal(eff.any, false);
});

test("aggregate flags OR across multiple active items", () => {
  const eff = activeContextEffect(TODAY, [
    ev({ title: "Concert", start_date: ago(1) }),       // worse sleep + transient inflammation
    ev({ kind: "trip", title: "Work trip", start_date: ago(1) }), // fueling disrupted
  ]);
  assert.equal(eff.active.length, 2);
  assert.equal(eff.expect_worse_sleep, true);
  assert.equal(eff.transient_inflammation, true);
  assert.equal(eff.fueling_disrupted, true);
  assert.equal(eff.any, true);
});

test("markerInTransientWindow: true inside, false outside the window", () => {
  // A concert ~2 days ago raises a ~14-day transient-inflammation window.
  const eff = activeContextEffect(TODAY, [ev({ title: "Late loud concert", start_date: ago(2) })]);
  assert.equal(eff.transient_inflammation, true);
  const decaysOn = eff.active[0].decays_on;
  assert.ok(decaysOn, "a started event has a decay horizon");
  // A reading on the day of (or after the event start, before the horizon) is inside.
  assert.equal(markerInTransientWindow(ago(2), eff), true);
  assert.equal(markerInTransientWindow(TODAY, eff), true);
  // A reading AFTER the decay horizon is outside.
  const afterHorizon = new Date(Date.parse(`${decaysOn}T00:00:00Z`) + 1 * 864e5).toISOString().slice(0, 10);
  assert.equal(markerInTransientWindow(afterHorizon, eff), false);
});

test("markerInTransientWindow: false when the effect carries no transient inflammation", () => {
  // A stressful week raises expect_worse_sleep but NOT transient_inflammation.
  const eff = activeContextEffect(TODAY, [ev({ title: "Stressful deadline week", start_date: ago(1) })]);
  assert.equal(eff.transient_inflammation, false);
  assert.equal(markerInTransientWindow(TODAY, eff), false);
});

test("markerInTransientWindow: false on a malformed reading date", () => {
  const eff = activeContextEffect(TODAY, [ev({ title: "Concert", start_date: ago(1) })]);
  assert.equal(markerInTransientWindow("not-a-date", eff), false);
  assert.equal(markerInTransientWindow("", eff), false);
});

test("isAcuteMarker: acute reactants true, chronic/structural markers false", () => {
  assert.equal(isAcuteMarker("hs-CRP"), true);
  assert.equal(isAcuteMarker("C-Reactive Protein"), true);
  assert.equal(isAcuteMarker("ESR"), true);
  assert.equal(isAcuteMarker("ApoB"), false);
  // a cluster name mentioning CRP but dominated by chronic markers is NOT acute
  assert.equal(isAcuteMarker("ApoB+LDL-C+Lp(a)+hs-CRP+Triglycerides"), false);
  assert.equal(isAcuteMarker(null), false);
});

test("archived events are ignored even if passed in", () => {
  const eff = activeContextEffect(TODAY, [ev({ title: "Concert", start_date: ago(1), archived: 1 })]);
  assert.equal(eff.any, false);
});
