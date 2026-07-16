// ============================================================================
// THE TEAM'S WEEK — a calm, deterministic "here's what your team did" read.
//
// The case conference literally runs four+ specialists and a decision ledger with
// falsifiable expectations, all of it invisible. This is the projection that makes
// their week FELT: over the last 7 local days it composes, from data the app
// already owns, what the team DID (applied/announced ledger decisions, with the
// specialist voice attached when one is stored), what it FLAGGED for the athlete
// (new directives / held-for-review items), what it is WATCHING (attention entries
// + still-maturing expectations), how earlier calls LANDED (closed evaluations, in
// words), and the connection INSIGHTS surfaced this week — plus a bounded drain of
// the unseen backlog so nothing rots.
//
// Constitution-bound: words not scores (a count is a fact, never a grade), pull-
// never-push (this is a read you visit, never a notification), health findings are
// informational. Everything is concrete and dated. An empty week yields a
// genuinely short read, never filler.
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
import { addDaysISO, localDateISO } from "./shared.js";

// app_state stamp bounding the unseen-insight backlog drain to once per LOCAL day
// (its value is the read's local day). See insightItems for why.
const BACKLOG_DRAIN_STAMP_KEY = "team_week_backlog_drain_date";

export interface TeamWeekChange {
  text: string; // the plain change summary
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
  verdict: string; // aligned | not_aligned | inconclusive | canceled
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

// Plain words for an expectation metric key (the same vocabulary the Learned
// timeline uses; kept as a compact local map to avoid a cross-module dependency).
const METRIC_WORDS: Record<string, string> = {
  weight_trend_lb_wk: "weight trend",
  intake_to_weight_response: "intake-to-weight response",
  exercise_target_completion: "exercise completion",
  exercise_est_1rm_trend: "strength progression",
  session_performance_feedback: "session performance",
  joint_pain_or_soreness: "joint-pain or soreness",
  plan_day_adherence: "plan adherence",
  recovery_hrv_delta: "HRV response",
  recovery_rhr_delta: "resting-heart-rate response",
  sleep_duration_delta: "sleep response",
  marker_direction: "marker direction",
  body_measurement_direction: "body-measurement direction",
};
function metricWords(metric: unknown): string {
  const key = String(metric ?? "");
  return METRIC_WORDS[key] ?? key.replace(/_/g, " ");
}

// Verdict → athlete-facing words. No score ever crosses; the tone is qualitative.
const VERDICT_WORDS: Record<string, string> = {
  aligned: "landed as expected",
  not_aligned: "didn't land the way we expected",
  inconclusive: "couldn't be judged cleanly yet",
  canceled: "couldn't be tested",
};

function clip(value: unknown, max = 220): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
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

// ---- did[]: applied/announced ledger decisions, grouped by domain -----------
function didGroups(windowStart: string, asOf: string): TeamWeekDomainGroup[] {
  const byDomain = new Map<string, TeamWeekChange[]>();
  try {
    const decisions = listBrainDecisions({ limit: 200 }).filter((d) =>
      d.status === "applied" || d.status === "announced"
    );
    for (const d of decisions) {
      // Window on when the team acted: an applied change lands at applied_at, an
      // announced one was decided at created_at (its effective_date may be future).
      const when = isoDay(d.applied_at ?? d.created_at ?? d.effective_date);
      if (!when || when < windowStart || when > asOf) continue;
      const summary = clip(d.summary, 200);
      if (!summary) continue;
      const voice = specialistVoiceLine(d.specialist, d.domain);
      const domain = String(d.domain ?? "cross_domain");
      const changes = byDomain.get(domain) ?? [];
      changes.push({ text: summary, specialist: voice ? voice.line : null, when });
      byDomain.set(domain, changes);
    }
  } catch {
    /* ledger absent/partial — this section is simply empty */
  }
  const groups: TeamWeekDomainGroup[] = [];
  const order = [...DOMAIN_ORDER, ...[...byDomain.keys()].filter((k) => !DOMAIN_ORDER.includes(k))];
  for (const domain of order) {
    const changes = byDomain.get(domain);
    if (!changes || !changes.length) continue;
    changes.sort((a, b) => (a.when < b.when ? 1 : a.when > b.when ? -1 : 0));
    groups.push({ domain, label: domainLabel(domain), changes });
  }
  return groups;
}

// ---- flagged[]: new directives + held-for-review decisions awaiting the athlete
function flaggedItems(windowStart: string, asOf: string): TeamWeekFlag[] {
  const out: TeamWeekFlag[] = [];
  try {
    for (const d of listActiveDirectives() as any[]) {
      const when = isoDay(d?.created_at);
      if (!when || when < windowStart || when > asOf) continue;
      const text = clip(d?.directive, 220);
      if (!text) continue;
      out.push({ kind: "directive", text, domain: String(d?.domain ?? "watch"), when });
    }
  } catch {
    /* directives table absent — skip */
  }
  try {
    for (const d of listBrainDecisions({ status: "review", limit: 60 })) {
      const when = isoDay(d.created_at ?? d.effective_date);
      if (!when || when < windowStart || when > asOf) continue;
      const text = clip(d.summary, 220);
      if (!text) continue;
      out.push({ kind: "review", text, domain: String(d.domain ?? "cross_domain"), when });
    }
  } catch {
    /* ledger absent — skip */
  }
  out.sort((a, b) => (a.when < b.when ? 1 : a.when > b.when ? -1 : 0));
  return out.slice(0, 6);
}

// ---- watching[]: near-due attention entries + still-maturing expectations ----
function watchingItems(asOf: string): TeamWeekWatch[] {
  const out: TeamWeekWatch[] = [];
  const horizon = addDaysISO(asOf, 21) ?? asOf; // "near" — the next few weeks
  try {
    for (const entry of listAttentionSchedule({ includeReleased: false, limit: 100 })) {
      const due = entry.next_due ? isoDay(entry.next_due) : "";
      if (!due || due < asOf || due > horizon) continue; // only genuinely upcoming checks
      const text = clip(entry.reason, 220);
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
        text: `how your ${metricWords(exp.metric_key)} answers the ${domainLabel(decision.domain).toLowerCase()} change`,
        through: end,
        source: "expectation",
      });
    }
  } catch {
    /* ledger absent — skip */
  }
  // Dedup identical texts, keep the earliest `through`, bound the list.
  const seen = new Map<string, TeamWeekWatch>();
  for (const item of out) {
    const prior = seen.get(item.text);
    if (!prior) seen.set(item.text, item);
    else if (item.through && (!prior.through || item.through < prior.through)) seen.set(item.text, item);
  }
  return [...seen.values()]
    .sort((a, b) => String(a.through ?? "").localeCompare(String(b.through ?? "")))
    .slice(0, 5);
}

// ---- landed[]: evaluations that closed this week, verdict in words -----------
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
      const phrase = VERDICT_WORDS[verdict];
      if (!phrase) continue;
      const subject = metricWords(row?.metric_key);
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

// ---- insights[]: this week's surfaced connections + a bounded backlog drain --
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
      const text = clip(row?.text, 260);
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
        const text = clip(row?.text, 260);
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

// ---- lead: a short deterministic summary sentence (or "" on an empty week) ----
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
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return capitalize(`this week your team ${joined}.`);
}

/**
 * The deterministic team's-week read over the last 7 local days.
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
