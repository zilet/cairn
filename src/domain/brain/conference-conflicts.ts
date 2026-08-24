import type { SpecialistDomain, SpecialistOpinion } from "../../brain/specialist-contract.js";

// ============================================================================
// CASE-CONFERENCE ARBITRATION — the deterministic conflict layer.
//
// A "conflict" is a genuine cross-domain tension the conductor has to reconcile
// before the server will let a revision land at anything but the review floor.
// It used to be detected by running regexes over JSON.stringify(context), which
// matches KEY NAMES as readily as values: `cut_quality` (an unconditional key of
// the nutrition slice) plus `fatigue` (an unconditional key of the day-read
// signals) fired deficit_recovery on EVERY conference, whatever the athlete was
// actually doing — floor the risk class, tighten the tier ceiling, and tell every
// specialist a conflict had been detected, all from the spelling of two null
// fields.
//
// So conflicts are predicates over TYPED values read out of the same context the
// specialists see, with one law borrowed from the intake rules: ABSENT EVIDENCE
// NEVER FIRES A CONFLICT. `null` means "nothing in the context answers this
// question" and is not the same as `false` ("the context answers, and the answer
// is no"). Both are silent here; only `true` on both sides of a rule speaks.
// ============================================================================

export type ConferenceConflictKey =
  | "injury_load"
  | "deficit_recovery"
  | "medication_supplement"
  | "allergy_meal"
  | "race_strength"
  | "clinical_autonomy";

/** WHICH specialist domains may speak to a conflict. A resolution has to be
 * cited from a party to the conflict — a lifestyle opinion cannot close an
 * injury/load question. `clinical_autonomy` deliberately has NO parties: the
 * clinician floor is the server's, and no opinion may attest it away. */
const CONFLICT_PARTIES: Readonly<Record<ConferenceConflictKey, readonly SpecialistDomain[]>> = {
  injury_load: ["training", "recovery", "health"],
  deficit_recovery: ["nutrition", "recovery"],
  medication_supplement: ["health", "nutrition"],
  allergy_meal: ["nutrition", "health"],
  race_strength: ["training", "recovery"],
  clinical_autonomy: [],
};

/** A tri-state answer: true / false / null when the context carries no evidence. */
type Evidence = boolean | null;

/** The typed question sheet the conflict rules read. Assembled from context
 * VALUES only — never from serialized key names. */
export interface ConferenceConflictInputs {
  /** An open injury event, or a still-active joint the athlete named. */
  activeInjury: Evidence;
  /** At least one planned lift is ready to take a bigger dose. */
  plannedLoadIncrease: Evidence;
  /** The measured intake target sits below measured maintenance. */
  inDeficit: Evidence;
  /** Recovery is being watched or is outright constraining the day. */
  recoveryStrain: Evidence;
  /** A dated race still ahead. */
  raceCommitment: Evidence;
  /** Strength/hypertrophy is one of the athlete's declared priorities. */
  strengthEmphasis: Evidence;
  /** A lab/clinical priority the brain is being asked to act on now. */
  clinicalAttention: Evidence;
  /** A health finding is being propagated into a domain the brain can change itself. */
  clinicalLever: Evidence;
  /** Food is actually being planned (a live plan, or food logged today). */
  mealPlanning: Evidence;
  /** Verbatim names, empty when the context carries none. */
  activeMedications: string[];
  activeSupplements: string[];
  knownAllergies: string[];
}

// ---------- null-honest readers ----------

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finite(value: unknown): number | null {
  const number = Number(value);
  return typeof value === "number" && Number.isFinite(number) ? number : null;
}

/** Both sides must actually say yes. Absence is silence, never a conflict. */
function both(first: Evidence, second: Evidence): boolean {
  return first === true && second === true;
}

// ---------- per-input derivations ----------

