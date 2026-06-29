import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadDateUtils() {
  const context = { Date, Intl, Number, String, Math, JSON, RegExp };
  vm.runInNewContext(readFileSync(join(root, "public/js/date-utils.js"), "utf8"), context);
  return context;
}

test("client date utilities stay pure and browser-global", () => {
  const utils = loadDateUtils();
  assert.equal(utils.localISO(new Date(2026, 5, 29)), "2026-06-29");
  assert.equal(
    utils.latestReviewDate({ markers: [{ date: "2026-01-02" }, { note: "reviewed 2026-06-11" }] }),
    "2026-06-11",
  );

  const cleaned = utils.humanizeReviewText(
    "LDL-C measured on 2026-06-11 stayed above the prior 2026-01-02 result.",
    "2026-06-11",
  );
  assert.doesNotMatch(cleaned, /2026-06-11/, "latest date is shown once by the caller, not repeated in prose");
  assert.doesNotMatch(cleaned, /2026-01-02/, "older ISO dates are humanized for display");
  assert.match(utils.absDate("2026-06-11"), /2026/);
});
