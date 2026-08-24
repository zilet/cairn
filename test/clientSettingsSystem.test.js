import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const screen = readFileSync(join(root, "src/client/settings-screen.ts"), "utf8");
const saveBar = readFileSync(join(root, "src/client/save-bar.ts"), "utf8");

test("System health is lazy, explicitly windowed, and isolated from Settings edits", () => {
  assert.match(screen, /api\("\/agent-stats\?recent=12&days=7"\)/);
  assert.doesNotMatch(screen.match(/async function fetchSettingsBundle[\s\S]*?\n}/)?.[0] || "", /\/diagnostics/);
  assert.match(screen, /api\(`\/diagnostics\?recent=100&days=\$\{days}`/);
  assert.match(screen, /api\("\/ready", \{ cache: "no-store", acceptErrorBody: true \}\)/);
  assert.match(screen, /readinessStatus: "idle"/);
  assert.match(screen, /typeof readiness\.ok === "boolean"/);
  const renderer = readFileSync(join(root, "src/client/settings-client.ts"), "utf8");
  assert.match(renderer, /currentBuild\.scope === "current_build"/);
  assert.match(renderer, /const pulse = hasCurrentBuild \? currentBuild : row/);
  assert.match(screen, /status: "idle"/);
  assert.match(screen, /status = "unavailable"/);
  assert.match(screen, /system: renderSystemSlice/);

  const start = screen.indexOf("function renderSystemSlice");
  const end = screen.indexOf("function renderYouSlice", start);
  const systemSlice = screen.slice(start, end);
  assert.match(systemSlice, /data-diag-days/);
  assert.match(systemSlice, /#sysDiagSource/);
  assert.match(systemSlice, /#sysDiagSeverity/);
  assert.match(systemSlice, /data-diag-page/);
  assert.match(systemSlice, /data-copy-request/);
  assert.match(systemSlice, /readinessStatus/);
  assert.doesNotMatch(systemSlice, /markDirty|persistSettings|savebar/, "diagnostic exploration never opens the Settings save bar");
  assert.match(saveBar, /closest\("\[data-save-ignore\]"\)/, "shared save tracking ignores explicitly non-editing controls");

  // The System tab is entirely operator diagnostics — it collapses behind ONE
  // "Under the hood" fold, closed by default, whose open/closed state survives a
  // day/source/severity re-render (tracked in diagnosticsState.foldOpen).
  assert.match(systemSlice, /<details class="route-card"\$\{diagnosticsState\.foldOpen \? " open" : ""\}>/);
  assert.match(systemSlice, /Under the hood/);
  assert.match(systemSlice, /diagnosticsState\.foldOpen = \(event\.currentTarget as HTMLDetailsElement\)\.open;/);
});
