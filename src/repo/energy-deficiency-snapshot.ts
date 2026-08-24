// One memoized, repo-layer source of truth for the low-energy-availability watch,
// and the small projection of it that a PERSON's coach is allowed to see.
//
// Why a snapshot at all: the watch evaluates its five arms twice — today and twelve
// days ago — and the earlier pass computes a program state for a date nothing else
// asks about, so it is the one genuinely expensive read in the module. The scheduler
// pass and the coach context must not each pay for it, and more importantly they must
// not disagree: a prompt that says the deficit looks fine while the same day's watch
// schedules a protective raise is the split-brain this codebase has shipped before.
//
// Cheap when nothing is happening: with no affirmed deficit running, the state
// assembly short-circuits before any arm is evaluated.
import { db } from "../db.js";
import { localDateISO } from "./shared.js";
import { foodBackstopSignature, registerTrainingCacheClear, trainingBackstopSignature } from "./training-cache.js";
import { type EnergyDeficiencyArmKey, type EnergyDeficiencyRead, energyDeficiencyRead } from "./energy-deficiency.js";

let currentReadCache: { key: string; value: EnergyDeficiencyRead } | null = null;
registerTrainingCacheClear(() => {
  currentReadCache = null;
});

// The accepted-target rows are an INPUT to this read (the baseline every protective
// step is measured from) and nothing in the training or food backstops moves when one
// is written — so without this term the memo would keep serving a pre-raise answer to
// the rest of the process after the raise landed.
function nutritionTargetSignature(): string {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS m, COALESCE(SUM(COALESCE(target_kcal, 0)), 0) AS s
           FROM nutrition_targets`
      )
      .get() as any;
    return [row?.n, row?.m, row?.s].join("|");
  } catch {
    return `nocache:${Math.random()}`;
  }
}

export function currentEnergyDeficiencyRead(today = localDateISO()): EnergyDeficiencyRead {
  const d = String(today || localDateISO());
  const key = `${d}|${trainingBackstopSignature()}|${foodBackstopSignature()}|${nutritionTargetSignature()}`;
  if (currentReadCache?.key === key) return structuredClone(currentReadCache.value);
  const value = energyDeficiencyRead(d);
  currentReadCache = { key, value: structuredClone(value) };
  return value;
}

/**
 * What a PROMPT is shown. Deliberately small and deliberately wordless about the
 * mechanism: which channels agree, whether the pattern is standing, and whether the
 * fuel target has been moved for it.
 *
 * The arm KEYS travel, the arms' machine summaries do not — a prompt that recites
 * "overnight HRV drifting below its own recent norm (52 vs 61 ms)" is reading numbers
 * back to the athlete, and the register those belong to is the provenance trail.
 * The coach needs to know a protective move happened and why, so it can answer "why
 * has my target gone up?" without inventing a reason; it does not need the evidence
 * dump to do that.
 *
 * Null whenever nothing is being watched, so the DATA block carries no key at all
 * rather than a row of falses inviting the model to talk about it.
 */
export interface CoachEnergyDeficiency {
  watching: boolean;
  standing: boolean;
  agreeing_channels: EnergyDeficiencyArmKey[];
  /** True only when this watch has actually moved the fuel target toward maintenance. */
  fuel_protected: boolean;
}

export function energyDeficiencyForCoach(today = localDateISO()): CoachEnergyDeficiency | null {
  let read: EnergyDeficiencyRead | null = null;
  try {
    read = currentEnergyDeficiencyRead(today);
  } catch {
    return null;
  }
  if (!read || read.state === "not_watching") return null;
  return {
    watching: true,
    standing: read.state === "sustained_cluster",
    agreeing_channels: read.met_keys,
    fuel_protected: read.state === "sustained_cluster" && read.protection.raise,
  };
}
