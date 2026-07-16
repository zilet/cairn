// One hydrated, repo-layer source of truth for the protective fuel read. Heavy
// dependencies are computed once for standalone callers; callers that already
// own a coherent coach snapshot pass them explicitly. `undefined` authorizes a
// compute, while `null` is a terminal "attempted but unavailable" sentinel.
import { db } from "../db.js";
import { estimateExpenditure } from "./expenditure.js";
import { getProgramState } from "./program-state.js";
import { computeGoalCheck } from "./profile.js";
import { localDateISO } from "./shared.js";
import {
  foodBackstopSignature,
  registerTrainingCacheClear,
  trainingBackstopSignature,
} from "./training-cache.js";
import { underfuelingRead, type UnderfuelingRead } from "./underfueling.js";
import { wholePersonTrajectory } from "./whole-person-trajectory.js";

export interface UnderfuelingSnapshotOptions {
  expenditure?: any | null;
  goal?: any | null;
  programState?: any | null;
  wholePerson?: any | null;
}

let currentReadCache: { key: string; value: UnderfuelingRead } | null = null;
registerTrainingCacheClear(() => {
  currentReadCache = null;
});

function underfuelingBackstopSignature(): string {
  try {
    const r = db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM nutrition_targets) AS ntc,
         (SELECT COALESCE(MAX(id),0) FROM nutrition_targets) AS ntm,
         (SELECT COALESCE(SUM(COALESCE(target_kcal,0)),0) FROM nutrition_targets) AS nts,
         (SELECT COUNT(*) FROM fueling_feedback) AS ffc,
         (SELECT COALESCE(MAX(id),0) FROM fueling_feedback) AS ffm,
         (SELECT COALESCE(SUM(COALESCE(energy,0)+COALESCE(hunger,0)),0) FROM fueling_feedback) AS ffs,
         (SELECT COUNT(*) FROM checkins) AS cic,
         (SELECT COALESCE(MAX(id),0) FROM checkins) AS cim,
         (SELECT COALESCE(SUM(COALESCE(energy,0)+COALESCE(sleep_feel,0)+COALESCE(soreness,0)),0) FROM checkins) AS cis,
         (SELECT COUNT(*) FROM body_measurements) AS bmc,
         (SELECT COALESCE(MAX(id),0) FROM body_measurements) AS bmm,
         (SELECT COALESCE(SUM(COALESCE(waist_in,0)),0) FROM body_measurements) AS bms`
    ).get() as any;
    return [r?.ntc, r?.ntm, r?.nts, r?.ffc, r?.ffm, r?.ffs, r?.cic, r?.cim, r?.cis, r?.bmc, r?.bmm, r?.bms].join("|");
  } catch {
    return `nocache:${Math.random()}`;
  }
}

function attempted<T>(compute: () => T): T | null {
  try {
    return compute();
  } catch {
    return null;
  }
}

function hasExplicitSnapshot(opts: UnderfuelingSnapshotOptions): boolean {
  return ["expenditure", "goal", "programState", "wholePerson"].some((key) => Object.hasOwn(opts, key));
}

export function currentUnderfuelingRead(
  today = localDateISO(),
  opts: UnderfuelingSnapshotOptions = {},
): UnderfuelingRead {
  const d = String(today || localDateISO());
  const cacheable = !hasExplicitSnapshot(opts);
  const key = cacheable
    ? `${d}|${trainingBackstopSignature()}|${foodBackstopSignature()}|${underfuelingBackstopSignature()}`
    : null;
  if (key && currentReadCache?.key === key) return structuredClone(currentReadCache.value);

  const expenditure = opts.expenditure === undefined
    ? attempted(() => estimateExpenditure(21))
    : opts.expenditure;
  const programState = opts.programState === undefined
    ? attempted(() => getProgramState(d))
    : opts.programState;
  const wholePerson = opts.wholePerson === undefined
    ? attempted(() => wholePersonTrajectory({ end: d, days: 56 }))
    : opts.wholePerson;
  const goal = opts.goal === undefined
    ? attempted(() => computeGoalCheck(undefined, { expenditure }))
    : opts.goal;
  const value = underfuelingRead(d, {
    windowDays: 14,
    expenditure,
    goal,
    programState,
    wholePerson,
  });
  if (key) currentReadCache = { key, value: structuredClone(value) };
  return value;
}
