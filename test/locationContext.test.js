import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { db, repo, resetTables } from "./_seed.js";
import { localDateISO } from "../dist/repo/shared.js";
import { projectCoachContext, PROMPT_CONTEXT_SITES } from "../dist/prompt/context-projection.js";
import { renderDiscipline } from "../dist/prompt/shared.js";
import { buildDayReadPrompt, buildDailyCompositionPrompt, buildSessionPrompt, buildSessionVerifyPrompt } from "../dist/prompt.js";
import { registerPersonTools } from "../dist/surfaces/mcp/person.js";
import { flushBrainEventsForTest } from "../dist/brainEvents.js";

function dayOffset(days) {
  return localDateISO(new Date(Date.now() + days * 864e5));
}

function personTools() {
  const tools = new Map();
  registerPersonTools({
    tool(name, description, schema, handler) {
      tools.set(name, { description, schema, handler });
    },
  });
  return tools;
}

beforeEach(() => {
  resetTables("profile", "context_events", "brain_events");
});

test("home location normalizes, caps, persists, and clears explicitly", () => {
  const saved = repo.setProfile({ home_location: "  New   York, NY  " });
  assert.equal(saved.home_location, "New York, NY");
  assert.deepEqual(repo.getLocationContext({ on: "2026-08-10" }), {
    home: "New York, NY",
    effective: "New York, NY",
    source: "home",
    trip_id: null,
    trip_title: null,
    weather_available: false,
    planning_role: "context_only",
  });

  repo.setProfile({ home_location: ` ${"x".repeat(200)} ` });
  assert.equal(repo.getProfile().home_location.length, 160);

  repo.setProfile({ home_location: "" });
  assert.equal(repo.getProfile().home_location, null);
  assert.equal(repo.getLocationContext({ on: "2026-08-10" }).source, "unknown");
});

test("changing home location emits a material profile identity event", () => {
  repo.setProfile({ home_location: "Boston, MA" });
  const event = flushBrainEventsForTest().find(
    (candidate) => candidate.kind === "profile_changed" && candidate.subject_key === "profile:identity"
  );
  assert.ok(event);
  assert.equal(event.material, true);
  assert.match(event.reason, /home_location/);
});

test("only an active trip with meta.location overrides home", () => {
  repo.setProfile({ home_location: "Boston, MA" });
  repo.addContextEvent({
    kind: "trip",
    title: "Past trip",
    start_date: "2026-06-01",
    end_date: "2026-06-10",
    meta: { location: "Lisbon" },
  });
  repo.addContextEvent({
    kind: "trip",
    title: "Upcoming trip",
    start_date: "2026-09-01",
    end_date: "2026-09-10",
    meta: { location: "Tokyo" },
  });
  repo.addContextEvent({
    kind: "trip",
    title: "Archived active trip",
    start_date: "2026-08-01",
    end_date: "2026-08-20",
    archived: true,
    meta: { location: "Chicago" },
  });
  repo.addContextEvent({
    kind: "trip",
    title: "Resolved active trip",
    start_date: "2026-08-01",
    end_date: "2026-08-20",
    resolved_at: "2026-08-05",
    meta: { location: "Portland" },
  });
  const active = repo.addContextEvent({
    kind: "trip",
    title: "Fells riding week",
    start_date: "2026-08-01",
    end_date: "2026-08-20",
    meta: { location: "Middlesex Fells, MA" },
  });

  assert.deepEqual(repo.getLocationContext({ on: "2026-08-10" }), {
    home: "Boston, MA",
    effective: "Middlesex Fells, MA",
    source: "trip",
    trip_id: active.id,
    trip_title: "Fells riding week",
    weather_available: false,
    planning_role: "context_only",
  });
  assert.equal(repo.getLocationContext({ on: "2026-05-01" }).effective, "Boston, MA");
  assert.equal(repo.getLocationContext({ on: "2026-10-01" }).effective, "Boston, MA");
  assert.equal(repo.listContextEvents().length, 5, "past and upcoming trips remain durable context events");
});

test("coach context and every person-aware prompt receive the compact location block", () => {
  repo.setProfile({ home_location: "Boston, MA" });
  const trip = repo.addContextEvent({
    kind: "trip",
    title: "Active trip",
    start_date: dayOffset(-1),
    end_date: dayOffset(1),
    meta: { location: "Burlington, VT" },
  });

  const ctx = repo.getCoachContext();
  assert.deepEqual(ctx.location, {
    home: "Boston, MA",
    effective: "Burlington, VT",
    source: "trip",
    trip_id: trip.id,
    trip_title: "Active trip",
    weather_available: false,
    planning_role: "context_only",
  });

  for (const [site, config] of Object.entries(PROMPT_CONTEXT_SITES)) {
    assert.ok(config.keys.includes("location"), `${site} keeps location planning context`);
    assert.deepEqual(projectCoachContext(ctx, site).location, ctx.location);
  }
});

test("MCP set_profile explicitly accepts bounded home_location and empty clears it", async () => {
  const tool = personTools().get("set_profile");
  assert.ok(tool);
  assert.match(tool.description, /home_location.*durable home base/i);
  assert.equal(tool.schema.home_location.safeParse("Boston, MA").success, true);
  assert.equal(tool.schema.home_location.safeParse("").success, true);
  assert.equal(tool.schema.home_location.safeParse("x".repeat(161)).success, false);

  const saved = JSON.parse((await tool.handler({ home_location: "Boston, MA" })).content[0].text);
  assert.equal(saved.home_location, "Boston, MA");
  const cleared = JSON.parse((await tool.handler({ home_location: "" })).content[0].text);
  assert.equal(cleared.home_location, null);
});

