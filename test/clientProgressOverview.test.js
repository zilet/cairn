import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const overview = readFileSync(join(root, "src/client/progress-overview-client.ts"), "utf8");

test("the Train overview reads the server's acuteGate answer instead of re-deriving it", () => {
  assert.doesNotMatch(
    overview,
    /days_ago[\s\S]{0,40}<= 1[\s\S]{0,40}heavy|heavy[\s\S]{0,40}days_ago[\s\S]{0,40}<= 1/,
    "the retired days_ago<=1 && heavy heuristic must not return"
  );
  assert.match(overview, /l\?\.saturated/, "tone comes from the server-computed saturated flag");
});
