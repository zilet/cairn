// Empty states come from one primitive (CairnUi.emptyStateHtml): Progress's
// art-led empty state, the meal-plan history and the Health read's marker section
// all render it — what would fill the space and where it comes from, never "0".
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadClientModule, renderHtml } from "./_dom.mjs";

test("the primitive: a polite status with escaped copy and art sized by CSS, not an inline style", () => {
  const win = loadClientModule(["html-utils", "ui-components"]);
  const host = renderHtml(
    win.CairnUi.emptyStateHtml({ artHtml: `<svg class="art"></svg>`, title: "No <sets> yet", body: "Log one <today>" }),
    {
      document: win.document,
    }
  );
  const empty = host.querySelector(".empty-state");
  assert.equal(empty.getAttribute("role"), "status");
  assert.equal(empty.getAttribute("aria-live"), "polite");
  assert.equal(empty.querySelector(".empty-state-line").textContent, "No <sets> yet");
  assert.equal(empty.querySelector(".hpic-hero-sub").textContent, "Log one <today>");
  const art = empty.querySelector(".artile.artile-lg");
  assert.ok(art.querySelector("svg.art"), "trusted art is kept as markup");
  assert.equal(art.getAttribute("style"), null);
});

test("Progress's empty state is the shared primitive", () => {
  const win = loadClientModule(["html-utils", "ui-components", "ui-chart", "progress-components-client"], {
    globals: { art: () => `<svg class="fallback"></svg>`, stagger: (i) => `--i:${i}` },
  });
  const host = renderHtml(win.emptyStateHtml(null, "No sessions logged yet"), { document: win.document });
  const empty = host.querySelector(".empty-state.reveal");
  assert.equal(empty.getAttribute("role"), "status");
  assert.equal(empty.style.getPropertyValue("--i"), "1");
  assert.ok(empty.querySelector(".artile svg.fallback"));
  assert.equal(empty.querySelector(".empty-state-line").textContent, "No sessions logged yet");
});

test("the meal-plan history and the Health read's markers render the primitive when empty", () => {
  const meals = loadClientModule(
    ["html-utils", "ui-components", "decision-undo-client", "meal-row-client", "meal-plan-upcoming-client", "meal-plan-client"],
    {
      globals: { stagger: (i) => `--i:${i}`, art: () => "", artImg: () => "" },
    }
  );
  const list = renderHtml(meals.CairnMealPlan.mealPlanListHtml([]), { document: meals.document });
  assert.equal(list.querySelector(".empty-state .empty-state-line").textContent, "No meal plans yet");

  const health = loadClientModule(
    [
      "date-utils",
      "ui-format",
      "html-utils",
      "ui-components",
      "ui-chart",
      "health-evidence-client",
      "health-marker-order-client",
      "health-client",
      "health-read-client",
    ],
    { globals: { stagger: (i) => `--i:${i}`, fmtK: String } }
  );
  const section = renderHtml(health.CairnHealthRead.priorityMarkersSectionHtml([]), { document: health.document });
  assert.equal(section.querySelector(".hb-section .empty-state .empty-state-line").textContent, "No markers yet");
});
