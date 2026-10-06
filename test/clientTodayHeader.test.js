// v2 wave 7, "Today is Home": Today only ever shows today, so its header is a plain mono
// eyebrow ("Today · Tue 29 Sep"), never a date picker; the Today home's sub-views (a day,
// Fuel) wear the same eyebrow for the day they show.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadHeader() {
  const context = { Object, String, Number, Date };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/ui-format.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/ui-header-client.js"), "utf8"), context);
  return context.CairnUiHeader;
}

function el() {
  const classes = new Set(["hdr-tappable"]);
  return {
    innerHTML: "",
    textContent: "",
    classList: {
      add: (c) => classes.add(c),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      contains: (c) => classes.has(c),
    },
  };
}

test("Today's header says today, plainly, with no way to pick another date", () => {
  const header = loadHeader();
  const title = el();
  header.setTodayHeaderTitle({
    headerTitle: title,
    state: { tab: "today", logDate: "2026-09-27" },
    escapeHtml: String,
    dateLabel: () => "Today",
    localISO: () => "2026-09-29",
    syncRouteFromState: () => {},
    renderToday: () => {},
  });
  assert.match(title.innerHTML, /Today · Tue 29 Sep/, "always today, whatever a stale logDate says");
  assert.doesNotMatch(title.innerHTML, /type="date"|hdr-datepick|hdr-chev/);
  assert.equal(title.classList.contains("hdr-tappable"), false);
  assert.equal(title.classList.contains("hdr-eyebrow"), true);
});

test("a Today-home sub-view wears the same eyebrow for its own day", () => {
  const header = loadHeader();
  const title = el();
  header.setEyebrowTitle(title, `Fuel · ${header.shortDate("2026-09-28")}`);
  assert.equal(title.textContent, "Fuel · Mon 28 Sep");
  assert.equal(title.classList.contains("hdr-eyebrow"), true);
});
