// ============================================================================
// THE TEAM'S WEEK — a calm, deterministic "week in review" read.
//
// The case conference literally runs four+ specialists and a decision ledger with
// falsifiable expectations, all of it invisible. This is the projection that makes
// their week FELT: over the last 7 local days it composes, from data the app
// already owns, what the team DID (applied/announced ledger decisions, coalesced to
// the LATEST state per thing so three successive target revisions read as one), what
// it FLAGGED for the athlete (new directives / held-for-review items, deduped to the
// actionable asks), what it is WATCHING (attention entries + still-maturing
// expectations, in plain words), how earlier calls LANDED (only the conclusive
// verdicts, in words), and the connection INSIGHTS surfaced this week — plus a
// bounded drain of the unseen backlog so nothing rots.
//
// Constitution-bound: words not scores (a count is a fact, never a grade), pull-
// never-push (this is a read you visit, never a notification), health findings are
// informational. Everything is concrete and dated. An empty week yields a
// genuinely short read, never filler.
//
// The read is NOT display-capped here: it returns the full coalesced/deduped/
// humanized set so REST + MCP both benefit and the client can put anything hidden
// by a display cap behind a quiet expander. Only generous safety bounds apply.
//
// Pure + deterministic given `asOf` (except the OPTIONAL, explicit backlog drain,
// which flips new→seen so a surfaced insight is not re-drained next week). Every
// source is read in its own try/catch so a missing table on an old DB degrades to
// fewer sections, never a thrown read.
//
// WHO MADE EACH CALL. Every change, and the `seats` summary, is attributed to one of
// the six seats (src/repo/team-seats.ts — Strength, Run, Recovery, Fuel, Body, Heart),
// read from the ledger row itself, so older rows are attributed too. Roles, never
// personas.
//
// SPOKEN, NOT LOGGED. Every line a person reads here goes through the team-week voice
// (src/repo/team-week-voice.ts): a progression names its lifts and the step, a landed
// call names its subject, what was expected and what happens next, a clinician-
// addressed directive becomes one line for the athlete and their doctor, and the lead
// is a sentence, never a wall of counts. The ledger's machine register is untouched.
// ============================================================================
import { db } from "../db.js";
import { specialistVoiceLine } from "../brain/specialist-voice.js";
import { updateInsight } from "./insights.js";
import { listActiveDirectives } from "./directives-read.js";
import { getBrainDecision, getBrainExpectation, listBrainDecisions, listBrainExpectations } from "./brain-decisions.js";
import type { BrainDecision } from "../brain/decision-contract.js";
import type { BrainExpectation } from "../brain/expectation-contract.js";
import { athleteUnits } from "./settings.js";
import type { WeightUnit } from "./display-words.js";
import { type TeamSeatKey, teamSeatForDecision, teamSeatRole } from "./team-seats.js";
import {
  composeTeamLead,
  decisionLiftMoves,
  decisionSubjectNoun,
  decisionSwaps,
  directiveForClinician,
  doctorLine,
  expectationClause,
  expectsSentence,
  landedSentence,
  type LiftMove,
  numberWord,
  progressionSentence,
  rotationSentence,
  seatLandedSentence,
  spokenChangeLine,
  spokenFlagText,
  spokenWatchReason,
  watchingSentence,
} from "./team-week-voice.js";
import { listAttentionSchedule } from "./attention.js";
import { canonicalMarker } from "./marker-canon.js";
import { markerGroup } from "./propagation.js";
import { getAppState, setAppState } from "./app-state.js";
import { vouchedRunCompliance, weeklyAerobicLoad } from "./sessions.js";
import { addDaysISO, clipText, joinList, localDateISO, parseDbTime } from "./shared.js";
import { type CutQualityRead, cutQualityRead, cutQualityWeekLine } from "./cut-quality.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { DAY_READ_ADHERENCE_METRIC, dayReadCallFromVerdict } from "./brain/read-adherence.js";
import { type ConclusiveDayReadCall, DAY_READ_LANDED_VARIANTS, dayReadLandedKey } from "./brain/day-read-call.js";

// app_state stamp bounding the unseen-insight backlog drain to once per LOCAL day
// (its value is the read's local day). See insightItems for why.
const BACKLOG_DRAIN_STAMP_KEY = "team_week_backlog_drain_date";

export type { TeamSeatKey } from "./team-seats.js";

export interface TeamWeekChange {
  text: string; // the spoken change line (coalesced to the latest state per thing)
  // Who made the call: the conference specialist's line when one is stored
  // ("Fuel: Hold 2,225 for two weeks."), else the seat's role word ("Strength").
  specialist: string | null;
  seat: TeamSeatKey; // the seat that made the call (src/repo/team-seats.ts)
  when: string; // local date the change landed / was made (YYYY-MM-DD)
}
export interface TeamWeekDomainGroup {
  domain: string; // canonical brain domain
  label: string; // plain domain label ("Nutrition")
  changes: TeamWeekChange[];
}
export interface TeamWeekFlag {
  kind: "directive" | "review";
  text: string;
  domain: string;
  when: string;
  marker: string | null; // the source lab marker, when this flag came from a directive — lets a
  // same-marker ask collapse across domains/wording (see collapseFlagsByMarker); review
  // decisions never carry one and always fall through to the text-based pass.
}
export interface TeamWeekWatch {
  text: string;
  through: string | null; // the date the read matures / next check is due
  source: "attention" | "expectation";
}
export interface TeamWeekLanded {
  text: string;
  verdict: string; // aligned | not_aligned (only conclusive verdicts surface)
  when: string;
  // Present only where the verdict alone would mis-tone the line: a morning read the
  // athlete worked past is the TEAM learning, never a warning, so it renders "quiet".
  tone?: "good" | "quiet";
  seat?: TeamSeatKey; // the seat whose call this was (absent on a morning-read line)
}
export interface TeamWeekInsight {
  id: number;
  text: string;
  when: string;
  backlog: boolean; // true = drained from the unseen backlog (older than this week)
}
export interface TeamWeekEndurance {
  text: string; // one quiet factual line (plan compliance when a run plan exists, else "moved X km over N outings")
  km: number; // this week's total endurance distance (runs + hikes + rides), a plain number never a score
  sessions: number; // count of endurance outings this week
  longest_km: number | null; // longest single outing (fuel-relevant), or null
}
export interface TeamWeekCut {
  text: string; // one plain line — present only during a confident, active cut (verdict !== 'insufficient')
}
export interface TeamWeekSeat {
  seat: TeamSeatKey;
  /** "Strength" | "Run" | "Recovery" | "Fuel" | "Body" | "Heart" */
  role: string;
  /** ONE spoken sentence: the seat's most material call this week, second person, plain ("Bench moved to 145 lb today."). */
  did: string;
  /** What the seat expects and by when, from the decision's own expectation ("Expects every set at six or more by Nov 30."); null when none is open. */
  expects: string | null;
  /** How the seat's last concluded call landed, in words with its subject ("The last step on the row landed as expected."); null when none concluded. */
  landed: string | null;
  /** Local date of the call (YYYY-MM-DD). */
  when: string;
}
/** Two seats pulling against each other, said once, with the lever and a what-if the athlete can open in chat. */
export interface TeamWeekLink {
  seats: TeamSeatKey[];
  /** "Two anchor lifts are sliding while your weight drops. Worth easing the deficit a touch, or anchoring protein around the press days." */
  text: string;
  /** A sentence to PREFILL chat with, never sent for the athlete: "What if I ease the cut?" */
  ask: string;
}
export interface TeamWeekRead {
  lead: string; // a short spoken summary — who led the week, then the one thing that needs you; "" on a genuinely empty week
  did: TeamWeekDomainGroup[];
  flagged: TeamWeekFlag[];
  watching: TeamWeekWatch[];
  landed: TeamWeekLanded[];
  insights: TeamWeekInsight[];
  endurance: TeamWeekEndurance | null; // present ONLY when endurance activity exists this week; never a nag/zero-shame line
  cut: TeamWeekCut | null; // present ONLY during a confident active cut — is strength holding as weight drops?
  seats: TeamWeekSeat[]; // at most 3, most material first; [] on a quiet week
  link: TeamWeekLink | null; // from the cut read when it says lifts are sliding during the cut; null otherwise
  changes_count: number; // how many changes the week holds (a count is a fact, not a grade)
}

