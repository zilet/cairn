import { listCheckins } from "./coach.js";
import { listContextEvents } from "./health.js";
import { type OptimalZone, markerSide, matchOptimalZone, prioritizeMarkers } from "./propagation.js";
import { localDateISO } from "./shared.js";

// ============================================================================
// SYMPTOM → MARKER REASONING — the connective tissue between what the athlete
// FELT and what their labs show. Today a logged symptom (a context_event note,
// a check-in note: "head blurriness on walks", "wiped out lately", "leg cramps")
// never connects to a plausibly-related out-of-range marker sitting in the same
// window. This deterministic engine reads recent symptom text through a curated,
// conservative SYMPTOM_KB, cross-references each candidate analyte against its
// LATEST reading (out-of-optimal or lab-flagged, via the existing optimal-zone
// machinery), and emits ONE quiet, non-alarmist clinician-referral note per
// symptom — but ONLY where BOTH a symptom AND a related off-marker co-occur.
//
// CONSTITUTION: health findings are INFORMATIONAL, never medical advice — every
// note frames the connection as "worth mentioning to your clinician", NEVER a
// diagnosis. It NEVER invents a marker value (it only reads real readings) and
// returns [] when nothing co-occurs. A false connection is worse than silence, so
// the KB is deliberately tight + directional (a symptom links to the marker side
// that's clinically plausible, e.g. blurry vision ↔ HIGH blood pressure / glucose).
// DETERMINISTIC + PURE + null-safe — no agent calls, never throws.
// ============================================================================

// A symptom → the analytes it plausibly relates to. `side` constrains the link to
// the clinically-defensible direction ("high"/"low"), or "any" when either side of
// off-optimal is meaningful (e.g. dizziness ↔ blood pressure on either extreme).
// `label` is the optimal-zone label (matchOptimalZone(...).label) the marker keys off.
interface SymptomTarget { label: string; side: "high" | "low" | "any"; }
interface SymptomEntry {
  key: string;       // stable dedup key
  label: string;     // plain-words symptom name for the note + output
  re: RegExp;        // word-bounded matcher over the symptom text
  markers: SymptomTarget[];
}

