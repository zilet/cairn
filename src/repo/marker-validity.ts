// ============================================================================
// TEMPORAL VALIDITY — how long a marker's reading keeps describing the person.
//
// "Is this reading old?" has no single answer. A morning cortisol or an hs-CRP is
// a snapshot of that day; a lipid panel describes a season; a bone-density scan
// describes years; Lp(a) and blood type are set once and never move. A blanket
// age rule therefore either nags about a genetic marker forever or lets a
// months-old inflammatory value keep shaping today.
//
// So staleness is classified PER MARKER, in four classes, each with its own two
// horizons: the day the age becomes worth NAMING, and the day the finding stops
// being something the coach should act on (softened to `uncertain`, and moved out
// of the prompt's "honor these" block).
//
// Pure and DB-free like ./propagation-data.js — matching mirrors markerGroup /
// matchOptimalZone exactly (lowercased SUBSTRING, LONGEST-MATCH-WINS, earlier
// entry wins an exact-length tie), and anything unmatched falls to `standard`, so
// a marker Cairn has never seen behaves exactly as it did before this table
// existed. Only markers that genuinely appear in this repo's catalog
// (OPTIMAL_ZONES / MARKER_GROUPS) are classified.
//
// INFORMATIONAL, never medical advice: nothing here decides what a value MEANS,
// only how long the reading can still speak for itself.
// ============================================================================

export type MarkerValidityClass = "genetic" | "slow" | "standard" | "fast";

export interface ValidityHorizons {
  // Past this many days the age is named in the directive's rationale, but the
  // finding keeps its confidence — it is still the best evidence on file.
  note_days: number;
  // Past this many days the finding softens to `uncertain` and stops being
  // something the coach honors. null = age alone never demotes this class.
  uncertain_days: number | null;
}

export const VALIDITY_HORIZONS: Record<MarkerValidityClass, ValidityHorizons> = {
  // Set at conception, measured once. Age is never doubt — at most a calm note
  // that a single confirmatory re-test is all it ever needs.
  genetic: { note_days: 365, uncertain_days: null },
  // Structural: bone mineral density, arterial calcium. Moves over years, and the
  // repeat measurement is a scan, not a blood draw — a yearly note, two-year demote.
  slow: { note_days: 365, uncertain_days: 730 },
  // The default and the great majority: lipids, HbA1c, thyroid, hormones,
  // vitamins, kidney and liver chemistry. Conventional re-test cadence is
  // 3-12 months, so half a year names the age and a year retires the finding.
  standard: { note_days: 180, uncertain_days: 365 },
  // State-dependent: acute-phase reactants, white-cell counts, fasting glucose /
  // insulin, cortisol, iron kinetics, electrolytes, blood pressure, wearable
  // vitals. These describe a day, not a season.
  fast: { note_days: 90, uncertain_days: 180 },
};

// Volatility rank — how long-lived a class is. Used to reconcile a synthesized
// cross-marker (cluster) name that carries several markers at once.
const CLASS_RANK: Record<MarkerValidityClass, number> = { fast: 0, standard: 1, slow: 2, genetic: 3 };

