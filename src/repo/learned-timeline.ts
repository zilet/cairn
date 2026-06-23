import { listMemory, getOutcomeLearnings } from "./memory.js";
import { listDirectives } from "./coach.js";
import { listProposals } from "./profile.js";

// ============================================================================
// THE LEARNED TIMELINE — a calm, legible "what Cairn has understood about you"
// read. For a decade-long buddy, showing its working is what compounds trust.
//
// This is PULL-ONLY (you VISIT it, it is never a notification) and it EXPLAINS,
// it does NOT GRADE — no scores, no "accuracy %", no judgment anywhere. It is a
// thin, deterministic PROJECTION over data the rest of the app already owns:
//   - load-bearing memories (the durable person-model)        → "Understood about you"
//   - outcome learnings (suggestion → actual reconciliation)  → "What we tried & how it went"
//   - health directives the connected brain propagated         → "Connections it made"
//   - applied plan proposals (changes you accepted)            → "Plan changes you accepted"
//
// It calls EXISTING repo functions — it never duplicates their logic. Every
// source is read in its own try/catch so a missing table on an old DB (or a
// single bad source) degrades to fewer items, never a thrown read.
// ============================================================================

export type LearnedKind = "memory" | "learning" | "directive" | "applied" | "about_me" | "outcome";

export interface LearnedItem {
  when: string;          // ISO timestamp / date the understanding landed (best available)
  kind: LearnedKind;
  title: string;         // plain-language headline — NEVER a score
  detail?: string;       // optional plain-language elaboration
  source?: string;       // a quiet provenance hint (e.g. "memory:injury", "connected brain")
}

const DEFAULT_LIMIT = 40;
const HARD_CAP = 200;

// The load-bearing memory kinds — the durable person-model Cairn carries, the
// part worth showing as "understood about you" (mirrors memoryForCoach's set).
const LOAD_BEARING_KINDS = new Set(["constraint", "injury", "preference", "decision", "milestone", "goal"]);

// Plain, human label per memory kind for the timeline title prefix. Anything not
// listed falls through to a neutral framing.
const MEMORY_KIND_LABEL: Record<string, string> = {
  constraint: "A constraint to plan around",
  injury: "An injury to plan around",
  preference: "A preference",
  decision: "A decision you made",
  milestone: "A milestone",
  goal: "A goal",
};

// Normalize a SQLite "YYYY-MM-DD HH:MM:SS" / date / ISO string to a comparable
// ISO-ish string. Null-safe: a falsy stamp sorts oldest (empty string).
function toWhen(v: any): string {
  const s = String(v ?? "").trim();
  if (!s) return "";
  // SQLite datetime('now') is space-separated; make it ISO-ish for Date.parse + display.
  return s.includes(" ") && !s.includes("T") ? s.replace(" ", "T") : s;
}

