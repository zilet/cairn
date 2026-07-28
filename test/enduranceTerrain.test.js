import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";
import {
  canonicalEnduranceSport,
  classifyEnduranceActivity,
  classifyEnduranceSport,
  configuredEnduranceSportKeys,
} from "../dist/repo/endurance-sports.js";
import {
  isLoadRelevantEnduranceImpact,
  recentEnduranceImpacts,
} from "../dist/repo/hybrid-load.js";

const AS_OF = "2026-07-28";

function setCapacity(sport, target = 120) {
  repo.setProfile({
    training_intent: {
      priorities: ["longevity", "muscle", "endurance"],
      endurance_role: "supporting",
      endurance_capacity: {
        sport,
        target_duration_min: target,
      },
    },
  });
}

beforeEach(() => {
  resetTables("garmin_activities", "garmin_sources", "activities", "profile");
});

test("legacy families stay stable while cycling and ski modes become first-class", () => {
  assert.equal(canonicalEnduranceSport("mountain_biking").key, "ride");
  assert.equal(canonicalEnduranceSport("nordic_skiing").key, "ski");
  assert.deepEqual(configuredEnduranceSportKeys("running, MTB, skiing"), ["run", "ride", "ski"]);

  assert.equal(classifyEnduranceSport("cross-country MTB").mode, "ride-trail-mtb");
  assert.equal(classifyEnduranceSport("lift-served downhill MTB").mode, "ride-downhill-mtb");
  assert.equal(classifyEnduranceSport("road cycling").mode, "ride-road");
  assert.equal(classifyEnduranceSport("gravel riding").mode, "ride-gravel");
  assert.equal(classifyEnduranceSport("cycling").mode, "ride");

  assert.equal(classifyEnduranceSport("downhill alpine skiing").mode, "ski-alpine");
  assert.equal(classifyEnduranceSport("Nordic cross-country skiing").mode, "ski-nordic");
  assert.equal(classifyEnduranceSport("backcountry ski touring").mode, "ski-touring");
  assert.equal(classifyEnduranceSport("skiing").mode, "ski");
});

test("structured family stays authoritative while generic Garmin ride text can recover MTB mode", () => {
  assert.deepEqual(classifyEnduranceActivity("ride", "Fells mountain biking after yesterday's run"), {
    family: "ride",
    mode: "ride-trail-mtb",
    label: "Trail mountain biking",
    paced: false,
    specificity: "mode",
  });
  assert.equal(
    classifyEnduranceActivity("ride", "legs tired after yesterday's trail run").mode,
    "ride",
    "incidental trail-running prose does not invent an MTB subtype",
  );
  assert.equal(
    classifyEnduranceActivity("run", "recovery after a mountain bike ride").family,
    "run",
    "supporting prose cannot recategorize the structured family",
  );
  assert.equal(
    classifyEnduranceActivity("mountain_biking", "lift-served downhill MTB").mode,
    "ride-downhill-mtb",
    "a broad MTB provider type can be refined by explicit gravity-riding detail",
  );
  assert.equal(
    classifyEnduranceActivity("road_cycling", "a long downhill after the climb").mode,
    "ride-road",
    "a road descent is not silently recategorized as downhill MTB",
  );
  assert.equal(classifyEnduranceActivity("ride", "Fells ride").mode, "ride-trail-mtb");
  assert.equal(classifyEnduranceActivity("ride", "riding in the Fells").mode, "ride-trail-mtb");
  assert.equal(
    classifyEnduranceActivity("hike", "walking in the Fells").mode,
    "walk",
    "the bounded ride alias does not recategorize Fells hiking",
  );
  assert.equal(
    classifyEnduranceActivity("run", "recovery run after a Fells ride").mode,
    "run",
    "incidental Fells-ride history cannot override a structured run",
  );
});

test("a structured Fells ride is trail-MTB capability evidence", () => {
  setCapacity("trail MTB");
  repo.addActivity({
    date: "2026-07-20",
    type: "ride",
    text: "Fells ride",
    duration_min: 125,
  });
  const read = repo.getEnduranceCapacity(repo.getTrainingIntent(), { asOf: AS_OF });
  assert.equal(read.status, "ready");
  assert.equal(read.evidence_specificity, "mode");
});