function readActiveInjury(context: Record<string, unknown>, symptomAreas: readonly string[] | null): Evidence {
  // `context_events` is already the ACTIVE list (listContextEvents({activeOnly:true})),
  // so an injury row here is an open injury.
  const events = context.context_events;
  const injuries = list(events).filter((event) => text(record(event)?.kind) === "injury");
  // Joint areas the lifecycle still reads as ACTIVE (coach.ts filters resolved
  // areas out before the rollup), so this is stated freshness, not an old note.
  const autoregulation = record(record(context.training_signals)?.autoregulation);
  const joints = list(autoregulation?.joint_areas).filter((area) => text(area).length > 0);
  // The lifecycle itself, which the context can only show THROUGH a rated session:
  // pain reported in chat on Monday with nothing trained since is live evidence the
  // autoregulation rollup has no way to carry. Supplied by the caller (the context
  // does not hold it); `null` when nothing looked.
  const stated = symptomAreas == null ? [] : symptomAreas.filter((area) => text(area).length > 0);
  if (injuries.length > 0 || joints.length > 0 || stated.length > 0) return true;
  // Only claim "no injury" when something actually answered.
  return Array.isArray(events) || record(context.training_signals) || symptomAreas != null ? false : null;
}

function readPlannedLoadIncrease(context: Record<string, unknown>): Evidence {
  const signals = list(record(context.training_signals)?.progression);
  if (signals.some((signal) => record(signal)?.progress_ready === true)) return true;
  // The next session's actual prescriptions: an overload step is a planned increase.
  const prescriptions = list(context.progression);
  if (prescriptions.some((item) => text(record(item)?.action) === "overload")) return true;
  return signals.length > 0 || prescriptions.length > 0 ? false : null;
}

// Maintenance is an ESTIMATE with its own error bars, so a target a handful of
// calories under it is not evidence of a deficit — it is two numbers that landed
// close. A declared loss phase needs no margin; it has already said what it is.
const DEFICIT_MARGIN_KCAL = 100;

function readInDeficit(context: Record<string, unknown>): Evidence {
  // A measured cut in flight — cutQualityRead is only `active` on a genuine
  // measured downtrend during a declared loss phase.
  const cutQuality = record(context.cut_quality);
  if (cutQuality?.active === true) return true;
  const goal = record(context.goal);
  if (!goal || goal.ok !== true) return cutQuality ? false : null;
  if (text(goal.goal_mode) === "lose") return true;
  // Otherwise: the EFFECTIVE target the surfaces read, against measured
  // maintenance, by a margin big enough to mean something.
  const target = finite(record(goal.effective_target)?.target_kcal);
  const maintenance = finite(goal.tdee);
  if (target == null || maintenance == null) return false;
  return maintenance - target >= DEFICIT_MARGIN_KCAL;
}

function readRecoveryStrain(context: Record<string, unknown>): Evidence {
  const state = record(context.signal_state);
  if (!state) return null;
  const dimension = record(record(state.dimensions)?.recovery_capacity);
  const status = text(dimension?.status);
  const action = record(state.action);
  const directive = text(record(action?.directives)?.training);
  const readiness = text(action?.readiness);
  if (status === "watch" || status === "constrained") return true;
  if (directive === "recover" || directive === "modify") return true;
  if (readiness === "protect" || readiness === "caution") return true;
  // A dimension that read `unknown` answered nothing.
  const answered = (status !== "" && status !== "unknown") || (readiness !== "" && readiness !== "unknown");
  return answered ? false : null;
}

function readClinicalAttention(context: Record<string, unknown>): Evidence {
  const focus = record(context.health_focus);
  if (!focus) return null;
  const actNow = finite(focus.act_now);
  if (actNow != null && actNow > 0) return true;
  if (record(focus.lead)?.flagged === true) return true;
  return actNow == null && focus.lead === undefined ? null : false;
}

function readClinicalLever(context: Record<string, unknown>): Evidence {
  // A directive is a health finding propagated INTO a domain the brain can change
  // on its own. `watch` is an observation and changes nothing, so it is not a lever.
  const directives = context.directives;
  if (!Array.isArray(directives)) return null;
  return directives.some((directive) => {
    const domain = text(record(directive)?.domain);
    return domain === "training" || domain === "nutrition";
  });
}

function readMealPlanning(context: Record<string, unknown>): Evidence {
  const plan = record(context.meal_plan);
  if (plan) return true;
  const intake = record(context.day_intake);
  const count = finite(intake?.count);
  if (count != null && count > 0) return true;
  if (context.meal_plan === null || intake) return false;
  return null;
}

