import { db } from "../db.js";
import { inferExerciseEquipment, type SessionEquipment } from "./equipment-capability.js";
import { normalizedExerciseKey } from "./exercise-canon.js";
import { findExercise } from "./exercises.js";
import { movementRegionKey } from "./movement-region.js";

// WHAT A LIFT OCCUPIES ON A SHARED GYM FLOOR. A superset is only doable when the athlete
// can move between its two lifts without holding two stations at once: dumbbells, a
// kettlebell, a band or a plate go wherever you are (`portable`); a machine, a cable
// stack, a rack or barbell station, a landmine or a pull-up bar is a place you occupy
// (`fixed`). Two fixed lifts pair only when they are the SAME station — two movements on
// one cable stack, a pull-up and a hanging knee raise on one bar.
//
// One table, read in one order: the implement a data field names first (the exercise
// row's classified `equipment`, then its linked guide's dataset `equipment`), the name
// last. The existing implement classifier (`inferExerciseEquipment`) answers the common
// implements; the rows below cover what it does not name. An exercise whose implement
// nothing names is `unknown`, and unknown is FIXED — a guess that frees a station nobody
// confirmed is the failure this module exists to prevent.

export type StationImplement =
  | SessionEquipment
  | "plate"
  | "medicine_ball"
  | "mat"
  | "landmine"
  | "pullup_bar"
  | "dip_station"
  | "rack"
  | "sled"
  | "suspension"
  | "unknown";

export type StationFootprintKind = "portable" | "fixed";

/**
 * The footprint of every implement. Barbell work is fixed — it needs a rack, a bench or a
 * platform — except a standing barbell curl (stationFootprint), which needs none.
 */
export const IMPLEMENT_FOOTPRINT: Readonly<Record<StationImplement, StationFootprintKind>> = Object.freeze({
  dumbbell: "portable",
  kettlebell: "portable",
  bands: "portable",
  bodyweight: "portable",
  plate: "portable",
  medicine_ball: "portable",
  mat: "portable",
  barbell: "fixed",
  machine: "fixed",
  cable: "fixed",
  landmine: "fixed",
  pullup_bar: "fixed",
  dip_station: "fixed",
  rack: "fixed",
  sled: "fixed",
  suspension: "fixed",
  unknown: "fixed",
});

// Stations a NAME gives away even when a data field calls the implement "bodyweight": a
// pull-up still occupies the bar, a dip the dip station. Checked before every data
// field, in order (an assisted pull-up is the machine, a band-assisted one the bar).
const NAME_STATIONS: ReadonlyArray<{ re: RegExp; implement: StationImplement }> = [
  { re: /\bband(?:ed)?[ -]assisted\b.*\b(?:pull|chin)[ -]?ups?\b/, implement: "pullup_bar" },
  { re: /\bassisted\b.*\b(?:pull[ -]?ups?|chin[ -]?ups?|dips?)\b/, implement: "machine" },
  { re: /\bplate[ -]loaded\b|\bsmith\b/, implement: "machine" },
  { re: /\b(?:pull|chin)[ -]?ups?\b|\bhanging\b|\bdead hang\b|\btoes[ -]to[ -]bar\b/, implement: "pullup_bar" },
  // A dip on rings hangs from the rings, and a bench (or chair) dip needs no station at
  // all — only a parallel-bar dip occupies the dip station.
  { re: /\brings?\b.*\bdips?\b|\bdips?\b.*\brings?\b/, implement: "suspension" },
  { re: /\b(?:bench|chair|box)[ -]dips?\b|\bdips?\b.*\bbench\b/, implement: "bodyweight" },
  { re: /\bdips?\b/, implement: "dip_station" },
  { re: /\binverted rows?\b/, implement: "rack" },
  { re: /\blandmine\b/, implement: "landmine" },
  { re: /\bsled\b|\bprowler\b/, implement: "sled" },
  { re: /\brings?\b|\btrx\b|\bsuspension\b/, implement: "suspension" },
];