test("trail-MTB capacity rejects road, generic and downhill-only rides as proof", () => {
  setCapacity("trail MTB");
  repo.addActivity({ date: "2026-07-20", type: "road_cycling", duration_min: 150 });
  repo.addActivity({ date: "2026-07-21", type: "ride", duration_min: 140 });
  repo.addActivity({
    date: "2026-07-22",
    type: "mountain_biking",
    text: "Lift-served downhill MTB bike park",
    duration_min: 180,
  });

  const read = repo.getEnduranceCapacity(repo.getTrainingIntent(), { asOf: AS_OF });
  assert.equal(read.status, "no_data");
  assert.equal(read.evidence, null);
  assert.equal(read.evidence_specificity, "insufficient");
  assert.match(read.summary, /same sport family|specifically enough/i);
});

test("Garmin generic ride plus MTB text is mode-specific evidence with terrain support", () => {
  setCapacity("trail MTB");
  repo.upsertGarminActivity({
    external_id: "fells-trail-1",
    date: "2026-07-20",
    type: "mountain_biking",
    name: "Fells Mountain Biking",
    duration_min: 125,
    distance_km: 23,
    ascent_m: 640,
    elevation_loss_m: 630,
  });

  const read = repo.getEnduranceCapacity(repo.getTrainingIntent(), { asOf: AS_OF });
  assert.equal(read.status, "ready");
  assert.equal(read.evidence_specificity, "mode");
  assert.deepEqual(read.evidence, {
    date: "2026-07-20",
    duration_min: 125,
    ascent_m: 640,
    elevation_loss_m: 630,
  });
  assert.match(read.summary, /climbing and descending/i);
});

test("generic cycling capacity continues to accept every cycling subtype", () => {
  setCapacity("cycling");
  repo.addActivity({
    date: "2026-07-20",
    type: "downhill_mountain_biking",
    duration_min: 130,
  });
  const read = repo.getEnduranceCapacity(repo.getTrainingIntent(), { asOf: AS_OF });
  assert.equal(read.status, "ready");
  assert.equal(read.evidence_specificity, "family");
});

test("recent trail MTB load includes climbing legs and technical upper-body demand", () => {
  repo.upsertGarminActivity({
    external_id: "trail-impact-1",
    date: AS_OF,
    type: "mountain_biking",
    name: "Trail MTB",
    duration_min: 90,
    distance_km: 19,
    ascent_m: 720,
    elevation_loss_m: 705,
  });
  const impact = recentEnduranceImpacts(2, AS_OF)[0];
  assert.equal(impact.label, "trail MTB");
  assert.equal(impact.load_character, "mixed-terrain");
  assert.equal(impact.aerobic_volume, "mixed");
  assert.ok(impact.regions.includes("quads"));
  assert.ok(impact.regions.includes("core"));
  assert.ok(impact.regions.includes("back"));
  assert.ok(impact.regions.includes("forearms"));
  assert.match(impact.why, /climbing|technical descending|grip/i);
});

test("short lift-served downhill MTB is technical exposure, not generic aerobic volume", () => {
  repo.addActivity({
    date: AS_OF,
    type: "ride",
    text: "Lift-served downhill MTB bike park",
    duration_min: 60,
    distance_km: 8,
  });
  const impact = recentEnduranceImpacts(2, AS_OF)[0];
  assert.equal(impact.label, "downhill MTB");
  assert.equal(impact.load_character, "technical-eccentric");
  assert.equal(impact.aerobic_volume, "limited");
  assert.equal(impact.load, "light");
  assert.equal(isLoadRelevantEnduranceImpact(impact), false);
  assert.match(impact.why, /not equivalent aerobic cycling volume/i);
});

test("ski modalities carry distinct conservative recent-load traits", () => {
  repo.addActivity({ date: AS_OF, type: "alpine_skiing", duration_min: 130 });
  repo.addActivity({ date: AS_OF, type: "cross_country_skiing", duration_min: 70 });
  repo.addActivity({ date: AS_OF, type: "backcountry_ski_touring", duration_min: 80 });

  const impacts = recentEnduranceImpacts(2, AS_OF);
  const alpine = impacts.find((impact) => impact.label === "alpine ski");
  const nordic = impacts.find((impact) => impact.label === "Nordic ski");
  const touring = impacts.find((impact) => impact.label === "ski touring");

  assert.equal(alpine.load_character, "eccentric");
  assert.equal(alpine.aerobic_volume, "limited");
  assert.match(alpine.why, /eccentric leg and core/i);

  assert.equal(nordic.load_character, "full-body-aerobic");
  assert.equal(nordic.aerobic_volume, "full");
  assert.ok(nordic.regions.includes("shoulders"));
  assert.match(nordic.why, /aerobic full-body/i);

  assert.equal(touring.load_character, "mixed-terrain");
  assert.equal(touring.aerobic_volume, "mixed");
  assert.match(touring.why, /climbs load the legs and core/i);
});
