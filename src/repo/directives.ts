// Health directives — the connected brain's write/lifecycle side, split out of
// coach.ts. The active-directive READ lives in ./directives-read.js; this module
// owns creation, the status lifecycle and the per-source reconcile. Re-exported
// through src/repo.ts, so callers are unchanged.
import { db } from "../db.js";
import { getAppState, setAppState } from "./app-state.js";
import { dedupeActiveDirectives, directiveIdentityKey, hydrateDirective } from "./directives-read.js";
// Function-level cycle (doctor-loop imports listDirectives back from here);
// scheduleDirectiveRecheck is only called at runtime inside updateDirective, so
// the hoisted binding is always resolved by call time.
import { scheduleDirectiveRecheck } from "./doctor-loop.js";
import { discardDayRead } from "./intelligence.js";
import { markerSide, matchOptimalZone, prioritizeMarkers } from "./propagation.js";
import { classifyDirectiveIntent } from "./propagation-data.js";

// ---------- health directives (the connected brain — Phase 4C / T4) ----------
// A flagged/sub-optimal finding (a lab marker, a pattern) propagated into every
// domain it touches — nutrition, training, watch — grounded in reputable
// guideline citations where the lever is well-established, flagged uncertain
// (citation null) where the mapping is real but not settled. INFORMATIONAL, not
// medical advice. Two sources coexist: 'markers' (deterministic propagation
// engine) and 'health_review' (agent-emitted on a saved review).
export interface DirectiveInput {
  source?: string | null; // markers | health_review
  domain?: string | null; // nutrition | training | watch
  marker?: string | null; // the source marker key (e.g. 'LDL-C') when applicable
  directive_key?: string | null; // stable advice family key for repeat suppression
  intent_key?: string | null; // semantic intent: recheck | lever | notice (identity axis)
  directive?: string | null;
  rationale?: string | null;
  citation?: string | null;
  uncertain?: boolean; // 1 when the lever is real but not settled
  status?: string | null; // active | resolved | dismissed
  status_at?: string | null;
  trigger_value?: number | null;
  trigger_side?: string | null; // low | high | unknown
  trigger_date?: string | null;
  resurfaced_from_id?: number | null;
}

export const DIRECTIVE_DOMAINS = new Set(["nutrition", "training", "watch"]);
const DIRECTIVE_STATUSES = new Set(["active", "resolved", "dismissed"]);

export function normalizeDirectiveKey(v: any): string | null {
  const s = String(v ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 160);
  return s || null;
}

export function defaultDirectiveKey(marker: string | null, domain: string, directive: string | null): string | null {
  const directivePart = directive ? normalizeDirectiveKey(directive) : null;
  const parts = [
    marker ? normalizeDirectiveKey(marker) : null,
    normalizeDirectiveKey(domain),
    directivePart ? directivePart.slice(0, 90) : null,
  ].filter(Boolean);
  return parts.length ? parts.join(":") : null;
}

function directiveTriggerFromMarker(marker: string | null) {
  if (!marker) return null;
  const target = String(marker).toLowerCase();
  const { markers } = prioritizeMarkers();
  const m =
    markers.find((x: any) => String(x?.name || x?.key || "").toLowerCase() === target) ||
    markers.find((x: any) =>
      String(x?.name || x?.key || "")
        .toLowerCase()
        .includes(target)
    );
  if (!m) return null;
  const z = matchOptimalZone(m?.name);
  if (!z) return null;
  const value = typeof m?.latest?.value === "number" ? m.latest.value : Number(m?.latest?.value);
  if (!Number.isFinite(value)) return null;
  const flag: string | null = m?.latest?.flag === "low" || m?.latest?.flag === "high" ? m.latest.flag : null;
  return { value, side: markerSide(value, z, flag), date: m?.latest?.date ?? null };
}

