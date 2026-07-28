import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";
import { dayTrainingTruth } from "../dist/repo/brain/read-adherence.js";

const REF = "2026-07-28";
const back = (days) => new Date(new Date(`${REF}T00:00:00Z`).getTime() - days * 864e5).toISOString().slice(0, 10);

function explicitIntent(endurance_role) {
  return {
    priorities: ["longevity", "muscle", "strength", "leanness", "endurance"],
    endurance_role,
    endurance_capacity:
      endurance_role === "none"
        ? null
        : {
            sport: "running",
            target_duration_min: 90,
            context: "supporting aerobic capability",
          },
  };
}

test("explicit supporting endurance remains visible across deterministic reads on a strength-labelled profile", () => {
  repo.setProfile({
    primary_discipline: "strength",
    endurance_sport: "running",
    age: 44,
    training_intent: explicitIntent("supporting"),
  });
  for (const days of [22, 15, 8, 1]) {
    repo.addActivity({
      type: "run",
      duration_min: 35,
      distance_km: 5,
      date: back(days),
    });
  }

  const program = repo.getProgramState(REF);
  assert.ok(program.endurance, "supporting endurance is part of the deterministic program read");
  assert.ok(program.hybrid, "strength plus supporting endurance produces the combined load read");

  const brief = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.ok(brief.signals.endurance_volume, "the Brief counts configured supporting endurance");

  const truth = dayTrainingTruth(back(1));
  assert.equal(truth.trained, true);
  assert.notEqual(truth.load, "none", "a real supporting run is training, even when legacy discipline says strength");
});

test("explicit no-endurance suppresses deterministic endurance reads on a legacy hybrid profile", () => {
  repo.setProfile({
    primary_discipline: "hybrid",
    endurance_sport: "running",
    training_intent: explicitIntent("none"),
  });
  repo.addActivity({
    type: "run",
    duration_min: 40,
    distance_km: 6,
    date: back(1),
  });

  const program = repo.getProgramState(REF);
  assert.equal(program.endurance, null);
  assert.equal(repo.dayRead(REF, { has_data: false, recovery: {} }).signals.endurance_volume, null);
});