function readRaceCommitment(context: Record<string, unknown>): Evidence {
  const goal = record(context.endurance_goal);
  if (context.endurance_goal === null) return false;
  if (!goal) return null;
  if (goal.is_race !== true) return false;
  return text(goal.phase) !== "past";
}

function readStrengthEmphasis(context: Record<string, unknown>): Evidence {
  const intent = record(context.training_intent);
  const priorities = list(intent?.priorities).map((priority) => text(priority));
  if (priorities.includes("strength") || priorities.includes("muscle")) return true;
  if (priorities.length > 0) return false;
  const discipline = record(context.discipline);
  if (!discipline) return null;
  return text(discipline.primary) === "strength" || text(discipline.primary) === "hybrid";
}

const INACTIVE_STATUS = /\b(discontinued|inactive|stopped|resolved|completed|historical|no longer|expired|held)\b/i;

function readClinicalFactNames(context: Record<string, unknown>, kind: string): string[] {
  const names: string[] = [];
  for (const doc of list(context.health)) {
    for (const fact of list(record(doc)?.clinical_facts)) {
      const row = record(fact);
      if (!row || text(row.kind) !== kind) continue;
      if (INACTIVE_STATUS.test(text(row.status))) continue;
      const name = text(row.name);
      if (name) names.push(name);
    }
  }
  return [...new Set(names)];
}

function readSupplements(context: Record<string, unknown>): string[] {
  const names = list(context.supplements)
    .map((supplement) => text(record(supplement)?.name))
    .filter(Boolean);
  return [...new Set(names)];
}

function readAllergies(context: Record<string, unknown>): string[] {
  const names: string[] = [];
  const own = text(record(context.profile)?.allergies);
  if (own) names.push(own);
  for (const member of list(context.family)) {
    const allergy = text(record(member)?.allergies);
    if (allergy) names.push(allergy);
  }
  names.push(...readClinicalFactNames(context, "allergy"));
  return [...new Set(names)];
}

/** Evidence a conference has that the coach context does not carry. */
export interface ConferenceConflictEvidence {
  /** Display labels of lifecycle symptoms currently ACTIVE and area-scoped.
   * `null` (the default) means nothing looked, not that nothing hurts. */
  activeSymptomAreas?: readonly string[] | null;
}

/** Read the typed conflict question sheet out of a conference context. Pure and
 * null-safe: an unrecognizable context answers nothing, and nothing fires.
 *
 * MUST be given the FULL context, not a bounded snapshot of it. The snapshot the
 * specialists receive is truncated to its first 50 keys, which silently drops
 * signal_state, health_focus, directives, health and supplements from the real
 * 73-key coach context — every reader below them would answer `null` forever.
 */
export function conferenceConflictInputs(
  context: unknown,
  evidence: ConferenceConflictEvidence = {}
): ConferenceConflictInputs {
  const root = record(context) ?? {};
  return {
    activeInjury: readActiveInjury(root, evidence.activeSymptomAreas ?? null),
    plannedLoadIncrease: readPlannedLoadIncrease(root),
    inDeficit: readInDeficit(root),
    recoveryStrain: readRecoveryStrain(root),
    raceCommitment: readRaceCommitment(root),
    strengthEmphasis: readStrengthEmphasis(root),
    clinicalAttention: readClinicalAttention(root),
    clinicalLever: readClinicalLever(root),
    mealPlanning: readMealPlanning(root),
    activeMedications: readClinicalFactNames(root, "medication"),
    activeSupplements: readSupplements(root),
    knownAllergies: readAllergies(root),
  };
}

/** The conflict rules themselves — one small named predicate each, so a rule can
 * be read (and tested) without reading the reader. */