export function addDirective(fields: DirectiveInput = {}) {
  const domain = DIRECTIVE_DOMAINS.has(String(fields.domain)) ? String(fields.domain) : "watch";
  const status = DIRECTIVE_STATUSES.has(String(fields.status)) ? String(fields.status) : "active";
  const marker = fields.marker == null ? null : String(fields.marker).trim().slice(0, 60) || null;
  const directive = fields.directive == null ? null : String(fields.directive).trim().slice(0, 600) || null;
  const directive_key =
    fields.directive_key == null
      ? defaultDirectiveKey(marker, domain, directive)
      : normalizeDirectiveKey(fields.directive_key);
  // The semantic intent (recheck | lever | notice) is part of directive identity. Prefer
  // an explicit value from the caller (the mapped path passes it); else classify the text.
  const intent_key =
    fields.intent_key === "recheck" || fields.intent_key === "lever" || fields.intent_key === "notice"
      ? fields.intent_key
      : classifyDirectiveIntent(directive, null);
  const triggerSide = ["low", "high", "unknown"].includes(String(fields.trigger_side))
    ? String(fields.trigger_side)
    : null;
  const triggerValue =
    fields.trigger_value == null || !Number.isFinite(Number(fields.trigger_value))
      ? null
      : Number(fields.trigger_value);
  const info = db
    .prepare(`INSERT INTO health_directives (source, domain, marker, directive_key, intent_key, directive, rationale, citation, uncertain, status, status_at, trigger_value, trigger_side, trigger_date, resurfaced_from_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      fields.source == null ? null : String(fields.source).trim().slice(0, 120) || null,
      domain,
      marker,
      directive_key,
      intent_key,
      directive,
      fields.rationale == null ? null : String(fields.rationale).trim().slice(0, 600) || null,
      fields.citation == null || String(fields.citation).trim() === ""
        ? null
        : String(fields.citation).trim().slice(0, 600),
      fields.uncertain ? 1 : 0,
      status,
      fields.status_at == null ? null : String(fields.status_at).trim().slice(0, 40) || null,
      triggerValue,
      triggerSide,
      fields.trigger_date == null ? null : String(fields.trigger_date).trim().slice(0, 20) || null,
      fields.resurfaced_from_id == null || !Number.isFinite(Number(fields.resurfaced_from_id))
        ? null
        : Number(fields.resurfaced_from_id)
    );
  return getDirective(Number(info.lastInsertRowid));
}

export function getDirective(id: number) {
  return hydrateDirective(db.prepare(`SELECT * FROM health_directives WHERE id = ?`).get(id) ?? null);
}

// Defaults to the active set (what the user/coach should act on); pass
// { all: true } for the full history incl. resolved/dismissed.
export function listDirectives(opts: { all?: boolean } = {}) {
  const rows = opts.all
    ? (db.prepare(`SELECT * FROM health_directives ORDER BY id DESC`).all() as any[])
    : (db.prepare(`SELECT * FROM health_directives WHERE status = 'active' ORDER BY id DESC`).all() as any[]);
  const hydrated = rows.map(hydrateDirective);
  return opts.all ? hydrated : dedupeActiveDirectives(hydrated);
}

// Monotonic counter bumped on every USER directive status flip. It feeds the derive
// signature so a Done/Dismiss (which changes what's suppressed) always forces the next
// propagation pass instead of short-circuiting on an unchanged marker snapshot.
const DIRECTIVE_FEEDBACK_COUNTER_KEY = "directive_feedback_counter";
export function directiveFeedbackCounter(): string {
  return getAppState(DIRECTIVE_FEEDBACK_COUNTER_KEY) || "0";
}
function bumpDirectiveFeedbackCounter(): void {
  const n = Number(getAppState(DIRECTIVE_FEEDBACK_COUNTER_KEY) || "0");
  setAppState(DIRECTIVE_FEEDBACK_COUNTER_KEY, String((Number.isFinite(n) ? n : 0) + 1));
}

// Cascade a USER status flip to every ACTIVE twin sharing the row's identity tuple
// (any source), so one Done/Dismiss clears the deterministic 'markers' directive AND
// its agent-emitted 'health_review' echo at once. Uses the SAME status_at as the
// primary flip so the feedback timeline stays coherent. Returns the number of twins
// updated. Machine soft-resolves never call this (they go through direct SQL).
function cascadeDirectiveStatus(primary: any, status: string): number {
  if (!primary || (status !== "resolved" && status !== "dismissed")) return 0;
  const identity = directiveIdentityKey(primary);
  const statusAt = primary.status_at ?? null;
  const rows = db
    .prepare(`SELECT * FROM health_directives WHERE status = 'active' AND id != ?`)
    .all(Number(primary.id)) as any[];
  let changed = 0;
  for (const r of rows) {
    if (directiveIdentityKey(r) !== identity) continue;
    db.prepare(`UPDATE health_directives SET status = ?, status_at = ? WHERE id = ?`).run(status, statusAt, r.id);
    changed++;
  }
  return changed;
}

export function updateDirective(id: number, fields: DirectiveInput) {
  const cur = getDirective(id) as any;
  if (!cur) return null;
  const sets: string[] = [];
  const vals: any[] = [];
  let statusChanged = false;
  let nextStatus = cur.status;
  if (fields.source !== undefined) {
    sets.push("source = ?");
    vals.push(fields.source == null ? null : String(fields.source).trim().slice(0, 120) || null);
  }
  if (fields.domain !== undefined) {
    sets.push("domain = ?");
    vals.push(DIRECTIVE_DOMAINS.has(String(fields.domain)) ? String(fields.domain) : cur.domain);
  }
  if (fields.marker !== undefined) {
    sets.push("marker = ?");
    vals.push(fields.marker == null ? null : String(fields.marker).trim().slice(0, 60) || null);
  }
  if (fields.directive_key !== undefined) {
    sets.push("directive_key = ?");
    vals.push(fields.directive_key == null ? null : normalizeDirectiveKey(fields.directive_key));
  }
  if (fields.intent_key !== undefined) {
    sets.push("intent_key = ?");
    vals.push(
      fields.intent_key === "recheck" || fields.intent_key === "lever" || fields.intent_key === "notice"
        ? fields.intent_key
        : classifyDirectiveIntent(fields.directive ?? cur.directive, null)
    );
  }
  if (fields.directive !== undefined) {
    sets.push("directive = ?");
    vals.push(fields.directive == null ? null : String(fields.directive).trim().slice(0, 600) || null);
  }
  if (fields.rationale !== undefined) {
    sets.push("rationale = ?");
    vals.push(fields.rationale == null ? null : String(fields.rationale).trim().slice(0, 600) || null);
  }
  if (fields.citation !== undefined) {
    sets.push("citation = ?");
    vals.push(
      fields.citation == null || String(fields.citation).trim() === ""
        ? null
        : String(fields.citation).trim().slice(0, 600)
    );
  }
  if (fields.uncertain !== undefined) {
    sets.push("uncertain = ?");
    vals.push(fields.uncertain ? 1 : 0);
  }
  if (fields.status !== undefined) {
    nextStatus = DIRECTIVE_STATUSES.has(String(fields.status)) ? String(fields.status) : cur.status;
    sets.push("status = ?");
    vals.push(nextStatus);
    statusChanged = nextStatus !== cur.status;
    if (nextStatus !== cur.status && fields.status_at === undefined) {
      sets.push("status_at = datetime('now')");
    }
  }
  if (statusChanged && !cur.directive_key && fields.directive_key === undefined) {
    sets.push("directive_key = ?");
    vals.push(defaultDirectiveKey(cur.marker ?? null, cur.domain || "watch", cur.directive ?? null));
  }
  if (statusChanged && (cur.trigger_value == null || !cur.trigger_side || !cur.trigger_date)) {
    const trigger = directiveTriggerFromMarker(cur.marker ?? null);
    if (trigger) {
      if (cur.trigger_value == null && fields.trigger_value === undefined) {
        sets.push("trigger_value = ?");
        vals.push(trigger.value);
      }
      if (!cur.trigger_side && fields.trigger_side === undefined) {
        sets.push("trigger_side = ?");
        vals.push(trigger.side);
      }
      if (!cur.trigger_date && fields.trigger_date === undefined) {
        sets.push("trigger_date = ?");
        vals.push(trigger.date);
      }
    }
  }
  if (fields.status_at !== undefined) {
    sets.push("status_at = ?");
    vals.push(fields.status_at == null ? null : String(fields.status_at).trim().slice(0, 40) || null);
  }
  if (fields.trigger_value !== undefined) {
    sets.push("trigger_value = ?");
    vals.push(
      fields.trigger_value == null || !Number.isFinite(Number(fields.trigger_value))
        ? null
        : Number(fields.trigger_value)
    );
  }
  if (fields.trigger_side !== undefined) {
    sets.push("trigger_side = ?");
    vals.push(["low", "high", "unknown"].includes(String(fields.trigger_side)) ? String(fields.trigger_side) : null);
  }
  if (fields.trigger_date !== undefined) {
    sets.push("trigger_date = ?");
    vals.push(fields.trigger_date == null ? null : String(fields.trigger_date).trim().slice(0, 20) || null);
  }
  if (fields.resurfaced_from_id !== undefined) {
    sets.push("resurfaced_from_id = ?");
    vals.push(
      fields.resurfaced_from_id == null || !Number.isFinite(Number(fields.resurfaced_from_id))
        ? null
        : Number(fields.resurfaced_from_id)
    );
  }
  if (sets.length) {
    vals.push(id);
    db.prepare(`UPDATE health_directives SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }
  const updated = getDirective(id);
  // A USER status flip to resolved/dismissed is feedback: bump the derive-signature
  // counter (so the next propagation pass never short-circuits past it) and cascade the
  // same verdict onto every ACTIVE twin sharing this directive's identity, so one Done
  // clears the 'markers' directive AND its 'health_review' echo at once.
  if (statusChanged && (nextStatus === "resolved" || nextStatus === "dismissed")) {
    bumpDirectiveFeedbackCounter();
    const twins = cascadeDirectiveStatus(updated, nextStatus);
    if (twins > 0) {
      try {
        // Deliberately the UNCONDITIONAL invalidation, not the fingerprint-aware one:
        // directives are not part of the deterministic decision (the fingerprint could
        // never move), yet the Brief's PROSE is written against the active training and
        // watch directives. A directive the athlete just cleared must stop being voiced,
        // and this is a rare, explicit athlete action — not telemetry churn. A DISCARD,
        // not the stale mark: the prose pin keys on the deterministic call, which a
        // directive never moves, so a kept sentence would go on voicing the cleared one.
        discardDayRead();
      } catch {
        /* cache bust is best-effort */
      }
    }
    // Marking a RECHECK directive Done ("Retest lipids in ~12 weeks", "Confirm
    // testosterone with a morning repeat") schedules the follow-up on the attention
    // engine so it actually comes back around, instead of the card just vanishing.
    // Only on Done (resolved) — a dismiss means "not relevant", never a new retest.
    // No-op for non-recheck directives. Best-effort; a hiccup never blocks the flip.
    if (nextStatus === "resolved") {
      try {
        scheduleDirectiveRecheck(updated);
      } catch {
        /* scheduling is additive; never block the status flip */
      }
    }
  }
  return updated;
}