// Plain domain labels for the brain's decision domains.
const DOMAIN_LABEL: Record<string, string> = {
  training: "Training",
  nutrition: "Nutrition",
  health: "Health",
  recovery: "Recovery",
  body: "Body",
  profile: "Profile",
  goal: "Goal",
  cross_domain: "Whole picture",
};
// A stable display order for the domain groups (clinical-to-lifestyle-ish).
const DOMAIN_ORDER = ["nutrition", "training", "recovery", "health", "body", "goal", "profile", "cross_domain"];

// Only CONCLUSIVE verdicts surface in "How it landed" — an inconclusive/canceled read
// is filler, so it is dropped, and the whole section is omitted when nothing
// conclusive closed this week. Each verdict is spoken with its subject, what was
// expected and what happens next (landedSentence, team-week-voice.ts).
const CONCLUSIVE_VERDICTS = new Set(["aligned", "not_aligned"]);

// Truncate to a readable budget WITHOUT ever clipping mid-word. Prefer ending on a
// sentence boundary that sits far enough into the budget (a complete thought, no
// ellipsis); otherwise cut at the last word boundary and append an ellipsis. Never
// returns a bare fragment like "Soluble fiber is held hig".
function clip(value: unknown, max = 150): string {
  return clipText(value, max, { collapseWhitespace: true, ellipsis: "…", wordBoundary: true, sentenceBoundary: true });
}

function localDayKey(value: unknown): string {
  const s = String(value ?? "");
  // A bare YYYY-MM-DD is already a local day key (effective_date, window_end) —
  // pass it through untouched (parseDbTime would read it as UTC midnight and
  // shift it back a day in western zones). A full timestamp is a UTC instant
  // (SQLite datetime('now')) and must be re-keyed to the LOCAL day, or evening
  // rows land on "tomorrow" and fall out of a today-anchored window.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = parseDbTime(s);
  return t ? localDateISO(t) : s.slice(0, 10);
}

