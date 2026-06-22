import { db } from "../db.js";
import { matchOptimalZone, prioritizeMarkers } from "./propagation.js";
import { getSettings } from "./settings.js";

// ============================================================================

// ---------- evidence cache ----------
export interface EvidenceInput {
  topic?: string | null;
  marker?: string | null;
  claim?: string | null;
  source_title?: string | null;
  source_url?: string | null;
  body?: string | null;
  confidence?: string | null;        // high | moderate | low (plain band, never a score)
}

export function normTopic(s: any): string {
  return String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
}

const EVIDENCE_CONFIDENCE = new Set(["high", "moderate", "low"]);

// Persist one cited evidence row. Coerced/clamped at the trust boundary like the
// rest of the agent-fed writes. A row with neither a claim nor a body is skipped.
export function addEvidence(fields: EvidenceInput) {
  const claim = fields.claim == null ? null : String(fields.claim).trim().slice(0, 800) || null;
  const body = fields.body == null ? null : String(fields.body).trim().slice(0, 4000) || null;
  if (!claim && !body) return null;
  // Server-side scheme guard (defense-in-depth): never persist a javascript:/data:/
  // internal URL even if a research source supplied one — mirrors the client filter
  // so the stored URL is genuinely http(s)-validated, not trusting the renderer alone.
  const rawUrl = fields.source_url == null ? null : String(fields.source_url).trim().slice(0, 600) || null;
  const sourceUrl = rawUrl && isPlausibleSourceUrl(rawUrl) ? rawUrl : null;
  const confidence = EVIDENCE_CONFIDENCE.has(String(fields.confidence)) ? String(fields.confidence) : "moderate";
  const info = db
    .prepare(`INSERT INTO evidence_cache (topic, marker, claim, source_title, source_url, body, confidence, retrieved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
    .run(
      fields.topic == null ? null : normTopic(fields.topic) || null,
      fields.marker == null || String(fields.marker).trim() === "" ? null : String(fields.marker).trim().slice(0, 60),
      claim,
      fields.source_title == null ? null : String(fields.source_title).trim().slice(0, 300) || null,
      sourceUrl,
      body,
      confidence
    );
  return db.prepare(`SELECT * FROM evidence_cache WHERE id = ?`).get(info.lastInsertRowid);
}

// Read cached evidence by topic and/or marker (most recent first). Pass neither
// to get the most-recent rows overall (bounded).
export function getEvidence(opts: { topic?: string | null; marker?: string | null; limit?: number } = {}) {
  const limit = Number.isFinite(opts.limit as number) ? Math.max(1, Math.min(50, Number(opts.limit))) : 20;
  const where: string[] = [];
  const vals: any[] = [];
  if (opts.topic != null && String(opts.topic).trim()) { where.push("topic = ?"); vals.push(normTopic(opts.topic)); }
  if (opts.marker != null && String(opts.marker).trim()) { where.push("marker = ? COLLATE NOCASE"); vals.push(String(opts.marker).trim()); }
  const sql = `SELECT * FROM evidence_cache ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY retrieved_at DESC, id DESC LIMIT ?`;
  return db.prepare(sql).all(...vals, limit) as any[];
}

// Make a directive's citation INSPECTABLE (Trust build V1). Reads the cached
// evidence for ONE marker and projects only the verifiable fields, so the UI (and
// any MCP client) can show the source(s) behind a claim instead of asserting it.
// `evidence:[]` when research never ran for that marker — degrade to the citation
// string. INFORMATIONAL, not medical advice. The marker is matched case-insensitively;
// a falsy marker returns the most-recent rows overall (still bounded).
export interface MarkerEvidence {
  claim: string | null;
  source_title: string | null;
  source_url: string | null;
  body: string | null;
  confidence: string | null;
  retrieved_at: string | null;
}
export function getEvidenceForMarker(marker: string | null | undefined, limit = 20): { marker: string | null; evidence: MarkerEvidence[] } {
  const name = marker == null ? "" : String(marker).trim();
  const rows = getEvidence({ marker: name || undefined, limit });
  const evidence: MarkerEvidence[] = rows.map((r: any) => ({
    claim: r.claim ?? null,
    source_title: r.source_title ?? null,
    source_url: r.source_url ?? null,
    body: r.body ?? null,
    confidence: r.confidence ?? null,
    retrieved_at: r.retrieved_at ?? null,
  }));
  return { marker: name || null, evidence };
}

// Make the cache DISCOVERABLE without N per-marker fetches (F1). Returns the
// total cached rows plus the per-marker counts (marker → how many cited rows we
// hold), so a directive/marker view can show a "see the evidence (N)" hint and
// know up-front whether anything is on file. Reads the cache only — never the
// network — so it works with research disabled. byMarker keys are the stored
// marker strings (case as filed); a NULL-marker row contributes only to `total`.
export interface EvidenceSummary {
  research_enabled: boolean;
  total: number;
  by_marker: { marker: string; count: number }[];
}
export function evidenceSummary(): EvidenceSummary {
  let total = 0;
  const by_marker: { marker: string; count: number }[] = [];
  try {
    total = Number((db.prepare(`SELECT COUNT(*) AS n FROM evidence_cache`).get() as any)?.n) || 0;
    const rows = db.prepare(
      `SELECT marker, COUNT(*) AS n FROM evidence_cache
       WHERE marker IS NOT NULL AND TRIM(marker) <> ''
       GROUP BY marker COLLATE NOCASE ORDER BY n DESC, marker ASC`
    ).all() as any[];
    for (const r of rows) by_marker.push({ marker: String(r.marker), count: Number(r.n) || 0 });
  } catch { /* evidence_cache absent on a very old DB — empty summary */ }
  let research_enabled = false;
  try { research_enabled = !!getSettings().research_enabled; } catch { /* default off */ }
  return { research_enabled, total, by_marker };
}

// Topics whose newest evidence row is older than ttlDays — the re-research pass
// reads this to refresh stale grounding. Returns distinct {topic, marker, age_days}.
export function staleEvidence(ttlDays = 90) {
  const ttl = Number.isFinite(ttlDays) ? Math.max(1, Number(ttlDays)) : 90;
  const rows = db.prepare(
    `SELECT topic, marker, MAX(retrieved_at) AS newest FROM evidence_cache
     WHERE topic IS NOT NULL GROUP BY topic, marker`
  ).all() as any[];
  const out: { topic: string; marker: string | null; age_days: number }[] = [];
  for (const r of rows) {
    const t = Date.parse(String(r.newest ?? "").replace(" ", "T") + "Z");
    if (!Number.isFinite(t)) continue;
    const ageDays = Math.floor((Date.now() - t) / 86_400_000);
    if (ageDays >= ttl) out.push({ topic: r.topic, marker: r.marker ?? null, age_days: ageDays });
  }
  return out.sort((a, b) => b.age_days - a.age_days);
}

// ---------- citation verification ----------
// Recognized guideline / evidence bodies. An agent-emitted citation naming one of
// these is accepted on its face (they're the institutions the deterministic
// MARKER_MAPPINGS already cite); anything else must match a cached evidence row.
// Lowercased substring match, longest list wins — kept deliberately broad but
// finite so a hallucinated journal title doesn't pass.
const GUIDELINE_ALLOWLIST = [
  "aha", "acc", "aha/acc", "acc/aha", "esc", "eas", "esc/eas", "ada", "aasld",
  "endocrine society", "uspstf", "nice", "who", "cochrane", "nla", "kdigo",
  "ata", "acr", "iom", "iof", "afp", "acsm", "ada/acsm", "cdc", "nih",
  "national lipid association", "american heart association", "american college of cardiology",
  "european society of cardiology", "european atherosclerosis society",
  "american diabetes association", "world health organization",
  "kidney disease improving global outcomes", "american thyroid association",
];

// Match one allowlist entry against a citation. A SHORT entry (≤4 chars) is an
// acronym (WHO, NIH, ADA, NICE) — it must appear as the UPPERCASE token on a word
// boundary in the ORIGINAL citation, so a guideline body ("WHO 2023…") verifies but
// the everyday lowercase word ("a study of who responds…", "nice diet", "Canada")
// does NOT — and a substring ("who" in "Whoop") never matches either. A longer /
// multiword entry stays a case-insensitive substring (specific enough not to collide).
function allowlistMatches(entry: string, low: string, raw: string): boolean {
  if (entry.length <= 4) {
    const re = new RegExp(`\\b${entry.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    return re.test(raw);
  }
  return low.includes(entry);
}

export interface CitationVerdict {
  citation: string | null;   // the kept citation string (null when stripped)
  uncertain: boolean;        // true when the citation could not be verified
  verified: boolean;
}

// Verify an agent-emitted citation. Accepts when it names a recognized guideline
// body OR matches a cached evidence_cache row (by source title/url). On failure
// the unverifiable string is STRIPPED (returned null) and `uncertain` is set, so
// the directive survives as a softer nudge rather than carrying a fake source.
export function verifyCitation(citation: string | null | undefined, sourceUrl?: string | null): CitationVerdict {
  const raw = citation == null ? "" : String(citation).trim();
  if (!raw) return { citation: null, uncertain: true, verified: false };
  const low = raw.toLowerCase();
  // 1) A recognized guideline body named anywhere in the citation. SHORT acronyms
  // (≤4 chars: who, nih, ata, …) require a WORD-BOUNDARY match — a bare `includes`
  // false-accepts them inside unrelated words ("who" in "Whoop"/"who responds",
  // "ada" in "Canada", "acr" in "across"). Longer / multiword entries stay
  // substring (they're specific enough not to collide).
  if (GUIDELINE_ALLOWLIST.some((g) => allowlistMatches(g, low, raw))) {
    return { citation: raw.slice(0, 600), uncertain: false, verified: true };
  }
  // 2) A cached evidence row whose title or url corroborates it.
  const url = sourceUrl == null ? "" : String(sourceUrl).trim();
  try {
    const rows = db.prepare(`SELECT source_title, source_url FROM evidence_cache ORDER BY id DESC LIMIT 500`).all() as any[];
    for (const r of rows) {
      const title = String(r.source_title ?? "").trim().toLowerCase();
      const rurl = String(r.source_url ?? "").trim().toLowerCase();
      if (title && (low.includes(title) || title.includes(low))) return { citation: raw.slice(0, 600), uncertain: false, verified: true };
      if (url && rurl && (rurl === url.toLowerCase())) return { citation: raw.slice(0, 600), uncertain: false, verified: true };
      if (rurl && low.includes(rurl)) return { citation: raw.slice(0, 600), uncertain: false, verified: true };
    }
  } catch { /* evidence_cache absent on a very old DB — treat as unverifiable */ }
  // Unverifiable → strip the string, downgrade to uncertain. Directive survives.
  return { citation: null, uncertain: true, verified: false };
}

// Validate a URL is a plausible http(s) source (used by src/research.ts before a
// claim is cached, and reusable anywhere a citation URL needs a sanity check).
export function isPlausibleSourceUrl(url: any): boolean {
  const s = String(url ?? "").trim();
  if (!s) return false;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    // host must have a dot and at least a 2-char TLD; reject bare/localhost-ish.
    const host = u.hostname.toLowerCase();
    if (!host.includes(".")) return false;
    if (host === "localhost" || host.endsWith(".local")) return false;
    if (!/\.[a-z]{2,}$/.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

// ---------- supplement / interaction safety gate ----------
// A curated rule set that DOWNGRADES/ANNOTATES (never hard-blocks) a supplement
// suggestion when the user's own markers contraindicate it. Applied as a PASS
// over directives AFTER they're derived/emitted — NOT by editing MARKER_MAPPINGS.
// Each rule: detect a supplement intent in the directive text, then check the
// relevant marker context; if contraindicated, append an informational note and
// mark the directive uncertain. INFORMATIONAL, defer to a clinician.
export interface SafetyMarkerContext {
  // latest numeric value + side ('low'/'high'/'normal'/null) per recognized marker, keyed by zone label.
  byLabel: Record<string, { value: number; side: string | null; inOptimal: boolean | null }>;
}

// Build the marker context the gate reads, from the impact-ranked markers. Cheap,
// null-safe; an empty context means the gate is a no-op (degrades gracefully).
export function buildSafetyMarkerContext(): SafetyMarkerContext {
  const byLabel: SafetyMarkerContext["byLabel"] = {};
  try {
    const { markers } = prioritizeMarkers();
    for (const m of markers as any[]) {
      const z = matchOptimalZone(m?.name);
      if (!z) continue;
      if (m?.latest?.unit_mismatch === true) continue;
      const v = typeof m?.latest?.value === "number" ? m.latest.value : Number(m?.latest?.value);
      if (!Number.isFinite(v)) continue;
      const flag: string | null = m?.latest?.flag === "low" || m?.latest?.flag === "high" ? m.latest.flag : null;
      const side = flag ?? (v < z.optimal[0] ? "low" : v > z.optimal[1] ? "high" : "normal");
      // First (highest-impact) reading per label wins.
      if (!(z.label in byLabel)) byLabel[z.label] = { value: v, side, inOptimal: m?.in_optimal ?? null };
    }
  } catch { /* no markers / engine unavailable → empty context, gate no-ops */ }
  return { byLabel };
}

// What the gate reads to decide a rule applies. The directive TEXT is the primary
// signal, but a contraindicated supplement can be phrased WITHOUT the obvious words
// ("boost your stores with a daily ferrous bisglycinate" never says "iron"; "keep
// taking your usual creatine scoop" never says "supplement"/"add"). So each rule is
// ALSO keyed off (a) the directive's structured `marker` field and (b) a small
// supplement-name lexicon detected in the text — caught via `matchesSubject` below.
interface SafetyMatch {
  text: string;     // lowercased directive text
  marker: string;   // lowercased directive.marker (may be "")
}

interface SafetyRule {
  // true when the directive suggests this supplement (by text, marker, or a
  // supplement-name in the text — see matchesSubject).
  matches: (m: SafetyMatch) => boolean;
  // returns an informational note when the marker context contraindicates it, else null
  check: (ctx: SafetyMarkerContext) => string | null;
}

// Small supplement-name lexicon per subject: catch a contraindicated combo even when
// the prose avoids the obvious trigger words. Each name implies a SUPPLEMENT intent on
// its own (you don't say "ferrous bisglycinate" / "cholecalciferol" / "creatine
// monohydrate" except about supplementing), so a name match needs no separate verb.
const SUPPLEMENT_LEXICON = {
  iron: /\bferrous\b|\bferric\b|bisglycinate|fumarate|gluconate|\bheme iron\b|carbonyl iron/,
  vitaminD: /cholecalciferol|ergocalciferol|\bvitamin d3?\b|\bd3\b|25-oh/,
  creatine: /\bcreatine\b|monohydrate/, // \b excludes "creatinine" (the kidney marker)
} as const;

// A rule's subject (a supplement INTENT, not merely a mention of the analyte) is
// present when ANY of:
//   • a supplement-name from the lexicon appears in the text — implies intent on its
//     own ("ferrous bisglycinate", "cholecalciferol", "creatine scoop"); no verb needed;
//   • the obvious word + a supplement/dose verb appear in the text ("add iron", "take D3");
//   • the structured `marker` field names the analyte AND a supplement/dose verb appears
//     in the text — the marker broadens the subject word, but a verb is still required so
//     a directive merely ABOUT the analyte ("ferritin is low, eat red meat") doesn't trip.
// Conservative by construction: an unrelated directive never trips a rule, and a
// directive that discusses a marker without suggesting a supplement doesn't either.
function matchesSubject(
  m: SafetyMatch,
  opts: { markerRe: RegExp; wordRe: RegExp; verbRe: RegExp; lexicon: RegExp }
): boolean {
  if (opts.lexicon.test(m.text)) return true;                          // a named supplement implies intent
  const hasVerb = opts.verbRe.test(m.text);
  if (opts.wordRe.test(m.text) && hasVerb) return true;                // obvious word + a dose/add verb
  if (m.marker && opts.markerRe.test(m.marker) && hasVerb) return true; // marker field broadens the word, verb still required
  return false;
}

const SAFETY_RULES: SafetyRule[] = [
  {
    // Iron / ferritin: supplementing iron is contraindicated when ferritin is
    // already normal/high (iron overload risk). Only low ferritin warrants it.
    matches: (m) => matchesSubject(m, {
      markerRe: /\biron\b|ferritin|transferrin|\btsat\b/,
      wordRe: /\biron\b|ferritin/,
      verbRe: /(supplement|tablet|capsule|take\b|add\b|boost\b|raise\b|increase\b)/,
      lexicon: SUPPLEMENT_LEXICON.iron,
    }),
    check: (ctx) => {
      const f = ctx.byLabel.Ferritin;
      if (f && (f.side === "high" || (f.side === "normal" && f.inOptimal !== false))) {
        return "Safety note: your most recent ferritin is not low, so don't add iron to chase it — excess iron can accumulate. Confirm iron status with your doctor before supplementing.";
      }
      return null;
    },
  },
  {
    // High-dose vitamin D3 when 25-OH D is already replete (in/above optimal).
    matches: (m) => matchesSubject(m, {
      markerRe: /vitamin d|25-oh|cholecalciferol/,
      wordRe: /(vitamin d|d3|25-oh|cholecalciferol)/,
      verbRe: /(supplement|high-dose|high dose|\biu\b|take\b|add\b|boost\b)/,
      lexicon: SUPPLEMENT_LEXICON.vitaminD,
    }),
    check: (ctx) => {
      const d = ctx.byLabel["Vitamin D"];
      if (d && (d.side === "high" || (d.side === "normal" && d.inOptimal === true))) {
        return "Safety note: your vitamin D already looks replete, so a high dose isn't needed and over-supplementing carries risk — keep any dose modest and confirm with your doctor.";
      }
      return null;
    },
  },
  {
    // Creatine when kidney function is reduced (low eGFR / high creatinine).
    // Match "creatine" but NOT "creatinine" (the kidney MARKER, not the supplement) —
    // \bcreatine\b excludes the longer word so a Creatinine directive can't self-trip.
    matches: (m) => matchesSubject(m, {
      markerRe: /\bcreatine\b/,
      wordRe: /\bcreatine\b/,
      verbRe: /(supplement|take\b|add\b|\bg\/day|grams?\b|loading|scoop\b|keep\b|daily\b)/,
      lexicon: SUPPLEMENT_LEXICON.creatine,
    }),
    check: (ctx) => {
      const egfr = ctx.byLabel.eGFR;
      const creat = ctx.byLabel.Creatinine;
      if ((egfr && egfr.side === "low") || (creat && creat.side === "high")) {
        return "Safety note: your kidney markers (eGFR/creatinine) are off-optimal — clear creatine with your doctor first, as it can raise creatinine and isn't advised with reduced kidney function.";
      }
      return null;
    },
  },
];

export interface SafetyResult { directive: string | null; rationale: string | null; uncertain: boolean; annotated: boolean; }

// Run the gate over one directive. Only nutrition/watch supplement suggestions are
// candidates; everything else passes through untouched. Appends the informational
// note to the directive text (so it travels into every consumer) and flags
// uncertain. Never blocks — the suggestion still appears, with the caveat.
export function safetyGate(
  directive: { domain?: string | null; marker?: string | null; directive?: string | null; rationale?: string | null },
  ctx: SafetyMarkerContext
): SafetyResult {
  const text = String(directive?.directive ?? "");
  const base: SafetyResult = { directive: directive?.directive ?? null, rationale: directive?.rationale ?? null, uncertain: false, annotated: false };
  // Every rule requires a dose/add verb IN THE TEXT (the marker field only broadens
  // which analyte word counts), so an empty directive can't trip the gate.
  if (!text.trim()) return base;
  const marker = String(directive?.marker ?? "").toLowerCase().trim();
  const low = text.toLowerCase();
  const subject: SafetyMatch = { text: low, marker };
  const notes: string[] = [];
  for (const rule of SAFETY_RULES) {
    if (!rule.matches(subject)) continue;
    const note = rule.check(ctx);
    if (note) notes.push(note);
  }
  if (!notes.length) return base;
  const annotated = `${text} ${notes.join(" ")}`.trim().slice(0, 600);
  return { directive: annotated, rationale: directive?.rationale ?? null, uncertain: true, annotated: true };
}