export const CONFERENCE_CONFLICT_RULES: ReadonlyArray<{
  key: ConferenceConflictKey;
  fires: (inputs: ConferenceConflictInputs) => boolean;
}> = [
  // Loading a body part that is currently hurt.
  { key: "injury_load", fires: (i) => both(i.activeInjury, i.plannedLoadIncrease) },
  // Asking recovery to absorb work while the fuel to recover on is short.
  { key: "deficit_recovery", fires: (i) => both(i.inDeficit, i.recoveryStrain) },
  // Something the athlete takes on purpose meeting something they were prescribed.
  {
    key: "medication_supplement",
    fires: (i) => i.activeMedications.length > 0 && i.activeSupplements.length > 0,
  },
  // A hard food exclusion while food is actually being planned.
  { key: "allergy_meal", fires: (i) => i.knownAllergies.length > 0 && i.mealPlanning === true },
  // A dated race build competing with a strength/hypertrophy push.
  { key: "race_strength", fires: (i) => both(i.raceCommitment, i.strengthEmphasis) },
  // A clinical finding being propagated into a domain the brain can change itself.
  { key: "clinical_autonomy", fires: (i) => both(i.clinicalAttention, i.clinicalLever) },
];

/** Apply the rules to an already-read question sheet. */
export function conflictsFromInputs(inputs: ConferenceConflictInputs): ConferenceConflictKey[] {
  return CONFERENCE_CONFLICT_RULES.filter((rule) => rule.fires(inputs)).map((rule) => rule.key);
}

/** The deterministic cross-domain conflicts a conference must reconcile. Give it
 * the FULL context — see the note on conferenceConflictInputs. */
export function deterministicConferenceConflicts(
  context: unknown,
  evidence: ConferenceConflictEvidence = {}
): ConferenceConflictKey[] {
  return conflictsFromInputs(conferenceConflictInputs(context, evidence));
}

/**
 * The SECOND arm of the clinical lever, which can only be asked once the decision
 * exists.
 *
 * `clinicalLever` above wants a directive already propagated into training or
 * nutrition, but deriveDirectives frequently emits only a `watch` row for a flagged
 * marker — and the tension the conflict models (an act-now clinical finding while
 * the brain is about to change something on its own) is fully present without that
 * row. So a conference that has ACTUALLY produced a revision is itself the lever.
 * Broadening, never narrowing: a clinical floor may only ever gain reasons to hold.
 */
export function clinicalAutonomyFromRevision(inputs: ConferenceConflictInputs, hasRevision: boolean): boolean {
  return hasRevision && inputs.clinicalAttention === true;
}

/** Which specialist domains may close a conflict. */
export function conflictParties(key: ConferenceConflictKey): readonly SpecialistDomain[] {
  return CONFLICT_PARTIES[key] ?? [];
}

export interface ResolvedConflictClaim {
  key: string;
  resolution: string;
  evidence_key?: string | null;
}

/**
 * Which DETECTED conflicts the conductor actually resolved.
 *
 * Membership of the key used to be the whole test, and the prompt told the model
 * to list every conflict — so echoing the server's own list back at it dissolved
 * every conflict, which is a false negative wired straight into the contract. A
 * resolution now has to CITE: an `evidence_key` that really appears in the
 * evidence of a specialist who is a party to that conflict. An echo without a
 * verifiable citation leaves the conflict unresolved, and the existing demotion
 * applies unchanged. `clinical_autonomy` has no parties at all, so no citation
 * can close it — the clinician floor stays the server's.
 */
export function citedConflictResolutions(
  claims: readonly ResolvedConflictClaim[],
  conflicts: readonly ConferenceConflictKey[],
  opinions: readonly SpecialistOpinion[]
): Set<ConferenceConflictKey> {
  const detected = new Set<string>(conflicts);
  const resolved = new Set<ConferenceConflictKey>();
  for (const claim of claims) {
    const key = text(claim?.key) as ConferenceConflictKey;
    if (!detected.has(key)) continue;
    const parties = conflictParties(key);
    if (!parties.length) continue;
    const citation = text(claim?.evidence_key).toLowerCase();
    if (!citation) continue;
    const cited = opinions.some(
      (opinion) =>
        parties.includes(opinion.domain) &&
        opinion.evidence_keys.some((evidence) => text(evidence).toLowerCase() === citation)
    );
    if (cited) resolved.add(key);
  }
  return resolved;
}
