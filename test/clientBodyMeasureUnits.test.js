// Body measurements open in the athlete's Settings units (kg ⇒ cm, lb ⇒ in), not in a
// per-browser memory or a locale guess of their own. The in/cm toggle on the tape is a
// quick page-lifetime switch (CairnFmt.setLength), never stored, and a changed weight
// unit in Settings drops it. And the first boot of a fresh install sends the device's
// locale + zone once so its units start right (src/repo/unit-system.ts decides).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStorage, loadClientModule } from "./_dom.mjs";

const FMT = ["html-utils", "date-utils", "format-utils", "ui-format"];

function bodyMetricsContext(settings, extra = {}) {
  const calls = [];
  const api = (path, init) => {
    calls.push({ path, init });
    if (path === "/settings") return Promise.resolve({ settings });
    return Promise.reject(new Error("offline in test"));
  };
  const ctx = loadClientModule([...FMT, "body-metrics-client"], {
    globals: {
      Intl,
      api,
      toast: () => {},
      sparklineSvg: () => "",
      relAge: () => "",
      localISO: () => "2026-10-08",
      ...extra,
    },
  });
  return { ctx, calls };
}

async function openBody(ctx) {
  const mount = { innerHTML: "" };
  ctx.renderBodyMetrics(mount);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  return mount;
}

const bodyRead = (calls) => calls.find((c) => c.path.startsWith("/body-metrics"))?.path;

test("CairnFmt.length follows Settings' weight unit; the toggle is a page-only override", () => {
  const ctx = loadClientModule(FMT, { globals: { Intl } });
  const F = ctx.CairnFmt;
  assert.equal(F.length(), "in", "lb (the default) tapes in inches");
  F.set({ run_units: "km", weight_units: "kg" });
  assert.equal(F.length(), "cm", "kg tapes in centimetres");
  F.setLength("in");
  assert.equal(F.length(), "in", "the quick toggle wins for this page");
  F.set({ run_units: "mi", weight_units: "kg" });
  assert.equal(F.length(), "in", "a settings read with the same weight unit keeps the toggle");
  F.set({ weight_units: "lb" });
  assert.equal(F.length(), "in");
  F.set({ weight_units: "kg" });
  assert.equal(F.length(), "cm", "a changed weight unit in Settings drops the toggle");
  assert.equal(ctx.localStorage.getItem("cairn-bm-unit"), null, "nothing is remembered per browser");
});

test("the body screen opens in centimetres for a kg athlete, whatever the browser locale says", async () => {
  const { ctx, calls } = bodyMetricsContext(
    { run_units: "km", weight_units: "kg" },
    { navigator: { language: "en-US" } }
  );
  await openBody(ctx);
  assert.equal(bodyRead(calls), "/body-metrics?unit=cm");
});

test("the body screen opens in inches for a lb athlete, even on a metric-locale browser", async () => {
  const { ctx, calls } = bodyMetricsContext(
    { run_units: "mi", weight_units: "lb" },
    { navigator: { language: "de-DE" } }
  );
  await openBody(ctx);
  assert.equal(bodyRead(calls), "/body-metrics?unit=in");
});

test("a stale per-browser 'cairn-bm-unit' no longer overrides Settings (and is cleared)", async () => {
  const localStorage = createStorage({ "cairn-bm-unit": "in" });
  const { ctx, calls } = bodyMetricsContext({ weight_units: "kg" }, { localStorage });
  await openBody(ctx);
  assert.equal(bodyRead(calls), "/body-metrics?unit=cm");
  assert.equal(localStorage.getItem("cairn-bm-unit"), null);
});

function onboardingContext({ settings, language = "de-DE" }) {
  const calls = [];
  const api = (path, init) => {
    calls.push({ path, init });
    if (path === "/settings") return Promise.resolve({ settings, agents: [] });
    if (path === "/settings/units/detect") {
      return Promise.resolve({
        applied: true,
        settings: { ...settings, run_units: "km", weight_units: "kg", units_source: "detected" },
      });
    }
    return Promise.resolve({});
  };
  const ctx = loadClientModule([...FMT, "app-onboarding"], {
    globals: {
      Intl,
      api,
      artEnabled: true,
      navigator: { language },
      location: { pathname: "/", search: "", href: "http://x/" },
      swrSet: () => {},
      deviceTimeZone: () => "Europe/Berlin",
      setTimeout: () => 0,
      CairnCoachLink: {
        KEY: "k",
        model: () => ({ onboarded: !!settings.onboarded, ready: [] }),
        openWelcome: () => {},
      },
    },
  });
  return { ctx, calls };
}

test("first boot of a fresh install sends the device's locale and zone once", async () => {
  const { ctx, calls } = onboardingContext({
    settings: { onboarded: false, units_source: null, run_units: "km", weight_units: "lb" },
  });
  await ctx.maybeOnboard();
  const hint = calls.find((c) => c.path === "/settings/units/detect");
  assert.ok(hint, "the hint is sent");
  assert.equal(hint.init.method, "POST");
  const body = JSON.parse(hint.init.body);
  assert.equal(body.locale, "de-DE");
  assert.equal(body.time_zone, "Europe/Berlin");
  assert.deepEqual(
    { ...ctx.CairnFmt.units() },
    { distance: "km", weight: "kg" },
    "the formatter speaks the detected units"
  );
});

test("no hint once units were chosen or detected, or the install has onboarded", async () => {
  for (const settings of [
    { onboarded: false, units_source: "explicit" },
    { onboarded: false, units_source: "detected" },
    { onboarded: true, units_source: null },
    { onboarded: false }, // an older server that does not report units_source
  ]) {
    const { ctx, calls } = onboardingContext({ settings });
    await ctx.maybeOnboard();
    assert.equal(calls.filter((c) => c.path === "/settings/units/detect").length, 0, JSON.stringify(settings));
  }
});
