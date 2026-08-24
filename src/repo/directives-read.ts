// ============================================================================
// Reading the ACTIVE directive set — the row hydration, the identity of a
// directive, and the dedupe that collapses one concern said twice.
//
// A LEAF module by construction: it imports only `db`, the marker canon and the
// intent classifier (both already below coach), and it must never import
// coach.ts, propagation.ts or anything that reaches the coach context. That is
// the whole reason it exists as its own file. Eight modules ask "what is the
// athlete acting on right now?" — health-focus, health-export, nutrition-progress,
// marker-response, run-progression, team-week, today-agenda and propagation —
// and asking coach.ts closed a cycle back through whole-person-trajectory that
// only survived because every edge in it resolves at call time. Nothing in this
// closure reads the coach context, so the read belongs below it, not inside it.
//
// coach.ts re-exports `listActiveDirectives`, `hydrateDirective`, `directiveKey`,
// `directiveIntentOf` and `directiveIdentityKey`, so every existing caller and
// test keeps importing them from where they have always been. New callers should
// import from here — going through the re-export would keep the cycle edge alive.
// ============================================================================
import { db } from "../db.js";
import { canonicalMarker } from "./marker-canon.js";
import { classifyDirectiveIntent } from "./propagation-data.js";

// hydrate a stored row: surface `uncertain` as a boolean for consumers.
export function hydrateDirective(row: any) {
  if (!row) return row;
  return { ...row, uncertain: !!row.uncertain };
}

export function listActiveDirectives() {
  return dedupeActiveDirectives(
    (db.prepare(`SELECT * FROM health_directives WHERE status = 'active' ORDER BY id DESC`).all() as any[]).map(
      hydrateDirective
    )
  ).reverse();
}

// ---- the connected brain: endurance-limiting health directives ----
// Iron / oxygen-transport markers whose depletion caps endurance capacity — the
// canonical keys (marker-canon) an anemia/iron directive is built on. Matching on the
// structured `marker` field (canonicalized, so lab-name variants + a "low "/"high "
// label prefix all resolve) is robust where brittle text matching is not.
//
// This classification lives HERE, in the leaf, because two layers now act on the same
// morning's directive and they must not be able to disagree about which rows they are
// acting on: the run builder caps the week (run-progression.ts) and the day-planning
// signal state raises a brake on the same dimension (signal-state.ts). A second copy
// of the predicate is exactly how the Brief came to speak room the week already denied.
const ENDURANCE_LIMITING_MARKER_KEYS = new Set<string>([
  "ferritin",
  "hemoglobin",
  "hematocrit",
  "mean corpuscular volume",
  "serum iron",
  "transferrin saturation",
  "total iron binding capacity",
  "transferrin",
  "red blood cell count",
]);

// A cluster directive stores its marker as a "+"-joined label ("low ferritin+low
// hemoglobin+low MCV"). Split it, drop any leading flag word, and canonicalize each
// token to its stable merge key.
export function directiveMarkerKeys(marker: string | null | undefined): string[] {
  return String(marker ?? "")
    .split("+")
    .map((tok) => tok.replace(/^\s*(?:low|high|elevated|borderline|reduced|raised)\s+/i, "").trim())
    .filter(Boolean)
    .map((tok) => canonicalMarker(tok).key)
    .filter(Boolean);
}

// Does an active TRAINING directive counsel HOLDING endurance volume? Primary signal
// is the structured marker (an iron/oxygen-transport limiter); a conservative text
// fallback catches an explicitly-worded endurance hold when no marker resolves. A
// directive that ENCOURAGES aerobic work ("keep regular aerobic work") carries no hold
// verb and never matches, so a CV-cluster nudge to move more is left untouched.
export function isEnduranceHoldDirective(d: any): boolean {
  if (!d || String(d.domain) !== "training") return false;
  if (directiveMarkerKeys(d.marker).some((k) => ENDURANCE_LIMITING_MARKER_KEYS.has(k))) return true;
  const text = String(d.directive ?? "").toLowerCase();
  const holdVerb = /\b(hold|reduce|limit|cap|cut|lower|ease|scale back|pull back)\b/;
  const enduranceObj = /\b(endurance|aerobic|mileage|running|run volume|cardio)\b/;
  return holdVerb.test(text) && enduranceObj.test(text);
}