// Conservative, clinically-defensible mappings only. Each symptom points at the
// small set of analytes a clinician would reasonably consider for it.
const SYMPTOM_KB: SymptomEntry[] = [
  {
    key: "blurry_vision",
    label: "blurry vision",
    re: /\b(blurr?y|blurred|blurr?iness|fuzzy vision|spots in (?:my |the )?vision|vision (?:is |going )?blurr)\b/i,
    markers: [
      { label: "Systolic BP", side: "high" },
      { label: "Diastolic BP", side: "high" },
      { label: "Fasting glucose", side: "high" },
      { label: "HbA1c", side: "high" },
    ],
  },
  {
    key: "dizziness",
    label: "dizziness or lightheadedness",
    re: /\b(dizzy|dizziness|light[- ]?headed|lightheaded|vertigo|woozy|feeling faint|near[- ]?faint)\b/i,
    markers: [
      { label: "Systolic BP", side: "any" },
      { label: "Diastolic BP", side: "any" },
      { label: "Fasting glucose", side: "low" },
    ],
  },
  {
    key: "fatigue",
    label: "ongoing fatigue",
    re: /\b(fatigue|fatigued|exhaust(?:ed|ion)|wiped out|no energy|low energy|drained|sluggish|lethargic|worn out|always tired|constantly tired|tired all the time)\b/i,
    markers: [
      { label: "TSH", side: "high" },
      { label: "Ferritin", side: "low" },
      { label: "Vitamin D", side: "low" },
      { label: "Vitamin B12", side: "low" },
      { label: "Testosterone", side: "low" },
      { label: "Free T3", side: "low" },
    ],
  },
  {
    key: "cold",
    label: "feeling cold",
    re: /\b(cold intoleran\w*|always cold|feeling cold|feel(?:s|ing)? cold|cold all the time|cold hands|cold feet)\b/i,
    markers: [
      { label: "TSH", side: "high" },
      { label: "Ferritin", side: "low" },
      { label: "Free T3", side: "low" },
    ],
  },
  {
    key: "hair",
    label: "hair thinning or loss",
    re: /\b(hair (?:loss|thinning|falling|shedding)|losing hair|thinning hair)\b/i,
    markers: [
      { label: "TSH", side: "high" },
      { label: "Ferritin", side: "low" },
      { label: "Vitamin D", side: "low" },
    ],
  },
  {
    key: "low_libido",
    label: "low libido",
    re: /\b(low libido|libido|low sex drive|no sex drive|sex drive)\b/i,
    markers: [
      { label: "Testosterone", side: "low" },
      { label: "Vitamin D", side: "low" },
      { label: "TSH", side: "high" },
    ],
  },
  {
    key: "low_mood",
    label: "low mood",
    re: /\b(low mood|depress(?:ed|ion)|feeling down|down mood|persistently irritable)\b/i,
    markers: [
      { label: "Testosterone", side: "low" },
      { label: "Vitamin D", side: "low" },
      { label: "TSH", side: "high" },
      { label: "Free T3", side: "low" },
    ],
  },
  {
    key: "poor_recovery",
    label: "poor recovery",
    re: /\b(poor recovery|not recovering|slow recovery|under[- ]?recover\w*|can'?t recover|recovery (?:is )?(?:poor|slow|bad))\b/i,
    markers: [
      { label: "Testosterone", side: "low" },
      { label: "Ferritin", side: "low" },
      { label: "Vitamin D", side: "low" },
    ],
  },
  {
    key: "tingling",
    label: "tingling or numbness",
    re: /\b(tingl(?:e|ing)|numb(?:ness)?|pins and needles|pins[- ]and[- ]needles)\b/i,
    markers: [
      { label: "Vitamin B12", side: "low" },
      { label: "Fasting glucose", side: "high" },
      { label: "HbA1c", side: "high" },
    ],
  },
  {
    key: "headaches",
    label: "headaches",
    re: /\b(headaches?|head ache|migraines?)\b/i,
    markers: [
      { label: "Systolic BP", side: "high" },
      { label: "Diastolic BP", side: "high" },
    ],
  },
  {
    key: "cramps",
    label: "muscle cramps",
    re: /\b(cramps?|cramping|muscle cramp|leg cramp|charley horse)\b/i,
    markers: [
      { label: "Magnesium", side: "low" },
    ],
  },
  {
    key: "thirst",
    label: "excessive thirst or frequent urination",
    re: /\b(excessive thirst|very thirsty|always thirsty|frequent urination|peeing (?:a lot|often|frequently)|polyuria|polydipsia)\b/i,
    markers: [
      { label: "Fasting glucose", side: "high" },
      { label: "HbA1c", side: "high" },
    ],
  },
];

export interface SymptomLinkMarker {
  name: string;                       // the lab's own display name
  value: number | string | null;     // the real latest reading (never invented)
  side: string;                       // 'high' | 'low' | 'unknown'
  unit: string | null;
  flag: string | null;               // the lab's own low/high flag, when present
}

export interface SymptomMarkerLink {
  symptom: string;                    // plain-words symptom label
  symptom_text: string;               // the source phrase as written (bounded)
  symptom_source: "context_event" | "checkin";
  symptom_source_date: string | null; // YYYY-MM-DD of the symptom mention
  markers: SymptomLinkMarker[];       // the co-occurring off-markers it plausibly relates to
  note: string;                       // one plain, non-alarmist clinician-referral sentence
}

export interface SymptomLinksOpts {
  date?: string;            // "today" anchor (default device-local today)
  events?: any[];           // inject context_events (testing); else read recent
  checkins?: any[];         // inject check-ins (testing); else read recent
  markers?: any[];          // inject prioritized markers (testing); else derive
  includeCheckins?: boolean; // default true — also scan check-in notes
  windowDays?: number;      // recency window for DB-read symptom sources (default 180)
  max?: number;             // cap on returned links (default 6)
}

function addDaysISO(iso: string, days: number): string | null {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return new Date(t + days * 864e5).toISOString().slice(0, 10);
}

// The searchable symptom text of a context_event: title + detail + meta.impact.
// meta may arrive parsed (hydrateContextEvent) or as a raw JSON string.
function eventSymptomText(ev: any): string {
  let meta: any = ev?.meta;
  if (meta == null && ev?.meta_json) {
    try { meta = JSON.parse(ev.meta_json); } catch { meta = null; }
  }
  const impact = meta && typeof meta === "object" ? meta.impact : null;
  return `${ev?.title ?? ""} ${ev?.detail ?? ""} ${impact ?? ""}`.trim();
}

function pickEventDate(ev: any): string | null {
  const sd = ev?.start_date && /^\d{4}-\d{2}-\d{2}$/.test(String(ev.start_date)) ? String(ev.start_date).slice(0, 10) : null;
  if (sd) return sd;
  const ca = ev?.created_at ? String(ev.created_at).slice(0, 10) : null;
  return ca && /^\d{4}-\d{2}-\d{2}$/.test(ca) ? ca : null;
}

function numericOf(v: any): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// The first prioritized marker that (a) keys to `label`'s optimal zone, (b) is
// genuinely OFF (out of optimal OR lab-flagged low/high), and (c) sits on the
// required side. Returns the real reading or null — it NEVER fabricates a value.
function findOffMarker(markers: any[], label: string, requiredSide: "high" | "low" | "any"): SymptomLinkMarker | null {
  for (const m of markers) {
    const z: OptimalZone | null = matchOptimalZone(m?.name);
    if (!z || z.label !== label) continue;
    const flag = m?.latest?.flag === "low" || m?.latest?.flag === "high" ? m.latest.flag : null;
    const off = m?.in_optimal === false || !!flag;
    if (!off) continue;
    const value = numericOf(m?.latest?.value);
    const side = value != null ? markerSide(value, z, flag) : (flag ?? "unknown");
    if (requiredSide !== "any" && side !== requiredSide) continue;
    return {
      name: String(m?.name ?? z.label),
      value: value != null ? value : (m?.latest?.value ?? null),
      side,
      unit: m?.unit ?? null,
      flag,
    };
  }
  return null;
}

function friendlyMarkerNoun(name: string): string {
  const n = String(name);
  if (/systolic/i.test(n)) return "systolic blood pressure";
  if (/diastolic/i.test(n)) return "diastolic blood pressure";
  return n;
}

function describeOff(m: SymptomLinkMarker): string {
  const noun = friendlyMarkerNoun(m.name);
  const adj = m.side === "high" ? "elevated" : m.side === "low" ? "low" : "out-of-range";
  return `${adj} ${noun}`;
}

function buildNote(symptom: string, markers: SymptomLinkMarker[]): string {
  const phrases = markers.slice(0, 3).map(describeOff);
  const joined =
    phrases.length === 1 ? phrases[0]
    : phrases.length === 2 ? `${phrases[0]} and ${phrases[1]}`
    : `${phrases.slice(0, -1).join(", ")}, and ${phrases[phrases.length - 1]}`;
  return `Your note about ${symptom} around the same time as your ${joined} is worth mentioning to your clinician.`;
}

// The headline: deterministic symptom → off-marker links. Reads recent symptom text
// (context_events + optional check-in notes) and the latest prioritized markers, and
// returns ONE link per symptom where a plausibly-related analyte is genuinely off.
// Returns [] when nothing co-occurs. Suitable to surface as a quiet insight/directive.
export function symptomMarkerLinks(opts: SymptomLinksOpts = {}): SymptomMarkerLink[] {
  const today = opts.date && /^\d{4}-\d{2}-\d{2}$/.test(opts.date) ? opts.date : localDateISO();
  const windowDays = Number.isFinite(opts.windowDays as number) && (opts.windowDays as number) > 0 ? Math.floor(opts.windowDays as number) : 180;
  const cutoff = addDaysISO(today, -windowDays);
  const max = Number.isFinite(opts.max as number) && (opts.max as number) > 0 ? Math.floor(opts.max as number) : 6;

  // Latest prioritized markers (optimal-zone framing + flags). Injected for tests; else
  // derived. We never invent a value, so with no markers there's nothing to connect.
  let markers: any[] = [];
  if (Array.isArray(opts.markers)) markers = opts.markers;
  else { try { markers = prioritizeMarkers().markers; } catch { markers = []; } }
  if (!markers.length) return [];

  // The symptom sources: recent context_events (+ optional check-in notes), each dated
  // so the co-occurrence is honest. Explicitly-passed sources are trusted as-is; DB-read
  // sources are recency-bounded to the window.
  const sources: { text: string; date: string | null; kind: "context_event" | "checkin" }[] = [];

  const eventsPassed = Array.isArray(opts.events);
  let events: any[] = [];
  if (eventsPassed) events = opts.events as any[];
  else { try { events = listContextEvents() as any[]; } catch { events = []; } }
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    if (ev.archived) continue;
    const date = pickEventDate(ev);
    if (!eventsPassed && date && cutoff && date < cutoff) continue;
    const text = eventSymptomText(ev);
    if (text) sources.push({ text, date, kind: "context_event" });
  }

  if (opts.includeCheckins !== false) {
    const checkinsPassed = Array.isArray(opts.checkins);
    let checkins: any[] = [];
    if (checkinsPassed) checkins = opts.checkins as any[];
    else { try { checkins = listCheckins(30) as any[]; } catch { checkins = []; } }
    for (const c of checkins) {
      const note = c?.note ? String(c.note).trim() : "";
      if (!note) continue;
      const date = c?.date && /^\d{4}-\d{2}-\d{2}$/.test(String(c.date)) ? String(c.date).slice(0, 10) : null;
      if (!checkinsPassed && date && cutoff && date < cutoff) continue;
      sources.push({ text: note, date, kind: "checkin" });
    }
  }
  if (!sources.length) return [];

  // Newest source first, so the per-symptom dedup keeps the most recent mention.
  sources.sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));

  const bySymptom = new Map<string, SymptomMarkerLink>();
  for (const src of sources) {
    for (const entry of SYMPTOM_KB) {
      if (bySymptom.has(entry.key)) continue;     // already linked from a newer source
      if (!entry.re.test(src.text)) continue;
      const found: SymptomLinkMarker[] = [];
      const seen = new Set<string>();
      for (const t of entry.markers) {
        const off = findOffMarker(markers, t.label, t.side);
        if (off && !seen.has(off.name.toLowerCase())) {
          seen.add(off.name.toLowerCase());
          found.push(off);
        }
      }
      if (!found.length) continue;                // symptom with no related off-marker → silent
      bySymptom.set(entry.key, {
        symptom: entry.label,
        symptom_text: src.text.slice(0, 200),
        symptom_source: src.kind,
        symptom_source_date: src.date,
        markers: found,
        note: buildNote(entry.label, found),
      });
    }
  }

  return [...bySymptom.values()].slice(0, max);
}
