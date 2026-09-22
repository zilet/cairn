// Stated movement considerations (`movement_considerations` on profile, v107): a
// lasting, PAINLESS condition the athlete states — "mild scoliosis" — shapes how a plan
// is built and never becomes an injury gate.
//
// Before this, the only structured home for that sentence was an `injury` context
// event, which hard-excludes squats, rows and hinges every day with no end. These pin:
// the parser/setter contract, that a consideration never reaches the protective
// machinery, that it reaches every plan-shaping prompt (with the supportive block only
// when the athlete asked for it addressed), and the chat + onboarding write paths.
// Synthetic persona only.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { db, repo } from "./_seed.js";
import { seed } from "../dist/seed.js";
import { MIGRATIONS } from "../dist/migrate.js";
import {
  MOVEMENT_CONSIDERATIONS_MAX_ITEMS,
  movementConsiderationsRead,
  parseMovementConsiderations,
  serializeMovementConsiderations,
} from "../dist/repo/movement-considerations.js";
import { decideDailySession } from "../dist/repo/daily-decision.js";
import { dayPlanningSignalState } from "../dist/repo/day-read.js";
import { localDateISO } from "../dist/repo/shared.js";
import { applyChatActions } from "../dist/chatTurns.js";
import { normalizeChatAction } from "../dist/chatActions.js";
import {
  buildChatPrompt,
  buildCoachPrompt,
  buildDailyCompositionPrompt,
  buildProgramEvolutionPrompt,
  buildSessionPrompt,
  buildWeekComposePrompt,
} from "../dist/prompt.js";
import { renderMovementConsiderations } from "../dist/prompt/shared.js";
import { PROMPT_CONTEXT_SITES } from "../dist/prompt/context-projection.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const SCOLIOSIS = {
  items: [{ label: "Mild scoliosis", detail: "right thoracic curve, no pain", wants_addressed: true }],
};

beforeEach(() => {
  seed(); // a real plan with squats, rows and hinges — the lifts an injury would take away
});

// ---------------------------------------------------------------------------
// the column + the contract
// ---------------------------------------------------------------------------

test("v107 adds movement_considerations_json, and a fresh database already has it", () => {
  const v107 = MIGRATIONS.find((m) => m.version === 107);
  assert.ok(v107, "migration v107 must exist");
  assert.equal(v107.name, "profile-movement-considerations");
  const columns = db.prepare(`PRAGMA table_info(profile)`).all();
  assert.ok(columns.find((c) => c.name === "movement_considerations_json"));
});

test("parse trims, folds newlines, caps and de-duplicates; an empty list is a clear, junk is rejected", () => {
  const long = "x".repeat(500);
  const parsed = parseMovementConsiderations(
    {
      items: [
        { label: "  Mild\nscoliosis ", detail: long, wants_addressed: "true" },
        { label: "mild scoliosis", wants_addressed: false },
        { label: "   " },
        ...Array.from({ length: 10 }, (_, i) => ({ label: `Condition ${i}` })),
      ],
    },
    { source: "chat", today: "2026-09-01" }
  );
  assert.equal(parsed.items.length, MOVEMENT_CONSIDERATIONS_MAX_ITEMS);
  assert.equal(parsed.items[0].label, "Mild scoliosis", "one line, trimmed");
  assert.equal(parsed.items[0].detail.length, 400, "detail capped");
  assert.equal(parsed.items[0].wants_addressed, true);
  assert.equal(parsed.items[0].source, "chat");
  assert.equal(parsed.items[0].stated_on, "2026-09-01");
  assert.ok(
    !parsed.items.some((item, i) => i > 0 && item.label.toLowerCase() === "mild scoliosis"),
    "a case-only duplicate is kept once"
  );
  assert.equal(parseMovementConsiderations({ items: [{ label: "x".repeat(200) }] }).items[0].label.length, 80);

  assert.deepEqual(parseMovementConsiderations({ items: [] }), { items: [] });
  assert.equal(parseMovementConsiderations({ items: [{ label: "" }] }), null);
  assert.equal(parseMovementConsiderations("not json"), null);
  assert.equal(serializeMovementConsiderations(null), null);
  assert.equal(serializeMovementConsiderations({ items: [] }), null);
  assert.equal(serializeMovementConsiderations({ nope: true }), undefined);
});

