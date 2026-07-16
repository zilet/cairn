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
// ============================================================================
import { db } from "../db.js";
import { specialistVoiceLine } from "../brain/specialist-voice.js";
import { listActiveDirectives, updateInsight } from "./coach.js";
import { getBrainDecision, listBrainDecisions, listBrainExpectations } from "./brain-decisions.js";
import { listAttentionSchedule } from "./attention.js";
import { getAppState, setAppState } from "./app-state.js";
import { addDaysISO, localDateISO, metricLabel } from "./shared.js";

// app_state stamp bounding the unseen-insight backlog drain to once per LOCAL day
// (its value is the read's local day). See insightItems for why.
const BACKLOG_DRAIN_STAMP_KEY = "team_week_backlog_drain_date";

export interface TeamWeekChange {
  text: string; // the plain change summary (coalesced to the latest state per thing)
  specialist: string | null; // the attributed specialist line, when one is stored
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
}
export interface TeamWeekInsight {
  id: number;
  text: string;
  when: string;
  backlog: boolean; // true = drained from the unseen backlog (older than this week)
}
export interface TeamWeekRead {
  lead: string; // a short deterministic summary sentence; "" on a genuinely empty week
  did: TeamWeekDomainGroup[];
  flagged: TeamWeekFlag[];
  watching: TeamWeekWatch[];
  landed: TeamWeekLanded[];
  insights: TeamWeekInsight[];
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

// Verdict → athlete-facing words. Only CONCLUSIVE verdicts surface in "How it
// landed" — an inconclusive/canceled read is filler, so it is dropped, and the
// whole section is omitted when nothing conclusive closed this week.
const VERDICT_WORDS: Record<string, string> = {
  aligned: "landed as expected",
  not_aligned: "didn't land the way we expected",
};
const CONCLUSIVE_VERDICTS = new Set(["aligned", "not_aligned"]);

// Truncate to a readable budget WITHOUT ever clipping mid-word. Prefer ending on a
// sentence boundary that sits far enough into the budget (a complete thought, no
// ellipsis); otherwise cut at the last word boundary and append an ellipsis. Never
// returns a bare fragment like "Soluble fiber is held hig".
function clip(value: unknown, max = 150): string {
  const s = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length <= max) return s;
  const window = s.slice(0, max);
  const sentenceEnd = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  if (sentenceEnd >= Math.floor(max * 0.5)) return window.slice(0, sentenceEnd + 1).trim();
  const lastSpace = window.lastIndexOf(" ");
  const cut = (lastSpace > 0 ? window.slice(0, lastSpace) : window).replace(/[\s,;:.!?…]+$/, "");
  return `${cut}…`;
}

function isoDay(value: unknown): string {
  return String(value ?? "").slice(0, 10);
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

// Collapse near-twin items (same normalized text, or same leading verb where one
// normalized form contains the other) keeping the LONGER, more specific original.
// Input order is preserved for the survivors.
function dedupeNearTwins<T>(items: T[], getText: (item: T) => string): T[] {
  const kept: { norm: string; verb: string; item: T }[] = [];
  for (const it of items) {
    const raw = String(getText(it) ?? "").trim();
    const norm = normalizeForDedup(raw);
    if (!norm) continue;
    const verb = norm.split(" ")[0] ?? "";
    const twin = kept.find(
      (k) =>
        k.norm === norm ||
        (k.verb === verb &&
          verb.length > 2 &&
          ((k.norm.length >= 8 && norm.includes(k.norm)) || (norm.length >= 8 && k.norm.includes(norm))))
    );
    if (twin) {
      if (raw.length > String(getText(twin.item) ?? "").trim().length) twin.item = it;
      continue;
    }
    kept.push({ norm, verb, item: it });
  }
  return kept.map((k) => k.item);
}

// ---- did[]: applied/announced ledger decisions, coalesced, grouped by domain ---

// A raw ledger change before coalescing (carries the fields coalescing keys off).
interface RawChange {
  summary: string;
  specialist: string | null;
  when: string;
  kind: string;
  source: string;
}

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
    raw.kind === "training_target" && (raw.source === "auto-progression" || /^auto-progression for day/i.test(raw.summary))
  );
}
function isNutritionTarget(raw: RawChange): boolean {
  return raw.kind === "nutrition_target";
}
function isMealPlan(raw: RawChange): boolean {
  return raw.kind === "meal_plan";
}