// The classification table. Keys are lowercased substrings of a marker NAME
// (the optimal-zone label the propagation engine stores, the canonical marker
// name the generic long-tail stores, or whatever a lab called it).
//
// `standard` entries exist ONLY to win the longest-match race against a shorter
// key from another class — everything unmatched is standard already. That is how
// "Insulin-Like Growth Factor 1" stays out of the fast `insulin` bucket and
// "Total Iron Binding Capacity" stays out of the fast `iron` one.
const VALIDITY_KEYS: { cls: MarkerValidityClass; keys: string[] }[] = [
  {
    // Lifelong. Lp(a) is ~90% heritable and does not respond to diet or training
    // (the CV cluster's own copy already says so); ABO/Rh and any genotype result
    // are fixed facts about the person.
    cls: "genetic",
    keys: [
      "lp(a)",
      "lipoprotein(a)",
      "lipoprotein (a)",
      "apoe",
      "genotype",
      "abo group",
      "blood type",
      "rhesus",
      "rh factor",
    ],
  },
  {
    // Structural measures with a multi-year natural history. Bone density is
    // conventionally re-scanned every 1-2 years; a coronary-calcium / Agatston
    // score progresses over years (and is deliberately kept OFF the serum-calcium
    // band by matchOptimalZone, so it must not inherit the fast electrolyte class).
    cls: "slow",
    keys: [
      "bone mineral density",
      "bone density",
      "bmd",
      "bone mineral content",
      "t-score",
      "t score",
      "z-score",
      "z score",
      "coronary artery calcium",
      "coronary calcium",
      "calcium score",
      "agatston",
    ],
  },
  {
    cls: "standard",
    keys: [
      "insulin-like growth factor",
      "insulin like growth factor", // NOT the fast `insulin`
      "estimated average glucose", // eAG is a 3-month average, not a snapshot
      "iron binding capacity", // TIBC turns over in weeks, unlike serum iron
      "transferrin", // …but `transferrin saturation` below is fast
    ],
  },
  {
    cls: "fast",
    keys: [
      // Acute-phase reactants — the class the whole idea exists for.
      "hs-crp",
      "hscrp",
      "c-reactive",
      "c reactive",
      "crp",
      "esr",
      "sed rate",
      "sedimentation rate",
      "fibrinogen",
      "creatine kinase",
      "cpk",
      // White line + platelets: infection, a hard block or a flare moves these within days.
      "wbc",
      "white blood",
      // Nucleated RBCs in an adult are a transient marrow-stress finding, not a trait.
      "nrbc",
      "neutrophil",
      "lymphocyte",
      "monocyte",
      "eosinophil",
      "basophil",
      "granulocyte",
      "imm gran",
      "platelet",
      "mpv", // the MPV zone LABEL — "platelet" only catches the long spelling
      // The red LINE is deliberately absent: hemoglobin, hematocrit, MCV, MCH, MCHC, RDW
      // and RBC count track the ~120-day red-cell lifespan, so they move over months, not
      // weeks. They fall to `standard` like any unclassified marker, on purpose.
      // Glycemic snapshots (HbA1c and fructosamine are deliberately absent — they average
      // ~3 months and ~3 weeks respectively; HOMA-IR is computed FROM one fasting draw).
      "glucose",
      "insulin",
      "homa",
      "c-peptide",
      // Cardiac injury / strain markers move over hours.
      "troponin",
      "bnp",
      // Diurnal / stress-driven.
      "cortisol",
      // Iron kinetics: ferritin is an acute-phase reactant, serum iron is strongly
      // diurnal and meal-dependent.
      "ferritin",
      "iron",
      "iron saturation",
      "transferrin saturation",
      "iron % saturation",
      // Electrolytes + serum calcium: homeostatically defended, so an abnormal one
      // is a point-in-time event that wants a prompt repeat, not a season's evidence.
      "sodium",
      "potassium",
      "chloride",
      "carbon dioxide",
      "bicarbonate",
      "co2", // the CO2 zone LABEL
      "anion gap",
      "calcium",
      // Vitals + wearable-derived readings: measured continuously, so a months-old
      // one was never meant to speak for today.
      "systolic",
      "diastolic",
      "blood pressure",
      "pulse",
      "heart rate",
      "resting hr",
      "rhr",
      "heart rate variability",
      "hrv",
      "rmssd",
      "oxygen saturation",
      "spo2",
      "o2 sat",
      "respiratory rate",
      "body temp",
      "temperature",
    ],
  },
];

// The class for ONE marker name, or null when nothing in the table claims it.
function matchValidityClass(name: string): MarkerValidityClass | null {
  const n = String(name ?? "").toLowerCase();
  if (!n) return null;
  let best: MarkerValidityClass | null = null;
  let bestLen = 0;
  for (const row of VALIDITY_KEYS) {
    for (const k of row.keys) {
      if (k && n.includes(k) && k.length > bestLen) {
        best = row.cls;
        bestLen = k.length;
      }
    }
  }
  return best;
}

// Temporal-validity class for a directive's marker. Unmatched → `standard`, which
// is exactly the behavior that existed before this table.
//
// A CLUSTER marker is a synthesized cross-marker name ("ApoB+LDL-C+Lp(a)+hs-CRP"):
// the directive it carries is the durable STORY, not its most volatile member, so the
// LONGEST-lived non-genetic member sets the clock. Three rules, in order:
//   - all members genetic  → genetic (nothing in it can age).
//   - any member genetic   → the result FLOORS at `standard`. A genetic finding is why
//     the cluster exists ("Lp(a) is high, so push the modifiable markers harder"), and
//     that advice does not expire on the fastest member's clock — the degenerate
//     "Lp(a)+hs-CRP" pair would otherwise read as `fast`, exactly the string
//     CHRONIC_GUARD_RE in propagation.ts refuses to age out on CRP's clock. It floors at
//     `standard` rather than at `genetic` so the cluster still re-derives on a normal
//     lab cadence — the modifiable half of the story is not lifelong.
//   - otherwise             → the longest-lived non-genetic member.
export function markerValidityClass(name?: string | null): MarkerValidityClass {
  const raw = String(name ?? "").trim();
  if (!raw) return "standard";
  if (raw.includes("+")) {
    const members = raw
      .split("+")
      .map((p) => p.trim())
      .filter(Boolean)
      // An unmatched member is a `standard` member, not an absent one — dropping it
      // would let one fast member speak for a cluster of otherwise durable findings.
      .map((p) => matchValidityClass(p) ?? "standard");
    if (!members.length) return "standard";
    const nonGenetic = members.filter((c) => c !== "genetic");
    if (!nonGenetic.length) return "genetic";
    const longest = nonGenetic.reduce((a, b) => (CLASS_RANK[b] > CLASS_RANK[a] ? b : a));
    if (members.length === nonGenetic.length) return longest;
    return CLASS_RANK[longest] < CLASS_RANK.standard ? "standard" : longest;
  }
  return matchValidityClass(raw) ?? "standard";
}