test("setProfile stores, keeps on a malformed write, keeps the first-said day, and null clears", () => {
  repo.setProfile({ movement_considerations: SCOLIOSIS });
  const first = movementConsiderationsRead();
  assert.equal(first.items[0].label, "Mild scoliosis");
  assert.equal(first.items[0].source, "athlete");

  repo.setProfile({ movement_considerations: { garbage: 1 } });
  assert.deepEqual(movementConsiderationsRead(), first, "an unreadable write never erases what they said");

  repo.setProfile({ about_me: "unrelated edit" });
  assert.deepEqual(movementConsiderationsRead(), first, "omitting the field leaves it intact");

  db.prepare("UPDATE profile SET movement_considerations_json = ? WHERE id = 1").run(
    JSON.stringify({ items: [{ ...first.items[0], stated_on: "2026-01-02" }] })
  );
  repo.setProfile({
    movement_considerations: { items: [...SCOLIOSIS.items, { label: "Hypermobile elbows", wants_addressed: false }] },
  });
  const restated = movementConsiderationsRead();
  assert.equal(restated.items.length, 2);
  assert.equal(restated.items[0].stated_on, "2026-01-02", "re-sending the full list does not re-date an old item");
  assert.equal(restated.items[1].stated_on, localDateISO());

  repo.setProfile({ movement_considerations: null });
  assert.equal(movementConsiderationsRead(), null);
  assert.equal(repo.getProfile().movement_considerations_json, null);
});

// ---------------------------------------------------------------------------
// never a gate
// ---------------------------------------------------------------------------

test("a consideration never produces an injury exclusion, excluded groups, or a modify posture", () => {
  repo.setProfile({ movement_considerations: SCOLIOSIS });
  const date = localDateISO();
  const { envelope } = decideDailySession(date);
  assert.ok(!envelope.hard_constraints.some((c) => c.code === "injury_exclusion"), "no injury exclusion");
  assert.deepEqual(envelope.muscles.excluded, [], "no excluded groups");
  assert.ok(!envelope.candidates.some((c) => c.action === "exclude"), "no lift taken away");
  const state = dayPlanningSignalState(date);
  assert.notEqual(state.dimensions.health_constraints.status, "constrained");
  assert.notEqual(state.action.directives.training, "modify");
  assert.equal(repo.getInjuryImpacts().count, 0);
});

test("control: the same sentence filed as an injury DOES gate — the reason this fact is separate", () => {
  repo.addContextEvent({
    kind: "injury",
    title: "Mild scoliosis (right thoracic curve)",
    meta: { area: "spine", severity: "mild" },
  });
  const { envelope } = decideDailySession(localDateISO());
  assert.ok(envelope.hard_constraints.some((c) => c.code === "injury_exclusion"));
  assert.ok(repo.getInjuryImpacts().count > 0);
});

// ---------------------------------------------------------------------------
// the prompts
// ---------------------------------------------------------------------------

const SITES = [
  ["coach", () => buildCoachPrompt()],
  ["program_evolution", () => buildProgramEvolutionPrompt()],
  ["week_compose", () => buildWeekComposePrompt()],
  ["session", () => buildSessionPrompt(undefined, { minutes: 45 })],
  [
    "daily_composition",
    () =>
      buildDailyCompositionPrompt({
        kind: "train",
        template: { focus: "lower" },
        muscles: { allowed: ["quads"], required: ["quads"], reduced: [], excluded: [] },
        caps: { volume: "normal", intensity: "normal", duration_min: 45 },
        candidates: [],
      }),
  ],
  ["chat", () => buildChatPrompt([], "what should I train this week?")],
];