// Whether an existing active row already carries the desired content, so a re-derive can
// leave it untouched (id + created_at preserved). Compares the fields the diff contract
// tracks — directive text, the trigger snapshot, AND the rationale/uncertain/citation
// content — after applying the same normalization addDirective would on insert, so a
// "kept" row truly equals a fresh write. The rationale/uncertain comparison matters
// because applyStaleness (propagation.ts) rewrites ONLY the rationale + uncertain of an
// aging directive (its text + trigger snapshot stay identical); without them here that
// staleness clause would be silently dropped as an "unchanged" row.
function directiveContentUnchanged(cur: any, d: DirectiveInput): boolean {
  const normText = (v: any) => (v == null ? null : String(v).trim().slice(0, 600) || null);
  const normDate = (v: any) => (v == null ? null : String(v).trim().slice(0, 20) || null);
  const numEq = (a: any, b: any) => {
    const an = a == null || !Number.isFinite(Number(a)) ? null : Number(a);
    const bn = b == null || !Number.isFinite(Number(b)) ? null : Number(b);
    if (an == null && bn == null) return true;
    if (an == null || bn == null) return false;
    return Math.abs(an - bn) < 1e-9;
  };
  const side = (v: any) => (["low", "high", "unknown"].includes(String(v)) ? String(v) : null);
  return (
    normText(cur.directive) === normText(d.directive) &&
    numEq(cur.trigger_value, d.trigger_value) &&
    side(cur.trigger_side) === side(d.trigger_side) &&
    normDate(cur.trigger_date) === normDate(d.trigger_date) &&
    normText(cur.rationale) === normText(d.rationale) &&
    normText(cur.citation) === normText(d.citation) &&
    !!cur.uncertain === !!d.uncertain
  );
}