export function markerValidityHorizons(name?: string | null): ValidityHorizons & { cls: MarkerValidityClass } {
  const cls = markerValidityClass(name);
  return { cls, ...VALIDITY_HORIZONS[cls] };
}

// Age of a source reading in whole days, or null when there is no parseable date.
export function readingAgeDays(readingDate: string | null | undefined, today?: string): number | null {
  if (!readingDate) return null;
  const t = Date.parse(String(readingDate).slice(0, 10));
  if (!Number.isFinite(t)) return null;
  const now = today ? Date.parse(today) : Date.now();
  if (!Number.isFinite(now)) return null;
  return Math.floor((now - t) / 864e5);
}

// The coarse MONTH bucket every age-derived STRING is built from. Deliberately the same
// `floor(ageDays / 30)` deriveSignature folds in, so a note's wording can only change on a
// day the signature also moves. A finer (or differently-rounded) bucket would rewrite the
// rationale on days the short-circuit skips the pass — the text would land late, and once
// the pass runs daily it would rewrite directive rows on a schedule of its own.
export function readingAgeMonths(ageDays: number): number {
  return Math.floor(ageDays / 30);
}

// Which age band a reading sits in for its class: 0 = current, 1 = worth naming,
// 2 = past the class's useful window. Folded into the derive signature ALONGSIDE the
// month bucket, because a class horizon (365, 730) need not fall on a month boundary —
// without it a band crossing could change the wording on a day the fingerprint didn't move.
export function validityBand(name: string | null | undefined, ageDays: number | null): 0 | 1 | 2 {
  if (ageDays == null) return 0;
  const h = markerValidityHorizons(name);
  if (h.uncertain_days != null && ageDays > h.uncertain_days) return 2;
  if (ageDays > h.note_days) return 1;
  return 0;
}

// True when a finding's source reading is past the point where its own kind of marker
// still describes the person — the test the prompt layer uses to move a directive out of
// "honor these" and into the informational block. A genetic marker never ages out.
export function readingPastValidity(name: string | null | undefined, ageDays: number | null): boolean {
  return validityBand(name, ageDays) === 2;
}

// The age note a desired directive carries, if any — a graded band per class, never a
// cliff, and worded in the class's own register: a genetic reading reads as reassurance,
// a fast one as "that was a snapshot". Returns null while the reading is still current.
//
// Every number in the prose comes from `readingAgeMonths` so the wording stays in lockstep
// with the derive signature (see readingAgeMonths above).
export function markerAgingClause(
  marker: string | null | undefined,
  readingDate: string | null | undefined,
  today?: string
): { clause: string; uncertain: boolean } | null {
  const ageDays = readingAgeDays(readingDate, today);
  if (ageDays == null) return null;
  const band = validityBand(marker, ageDays);
  if (band === 0) return null;
  const cls = markerValidityClass(marker);
  const months = readingAgeMonths(Math.max(0, ageDays));
  const atLeast = (floor: number) => Math.max(floor, months);
  if (cls === "genetic") {
    // Band 1 only — a genetic marker has no band 2.
    return {
      clause: `This one is set by genetics rather than anything you do, so the reading from ~${atLeast(12)} months ago still stands; a single confirmatory re-test is all it ever needs.`,
      uncertain: false,
    };
  }
  if (cls === "slow") {
    if (band === 2)
      return {
        clause: `This reading is ~${atLeast(24)} months old — slow-moving as this measure is, that is long enough that a repeat scan would be the honest way to confirm it.`,
        uncertain: true,
      };
    return {
      clause: `This reading is ~${atLeast(12)} months old — this measure changes over years, so it still describes where you are.`,
      uncertain: false,
    };
  }
  if (cls === "fast") {
    if (band === 2)
      return {
        clause: `This reading is from ~${atLeast(6)} months ago and this marker moves week to week — treat it as a snapshot of that day, not where you are now; a re-test would say.`,
        uncertain: true,
      };
    return {
      clause: `This reading is ~${atLeast(3)} months old, and this marker shifts week to week — a snapshot rather than a settled level.`,
      uncertain: false,
    };
  }
  // standard
  if (band === 2)
    return {
      clause: `This reading is from ~${atLeast(12)} months ago — a recheck would confirm it still holds.`,
      uncertain: true,
    };
  return {
    clause: `This reading is ~${months} months old — still the most recent one on file.`,
    uncertain: false,
  };
}
