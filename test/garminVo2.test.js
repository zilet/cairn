import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractGarminActivityHrZones,
  extractGarminActivityTeLabel,
  extractGarminActivityTemp,
  extractGarminActivityVo2,
  extractGarminFitnessMetrics,
  extractTrainingStatus,
  garminClientCredentials,
} from "../dist/garmin.js";

test("extractGarminFitnessMetrics reads standard generic and cycling maxmet payloads", () => {
  const metrics = extractGarminFitnessMetrics({
    generic: { vo2MaxPreciseValue: 47.6, fitnessAge: 38 },
    cycling: { vo2MaxValue: 51 },
  });

  assert.equal(metrics.vo2max, 47.6);
  assert.equal(metrics.vo2max_cycling, 51);
  assert.equal(metrics.fitness_age, 38);
});

test("extractGarminFitnessMetrics tolerates nested sport rows and maxMET units", () => {
  const metrics = extractGarminFitnessMetrics({
    maxMetData: [
      { sport: "RUNNING", maxMet: 13.2, fitnessAgeYears: 39 },
      { sport: "CYCLING", vO2MaxValue: 52.4 },
    ],
  });

  assert.equal(metrics.vo2max, 46.2);
  assert.equal(metrics.vo2max_cycling, 52.4);
  assert.equal(metrics.fitness_age, 39);
});

test("extractGarminActivityVo2 reads Garmin activity VO2 casing variants", () => {
  assert.equal(extractGarminActivityVo2({ vO2MaxValue: 49 }), 49);
  assert.equal(extractGarminActivityVo2({ VO2MaxPreciseValue: 48.7 }), 48.7);
});

test("extractGarminActivityHrZones reads summary hrTimeInZone fields", () => {
  assert.deepEqual(extractGarminActivityHrZones({
    hrTimeInZone_1: 120,
    hrTimeInZone_2: 1800,
    hrTimeInZone_3: 0,
    hrTimeInZone_4: 60,
  }), [
    { zone: 1, secs: 120, low_hr: null },
    { zone: 2, secs: 1800, low_hr: null },
    { zone: 4, secs: 60, low_hr: null },
  ]);
});

test("extractGarminActivityTeLabel derives useful effort labels from Garmin messages", () => {
  assert.equal(extractGarminActivityTeLabel({ aerobicTrainingEffectMessage: "IMPROVING_VO2_MAX_15" }), "VO2MAX");
  assert.equal(extractGarminActivityTeLabel({ aerobicTrainingEffectMessage: "HIGHLY_IMPROVING_LACTATE_THRESHOLD_13" }), "LACTATE_THRESHOLD");
  assert.equal(extractGarminActivityTeLabel({ aerobicTrainingEffectMessage: "RECOVERY_5" }), "RECOVERY");
  assert.equal(extractGarminActivityTeLabel({ anaerobicTrainingEffectMessage: "IMPROVING_ANAEROBIC_BASE_2" }), "ANAEROBIC");
  assert.equal(extractGarminActivityTeLabel({ anaerobicTrainingEffectMessage: "NO_ANAEROBIC_BENEFIT_0" }), null);
});

test("extractGarminActivityTemp falls back to min/max temperature midpoint", () => {
  assert.equal(extractGarminActivityTemp({ averageTemperature: 18.8, minTemperature: 10, maxTemperature: 20 }), 18.8);
  assert.equal(extractGarminActivityTemp({ minTemperature: 12.1, maxTemperature: 19.1 }), 15.6);
});

test("extractTrainingStatus reads status + load balance from the one aggregate", () => {
  // The trainingstatus/aggregated payload is device-id-keyed and carries BOTH the
  // latest training status AND the monthly load balance (no separate endpoint).
  const out = extractTrainingStatus({
    mostRecentTrainingStatus: {
      latestTrainingStatusData: {
        "3113957768": {
          trainingStatus: 3,
          trainingStatusFeedbackPhrase: "PRODUCTIVE_1",
          acuteTrainingLoadDTO: { acuteTrainingLoad: 312, dailyTrainingLoadAcute: 312 },
        },
      },
    },
    mostRecentTrainingLoadBalance: {
      metricsTrainingLoadBalanceDTOMap: {
        "3113957768": {
          monthlyLoadAerobicLow: 120,
          monthlyLoadAnaerobic: 40,
          trainingBalanceFeedbackPhrase: "BALANCED",
        },
      },
    },
  });
  assert.equal(out.training_status, "PRODUCTIVE_1");
  assert.equal(out.acute_load, 312, "acuteTrainingLoad found nested under its DTO");
  assert.equal(out.training_load_balance, "BALANCED");
});

test("extractTrainingStatus degrades to nulls when the device omits the blocks", () => {
  assert.deepEqual(extractTrainingStatus(null), {
    training_status: null,
    acute_load: null,
    training_load_balance: null,
  });
  assert.deepEqual(extractTrainingStatus({ mostRecentTrainingStatus: {} }), {
    training_status: null,
    acute_load: null,
    training_load_balance: null,
  });
});

test("garminClientCredentials lets stored token files bootstrap the client", () => {
  assert.deepEqual(garminClientCredentials("", "", true), { username: "token", password: "token" });
  assert.equal(garminClientCredentials("", "", false), null);
  assert.deepEqual(garminClientCredentials("user@example.com", "secret", true), {
    username: "user@example.com",
    password: "secret",
  });
});
