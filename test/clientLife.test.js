import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadLifeClient() {
  const context = {
    Array,
    Date,
    JSON,
    Number,
    Object,
    String,
    localISO: () => "2026-06-30",
    stagger: (index) => `--i:${index}`,
  };
  context.window = context;
  // date-utils owns the real pickDayVariant the life card rotates its impact line
  // through; load it first (as the browser does), then pin the day so the rotation
  // is deterministic here.
  vm.runInNewContext(readFileSync(join(root, "public/js/date-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/ui-format.js"), "utf8"), context);
  context.localISO = () => "2026-06-30";
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/life-client.js"), "utf8"), context);
  return context.CairnLife;
}

test("life helper formats kinds, dates, activity state, and fields", () => {
  const life = loadLifeClient();

  assert.equal(life.lifeKindLabel("injury"), "Injury");
  assert.equal(life.lifeKindLabel("school"), "school");
  assert.match(life.lifeKindOptionsHtml(), /value="trip"/);
  // Dates read the way people say them, never raw ISO; the year shows only off this year.
  assert.equal(life.fmtDateRange("2026-07-01", "2026-07-03"), "Jul 1 → Jul 3");
  assert.equal(life.fmtDateRange("", "2026-07-03"), "until Jul 3");
  assert.equal(life.fmtDateRange("2025-08-02", ""), "Aug 2, 2025");
  assert.equal(life.fmtDateRange("2025-07-01", "2025-07-03"), "Jul 1 → Jul 3, 2025");
  assert.equal(life.fmtDateRange("2026-12-28", "2027-01-03"), "Dec 28 → Jan 3, 2027");
  assert.equal(life.daysUntil("2026-07-02", "2026-06-30"), 2);
  assert.equal(life.daysUntil("bad", "2026-06-30"), null);
  assert.equal(life.eventActive({ end_date: "2026-06-29" }, "2026-06-30"), false);
  assert.equal(life.eventActive({ end_date: "2026-06-30" }, "2026-06-30"), true);
  assert.match(life.lifeFieldsHtml("injury"), /id="lSeverity"/);
  assert.match(life.lifeFieldsHtml("injury"), /<label for="lSeverity">Severity<\/label>/);
  assert.match(life.lifeFieldsHtml("injury"), /name="lSeverity"/);
  assert.match(life.lifeFieldsHtml("trip"), /id="lLocation"/);
  assert.match(life.lifeFieldsHtml("trip"), /<label for="lTitle">Title<\/label>/);
  assert.match(life.lifeFieldsHtml("trip"), /name="lStart"/);
});

test("life event renderer escapes timeline content and injury impact swaps", () => {
  const life = loadLifeClient();
  const html = life.lifeEventHtml(
    {
      id: '9" onclick="bad',
      kind: "injury",
      title: "Knee <tweak>",
      detail: "Avoid deep flexion <today>",
      start_date: "2026-06-29",
      meta_json: JSON.stringify({ area: "knee <right>", severity: "moderate <watch>" }),
    },
    4,
    {
      '9" onclick="bad': {
        affected: [
          {
            exercise: "Squat <bar>",
            days: [{ day_name: "Lower <A>" }],
            constraint_note: "No sharp pain <rule>",
            swaps: [{ name: "Step-up <low>", why: "less bend <knee>" }],
          },
        ],
      },
    },
  );

  assert.match(html, /data-life="9&quot; onclick=&quot;bad"/);
  assert.match(html, /Knee &lt;tweak&gt;/);
  assert.match(html, /Avoid deep flexion &lt;today&gt;/);
  assert.match(html, /knee &lt;right&gt; · moderate &lt;watch&gt;/);
  assert.match(html, /Squat &lt;bar&gt;/);
  assert.match(html, /Lower &lt;A&gt;/);
  assert.match(html, /Step-up &lt;low&gt;/);
  assert.match(html, /title="less bend &lt;knee&gt;"/);
  assert.match(html, /--i:4/);
  assert.doesNotMatch(html, /<tweak>|<today>|<right>|<bar>|onclick="bad/);
});

test("life injury card prints one 'try instead' line per shared set of stand-ins", () => {
  const life = loadLifeClient();
  const same = [{ name: "Glute Bridge", why: "" }, { name: "Hip Thrust", why: "" }];
  const html = life.lifeEventHtml({ id: 3, kind: "injury", title: "Knee", start_date: "2025-08-02" }, 0, {
    3: {
      affected: [
        { exercise: "Back Squat", days: [], swaps: same },
        { exercise: "Leg Curl", days: [], swaps: [{ name: "Romanian Deadlift", why: "" }] },
        { exercise: "Split Squat", days: [], swaps: same },
      ],
    },
  });
  assert.equal((html.match(/class="linj-grp"/g) || []).length, 2);
  assert.equal((html.match(/try instead/g) || []).length, 2);
  assert.equal((html.match(/Glute Bridge/g) || []).length, 1);
  assert.match(html, /Since Aug 2, 2025/);
});

test("life parser handles JSON strings and malformed metadata", () => {
  const life = loadLifeClient();

  assert.equal(life.parsedMeta({ meta_json: '{"location":"Lisbon"}' }).location, "Lisbon");
  assert.equal(JSON.stringify(life.parsedMeta({ meta_json: "not json" })), "{}");
  assert.equal(life.parsedMeta({ meta_json: { impact: "high" } }).impact, "high");
});
