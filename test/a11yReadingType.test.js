// Reading text in the stylesheets stays at least 11px (12px where it is a sentence
// or a tooltip). Axis ticks and tiny glyphs stay small on purpose.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function css(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function fontSize(source, selector) {
  const at = source.indexOf(selector);
  assert.ok(at >= 0, selector);
  const rule = source.slice(at, source.indexOf("}", at));
  const m = /font-size:\s*([\d.]+)px/.exec(rule);
  assert.ok(m, `${selector} declares a px font-size`);
  return Number(m[1]);
}

test("reading text is at least 11px, and body-like lines at least 12px", () => {
  const you = css("../src/styles/you/cairn.css");
  const stand = css("../src/styles/health/stand.css");
  const packet = css("../src/styles/health/packet.css");
  const horizon = css("../src/styles/horizon/horizon.css");
  assert.ok(fontSize(you, ".stack-pile-name{") >= 11);
  assert.ok(fontSize(stand, ".zonebar-optimal{") >= 11);
  assert.ok(fontSize(stand, ".hchart-txt{") >= 11);
  assert.ok(fontSize(stand, ".hchart-tip text{") >= 12);
  assert.ok(fontSize(packet, ".packet-paper .packet-pv-title{") >= 11);
  assert.ok(fontSize(packet, ".packet-paper .packet-row-meta{") >= 11);
  assert.ok(fontSize(packet, ".packet-paper .packet-flag,.packet-paper .packet-opt{") >= 11);
  assert.ok(fontSize(packet, ".packet-paper .packet-more,.packet-paper .packet-empty-line{") >= 12);
  assert.ok(fontSize(horizon, ".hz-chart text{") >= 11);
});

test("axis ticks and decorative glyphs stay below the reading floor", () => {
  const train = css("../src/styles/train/progress.css");
  const horizon = css("../src/styles/horizon/horizon.css");
  const you = css("../src/styles/you/cairn.css");
  assert.equal(fontSize(train, ".gpace-ylbl,.gpace-xlbl{"), 8.5);
  assert.equal(fontSize(horizon, ".hz-chart .hz-axis{"), 8.5);
  assert.equal(fontSize(horizon, ".hz-chart .hz-stage-word{"), 6.8);
  assert.equal(fontSize(you, ".stack-pile-flag{"), 7);
});