test("fresh schema and v81 migration expose home_location", () => {
  const columns = db
    .prepare(`PRAGMA table_info(profile)`)
    .all()
    .map((row) => row.name);
  assert.ok(columns.includes("home_location"));
  assert.equal(db.prepare(`PRAGMA user_version`).get().user_version, 81);
});

test("renderDiscipline emits PLACE from structured location without memory keywords", () => {
  const base = {
    profile: { age: 40 },
    discipline: { primary: "strength", endurance_sport: null },
    training_intent: {
      priorities: ["longevity", "muscle", "strength"],
      endurance_role: "none",
    },
    memory: [],
  };

  const homeOnly = renderDiscipline(
    {
      ...base,
      location: {
        home: "Boston, MA",
        effective: "Boston, MA",
        source: "home",
        trip_id: null,
        trip_title: null,
        weather_available: false,
        planning_role: "context_only",
      },
    },
    "training"
  );
  assert.match(homeOnly, /PLACE & WEATHER: effective place is Boston, MA \(home base\)/i);
  assert.match(homeOnly, /planning_role is context_only/i);
  assert.match(homeOnly, /never a constraint or training gate/i);
  assert.match(homeOnly, /Weather is unavailable/i);
  assert.match(homeOnly, /do not invent weather without a fresh weather source/i);
  assert.doesNotMatch(homeOnly, /Season facts in memory/i);

  const onTrip = renderDiscipline(
    {
      ...base,
      location: {
        home: "Boston, MA",
        effective: "Burlington, VT",
        source: "trip",
        trip_id: 7,
        trip_title: "Active trip",
        weather_available: false,
        planning_role: "context_only",
      },
    },
    "day"
  );
  assert.match(onTrip, /effective place is Burlington, VT \(active trip: Active trip\)/i);
  assert.doesNotMatch(onTrip, /effective place is Boston, MA/i);
  assert.match(onTrip, /planning_role is context_only/i);
  assert.match(onTrip, /Weather is unavailable/i);

  const tripNoTitle = renderDiscipline(
    {
      ...base,
      location: {
        home: null,
        effective: "Lisbon",
        source: "trip",
        trip_id: 3,
        trip_title: null,
        weather_available: false,
        planning_role: "context_only",
      },
    },
    "nutrition"
  );
  assert.match(tripNoTitle, /effective place is Lisbon \(active trip\)/i);

  const noLocation = renderDiscipline(base, "training");
  assert.doesNotMatch(noLocation, /PLACE & WEATHER/i);
});

test("coach context with home only still renders PLACE prose via renderDiscipline", () => {
  repo.setProfile({ home_location: "Cambridge, MA" });
  const ctx = repo.getCoachContext();
  assert.equal(ctx.location.effective, "Cambridge, MA");
  assert.equal(ctx.location.source, "home");
  const rendered = renderDiscipline(ctx, "training");
  assert.match(rendered, /PLACE & WEATHER: effective place is Cambridge, MA \(home base\)/i);
  assert.match(rendered, /planning_role is context_only/i);
  assert.match(rendered, /Weather is unavailable/i);
});

function promptData(prompt) {
  const marker = ["DATA:\n", "DATA (for the injury/constraint/equipment context):\n"].find((candidate) =>
    prompt.includes(candidate)
  );
  const start = marker ? prompt.lastIndexOf(marker) : -1;
  assert.ok(start >= 0, "prompt contains a DATA block");
  const verifyContract = "\n\nReturn ONE bare JSON object only";
  const end = prompt.indexOf(verifyContract, start);
  return JSON.parse(prompt.slice(start + marker.length, end === -1 ? undefined : end));
}

test("dated prompt builders use the requested date's effective location", () => {
  repo.setProfile({ home_location: "Boston, MA" });
  repo.addContextEvent({
    kind: "trip",
    title: "Montreal week",
    start_date: "2026-04-21",
    end_date: "2026-04-22",
    meta: { location: "Montreal, QC" },
  });

  const builders = [
    ["day read", (date) => buildDayReadPrompt(undefined, { date })],
    ["session", (date) => buildSessionPrompt(undefined, { date })],
    ["session verify", (date) => buildSessionVerifyPrompt({ name: "Lower body", items: [] }, { date })],
    [
      "daily composition",
      (date) =>
        buildDailyCompositionPrompt({
          date,
          kind: "train",
          template: { focus: "lower" },
          muscles: { allowed: ["quads"], required: ["quads"], reduced: [], excluded: [] },
          caps: { volume: "normal", intensity: "normal", duration_min: 45 },
          candidates: [{ exercise: "Back Squat", muscle_group: "quads", action: "progress" }],
        }),
    ],
  ];

  for (const [name, build] of builders) {
    const onTrip = build("2026-04-21");
    assert.equal(promptData(onTrip).location.effective, "Montreal, QC", `${name} DATA scopes to the trip`);
    assert.equal(promptData(onTrip).location.source, "trip", `${name} DATA keeps the trip source`);

    const homeAgain = build("2026-04-23");
    assert.equal(promptData(homeAgain).location.effective, "Boston, MA", `${name} DATA returns home after the trip`);
    assert.equal(promptData(homeAgain).location.source, "home", `${name} DATA keeps the home source`);
  }

  const onTrip = buildDayReadPrompt(undefined, { date: "2026-04-21" });
  assert.match(onTrip, /effective place is Montreal, QC \(active trip: Montreal week\)/i);
  const homeAgain = buildSessionPrompt(undefined, { date: "2026-04-23" });
  assert.match(homeAgain, /effective place is Boston, MA \(home base\)/i);
});