// Trim + cap a free-text field to a calm length (never a wall of text).
function clip(v: any, max = 280): string {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

// Memories — the load-bearing, NON-superseded rows are "understood about you".
// listMemory already hides superseded rows by default; we additionally filter to
// the durable kinds so day-to-day chatter doesn't crowd the read.
function memoryItems(): LearnedItem[] {
  const out: LearnedItem[] = [];
  try {
    const rows = listMemory(200) as any[]; // superseded excluded by default
    for (const r of rows) {
      const kind = String(r?.kind ?? "");
      if (kind === "learning") continue; // surfaced separately as outcome learnings
      if (!LOAD_BEARING_KINDS.has(kind)) continue;
      const content = clip(r?.content, 280);
      if (!content) continue;
      out.push({
        when: toWhen(r?.updated_at || r?.created_at),
        kind: "memory",
        title: MEMORY_KIND_LABEL[kind] || "Understood about you",
        detail: content,
        source: `memory:${kind}`,
      });
    }
  } catch { /* memory table absent on a very old DB — skip this source */ }
  return out;
}

// Outcome learnings — the gentle observations from suggestion → actual
// reconciliation ("trained on a suggested rest day and it went fine → tolerates
// higher frequency"). getOutcomeLearnings already returns live, newest-first.
function learningItems(): LearnedItem[] {
  const out: LearnedItem[] = [];
  try {
    const { learnings } = getOutcomeLearnings(30);
    for (const l of learnings) {
      const content = clip(l?.content, 320);
      if (!content) continue;
      out.push({
        when: toWhen(l?.noticed_at),
        kind: "learning",
        title: "What we tried, and how it went",
        detail: content,
        source: "outcome-learning",
      });
    }
  } catch { /* memory table absent — skip */ }
  return out;
}

// Health directives — what the connected brain CONCLUDED from a marker and
// propagated across domains. We show both active AND resolved/dismissed (the
// full history is the point — "this is the connection it made, and you handled
// it"), newest-first. Each carries its plain rationale, never a score.
function directiveItems(): LearnedItem[] {
  const out: LearnedItem[] = [];
  try {
    const rows = listDirectives({ all: true }) as any[];
    for (const d of rows) {
      const directive = clip(d?.directive, 280);
      if (!directive) continue;
      const status = String(d?.status ?? "active");
      const marker = clip(d?.marker, 60);
      const domain = clip(d?.domain, 24);
      // "when" is the moment it landed/was handled: a resolved/dismissed row uses
      // status_at (when you acted), an active one uses created_at (when it was made).
      const when = status === "active" ? toWhen(d?.created_at) : toWhen(d?.status_at || d?.created_at);
      const rationale = clip(d?.rationale, 200);
      const handled = status === "resolved" ? " · you handled it" : status === "dismissed" ? " · you set it aside" : "";
      const bits = [marker ? `From ${marker}` : null, domain ? `${domain}` : null].filter(Boolean).join(" · ");
      out.push({
        when,
        kind: "directive",
        title: marker ? `A connection from ${marker}` : "A connection it made",
        detail: rationale ? `${directive} — ${rationale}` : directive,
        source: `connected brain${bits ? ` (${bits})` : ""}${handled}`,
      });
    }
  } catch { /* health_directives absent — skip */ }
  return out;
}

// Applied plan proposals — the changes Cairn proposed that YOU accepted. We read
// the proposal log and keep only status='applied'. The instruction (what you
// asked for / the coach's framing) is the plain-language "why".
function appliedItems(): LearnedItem[] {
  const out: LearnedItem[] = [];
  try {
    const rows = listProposals(200) as any[];
    for (const p of rows) {
      if (String(p?.status ?? "") !== "applied") continue;
      const instruction = clip(p?.instruction, 240);
      const parsed = p?.parsed || {};
      // A plain summary of WHAT changed, drawn from the parsed payload shape.
      let what = "Adjusted your plan";
      if (parsed.kind === "nutrition_target") what = "Tuned your nutrition target";
      else if (Array.isArray(parsed.days)) what = `Restructured your week (${parsed.days.length} days)`;
      else if (Array.isArray(parsed.changes) && parsed.changes.length) what = `Adjusted ${parsed.changes.length} prescription${parsed.changes.length === 1 ? "" : "s"}`;
      else if (Array.isArray(parsed.cardio) && parsed.cardio.length) what = "Prescribed your runs for the week";
      out.push({
        when: toWhen(p?.created_at),
        kind: "applied",
        title: "A plan change you accepted",
        detail: instruction ? `${what} — ${instruction}` : what,
        source: p?.agent ? `coach (${clip(p.agent, 40)})` : "coach",
      });
    }
  } catch { /* plan_proposals absent — skip */ }
  return out;
}

// Newest-first by `when`; a falsy/unparseable stamp sorts last (oldest). A pure
// string compare on the ISO-ish stamps is correct lexicographically AND cheap.
function byWhenDesc(a: LearnedItem, b: LearnedItem): number {
  const aw = a.when || "";
  const bw = b.when || "";
  if (aw === bw) return 0;
  if (!aw) return 1;   // unstamped → oldest
  if (!bw) return -1;
  return aw < bw ? 1 : -1;
}

// Dedup key: same kind + same detail (case-insensitive, whitespace-collapsed) is
// the same understanding surfaced twice (e.g. a memory re-observed). Keeps the
// first (newest, since we sort before deduping) occurrence.
function dedupKey(it: LearnedItem): string {
  return `${it.kind}|${(it.detail || it.title).toLowerCase().replace(/\s+/g, " ").trim()}`;
}

// Aggregate the legible "what Cairn has learned about you" timeline. Newest-first,
// deduped, bounded. Pure/deterministic/null-safe — each source already isolated in
// its own try/catch, so a single failing source only thins the read, never throws.
export function learnedTimeline(opts: { limit?: number } = {}): { items: LearnedItem[] } {
  const limit = Math.max(1, Math.min(HARD_CAP, Number(opts.limit) || DEFAULT_LIMIT));
  const all: LearnedItem[] = [
    ...memoryItems(),
    ...learningItems(),
    ...directiveItems(),
    ...appliedItems(),
  ];
  all.sort(byWhenDesc);
  const seen = new Set<string>();
  const items: LearnedItem[] = [];
  for (const it of all) {
    const k = dedupKey(it);
    if (seen.has(k)) continue;
    seen.add(k);
    items.push(it);
    if (items.length >= limit) break;
  }
  return { items };
}