// Multiple revisions of the SAME thing collapse to ONE line reflecting the FINAL
// (latest) state, suffixed with the revision count once there was more than one.
// The nutrition target and the meal plan are SEPARATE things — each is coalesced by
// its own family so a target retune and a meal-plan regeneration in the same week
// stay two distinct lines and never cross-count.
function latestStateLine(raws: RawChange[]): TeamWeekChange {
  const latest = raws[0];
  const suffix = raws.length >= 2 ? ` (settled after ${raws.length} revisions)` : "";
  return { text: `${clip(latest.summary)}${suffix}`, specialist: latest.specialist, when: latest.when };
}

// Exercise rotations coalesce into one compact "Rotated: A → B · C → D" line built
// from the structured "Rotate <from> → <to> on day <d>" summaries. If none parse,
// the latest rotation summary stands in (still one line).
function rotationLine(raws: RawChange[]): TeamWeekChange {
  const pairs: string[] = [];
  const seen = new Set<string>();
  for (const r of raws) {
    const m = /^rotate\s+(.+?)\s+→\s+(.+?)(?:\s+on day\b.*)?$/i.exec(r.summary);
    if (!m) continue;
    const from = m[1].trim();
    const to = m[2].trim();
    const key = `${from.toLowerCase()}→${to.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push(`${from} → ${to}`);
  }
  if (pairs.length) {
    const shown = pairs.slice(0, 3);
    const extra = pairs.length - shown.length;
    const text = `Rotated: ${shown.join(" · ")}${extra > 0 ? ` · +${extra} more` : ""}`;
    return { text, specialist: raws[0].specialist, when: raws[0].when };
  }
  return { text: clip(raws[0].summary), specialist: raws[0].specialist, when: raws[0].when };
}

// Auto-progressions collapse to one line: "Auto-progressed <N> lifts on day <D>"
// (or "across days D1, D2"), summing the lift counts the structured summaries carry.
function progressionLine(raws: RawChange[]): TeamWeekChange {
  let lifts = 0;
  const days = new Set<number>();
  for (const r of raws) {
    const m = /^auto-progression for day\s+(\d+)\s*—\s*(\d+)\s*lift/i.exec(r.summary);
    if (!m) continue;
    days.add(Number(m[1]));
    lifts += Number(m[2]);
  }
  if (lifts > 0) {
    const dayList = [...days].sort((a, b) => a - b);
    const where = dayList.length === 1 ? `on day ${dayList[0]}` : `across days ${dayList.join(", ")}`;
    return {
      text: `Auto-progressed ${lifts} lift${lifts === 1 ? "" : "s"} ${where}`,
      specialist: raws[0].specialist,
      when: raws[0].when,
    };
  }
  return { text: clip(raws[0].summary), specialist: raws[0].specialist, when: raws[0].when };
}

// Coalesce one domain's raw changes into calm, latest-state lines: the nutrition-
// target / meal-plan / rotation / auto-progression families each collapse to one
// line; every other change is an individual line (near-duplicate literal repeats
// deduped). The result is sorted latest-first.
function coalesceDomainChanges(raws: RawChange[]): TeamWeekChange[] {
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
  const lines: TeamWeekChange[] = [];
  if (targets.length) lines.push(latestStateLine(targets));
  if (mealPlans.length) lines.push(latestStateLine(mealPlans));
  if (rotations.length) lines.push(rotationLine(rotations));
  if (progressions.length) lines.push(progressionLine(progressions));
  for (const s of dedupeNearTwins(singles, (r) => r.summary)) {
    lines.push({ text: clip(s.summary), specialist: s.specialist, when: s.when });
  }
  return lines.sort(byWhenDesc);
}

function didGroups(windowStart: string, asOf: string): TeamWeekDomainGroup[] {
  const byDomain = new Map<string, RawChange[]>();
  try {
    const decisions = listBrainDecisions({ limit: 200 }).filter(
      (d) => d.status === "applied" || d.status === "announced"
    );
    for (const d of decisions) {
      // Window on when the team acted: an applied change lands at applied_at, an
      // announced one was decided at created_at (its effective_date may be future).
      const when = isoDay(d.applied_at ?? d.created_at ?? d.effective_date);
      if (!when || when < windowStart || when > asOf) continue;
      const summary = String(d.summary ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (!summary || isFillerSummary(summary)) continue;
      const voice = specialistVoiceLine(d.specialist, d.domain);
      const domain = String(d.domain ?? "cross_domain");
      const changes = byDomain.get(domain) ?? [];
      changes.push({
        summary,
        specialist: voice ? voice.line : null,
        when,
        kind: String(d.kind ?? ""),
        source: String(d.source ?? ""),
      });
      byDomain.set(domain, changes);
    }
  } catch {
    /* ledger absent/partial — this section is simply empty */
  }
  const groups: TeamWeekDomainGroup[] = [];
  const order = [...DOMAIN_ORDER, ...[...byDomain.keys()].filter((k) => !DOMAIN_ORDER.includes(k))];
  for (const domain of order) {
    const raws = byDomain.get(domain);
    if (!raws || !raws.length) continue;
    const changes = coalesceDomainChanges(raws);
    if (changes.length) groups.push({ domain, label: domainLabel(domain), changes });
  }
  return groups;
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
  return /\bnot a diet\b|\blargely genetic\b|\bmeasure (it|this) once\b|\bone[-\s]?time (measurement|baseline|test)\b|\bbaseline you (can't|cannot)\b/.test(lower);
}

function flaggedItems(windowStart: string, asOf: string): TeamWeekFlag[] {
  const out: TeamWeekFlag[] = [];
  try {
    for (const d of listActiveDirectives() as any[]) {
      const when = isoDay(d?.created_at);
      if (!when || when < windowStart || when > asOf) continue;
      const text = clip(d?.directive, 200);
      if (!text || isInformationalNote(text)) continue;
      out.push({ kind: "directive", text, domain: String(d?.domain ?? "watch"), when });
    }
  } catch {
    /* directives table absent — skip */
  }
  try {
    for (const d of listBrainDecisions({ status: "review", limit: 60 })) {
      const when = isoDay(d.created_at ?? d.effective_date);
      if (!when || when < windowStart || when > asOf) continue;
      const text = clip(d.summary, 200);
      if (!text || isInformationalNote(text)) continue;
      out.push({ kind: "review", text, domain: String(d.domain ?? "cross_domain"), when });
    }
  } catch {
    /* ledger absent — skip */
  }
  out.sort(byWhenDesc);
  // Dedupe near-twins from the two sources (a directive and a held-for-review
  // decision that name the same panel with the same leading verb), keeping the more
  // specific. A generous safety bound only — the client applies the display cap.
  return dedupeNearTwins(out, (f) => f.text).slice(0, 12);
}

// ---- watching[]: near-due attention entries + still-maturing expectations --------

// Humanize an attention-schedule reason into a short label. A follow-up reason of
// the shape "Health review follow-up: <action> (<qualifier>)" reduces to "<action>",
// and any trailing parenthetical is dropped. Kept LOCAL to team-week per the wave
// brief — a shared helper is consolidated at integration.
function humanizeWatchReason(reason: unknown): string {
  let s = String(reason ?? "")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(/^[a-z][a-z\s-]{0,40}follow-up\s*:\s*/i, "");
  s = s.replace(/\s*\([^)]*\)\s*\.?\s*$/g, "").trim(); // trailing "(qualifier)" — even when a period follows
  s = s.replace(/[.\s]+$/, "");
  return s;
}

function watchingItems(asOf: string): TeamWeekWatch[] {
  const out: TeamWeekWatch[] = [];
  const horizon = addDaysISO(asOf, 21) ?? asOf; // "near" — the next few weeks
  try {
    for (const entry of listAttentionSchedule({ includeReleased: false, limit: 100 })) {
      const due = entry.next_due ? isoDay(entry.next_due) : "";
      if (!due || due < asOf || due > horizon) continue; // only genuinely upcoming checks
      const text = capitalize(clip(humanizeWatchReason(entry.reason), 160));
      if (!text) continue;
      out.push({ text, through: due, source: "attention" });
    }
  } catch {
    /* attention_schedule absent — skip */
  }
  try {
    for (const exp of listBrainExpectations({ status: "pending", limit: 100 })) {
      const end = isoDay(exp.window_end);
      if (!end || end <= asOf) continue; // still maturing = window not yet closed
      const decision = getBrainDecision(exp.decision_id);
      if (!decision || (decision.status !== "applied" && decision.status !== "announced")) continue;
      out.push({
        text: capitalize(`how your ${metricLabel(exp.metric_key)} answers the ${domainLabel(decision.domain).toLowerCase()} change`),
        through: end,
        source: "expectation",
      });
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
  return [...seen.values()]
    .sort((a, b) => String(a.through ?? "").localeCompare(String(b.through ?? "")))
    .slice(0, 10);
}

// ---- landed[]: evaluations that closed CONCLUSIVELY this week, verdict in words --
function landedItems(windowStart: string, asOf: string): TeamWeekLanded[] {
  const out: TeamWeekLanded[] = [];
  try {
    const rows = db
      .prepare(
        `SELECT e.verdict AS verdict, e.evaluated_at AS evaluated_at,
                x.metric_key AS metric_key, d.summary AS summary, d.domain AS domain
           FROM brain_evaluations e
           JOIN brain_expectations x ON x.id = e.expectation_id
           JOIN brain_decisions d ON d.id = x.decision_id
          WHERE substr(e.evaluated_at, 1, 10) >= ? AND substr(e.evaluated_at, 1, 10) <= ?
          ORDER BY e.evaluated_at DESC, e.id DESC
          LIMIT 24`
      )
      .all(windowStart, asOf) as any[];
    const seen = new Set<string>();
    for (const row of rows) {
      const verdict = String(row?.verdict ?? "");
      if (!CONCLUSIVE_VERDICTS.has(verdict)) continue; // inconclusive/canceled is filler — drop it
      const phrase = VERDICT_WORDS[verdict];
      if (!phrase) continue;
      const subject = metricLabel(row?.metric_key);
      const text = `${capitalize(subject)} ${phrase}`;
      const key = `${text}|${verdict}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text, verdict, when: isoDay(row?.evaluated_at) });
      if (out.length >= 6) break;
    }
  } catch {
    /* evaluations table absent — skip */
  }
  return out;
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
      .all(windowStart, asOf) as any[];
    for (const row of recent) {
      const text = clip(row?.text, 200);
      if (!text) continue;
      out.push({ id: Number(row.id), text, when: isoDay(row?.created_at), backlog: false });
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
            ORDER BY id ASC LIMIT 2`
        )
        .all(windowStart) as any[];
      for (const row of stale) {
        const text = clip(row?.text, 200);
        if (!text) continue;
        out.push({ id: Number(row.id), text, when: isoDay(row?.created_at), backlog: true });
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
function composeLead(read: Omit<TeamWeekRead, "lead">): string {
  const changes = read.did.reduce((sum, group) => sum + group.changes.length, 0);
  const parts: string[] = [];
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (changes) parts.push(`made ${plural(changes, "change", "changes")}`);
  if (read.flagged.length) parts.push(`flagged ${plural(read.flagged.length, "thing", "things")} for you`);
  if (read.watching.length) parts.push(`is watching ${plural(read.watching.length, "response", "responses")}`);
  if (read.landed.length && !changes && !read.watching.length)
    parts.push(`checked how ${plural(read.landed.length, "call", "calls")} landed`);
  if (!parts.length) return "";
  const joined =
    parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return capitalize(`this week your team ${joined}.`);
}

/**
 * The deterministic team's-week ("week in review") read over the last 7 local days.
 * @param opts.asOf         local date to read as-of (default: today, local).
 * @param opts.drainBacklog when true (the human-facing weekly card), surface and
 *                          flip new→seen the oldest 1-2 unseen backlog insights so
 *                          nothing rots; read-only surfaces (MCP) pass false.
 */
export function teamWeekRead(opts: { asOf?: string; drainBacklog?: boolean } = {}): TeamWeekRead {
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.asOf)) ? String(opts.asOf) : localDateISO();
  const windowStart = addDaysISO(asOf, -6) ?? asOf;
  const drainBacklog = opts.drainBacklog === true;
  const body: Omit<TeamWeekRead, "lead"> = {
    did: didGroups(windowStart, asOf),
    flagged: flaggedItems(windowStart, asOf),
    watching: watchingItems(asOf),
    landed: landedItems(windowStart, asOf),
    insights: insightItems(windowStart, asOf, drainBacklog),
  };
  return { lead: composeLead(body), ...body };
}
