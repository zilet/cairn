import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadTodayActivity() {
  const context = {
    Object,
    String,
    art: (_kind, text) => `<svg data-art="${String(text).replace(/"/g, "&quot;")}"></svg>`,
    artImg: (_kind, text, className, svg) => `<div class="${className}" data-art-text="${String(text).replace(/"/g, "&quot;")}">${svg || ""}</div>`,
    activityLine: (activity) =>
      [activity.type, activity.duration_min ? `${activity.duration_min} min` : null, activity.distance_km ? `${activity.distance_km} km` : null]
        .filter(Boolean)
        .join(" · ") || activity.raw_text || "",
    enrichBadge: (status) => (status === "pending" ? `<span class="enr enr-pending">enriching...</span>` : ""),
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-activity-client.js"), "utf8"), context);
  return context.CairnTodayActivity;
}

test("today activity helpers render activity rows safely", () => {
  const activity = loadTodayActivity();

  assert.equal(activity.actArtText({ type: "Bike ride" }), "riding a road bicycle");
  assert.equal(activity.actArtText({ type: "Swim workout" }), "swimming freestyle");
  assert.equal(activity.actArtText({ type: "", raw_text: "yard work" }), "yard work");

  const html = activity.actEntryHtml({
    id: '7" onclick="bad',
    type: "<run>",
    duration_min: 30,
    enrichment_status: "pending",
  });

  assert.match(html, /class="qlent"/);
  assert.match(html, /data-actid="7&quot; onclick=&quot;bad"/);
  assert.match(html, /data-art-text="running"/);
  assert.match(html, /&lt;run&gt; · 30 min/);
  assert.match(html, /enriching\.\.\./);
  assert.doesNotMatch(html, /onclick="bad/);
});

test("today activity update refreshes text, badge, art, and done state", () => {
  const activity = loadTodayActivity();
  const host = {
    classList: {
      values: new Set(),
      add(name) { this.values.add(name); },
      contains(name) { return this.values.has(name); },
    },
    nodes: {
      ".qlent-line": { textContent: "" },
      ".qlent-badge": { innerHTML: "" },
      ".qlent-art": { outerHTML: "" },
    },
    querySelector(selector) {
      return this.nodes[selector] || null;
    },
  };

  activity.updateActEntry(host, { id: 4, type: "row", duration_min: 12, enrichment_status: "done" });

  assert.equal(host.nodes[".qlent-line"].textContent, "row · 12 min");
  assert.equal(host.nodes[".qlent-badge"].innerHTML, "");
  assert.match(host.nodes[".qlent-art"].outerHTML, /data-art-text="rowing on a rowing machine"/);
  assert.equal(host.classList.contains("qlent-done"), true);
});