// Implements the shared classifier does not name, read off a data field or the name.
const EXTRA_IMPLEMENTS: ReadonlyArray<{ re: RegExp; implement: StationImplement }> = [
  { re: /\be-?z[ -]?(?:curl )?bar\b|\btrap bar\b|\bhex bar\b/, implement: "barbell" },
  { re: /\bbody only\b/, implement: "bodyweight" },
  { re: /\bbands?\b/, implement: "bands" },
  { re: /\bmedicine ball\b|\bmed ball\b/, implement: "medicine_ball" },
  { re: /\bfoam roll(?:er)?\b|\bexercise ball\b|\bmat\b/, implement: "mat" },
  { re: /\bplates?\b/, implement: "plate" },
];

// Movements that, by name, ARE a cable-stack movement (nobody does a face pull or a
// pushdown off a machine of its own): all of them share the one adjustable column.
const CABLE_BY_NAME: ReadonlyArray<{ re: RegExp; implement: StationImplement }> = [
  {
    re: /\bpush[ -]?downs?\b|\bface[ -]?pulls?\b|\bcrossovers?\b|\bstraight[ -]arm pull[ -]?downs?\b|\bpallof\b|\bwood[ -]?chops?\b|\bpull[ -]throughs?\b/,
    implement: "cable",
  },
];

// Movements that, by name, are a selectorized machine of their own.
const MACHINE_BY_NAME: ReadonlyArray<{ re: RegExp; implement: StationImplement }> = [
  {
    re: /\bleg curls?\b|\bleg extensions?\b|\bpec[ -]?deck\b|\bseated calf raises?\b|\bhip (?:abduct|adduct)/,
    implement: "machine",
  },
];