test("every plan-shaping prompt carries the block and the DATA key when set, and is quiet when unset", () => {
  for (const [site, build] of SITES) {
    assert.ok(PROMPT_CONTEXT_SITES[site].keys.includes("movement_considerations"), `${site} projects the key`);
    assert.doesNotMatch(build(), /STATED MOVEMENT CONSIDERATIONS \(/, `${site} is quiet with nothing stated`);
  }
  repo.setProfile({ movement_considerations: SCOLIOSIS });
  for (const [site, build] of SITES) {
    const prompt = build();
    assert.match(prompt, /STATED MOVEMENT CONSIDERATIONS \(/, `${site} renders the block`);
    assert.match(prompt, /- Mild scoliosis: right thoracic curve, no pain/, `${site} carries their words`);
    assert.match(prompt, /never exclude the main lifts/, `${site} says it is not a gate`);
    assert.match(prompt, /"movement_considerations":\{"items":\[\{"label":"Mild scoliosis"/, `${site} DATA carries it`);
    assert.match(prompt, /STATED CONDITIONS:/, `${site} guardrails name it`);
  }
});

test("the supportive block rides only when they want it addressed; generic per-condition, not a fixed list, physio line always", () => {
  const block = (wants) =>
    renderMovementConsiderations({
      movement_considerations: { items: [{ label: "Mild scoliosis", wants_addressed: wants }] },
    });
  const addressed = block(true);
  assert.match(addressed, /\[they want the program to help with this\]/);
  // Generic: named ONLY as one example, keyed to a lateral curve, never as the fixed
  // prescription for any condition.
  assert.match(addressed, /appropriate to the STATED CONDITION/);
  assert.match(addressed, /e\.g\. for a lateral spinal curve:/);
  assert.match(addressed, /a different condition calls for its own choices/);
  assert.match(addressed, /prep, not working volume/);
  const informs = block(false);
  assert.doesNotMatch(informs, /appropriate to the STATED CONDITION/);
  assert.doesNotMatch(informs, /e\.g\. for a lateral spinal curve/);
  assert.match(informs, /only informs balance/);
  for (const text of [addressed, informs]) {
    assert.match(text, /BALANCED program/);
    assert.match(text, /physiotherapist can tailor this/);
    assert.match(text, /not medical advice/);
    assert.doesNotMatch(text, /schroth/i);
    assert.match(text, /PAIN, that is an injury/);
  }
  // A DIFFERENT stated condition still gets the same generic, condition-appropriate
  // framing rather than the lateral-curve example's specific movements being forced on it.
  const otherAddressed = renderMovementConsiderations({
    movement_considerations: { items: [{ label: "Hypermobile elbows", wants_addressed: true }] },
  });
  assert.match(otherAddressed, /appropriate to the STATED CONDITION/);
  assert.match(otherAddressed, /a different condition calls for its own choices/);

  assert.equal(renderMovementConsiderations({}), "");
  assert.equal(renderMovementConsiderations({ movement_considerations: null }), "");
});

// ---------------------------------------------------------------------------
// the write paths
// ---------------------------------------------------------------------------

test("chat: the validator accepts a list, rejects junk, and applying it writes the profile", () => {
  const ok = normalizeChatAction({ type: "set_movement_considerations", items: SCOLIOSIS.items });
  assert.equal(ok.type, "set_movement_considerations");
  assert.equal(ok.items[0].source, "chat");
  assert.equal(normalizeChatAction({ type: "set_movement_considerations", items: [{ label: "" }] }), null);
  assert.equal(normalizeChatAction({ type: "set_movement_considerations", note: "my back" }), null);
  assert.deepEqual(normalizeChatAction({ type: "set_movement_considerations", items: [] }).items, [], "[] is a clear");

  const written = applyChatActions(
    { actions: [{ type: "set_movement_considerations", items: SCOLIOSIS.items }] },
    { agent: "stub", message: "I have mild scoliosis, it doesn't hurt, but I'd like the program to help with it" }
  );
  assert.equal(written.applied[0]?.type, "set_movement_considerations");
  assert.equal(written.applied[0]?.error, undefined);
  const stored = movementConsiderationsRead();
  assert.equal(stored.items[0].label, "Mild scoliosis");
  assert.equal(stored.items[0].wants_addressed, true);
  assert.equal(stored.items[0].source, "chat");
  assert.equal(repo.listContextEvents().length, 0, "no injury event was written");

  applyChatActions(
    { actions: [{ type: "set_movement_considerations", items: [] }] },
    { agent: "stub", message: "forget that" }
  );
  assert.equal(movementConsiderationsRead(), null);
});

test("onboarding: a stated painless condition lands on the profile, never as a context event", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-onboard-consider-"));
  try {
    const configPath = path.join(dataDir, "agents.json");
    // A canned onboarding reply. The built-in `stub` replies with a plan `changes`
    // payload, which carries no onboarding fields at all.
    const reply = JSON.stringify({
      about_me: "Recreational lifter with mild scoliosis who wants a balanced program.",
      profile: { age: 34 },
      memories: [],
      context_events: [],
      movement_considerations: [{ label: "Mild scoliosis", detail: "no pain", wants_addressed: true }],
    });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        "onboard-stub": { command: "sh", args: ["-c", `printf '%s' '${reply}'`], input: "arg", env_required: [] },
      })
    );
    const url = (file) => JSON.stringify(pathToFileURL(path.join(root, "dist", file)).href);
    const runner = [
      `import * as repo from ${url("repo.js")};`,
      `import { onboardFromText } from ${url("coachOps.js")};`,
      `const out = await onboardFromText("onboard-stub", "I'm 34, I lift, and I have mild scoliosis — it doesn't hurt but I'd like my training to help with it.");`,
      `process.stdout.write("@@RESULT@@" + JSON.stringify({ applied: out.applied, read: repo.movementConsiderationsRead(), events: repo.listContextEvents().length }));`,
    ].join("\n");
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", runner], {
      cwd: root,
      env: { ...process.env, AGENTS_CONFIG: configPath, DATA_DIR: dataDir, DB_PATH: path.join(dataDir, "cairn.db") },
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout.slice(res.stdout.lastIndexOf("@@RESULT@@") + "@@RESULT@@".length));
    assert.equal(out.applied.movement_considerations, 1);
    assert.equal(out.read.items[0].label, "Mild scoliosis");
    assert.equal(out.read.items[0].source, "onboard");
    assert.equal(out.read.items[0].wants_addressed, true);
    assert.equal(out.events, 0, "no context event");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