// WHAT the hold is waiting on, in plain words ("your iron stores"). One derivation,
// shared by the plan's own note and by the athlete-facing voice the signal state
// speaks, so the two surfaces name the same thing on the same morning.
export function enduranceHoldSubject(d: any): string {
  const keys = directiveMarkerKeys(d?.marker);
  const iron = keys.some((k) =>
    ["ferritin", "serum iron", "transferrin saturation", "total iron binding capacity", "transferrin"].includes(k)
  );
  const blood = keys.some((k) =>
    ["hemoglobin", "hematocrit", "red blood cell count", "mean corpuscular volume"].includes(k)
  );
  return iron && blood
    ? "your iron and hemoglobin"
    : iron
      ? "your iron stores"
      : blood
        ? "your hemoglobin"
        : "your bloodwork";
}

export function directiveKey(d: any): string {
  return [
    String(d?.domain || "watch").toLowerCase(),
    String(d?.marker || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim(),
    String(d?.directive_key || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim(),
  ].join("|");
}

function directiveTextKey(d: any): string {
  return String(d?.directive || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// The semantic intent of a stored row: the persisted intent_key, else classified from
// the directive text on the fly (legacy rows written before the intent_key column, and
// the cross-source suppression that must recognize them).
export function directiveIntentOf(d: any): string {
  const stored = d?.intent_key;
  if (stored === "recheck" || stored === "lever" || stored === "notice") return stored;
  return classifyDirectiveIntent(d?.directive, null);
}

// The stable IDENTITY of a directive across sources: (canonical marker, domain, intent).
// Same analyte under different lab names folds to one; a 'markers' directive and a
// 'health_review' one for the same finding+intent are recognized as the same concern,
// so one Done clears both and near-twins collapse. Marker-less rows key on "" (no
// cross-marker collapse). Cluster markers ("A+B+C") key on their own compound label.
export function directiveIdentityKey(d: any): string {
  const raw = String(d?.marker || "").trim();
  const canon = raw ? (raw.includes("+") ? raw.toLowerCase() : canonicalMarker(raw).key) : "";
  return `${canon}|${String(d?.domain || "watch").toLowerCase()}|${directiveIntentOf(d)}`;
}

// When two active directives share an identity tuple, keep the strongest evidence:
// a cited (settled-lever) directive beats an uncertain one, then the deterministic
// 'markers' source beats the agent 'health_review' one, then the newest wins.
function directivePreferred(a: any, b: any): any {
  const cited = (d: any) => (d?.citation && String(d.citation).trim() && !d?.uncertain ? 0 : 1);
  if (cited(a) !== cited(b)) return cited(a) < cited(b) ? a : b;
  const srcRank = (d: any) => (String(d?.source || "") === "markers" ? 0 : 1);
  if (srcRank(a) !== srcRank(b)) return srcRank(a) < srcRank(b) ? a : b;
  return a; // same evidence + source → keep the first-seen (the input order is id-DESC = newest)
}

export function dedupeActiveDirectives(rows: any[]) {
  const seenMarkerDomain = new Set<string>();
  const seenText = new Set<string>();
  const out: any[] = [];
  for (const row of rows) {
    const mdKey = directiveKey(row);
    const txtKey = directiveTextKey(row);
    if ((mdKey !== "|" && seenMarkerDomain.has(mdKey)) || (txtKey && seenText.has(txtKey))) continue;
    seenMarkerDomain.add(mdKey);
    if (txtKey) seenText.add(txtKey);
    out.push(row);
  }
  // Cross-source collapse on IDENTITY (canonical marker, domain, intent): when
  // 'markers' and 'health_review' both kept a directive for the SAME marker+domain+intent
  // (different directive_key, so they survived the dedup above), they read as one concern
  // said twice. Keep ONE — cited > deterministic 'markers' source > newest. Conservative:
  // only collapses when marker AND domain AND intent match; marker-less rows are untouched.
  const byMd = new Map<string, any>();
  const collapsed: any[] = [];
  for (const row of out) {
    const raw = String(row?.marker || "").trim();
    if (!raw) {
      collapsed.push(row);
      continue;
    } // no marker → never cross-collapse
    const key = directiveIdentityKey(row);
    const prior = byMd.get(key);
    if (!prior) {
      byMd.set(key, row);
      collapsed.push(row);
      continue;
    }
    // Replace the kept row in-place with the preferred of the two.
    const winner = directivePreferred(prior, row);
    if (winner !== prior) {
      const idx = collapsed.indexOf(prior);
      if (idx >= 0) collapsed[idx] = winner;
      byMd.set(key, winner);
    }
  }
  return collapsed;
}