function domainLabel(domain: unknown): string {
  const key = String(domain ?? "").toLowerCase();
  return (
    DOMAIN_LABEL[key] ||
    key
      .split(/[_\s]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ") ||
    "Whole picture"
  );
}

function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function byWhenDesc(a: { when: string }, b: { when: string }): number {
  return a.when < b.when ? 1 : a.when > b.when ? -1 : 0;
}

// A comparison-normalized form: lowercase, parentheticals and "in ~N weeks/months"
// time qualifiers stripped, punctuation flattened to single spaces. Two asks that
// differ only by a parenthetical or a timeframe collapse to the same string.
function normalizeForDedup(text: unknown): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\bin\s*~?\s*\d+\s*[–-]?\s*\d*\s*(day|week|month|yr|year)s?\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Order-independent token-subset test: every token in `a` also appears in `b`.
// A local equivalent of exercise-canon's isTokenSubset — kept here so a mid-string
// insertion ("fasting" landing between "your" and "lipid panel") no longer defeats
// the near-twin test the way a whole-string includes() check did (the shorter
// phrase is not a contiguous substring of the longer one, even though every word
// of it is present).
function tokenSet(norm: string): Set<string> {
  return new Set(norm.split(" ").filter(Boolean));
}
function isTokenSubset(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

// A text reduced to its comparable shape (normalized form, leading verb, token
// set), computed once and reused across every pairwise near-twin check below.
interface TextShape {
  norm: string;
  verb: string;
  tokens: Set<string>;
}
function textShape(raw: string): TextShape | null {
  const norm = normalizeForDedup(raw);
  if (!norm) return null;
  return { norm, verb: norm.split(" ")[0] ?? "", tokens: tokenSet(norm) };
}

// Two shapes are near-twins when they normalize identically, or share a leading
// verb AND one's token set is a subset of the other's — with at least 3 tokens on
// both sides, so a 1-2 word overlap ("recheck it") never counts as meaningful.
// The single definition of "near-twin" shared by dedupeNearTwins AND
// collapseFlagsByMarker's cross-domain fallback.
function isNearTwinShape(a: TextShape, b: TextShape): boolean {
  return (
    a.norm === b.norm ||
    (a.verb === b.verb &&
      a.verb.length > 2 &&
      a.tokens.size >= 3 &&
      b.tokens.size >= 3 &&
      (isTokenSubset(a.tokens, b.tokens) || isTokenSubset(b.tokens, a.tokens)))
  );
}

// Collapse near-twin items (see isNearTwinShape) keeping the LONGER, more
// specific original. Input order is preserved for the survivors.
function dedupeNearTwins<T>(items: T[], getText: (item: T) => string): T[] {
  const kept: { shape: TextShape; item: T }[] = [];
  for (const it of items) {
    const raw = String(getText(it) ?? "").trim();
    const shape = textShape(raw);
    if (!shape) continue;
    const twin = kept.find((k) => isNearTwinShape(shape, k.shape));
    if (twin) {
      if (raw.length > String(getText(twin.item) ?? "").trim().length) twin.item = it;
      continue;
    }
    kept.push({ shape, item: it });
  }
  return kept.map((k) => k.item);
}

// ---- did[]: applied/announced ledger decisions, coalesced, grouped by domain ---

// The read's shared context for speaking: the day it reads as and the athlete's units.
interface Voice {
  asOf: string;
  units: WeightUnit;
}

// A raw ledger change before coalescing (carries the fields coalescing keys off).
interface RawChange {
  summary: string;
  specialist: string | null; // the conference specialist's voice line, when one is stored
  seat: TeamSeatKey;
  when: string;
  kind: string;
  source: string;
  decision: BrainDecision;
}

// A coalesced line plus what the seats read off it: how material it is, and the
// decisions behind it (their expectations are what the seat expects).
interface ChangeLine extends TeamWeekChange {
  rank: number;
  decisions: BrainDecision[];
}

// How material a change is, for picking each seat's one call and ordering the seats.
// A structural change or a target retune outranks a single lift's tweak; a meal plan
// refresh or a scoped adaptation is the lightest.
const KIND_RANK: Readonly<Record<string, number>> = {
  case_conference: 4,
  training_structure: 3,
  nutrition_target: 3,
  goal_change: 3,
  recovery_adjustment: 3,
  training_target: 2,
  exercise_rotation: 2,
  lifestyle_adjustment: 2,
  meal_plan: 1,
};

// A "bare update" summary carries no information ("Nutrition target updated.") and
// is always dropped so a real change is never buried under filler. Matches only a
// WHOLE summary of the shape "<noun phrase> updated/adjusted/…" — a real sentence
// that merely contains the word "updated" is untouched.
function isFillerSummary(summary: string): boolean {
  const s = summary
    .trim()
    .replace(/[.\s]+$/, "")
    .toLowerCase();
  if (!s) return true;
  return /^[a-z][a-z '-]*\b(updated|adjusted|changed|revised|refreshed|tweaked|modified)$/.test(s);
}

function isRotation(raw: RawChange): boolean {
  return raw.kind === "exercise_rotation" || raw.source === "exercise-swap" || /^rotate\s+.+→/i.test(raw.summary);
}
function isAutoProgression(raw: RawChange): boolean {
  return (
    raw.kind === "training_target" &&
    (raw.source === "auto-progression" || /^auto-progression for day/i.test(raw.summary))
  );
}
function isNutritionTarget(raw: RawChange): boolean {
  return raw.kind === "nutrition_target";
}
function isMealPlan(raw: RawChange): boolean {
  return raw.kind === "meal_plan";
}

// Who made the call: the specialist's own line when the conference stored one, else
// the seat's role word — so attribution always shows, never a bare null.
function lineOf(raws: RawChange[], text: string, rank: number): ChangeLine {
  const latest = raws[0];
  return {
    text,
    specialist: latest.specialist ?? teamSeatRole(latest.seat),
    seat: latest.seat,
    when: latest.when,
    rank,
    decisions: raws.map((r) => r.decision),
  };
}

// Multiple revisions of the SAME thing collapse to ONE line reflecting the FINAL
// (latest) state, with how many passes it took said once there was more than one.
// The nutrition target and the meal plan are SEPARATE things — each is coalesced by
// its own family so a target retune and a meal-plan regeneration in the same week
// stay two distinct lines and never cross-count.
function latestStateLine(raws: RawChange[]): ChangeLine {
  const latest = raws[0];
  const line = spokenChangeLine(latest.summary, latest.kind);
  const suffix = raws.length >= 2 ? ` It settled after ${numberWord(raws.length)} passes.` : "";
  return lineOf(raws, `${line}${suffix}`, KIND_RANK[latest.kind] ?? 1);
}

// Exercise rotations coalesce into one spoken line built from the swaps the rows carry
// (their payload, else their "Rotate <from> → <to>" summary): "Swapped Hammer Curl for
// Barbell Curl and …". If none parse, the latest rotation's own words stand in.
function rotationLine(raws: RawChange[], voice: Voice): ChangeLine {
  const swaps = raws.flatMap((r) => decisionSwaps(r.decision));
  const text = rotationSentence(swaps, voice.asOf) ?? spokenChangeLine(raws[0].summary, raws[0].kind);
  return lineOf(raws, text, KIND_RANK.exercise_rotation);
}

// Auto-progressions collapse to one line that names the lifts and the step, read off
// each row's applied payload (latest move per lift wins) — never "across days 1, 2, 4".
// An older row with no per-lift payload is counted from its label instead.
function progressionLine(raws: RawChange[], voice: Voice): ChangeLine {
  const moves: LiftMove[] = [];
  const seen = new Set<string>();
  let counted = 0;
  for (const r of raws) {
    const own = decisionLiftMoves(r.decision);
    if (!own.length) {
      const m = /—\s*(\d+)\s*lift/i.exec(r.summary);
      counted += m ? Number(m[1]) : 0;
    }
    for (const move of own) {
      const key = move.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      moves.push(move);
    }
  }
  const text = progressionSentence(moves, { units: voice.units, asOf: voice.asOf, fallbackCount: counted });
  return lineOf(raws, text, moves.some((m) => m.move === "raised") ? 3 : 2);
}

// Coalesce one domain's raw changes into calm, latest-state lines: the nutrition-
// target / meal-plan / rotation / auto-progression families each collapse to one
// line; every other change is an individual line (near-duplicate literal repeats
// deduped). The result is sorted latest-first.
function coalesceDomainChanges(raws: RawChange[], voice: Voice): ChangeLine[] {
  const sorted = [...raws].sort(byWhenDesc);
  const targets: RawChange[] = [];
  const mealPlans: RawChange[] = [];
  const rotations: RawChange[] = [];
  const progressions: RawChange[] = [];
  const singles: RawChange[] = [];
  for (const raw of sorted) {
    if (isNutritionTarget(raw)) targets.push(raw);
    else if (isMealPlan(raw)) mealPlans.push(raw);
    else if (isAutoProgression(raw)) progressions.push(raw);
    else if (isRotation(raw)) rotations.push(raw);
    else singles.push(raw);
  }
  const lines: ChangeLine[] = [];
  if (targets.length) lines.push(latestStateLine(targets));
  if (mealPlans.length) lines.push(latestStateLine(mealPlans));
  if (rotations.length) lines.push(rotationLine(rotations, voice));
  if (progressions.length) lines.push(progressionLine(progressions, voice));
  for (const s of dedupeNearTwins(singles, (r) => r.summary)) {
    lines.push(lineOf([s], spokenChangeLine(s.summary, s.kind), KIND_RANK[s.kind] ?? 1));
  }
  return lines.sort(byWhenDesc);
}

function publicChange(line: ChangeLine): TeamWeekChange {
  return { text: line.text, specialist: line.specialist, seat: line.seat, when: line.when };
}

function didGroups(
  windowStart: string,
  asOf: string,
  voice: Voice
): { groups: TeamWeekDomainGroup[]; lines: ChangeLine[] } {
  const byDomain = new Map<string, RawChange[]>();
  try {
    const decisions = listBrainDecisions({ limit: 200 }).filter(
      (d) =>
        (d.status === "applied" || d.status === "announced") &&
        // "What the team did this week" must only carry things the team DID. An
        // observe-tier row is the ledger recording a fact it noticed — a periodization
        // block that opened on its own, say — and reading that back as team work
        // claims credit for something nobody decided. The learned timeline still shows
        // it; that surface is about what is true, not about who acted.
        d.autonomy_tier !== "observe"
    );
    for (const d of decisions) {
      // Window on when the team acted: an applied change lands at applied_at, an
      // announced one was decided at created_at (its effective_date may be future).
      const when = localDayKey(d.applied_at ?? d.created_at ?? d.effective_date);
      if (!when || when < windowStart || when > asOf) continue;
      const summary = String(d.summary ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (!summary || isFillerSummary(summary)) continue;
      const voiceLine = specialistVoiceLine(d.specialist, d.domain);
      const domain = String(d.domain ?? "cross_domain");
      const changes = byDomain.get(domain) ?? [];
      changes.push({
        summary,
        specialist: voiceLine ? voiceLine.line : null,
        seat: teamSeatForDecision(d),
        when,
        kind: String(d.kind ?? ""),
        source: String(d.source ?? ""),
        decision: d,
      });
      byDomain.set(domain, changes);
    }
  } catch {
    /* ledger absent/partial — this section is simply empty */
  }
  const groups: TeamWeekDomainGroup[] = [];
  const lines: ChangeLine[] = [];
  const order = [...DOMAIN_ORDER, ...[...byDomain.keys()].filter((k) => !DOMAIN_ORDER.includes(k))];
  for (const domain of order) {
    const raws = byDomain.get(domain);
    if (!raws || !raws.length) continue;
    const changes = coalesceDomainChanges(raws, voice);
    if (!changes.length) continue;
    lines.push(...changes);
    groups.push({ domain, label: domainLabel(domain), changes: changes.map(publicChange) });
  }
  return { groups, lines };
}

// ---- flagged[]: new directives + held-for-review decisions awaiting the athlete --

// An informational explainer is not a discrete ask — an Lp(a) "measure it once, it's
// not a diet you can change" baseline note — so it is excluded from "Waiting for you",
// which carries actionable asks. Matched by explicit "you already know this / it won't
// change" phrasing ONLY: a leading-statement heuristic ("<X> is …") was tried and
// removed because it wrongly dropped genuine imperative directives that open by naming
// the marker ("Folate is low — load up on leafy greens …", "Magnesium is on the low
// side — lean on nuts, seeds …").
function isInformationalNote(text: string): boolean {
  const s = text.trim();
  if (!s) return true;
  const lower = s.toLowerCase();
  return /\bnot a diet\b|\blargely genetic\b|\bmeasure (it|this) once\b|\bone[-\s]?time (measurement|baseline|test)\b|\bbaseline you (can't|cannot)\b/.test(
    lower
  );
}

// Structural pre-pass: collapse items that share the same CANONICAL marker key
// ("ApoB" and "Apolipoprotein B" both key to "apob") ONLY when they're genuinely
// the same ask — same domain (deriveDirectives emits at most one directive per
// domain per marker, so two same-domain rows for one marker are always a real
// duplicate/near-twin), OR the wording itself is a near-twin even across domains
// (see isNearTwinShape). A DIFFERENT domain with DIFFERENT wording — e.g. a
// nutrition action ("lower saturated fat...") and a watch retest reminder
// ("recheck ApoB in 12 weeks...") for the SAME marker — is two distinct, real
// asks that must both survive: MARKER_MAPPINGS routinely emits exactly that
// shape per marker (nutrition/training lever + a watch retest), and collapsing
// them would silently drop real cross-domain guidance from the digest. Items
// with no marker (review decisions never carry one) fall straight through
// untouched, to be collapsed — or not — by the later passes.
function collapseFlagsByMarker(items: TeamWeekFlag[]): TeamWeekFlag[] {
  interface MarkerCluster {
    key: string;
    domain: string;
    shape: TextShape | null;
    item: TeamWeekFlag;
  }
  type Slot = { kind: "cluster"; cluster: MarkerCluster } | { kind: "flag"; flag: TeamWeekFlag };
  const clusters: MarkerCluster[] = [];
  const slots: Slot[] = [];
  for (const it of items) {
    const key = it.marker ? canonicalMarker(it.marker).key : "";
    if (!key) {
      slots.push({ kind: "flag", flag: it });
      continue;
    }
    const shape = textShape(it.text);
    const match = clusters.find(
      (c) => c.key === key && (c.domain === it.domain || (shape && c.shape && isNearTwinShape(shape, c.shape)))
    );
    if (match) {
      if (it.text.length > match.item.text.length) {
        match.item = it;
        match.domain = it.domain;
        match.shape = shape;
      }
      continue;
    }
    const cluster: MarkerCluster = { key, domain: it.domain, shape, item: it };
    clusters.push(cluster);
    slots.push({ kind: "cluster", cluster });
  }
  return slots.map((s) => (s.kind === "cluster" ? s.cluster.item : s.flag));
}

// A deliberately simple, conservative recheck/retest verb match. No bare "order"
// — every shipped MARKER_MAPPINGS watch string already matches on
// recheck/retest/follow-up, and a bare \border\b risks a false positive on an
// unrelated future watch directive phrased "...in order to...".
const RECHECK_VERB_RE = /\b(recheck|retest|re-test|follow[\s-]?up)\b/i;

// A SEPARATE, coarser collapse scoped to the watch domain only: two watch asks
// whose MARKERS land in the same clinical marker group (the exact MARKER_GROUPS
// taxonomy getMarkerHistory uses for group/group_label — see markerGroup) AND
// both read as a recheck/retest request collapse to one, keeping the longer
// text. This is what actually closes the live lipid wart: deriveDirectives runs
// per-marker, so a lipid panel with ApoB + LDL-C + Non-HDL-C all flagged emits
// THREE separate watch directives with three DIFFERENT canonical marker keys —
// collapseFlagsByMarker (same marker only) never touches them. A different
// group, a non-watch domain, or watch text with no recheck-type verb are all
// left untouched (a marker-less item is never eligible — there's no group to
// compute), so they still get a shot at the text-based dedupeNearTwins pass.
function collapseWatchPanelRechecks(items: TeamWeekFlag[]): TeamWeekFlag[] {
  interface PanelCluster {
    group: string;
    item: TeamWeekFlag;
  }
  type Slot = { kind: "cluster"; cluster: PanelCluster } | { kind: "flag"; flag: TeamWeekFlag };
  const clusters: PanelCluster[] = [];
  const slots: Slot[] = [];
  for (const it of items) {
    const eligible = it.domain === "watch" && !!it.marker && RECHECK_VERB_RE.test(it.text);
    if (!eligible) {
      slots.push({ kind: "flag", flag: it });
      continue;
    }
    const group = markerGroup(it.marker as string).key;
    const match = clusters.find((c) => c.group === group);
    if (match) {
      if (it.text.length > match.item.text.length) match.item = it;
      continue;
    }
    const cluster: PanelCluster = { group, item: it };
    clusters.push(cluster);
    slots.push({ kind: "cluster", cluster });
  }
  return slots.map((s) => (s.kind === "cluster" ? s.cluster.item : s.flag));
}

// A flag before it is spoken: the dedupe passes compare the STORED wording (that is
// what makes two asks twins), and only the survivors are then put into words.
interface RawFlag extends TeamWeekFlag {
  decision: BrainDecision | null;
}

function spokenFlags(flags: RawFlag[], asOf: string): { items: TeamWeekFlag[]; doctor: boolean; reviews: number } {
  // Directives written for a clinician fold into ONE line for the athlete and their
  // doctor, placed where the newest of them sat — so the person reads one plain
  // sentence about the results, never a stack of notes addressed to someone else.
  const doctorMembers = flags.filter((f) => f.kind === "directive" && directiveForClinician(f.text));
  const items: TeamWeekFlag[] = [];
  let doctorPlaced = false;
  let reviews = 0;
  for (const f of flags) {
    if (f.kind === "directive" && doctorMembers.includes(f)) {
      if (doctorPlaced) continue;
      doctorPlaced = true;
      const markers = doctorMembers.map((m) => m.marker ?? "").filter(Boolean);
      items.push({
        kind: "directive",
        text: doctorLine(markers, asOf),
        domain: "watch",
        when: f.when,
        marker: markers[0] ?? null,
      });
      continue;
    }
    if (f.kind === "review") {
      reviews++;
      const noun = decisionSubjectNoun(f.decision);
      const article = /^[aeiou]/i.test(noun) ? "An" : "A";
      items.push({ ...publicFlag(f), text: spokenFlagText(f.text, `${article} ${noun} is waiting on your yes.`) });
      continue;
    }
    items.push({ ...publicFlag(f), text: spokenFlagText(f.text, "A suggestion from your latest labs.") });
  }
  return { items, doctor: doctorPlaced, reviews };
}

function publicFlag(f: RawFlag): TeamWeekFlag {
  return { kind: f.kind, text: f.text, domain: f.domain, when: f.when, marker: f.marker };
}

function flaggedItems(windowStart: string, asOf: string): { items: TeamWeekFlag[]; doctor: boolean; reviews: number } {
  const out: RawFlag[] = [];
  try {
    for (const d of listActiveDirectives() as any[]) {
      const when = localDayKey(d?.created_at);
      if (!when || when < windowStart || when > asOf) continue;
      const text = clip(d?.directive, 200);
      if (!text || isInformationalNote(text)) continue;
      const marker = d?.marker ? String(d.marker).trim() : "";
      out.push({
        kind: "directive",
        text,
        domain: String(d?.domain ?? "watch"),
        when,
        marker: marker || null,
        decision: null,
      });
    }
  } catch {
    /* directives table absent — skip */
  }
  try {
    for (const d of listBrainDecisions({ status: "review", limit: 60 })) {
      const when = localDayKey(d.created_at ?? d.effective_date);
      if (!when || when < windowStart || when > asOf) continue;
      const text = clip(d.summary, 200);
      if (!text || isInformationalNote(text)) continue;
      out.push({ kind: "review", text, domain: String(d.domain ?? "cross_domain"), when, marker: null, decision: d });
    }
  } catch {
    /* ledger absent — skip */
  }
  out.sort(byWhenDesc);
  // Three complementary passes, narrowest-scope first: (1) collapse same-marker
  // asks that are genuinely the same ask (collapseFlagsByMarker), (2) collapse
  // same-clinical-group watch-domain recheck asks across DIFFERENT markers
  // (collapseWatchPanelRechecks — the fix for a lipid panel flagging ApoB, LDL-C
  // and Non-HDL-C as three separate retest reminders), then (3) dedupe whatever
  // near-twins remain by wording alone (a directive and a held-for-review
  // decision that name the same thing with the same leading verb). Each pass
  // keeps the more specific (longer) survivor. A generous safety bound only —
  // the client applies the display cap. Then the survivors are spoken.
  const deduped = dedupeNearTwins(
    collapseWatchPanelRechecks(collapseFlagsByMarker(out) as RawFlag[]) as RawFlag[],
    (f) => f.text
  ).slice(0, 12);
  return spokenFlags(deduped, asOf);
}

// ---- watching[]: near-due attention entries + still-maturing expectations --------

function watchingItems(asOf: string, voice: Voice): TeamWeekWatch[] {
  const out: TeamWeekWatch[] = [];
  const horizon = addDaysISO(asOf, 21) ?? asOf; // "near" — the next few weeks
  // A change-check note names its decision; the person reads the lifts or swaps it
  // changed. A change with no structured subject keeps the note's own words.
  const changeNoun = (decisionId: number): string | null => {
    try {
      const decision = getBrainDecision(decisionId);
      if (!decision || (!decisionLiftMoves(decision).length && !decisionSwaps(decision).length)) return null;
      return decisionSubjectNoun(decision);
    } catch {
      return null;
    }
  };
  try {
    for (const entry of listAttentionSchedule({ includeReleased: false, limit: 100 })) {
      const due = entry.next_due ? localDayKey(entry.next_due) : "";
      if (!due || due < asOf || due > horizon) continue; // only genuinely upcoming checks
      const spoken = spokenWatchReason(entry, asOf, changeNoun);
      const text = spoken ? clip(spoken, 220) : "";
      if (!text) continue;
      out.push({ text, through: due, source: "attention" });
    }
  } catch {
    /* attention_schedule absent — skip */
  }
  try {
    // One line per question a change asked: the lifts one progression asked the same
    // "done as written?" of read as one sentence, never a row per lift.
    const groups = new Map<string, BrainExpectation[]>();
    for (const exp of listBrainExpectations({ status: "pending", limit: 100 })) {
      const end = localDayKey(exp.window_end);
      if (!end || end <= asOf) continue; // still maturing = window not yet closed
      if (exp.metric_key === DAY_READ_ADHERENCE_METRIC) continue; // a same-day check, not a watch
      const decision = getBrainDecision(exp.decision_id);
      if (!decision || (decision.status !== "applied" && decision.status !== "announced")) continue;
      const key = `${exp.decision_id}|${exp.metric_key}|${end}`;
      const list = groups.get(key) ?? [];
      list.push(exp);
      groups.set(key, list);
    }
    for (const exps of groups.values()) {
      const end = localDayKey(exps[0].window_end);
      const subjects = exps.map((e) => String(e.subject_key ?? "").trim()).filter(Boolean);
      const clause = expectationClause(exps[0], voice.units, subjects.length > 1 ? subjects : undefined);
      if (!clause) continue;
      out.push({ text: watchingSentence(clause, end, asOf), through: end, source: "expectation" });
    }
  } catch {
    /* ledger absent — skip */
  }
  // Dedup identical texts, keep the earliest `through`, then a generous safety bound.
  const seen = new Map<string, TeamWeekWatch>();
  for (const item of out) {
    const prior = seen.get(item.text);
    if (!prior) seen.set(item.text, item);
    else if (item.through && (!prior.through || item.through < prior.through)) seen.set(item.text, item);
  }
  return [...seen.values()].sort((a, b) => String(a.through ?? "").localeCompare(String(b.through ?? ""))).slice(0, 10);
}

// ---- the morning read, landed ---------------------------------------------------
//
// A day-read verdict judges the READ, not the athlete, so each of the read's calls
// speaks in its own words (DAY_READ_LANDED_VARIANTS, day-read-call.ts), through
// pickDayVariant keyed on the read's own date, never one literal.
function dayReadLandedLine(
  call: ConclusiveDayReadCall,
  kind: string,
  date: string
): { text: string; tone: "good" | "quiet" } {
  const key = dayReadLandedKey(call, kind);
  return {
    text: pickDayVariant(DAY_READ_LANDED_VARIANTS[key], date, `team_week_${key}`),
    tone: call === "held" ? "good" : "quiet",
  };
}

// A concluded change's words: its subject, what was expected and what happens next.
function changeLandedLine(
  verdict: "aligned" | "not_aligned",
  expectationId: number,
  decisionId: number,
  when: string,
  voice: Voice
): { text: string; noun: string; seat: TeamSeatKey | undefined } {
  const exp = getBrainExpectation(expectationId);
  const decision = getBrainDecision(decisionId);
  const noun = decisionSubjectNoun(decision, exp);
  const clause = exp ? expectationClause(exp, voice.units) : null;
  const stillInForce = decision?.status === "applied" || decision?.status === "announced";
  return {
    text: landedSentence({ verdict, noun, clause, stillInForce, date: when }),
    noun,
    seat: decision ? teamSeatForDecision(decision) : undefined,
  };
}

// ---- landed[]: evaluations that closed CONCLUSIVELY this week, verdict in words --
function landedItems(windowStart: string, asOf: string, voice: Voice): TeamWeekLanded[] {
  const out: TeamWeekLanded[] = [];
  try {
    const rows = db
      .prepare(
        `SELECT e.verdict AS verdict, e.evaluated_at AS evaluated_at, e.actual_json AS actual_json,
                x.id AS expectation_id, x.decision_id AS decision_id,
                x.metric_key AS metric_key, x.subject_key AS subject_key
           FROM brain_evaluations e
           JOIN brain_expectations x ON x.id = e.expectation_id
           JOIN brain_decisions d ON d.id = x.decision_id
          WHERE substr(e.evaluated_at, 1, 10) >= ? AND substr(e.evaluated_at, 1, 10) <= ?
          ORDER BY e.evaluated_at DESC, e.id DESC
          LIMIT 24`
      )
      // The SQL bound compares the raw UTC timestamp's day, which drifts ±1 from
      // the local day near midnight — widen it a day each side, then re-filter
      // exactly in the local frame below (isoDay re-keys UTC instants).
      .all(addDaysISO(windowStart, -1) ?? windowStart, addDaysISO(asOf, 1) ?? asOf) as any[];
    const seen = new Set<string>();
    for (const row of rows) {
      const when = localDayKey(row?.evaluated_at);
      if (when < windowStart || when > asOf) continue;
      const verdict = String(row?.verdict ?? "");
      if (!CONCLUSIVE_VERDICTS.has(verdict)) continue; // inconclusive/canceled is filler — drop it
      if (row?.metric_key === DAY_READ_ADHERENCE_METRIC) {
        // One line per SHAPE of morning, newest first — a week of day reads is a few
        // sentences about how the reads are calibrating, not seven rows of verdicts.
        let actual: Record<string, unknown> | null = null;
        try {
          actual = row?.actual_json ? JSON.parse(String(row.actual_json)) : null;
        } catch {
          actual = null;
        }
        const call = dayReadCallFromVerdict(verdict, actual);
        const kind = String(actual?.read_kind ?? "");
        const readDate = String(actual?.read_date ?? row?.subject_key ?? when);
        const line = call ? dayReadLandedLine(call, kind, readDate) : null;
        if (!line) continue;
        const key = `day_read|${call}|${call === "held" && kind !== "train" ? "quiet" : kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ text: line.text, verdict, when, tone: line.tone });
        if (out.length >= 6) break;
        continue;
      }
      const line = changeLandedLine(
        verdict as "aligned" | "not_aligned",
        Number(row?.expectation_id),
        Number(row?.decision_id),
        when,
        voice
      );
      const key = `${line.noun}|${verdict}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text: line.text, verdict, when, ...(line.seat ? { seat: line.seat } : {}) });
      if (out.length >= 6) break;
    }
  } catch {
    /* evaluations table absent — skip */
  }
  return out;
}

// ---- seats[]: who sat at the table this week, one call each ----------------------
//
// Each seat that made a call this week, with its most material call in one spoken
// sentence, what it expects and by when (the call's OWN open expectation, never an
// invented one), and how its last concluded call landed (the ledger's verdict). At most
// three, most material first; a quiet week has none.
const MAX_SEATS = 3;

// The last CONCLUSIVE verdict per seat, newest first, over the ledger's change
// expectations (the morning-read check is the read's calibration, not a seat's call).
function seatLastLanded(voice: Voice): Map<TeamSeatKey, string> {
  const out = new Map<TeamSeatKey, string>();
  try {
    const rows = db
      .prepare(
        `SELECT e.verdict AS verdict, e.evaluated_at AS evaluated_at, x.id AS expectation_id, x.decision_id AS decision_id
           FROM brain_evaluations e
           JOIN brain_expectations x ON x.id = e.expectation_id
          WHERE e.verdict IN ('aligned', 'not_aligned') AND x.metric_key != ?
          ORDER BY e.evaluated_at DESC, e.id DESC
          LIMIT 200`
      )
      .all(DAY_READ_ADHERENCE_METRIC) as any[];
    for (const row of rows) {
      const decision = getBrainDecision(Number(row?.decision_id));
      if (!decision) continue;
      const seat = teamSeatForDecision(decision);
      if (out.has(seat)) continue;
      const exp = getBrainExpectation(Number(row?.expectation_id));
      const when = localDayKey(row?.evaluated_at) || voice.asOf;
      out.set(seat, seatLandedSentence(row.verdict, decisionSubjectNoun(decision, exp), when));
    }
  } catch {
    /* evaluations absent — no landed words */
  }
  return out;
}

// The seat's open expectation: the earliest-maturing still-pending question asked by
// the decisions behind its chosen call, else by any of its calls this week.
function seatExpects(primary: BrainDecision[], others: BrainDecision[], voice: Voice): string | null {
  for (const decisions of [primary, others]) {
    const groups = new Map<string, BrainExpectation[]>();
    for (const d of decisions) {
      if (d.id == null) continue;
      try {
        for (const exp of listBrainExpectations({ decisionId: Number(d.id), status: "pending", limit: 50 })) {
          const end = localDayKey(exp.window_end);
          if (!end || end <= voice.asOf || exp.metric_key === DAY_READ_ADHERENCE_METRIC) continue;
          const key = `${exp.metric_key}|${end}`;
          const list = groups.get(key) ?? [];
          list.push(exp);
          groups.set(key, list);
        }
      } catch {
        /* ledger absent */
      }
    }
    const ordered = [...groups.values()].sort((a, b) => String(a[0].window_end).localeCompare(String(b[0].window_end)));
    for (const exps of ordered) {
      const subjects = [...new Set(exps.map((e) => String(e.subject_key ?? "").trim()).filter(Boolean))];
      const clause = expectationClause(exps[0], voice.units, subjects.length > 1 ? subjects : undefined);
      if (clause) return expectsSentence(clause, localDayKey(exps[0].window_end), voice.asOf);
    }
  }
  return null;
}

function seatItems(lines: ChangeLine[], voice: Voice): TeamWeekSeat[] {
  const bySeat = new Map<TeamSeatKey, ChangeLine[]>();
  for (const line of lines) {
    const list = bySeat.get(line.seat) ?? [];
    list.push(line);
    bySeat.set(line.seat, list);
  }
  if (!bySeat.size) return [];
  const chosen = [...bySeat.entries()].map(([seat, seatLines]) => {
    const best = [...seatLines].sort((a, b) => b.rank - a.rank || byWhenDesc(a, b))[0];
    return { seat, best, seatLines };
  });
  chosen.sort(
    (a, b) => b.best.rank - a.best.rank || b.seatLines.length - a.seatLines.length || byWhenDesc(a.best, b.best)
  );
  const landed = seatLastLanded(voice);
  return chosen.slice(0, MAX_SEATS).map(({ seat, best, seatLines }) => ({
    seat,
    role: teamSeatRole(seat),
    did: best.text,
    expects: seatExpects(
      best.decisions,
      seatLines.filter((l) => l !== best).flatMap((l) => l.decisions),
      voice
    ),
    landed: landed.get(seat) ?? null,
    when: best.when,
  }));
}

// ---- link: two seats pulling against each other, said once ------------------------
//
// Only from the existing cut read, and only when it says lifts are sliding during a
// confident cut: Strength and Fuel are pulling against each other, so the lever is
// named once with a what-if the athlete can open in chat (never sent for them).
export function teamWeekLink(cut: CutQualityRead | null | undefined, asOf: string): TeamWeekLink | null {
  if (!cut || !cut.active || cut.verdict !== "sliding") return null;
  const sliding = cut.strength.anchors.filter((a) => a.status === "regressing").map((a) => a.name);
  const first =
    sliding.length >= 2
      ? `${joinList(sliding.slice(0, 2))} are sliding while your weight drops.`
      : sliding.length === 1
        ? `${sliding[0]} is sliding while your weight drops.`
        : "A couple of anchor lifts are sliding while your weight drops.";
  const lever =
    cut.rate.vs_lean_safe === "above"
      ? "You're losing a little faster than the lean-safe pace, so easing the deficit a touch comes first; anchoring protein around the lifting days helps too."
      : pickDayVariant(
          [
            "Worth easing the deficit a touch, or anchoring protein around the lifting days.",
            "Easing the deficit a touch, or anchoring protein higher around the lifting days, would help you hold onto muscle.",
          ],
          asOf,
          "team_week_link_lever"
        );
  const ask = pickDayVariant(
    ["What if I ease the cut?", "What if I eased the deficit a little?"],
    asOf,
    "team_week_link_ask"
  );
  return { seats: ["strength", "fuel"], text: `${first} ${lever}`, ask };
}

// ---- insights[]: this week's surfaced connections + a bounded backlog drain ------
function insightItems(windowStart: string, asOf: string, drainBacklog: boolean): TeamWeekInsight[] {
  const out: TeamWeekInsight[] = [];
  try {
    const recent = db
      .prepare(
        `SELECT id, text, created_at FROM insights
          WHERE status IN ('new', 'seen')
            AND (kind IS NULL OR kind != 'weekly_read')
            AND substr(created_at, 1, 10) >= ? AND substr(created_at, 1, 10) <= ?
          ORDER BY id DESC LIMIT 4`
      )
      // UTC-day prefilter widened a day each side; exact local-frame filter below.
      .all(addDaysISO(windowStart, -1) ?? windowStart, addDaysISO(asOf, 1) ?? asOf) as any[];
    for (const row of recent) {
      const text = clip(row?.text, 200);
      if (!text) continue;
      const when = localDayKey(row?.created_at);
      if (when < windowStart || when > asOf) continue;
      out.push({ id: Number(row.id), text, when, backlog: false });
    }
  } catch {
    /* insights table absent — skip */
  }
  // At most one backlog drain per LOCAL day. The weekly card fetches this read on
  // ~every Today render, so without a day-gate the whole unseen backlog would flush
  // in a single day, each item flashing by once. The app_state stamp (keyed to the
  // read's local day) bounds it to one ≤2-item drain per day; week-over-week
  // idempotence still comes from flipping each surfaced item new→seen. A read-only
  // pass (drainBacklog:false) never enters here, so it never spends the day's drain.
  if (drainBacklog && getAppState(BACKLOG_DRAIN_STAMP_KEY) !== asOf) {
    try {
      // The oldest still-unseen connections from BEFORE this week. Surfacing them
      // here and flipping new→seen is the drain: they get one appearance in the
      // digest, then they will not re-drain next week (idempotent via the status).
      const stale = db
        .prepare(
          `SELECT id, text, created_at FROM insights
            WHERE status = 'new'
              AND (kind IS NULL OR kind != 'weekly_read')
              AND substr(created_at, 1, 10) < ?
            ORDER BY id ASC LIMIT 4`
        )
        // UTC-day prefilter widened a day; exact local-frame filter below keeps
        // the drain at ≤2 genuinely pre-window items (a filtered row is not
        // flipped to seen, so it drains cleanly on a later pass).
        .all(addDaysISO(windowStart, 1) ?? windowStart) as any[];
      let drained = 0;
      for (const row of stale) {
        if (drained >= 2) break;
        const text = clip(row?.text, 200);
        if (!text) continue;
        if (localDayKey(row?.created_at) >= windowStart) continue;
        drained++;
        out.push({ id: Number(row.id), text, when: localDayKey(row?.created_at), backlog: true });
        try {
          updateInsight(Number(row.id), { status: "seen" });
        } catch {
          /* a failed flip just means it may surface once more — never throws */
        }
      }
      // Stamp the day AFTER a successful pass so at most one drain happens per local
      // day (even when the backlog was empty — nothing can become backlog mid-day).
      setAppState(BACKLOG_DRAIN_STAMP_KEY, asOf);
    } catch {
      /* insights table absent — skip (stamp not set, so it retries next call) */
    }
  }
  return out;
}

// ---- lead: a short deterministic summary sentence (or "" on an empty week) --------
// ---- endurance: one quiet factual line, only when there was aerobic activity -------
// The team's week is strength-first, so a runner/hiker's aerobic work would otherwise
// go unspoken. This adds ONE plain, factual line — the plan's run compliance when a run
// plan exists, else "moved X km over N outings" — anchored to the current calendar week
// (matching getRunCompliance/getWeeklyStats). Emitted ONLY when endurance activity
// exists this week; never a nag, never a zero-shame "you didn't run" line.
function enduranceLine(asOf: string): TeamWeekEndurance | null {
  try {
    const monday = (() => {
      const d = new Date(asOf + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return d.toISOString().slice(0, 10);
    })();
    const aero = weeklyAerobicLoad(monday);
    if (!aero || aero.outings === 0) return null; // only when endurance activity exists
    const comp = vouchedRunCompliance(monday);
    // A run plan that can vouch for THIS week exists → frame as compliance
    // (prescribed vs actual); otherwise — including when the applied plan is a
    // fossil from an earlier week — the honest broad-aerobic "moved X km over N
    // outings", which never implies the athlete fell short of anything.
    const line = comp.prescribed_sessions > 0 ? comp.in_words : aero.in_words;
    const text = `${capitalize(String(line).trim())}.`;
    return { text, km: aero.km, sessions: aero.outings, longest_km: aero.longest_km };
  } catch {
    return null; // activities/plan tables absent → no line
  }
}

// ---- cut: one line only during a confident, active weight-loss phase --------------
// The goal-aware complement to the endurance line: while the athlete is genuinely
// leaning out, is strength holding as the weight drops? Silent off a cut and when the
// read is too thin to call (verdict 'insufficient') — never a nag, never a zero-shame line.
function safeCutRead(asOf: string): CutQualityRead | null {
  try {
    return cutQualityRead(asOf);
  } catch {
    return null; // profile/training tables absent → no line
  }
}

function safeUnits(): WeightUnit {
  try {
    return athleteUnits().weight;
  } catch {
    return "lb";
  }
}

/**
 * The deterministic team's-week ("week in review") read over the last 7 local days.
 * @param opts.asOf         local date to read as-of (default: today, local).
 * @param opts.drainBacklog when true (the human-facing weekly card), surface and
 *                          flip new→seen the oldest 1-2 unseen backlog insights so
 *                          nothing rots; read-only surfaces (MCP) pass false.
 * @param opts.cutRead      an already-computed cut read (the cut line and the link
 *                          both read it); computed here when absent.
 */
export function teamWeekRead(
  opts: { asOf?: string; drainBacklog?: boolean; cutRead?: CutQualityRead | null } = {}
): TeamWeekRead {
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.asOf)) ? String(opts.asOf) : localDateISO();
  const windowStart = addDaysISO(asOf, -6) ?? asOf;
  const drainBacklog = opts.drainBacklog === true;
  const voice: Voice = { asOf, units: safeUnits() };
  const did = didGroups(windowStart, asOf, voice);
  const flagged = flaggedItems(windowStart, asOf);
  const watching = watchingItems(asOf, voice);
  const landed = landedItems(windowStart, asOf, voice);
  const cutRead = opts.cutRead !== undefined ? opts.cutRead : safeCutRead(asOf);
  const seats = seatItems(did.lines, voice);
  const lead = composeTeamLead({
    asOf,
    topSeat: seats[0] ? { seat: seats[0].seat, role: seats[0].role, did: seats[0].did } : null,
    reviewAsks: flagged.reviews,
    doctorNote: flagged.doctor,
    suggestions: flagged.items.length - flagged.reviews - (flagged.doctor ? 1 : 0),
    watching: watching.length,
    landed: landed.length,
  });
  return {
    lead,
    did: did.groups,
    flagged: flagged.items,
    watching,
    landed,
    insights: insightItems(windowStart, asOf, drainBacklog),
    endurance: enduranceLine(asOf),
    cut: cutRead ? cutQualityWeekLine(cutRead) : null,
    seats,
    link: teamWeekLink(cutRead, asOf),
    changes_count: did.lines.length,
  };
}
