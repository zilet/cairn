// A stale Settings screen must never silently end a dated push stance. The screen used to
// send its whole working model on every save — including the training_drive it LOADED
// with — so a screen opened before a chat push stance re-sent "steady" on an unrelated
// save, and setSettings read push → steady as the athlete's toggle and ended the stance.
// Three layers hold it now: the client sends training_drive only when the athlete moved
// the control (settings-screen.ts), a stance write drops the cached Settings screen
// (write-invalidation-client.ts), and the server never ends a stance for a write that
// equals the standing drive (settings.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { repo } from "./_seed.js";
import { addDaysISO } from "../dist/lib/dates.js";
import { localDateISO } from "../dist/repo/shared.js";
import { setTrainingDrive } from "../dist/domain/training/training-drive.js";
import { pushStanceActive } from "../dist/repo/training-drive.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const today = () => localDateISO();

test("the Settings save sends training_drive only when the athlete moved the control", () => {
  const screen = readFileSync(join(root, "src/client/settings-screen.ts"), "utf8");
  const persist = screen.slice(screen.indexOf("const persistSettings"), screen.indexOf("const settingsBar"));
  assert.ok(persist.length > 0, "persistSettings is where the body is built");
  assert.doesNotMatch(persist, /training_drive:\s*wm\.training_drive/, "never unconditionally in the body");
  assert.match(persist, /if \(wm\.training_drive !== loadedTrainingDrive\) body\.training_drive = wm\.training_drive;/);
  assert.match(screen, /const loadedTrainingDrive = wm\.training_drive;/);
  const types = readFileSync(join(root, "src/client/settings-screen-types.d.ts"), "utf8");
  assert.match(types, /training_drive\?: "steady" \| "push";/, "the persist body field is optional");
});

test("a stance write (chat or Undo) drops the cached Settings screen", () => {
  const context = { Object, Set, Map, Array, JSON, Number, String, Date, Promise, localStorage: null };
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/write-invalidation-client.js"), "utf8"), context);
  const api = context.CairnWriteInvalidation;
  assert.ok(api.targetsForChatAction("set_training_drive").includes("settings:screen"));
  assert.ok(api.targetsForChatAction("revert_decision").includes("settings:screen"));
  assert.ok(api.targetsForWrite("decision_revert").includes("settings:screen"));
});

test("server: a stale whole-model save that re-sends the standing drive keeps the stance", () => {
  setTrainingDrive({ drive: "push", until: addDaysISO(today(), 12), words: "push me" });
  // What an old Settings screen opened after the stance would send: everything, push included.
  repo.setSettings({ training_drive: "push", lead_mode: "lead", art_enabled: false, coach_day: 0, coach_hour: 7 });
  assert.equal(pushStanceActive(today()), true);
  // What the fixed screen sends on an unrelated save: no training_drive at all.
  repo.setSettings({ lead_mode: "announce_first" });
  assert.equal(pushStanceActive(today()), true);
  assert.equal(repo.getSettings().training_drive, "push");
});