// Diff-based reconcile of one source's ACTIVE directives toward a desired set — the
// zero-churn replacement for clear-all + reinsert. An existing active row with the same
// directive_key and unchanged content is KEPT untouched (id + created_at preserved); a
// changed one is UPDATED in place (status stays active, so no status_at stamp / cascade);
// a row no longer desired is SOFT-RESOLVED (status_at stays NULL — a machine resolve,
// never user feedback); a genuinely new directive is INSERTED. Idempotent: an unchanged
// desired set produces zero inserts/updates/resolves. Returns the change tally.
// `inScope` narrows which EXISTING active rows the pass owns: a scoped pass (the wearable
// re-derive on a sync — deriveWearableDirectives) reconciles only its own markers' rows and
// never soft-resolves a lab directive it did not compute. Omitted = the whole source.
export function reconcileDirectives(
  source: string,
  desired: DirectiveInput[],
  opts: { inScope?: (row: any) => boolean } = {}
) {
  const existing = (
    db.prepare(`SELECT * FROM health_directives WHERE source = ? AND status = 'active'`).all(source) as any[]
  ).filter((r) => !opts.inScope || opts.inScope(r));
  const existingByKey = new Map<string, any>();
  for (const r of existing) if (r.directive_key) existingByKey.set(String(r.directive_key), r);
  const desiredKeys = new Set<string>();
  const processed = new Set<string>();
  let inserted = 0;
  let updated = 0;
  let resolved = 0;
  for (const d of desired) {
    const key = d.directive_key
      ? normalizeDirectiveKey(d.directive_key)
      : defaultDirectiveKey(d.marker ?? null, String(d.domain || "watch"), d.directive ?? null);
    if (key) {
      desiredKeys.add(key);
      if (processed.has(key)) continue; // guard against a duplicate desired key within the run
      processed.add(key);
    }
    const cur = key ? existingByKey.get(key) : null;
    if (!cur) {
      addDirective(d);
      inserted++;
      continue;
    }
    if (directiveContentUnchanged(cur, d)) continue; // keep untouched
    updateDirective(cur.id, { ...d, status: undefined, status_at: undefined }); // in place, stays active
    updated++;
  }
  for (const r of existing) {
    if (!r.directive_key || !desiredKeys.has(String(r.directive_key))) {
      db.prepare(`UPDATE health_directives SET status = 'resolved' WHERE id = ? AND status = 'active'`).run(r.id);
      resolved++;
    }
  }
  return { changed: inserted + updated + resolved, inserted, updated, resolved, saved: inserted + updated };
}