// Free-weight and bodyweight lifts whose name, by convention, IS the implement (nobody
// writes "goblet squat" for a machine, and a lateral raise or a walking lunge with no
// implement named is a dumbbell or nothing at all). Name fallback only, after every data
// field, and never when the name itself says it is done on a station
// (STATION_WORDS_IN_NAME): a seated, machine, smith, cable or preacher version is not this.
const STATION_WORDS_IN_NAME = /\b(?:machine|seated|smith|cable|lever|selectori[sz]ed|preacher|scott|spider)\b/;
const PORTABLE_BY_NAME: ReadonlyArray<{ re: RegExp; implement: StationImplement }> = [
  {
    re: /\bgoblet\b|\bhammer curls?\b|\bconcentration curls?\b|\barnold press\b|\brenegade rows?\b/,
    implement: "dumbbell",
  },
  { re: /\bfarmer'?s? (?:carry|walk)\b|\bsuitcase carry\b/, implement: "dumbbell" },
  {
    re: /\b(?:lateral|front|side|y)[ -]raises?\b|\brear[ -]delt (?:raises?|fl(?:y|ys|ies|yes))\b|\breverse fl(?:y|ys|ies|yes)\b|\bfl(?:y|ys|ies|yes)\b|\bbiceps? curls?\b|\bcurls?\b|\bskull[ -]?crushers?\b|\btriceps? (?:extensions?|kick[ -]?backs?)\b|\bkick[ -]?backs?\b|\bshrugs?\b|\bcalf raises?\b|\blunges?\b|\bsplit squats?\b|\bbulgarian\b|\bstep[ -]?ups?\b|\bpullovers?\b|\bsingle[ -]leg (?:rdl|romanian)\b/,
    implement: "dumbbell",
  },
  {
    re: /\bsit[ -]?ups?\b|\bcrunch(?:es)?\b|\bside plank\b|\bbird[ -]?dogs?\b|\brussian twists?\b|\bmountain climbers?\b|\bburpees?\b|\b(?:air|bodyweight|jump) squats?\b|\bsupermans?\b|\bhollow (?:hold|body)\b|\bv[ -]ups?\b|\bleg raises?\b|\bflutter kicks?\b|\bwall sits?\b|\binchworms?\b|\bjumping jacks?\b|\bbear crawls?\b/,
    implement: "bodyweight",
  },
];

// The shared classifier first (a "barbell and plates" field is a barbell), the extra
// implements after it, and — for a name — the cable, machine and free-weight name
// conventions last of all.
function implementFromText(text: string, asName: boolean): StationImplement | null {
  if (!text) return null;
  const inferred = asName ? inferExerciseEquipment(text, null) : inferExerciseEquipment(null, text);
  if (inferred) return inferred;
  for (const row of EXTRA_IMPLEMENTS) if (row.re.test(text)) return row.implement;
  if (!asName) return null;
  for (const row of CABLE_BY_NAME) if (row.re.test(text)) return row.implement;
  for (const row of MACHINE_BY_NAME) if (row.re.test(text)) return row.implement;
  if (STATION_WORDS_IN_NAME.test(text)) return null;
  for (const row of PORTABLE_BY_NAME) if (row.re.test(text)) return row.implement;
  return null;
}

// A seated / low cable row has a bench of its own; every other cable movement shares the
// adjustable stack (a pushdown, a curl, a fly, a face pull on one column).
const CABLE_ROW_STATION = /\b(?:seated|low)\b.*\brows?\b|\bcable rows?\b/;

const BENCH_BOUND_CURL = /\bpreacher\b|\bspider\b|\bscott\b|\bbench\b|\bincline\b/;

export interface StationFootprint {
  footprint: StationFootprintKind;
  implement: StationImplement;
  // The station a fixed lift occupies; two fixed lifts share a station only when these
  // match. Null for portable work.
  station: string | null;
}

function linkedGuideEquipment(exerciseId: unknown): string {
  const id = Number(exerciseId);
  if (!Number.isInteger(id) || id <= 0) return "";
  try {
    const row = db
      .prepare(
        `SELECT equipment FROM exercise_guides
          WHERE exercise_id = ? AND COALESCE(match_confidence, '') NOT IN ('movement', 'detached')
          ORDER BY id LIMIT 1`
      )
      .get(id) as { equipment?: string | null } | undefined;
    return String(row?.equipment ?? "")
      .trim()
      .toLowerCase();
  } catch {
    return "";
  }
}

/** The implement a lift uses, from its data first and its name last; `unknown` when nothing names one. */
export function liftImplement(
  exercise: unknown,
  data: { equipment?: unknown; guide_equipment?: unknown } = {}
): StationImplement {
  const name = String(exercise ?? "")
    .trim()
    .toLowerCase();
  for (const row of NAME_STATIONS) if (row.re.test(name)) return row.implement;
  for (const field of [data.equipment, data.guide_equipment]) {
    const found = implementFromText(
      String(field ?? "")
        .trim()
        .toLowerCase(),
      false
    );
    if (found) return found;
  }
  return implementFromText(name, true) ?? "unknown";
}

/** The footprint of one lift by name (and, when given, its data) — the one read every pairing rule asks. */
export function stationFootprint(
  exercise: unknown,
  data?: { equipment?: unknown; guide_equipment?: unknown }
): StationFootprint {
  const name = String(exercise ?? "").trim();
  let fields = data;
  if (!fields) {
    const stored = name ? (findExercise(name) as any) : null;
    fields = { equipment: stored?.equipment ?? null, guide_equipment: linkedGuideEquipment(stored?.id) };
  }
  const implement = liftImplement(name, fields);
  const lower = name.toLowerCase();
  // A standing barbell or EZ-bar curl needs no rack and no bench: the bar is carried to
  // wherever the partner lift is (read through the movement region, the curl's own
  // classifier). A preacher or spider curl is bench-bound and stays fixed.
  if (
    implement === "barbell" &&
    String(movementRegionKey(name) ?? "").startsWith("curl:") &&
    !BENCH_BOUND_CURL.test(lower)
  ) {
    return { footprint: "portable", implement, station: null };
  }
  const footprint = IMPLEMENT_FOOTPRINT[implement];
  if (footprint === "portable") return { footprint, implement, station: null };
  const station =
    implement === "cable"
      ? CABLE_ROW_STATION.test(lower)
        ? "cable:row"
        : "cable:stack"
      : implement === "pullup_bar" || implement === "dip_station"
        ? implement
        : `${implement}:${normalizedExerciseKey(name) || lower}`;
  return { footprint, implement, station };
}

/** Can these two lifts run back to back while holding at most one fixed station? */
export function pairFitsOneStation(a: StationFootprint, b: StationFootprint): boolean {
  if (a.footprint === "portable" || b.footprint === "portable") return true;
  return a.station != null && a.station === b.station;
}
