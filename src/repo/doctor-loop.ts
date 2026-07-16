import { todayISO } from "../db.js";
import {
  applyAttentionObservation,
  listAttentionSchedule,
  listDueAttention,
  type AttentionScheduleEntry,
  type AttentionSignalStatus,
  type CadencePolicy,
} from "./attention.js";
import { canonicalMarker } from "./marker-canon.js";
import { getLatestHealthReview, getMarkerHistory } from "./health.js";
import { listDirectives } from "./coach.js";
import { matchOptimalZone, optimalDistance } from "./propagation-data.js";

type WorkupKind = "lab" | "dexa";

export interface MissingWorkupItem {
  key: string;
  label: string;
  kind: WorkupKind;
  reason: string;
  cadence_note: string;
}

export interface DoctorLoopRead {
  attention: AttentionScheduleEntry[];
  due: AttentionScheduleEntry[];
  missing_workup: MissingWorkupItem[];
  frame: string;
}

interface MarkerLike {
  key?: string | null;
  name?: string | null;
  unit?: string | null;
  latest?: {
    value?: unknown;
    flag?: string | null;
    date?: string | null;
    kind?: string | null;
    unit_mismatch?: boolean;
  } | null;
  points?: Array<{ date?: string | null; kind?: string | null; value?: unknown; flag?: string | null }>;
}

interface PolicySpec {
  signalClass: string;
  labels: string[];
  activeDays: number;
  confirmingDays: number;
  surveillanceInitialDays: number;
  surveillanceMaxDays: number;
  reason: string;
  release: string;
}

const POLICY_SPECS: PolicySpec[] = [
  {
    signalClass: "lipids",
    labels: ["ApoB", "LDL-C", "Non-HDL-C", "Triglycerides", "Total cholesterol", "HDL-C"],
    activeDays: 84,
    confirmingDays: 84,
    surveillanceInitialDays: 180,
    surveillanceMaxDays: 365,
    reason: "A lipid marker is off optimal or under an active lever; recheck after the expected lipid-response window.",
    release: "Lipids are cleanly optimal and stable without an active lipid intervention; they can stay quiet until new data, symptoms, or a clinician question brings them back.",
  },
  {
    signalClass: "lpa",
    labels: ["Lp(a)"],
    activeDays: 365,
    confirmingDays: 365,
    surveillanceInitialDays: 365,
    surveillanceMaxDays: 365,
    reason: "Lp(a) is mostly genetic; once elevated, it mainly changes how aggressively modifiable lipid markers are interpreted.",
    release: "Lp(a) has been measured; it does not need repeated routine scheduling unless a clinician asks or a new treatment question appears.",
  },
  {
    signalClass: "glucose",
    labels: ["HbA1c", "Fasting glucose", "Fasting insulin"],
    activeDays: 90,
    confirmingDays: 90,
    surveillanceInitialDays: 180,
    surveillanceMaxDays: 365,
    reason: "A glucose/insulin marker is off optimal or under an active lever; recheck after a meaningful metabolic-response window.",
    release: "Glucose/insulin markers are clean and stable with no active metabolic intervention; they can stay quiet until new data or a goal change.",
  },
  {
    signalClass: "iron",
    labels: ["Ferritin", "Iron", "Transferrin saturation", "Hemoglobin"],
    activeDays: 70,
    confirmingDays: 56,
    surveillanceInitialDays: 120,
    surveillanceMaxDays: 365,
    reason: "An iron/red-blood marker is off optimal or being corrected; recheck after the expected iron-response window.",
    release: "Iron/red-blood markers are cleanly stable with no active correction; they can stay quiet until symptoms, training issues, or new labs bring them back.",
  },
  {
    signalClass: "thyroid",
    labels: ["TSH", "Free T4", "Free T3"],
    activeDays: 56,
    confirmingDays: 56,
    surveillanceInitialDays: 180,
    surveillanceMaxDays: 365,
    reason: "A thyroid marker is off optimal or recently changed; recheck after the expected thyroid-response window.",
    release: "Thyroid markers are clean and stable without a medication or symptom change; no standing recheck is needed.",
  },
  {
    signalClass: "vitamin-d",
    labels: ["Vitamin D"],
    activeDays: 90,
    confirmingDays: 90,
    surveillanceInitialDays: 180,
    surveillanceMaxDays: 365,
    reason: "Vitamin D is off optimal or being corrected; recheck after a meaningful supplementation/sunlight-response window.",
    release: "Vitamin D is cleanly stable with no active dose change; it can stay quiet until seasonal change, symptoms, or clinician follow-up.",
  },
  {
    signalClass: "inflammation",
    labels: ["hs-CRP"],
    activeDays: 42,
    confirmingDays: 84,
    surveillanceInitialDays: 180,
    surveillanceMaxDays: 365,
    reason: "hs-CRP is non-specific; confirm it when not acutely ill, injured, or coming off unusually hard training.",
    release: "Inflammation is cleanly low and stable outside transient windows; it can stay quiet until a new symptom or draw.",
  },
  {
    signalClass: "kidney-liver",
    labels: ["eGFR", "Creatinine", "ALT", "AST", "GGT"],
    activeDays: 90,
    confirmingDays: 90,
    surveillanceInitialDays: 180,
    surveillanceMaxDays: 365,
    reason: "A kidney/liver marker is off optimal or newly changed; recheck after a clinically meaningful interval.",
    release: "Kidney/liver markers are clean and stable without an active lever; they can stay quiet until new data or symptoms.",
  },
  {
    signalClass: "body-composition",
    labels: ["Body fat"],
    activeDays: 84,
    confirmingDays: 84,
    surveillanceInitialDays: 180,
    surveillanceMaxDays: 365,
    reason: "Body composition is actively moving; DEXA or a consistent body-comp method is worth rechecking after 8-12 weeks, not daily.",
    release: "Body composition is stable and no recomposition lever is active; it can stay quiet until a phase change or new scan.",
  },
];

const MISSING_PANEL: MissingWorkupItem[] = [
  {
    key: "apob",
    label: "ApoB",
    kind: "lab",
    reason: "ApoB is the atherogenic particle count and helps interpret lipid risk beyond LDL-C.",
    cadence_note: "Worth adding at the next lipid draw if it has never been measured.",
  },
  {
    key: "lpa",
    label: "Lp(a)",
    kind: "lab",
    reason: "Lp(a) is largely genetic and usually only needs to be measured once to set lifetime context.",
    cadence_note: "One-time add-on unless a clinician specifically wants a repeat.",
  },
  {
    key: "hba1c",
    label: "HbA1c",
    kind: "lab",
    reason: "HbA1c anchors the longer glucose picture.",
    cadence_note: "Useful on routine metabolic panels, especially during a body-composition phase.",
  },
  {
    key: "fasting-insulin",
    label: "Fasting insulin",
    kind: "lab",
    reason: "Fasting insulin can show early insulin-resistance pressure before glucose drifts.",
    cadence_note: "Worth adding with fasting glucose/HbA1c when metabolic health is a goal.",
  },
  {
    key: "hs-crp",
    label: "hs-CRP",
    kind: "lab",
    reason: "hs-CRP adds inflammatory context to the cardiovascular picture, with transient spikes interpreted carefully.",
    cadence_note: "Best drawn when not acutely ill, injured, or right after unusually hard training.",
  },
  {
    key: "ferritin",
    label: "Ferritin",
    kind: "lab",
    reason: "Ferritin anchors iron stores, which can shape energy, endurance tolerance, and anemia workups.",
    cadence_note: "Worth adding when fatigue, endurance load, or red-cell markers matter.",
  },
  {
    key: "thyroid-axis",
    label: "Thyroid panel (TSH, Free T4, Free T3)",
    kind: "lab",
    reason: "The thyroid axis helps interpret energy, weight-change tolerance, and low-metabolic-adaptation questions.",
    cadence_note: "More useful as a panel than isolated TSH when symptoms or aggressive weight loss are in the picture.",
  },
  {
    key: "vitamin-d",
    label: "25-OH Vitamin D",
    kind: "lab",
    reason: "Vitamin D is a common, correctable micronutrient signal relevant to bone, immune, and training context.",
    cadence_note: "Worth adding if never measured, then rechecking only after a dose/season change.",
  },
  {
    key: "urine-acr",
    label: "Urine albumin/creatinine ratio",
    kind: "lab",
    reason: "Urine ACR adds kidney and vascular context that serum eGFR can miss.",
    cadence_note: "Worth adding at a clinician visit when cardiometabolic prevention is the theme.",
  },
  {
    key: "dexa-body-composition",
    label: "DEXA body composition",
    kind: "dexa",
    reason: "A DEXA anchors fat mass, lean mass, visceral fat, and bone context instead of relying on scale weight alone.",
    cadence_note: "Useful as a baseline, then only every 8-12+ weeks during active recomposition.",
  },
];

function lc(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function signalSlug(value: unknown): string {
  return lc(value).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "signal";
}

function markerLabel(marker: MarkerLike): string {
  const zone = matchOptimalZone(String(marker.name ?? ""));
  return zone?.label ?? canonicalMarker(String(marker.name ?? marker.key ?? "")).name ?? String(marker.name ?? marker.key ?? "");
}

function markerDate(marker: MarkerLike): string {
  const date = String(marker.latest?.date ?? marker.points?.at(-1)?.date ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayISO();
}

function numericLatest(marker: MarkerLike): number | null {
  const n = Number(marker.latest?.value);
  return Number.isFinite(n) ? n : null;
}

function markerStatus(marker: MarkerLike): AttentionSignalStatus {
  const flag = marker.latest?.flag === "low" || marker.latest?.flag === "high" ? marker.latest.flag : null;
  if (flag) return "flagged";
  const zone = matchOptimalZone(String(marker.name ?? ""));
  const value = numericLatest(marker);
  if (!zone || value == null || marker.latest?.unit_mismatch) return "normal";
  return optimalDistance(value, zone) === 0 ? "optimal" : "flagged";
}

function policyForLabel(label: string): PolicySpec | null {
  const folded = lc(label);
  return POLICY_SPECS.find((p) => p.labels.some((x) => lc(x) === folded)) ?? null;
}

function cadencePolicy(spec: PolicySpec, reason?: string): CadencePolicy {
  return {
    signal_class: spec.signalClass,
    domain: spec.signalClass === "body-composition" ? "body" : "health",
    source: spec.signalClass === "body-composition" ? "dexa" : "doctor-loop",
    active_days: spec.activeDays,
    confirming_days: spec.confirmingDays,
    surveillance_initial_days: spec.surveillanceInitialDays,
    surveillance_multiplier: 1.75,
    surveillance_max_days: spec.surveillanceMaxDays,
    surveillance_checks_before_release: 2,
    reason: reason ?? spec.reason,
    release_condition: spec.release,
  };
}

function activeDirectiveMarkers(): Set<string> {
  const out = new Set<string>();
  for (const d of listDirectives()) {
    const marker = d?.marker;
    if (!marker) continue;
    out.add(lc(marker));
    const zone = matchOptimalZone(marker);
    if (zone) out.add(lc(zone.label));
    out.add(lc(canonicalMarker(marker).name));
  }
  return out;
}

function hasActiveDirective(label: string, activeMarkers: Set<string>): boolean {
  return activeMarkers.has(lc(label)) || activeMarkers.has(lc(canonicalMarker(label).name));
}

function applyMarkerAttention(marker: MarkerLike, activeMarkers: Set<string>): AttentionScheduleEntry | null {
  const label = markerLabel(marker);
  const spec = policyForLabel(label);
  if (!spec) return null;
  let status = markerStatus(marker);
  if (hasActiveDirective(label, activeMarkers) && status !== "flagged") status = "active";
  const reason =
    status === "flagged" || status === "active"
      ? `${label} is ${status === "active" ? "under an active follow-up lever" : "outside its optimal/lab range"}; ${spec.reason}`
      : undefined;
  return applyAttentionObservation({
    signal_key: `marker:${signalSlug(label)}`,
    policy: cadencePolicy(spec, reason),
    observation: {
      checked_at: markerDate(marker),
      status,
      reason,
      source: spec.signalClass === "body-composition" ? "dexa" : "doctor-loop",
    },
  });
}

// The attention signal_key this marker's lab retest cadence is filed under, or
// null when the marker has no recheck policy. Encapsulates the doctor-loop's
// internal label→slug mapping so composition layers (the next-checkup read) can
// join a marker from getMarkerHistory back to its attention_schedule row without
// re-deriving the policy internals.
export function markerSignalKey(marker: MarkerLike): string | null {
  const label = markerLabel(marker);
  if (!policyForLabel(label)) return null;
  return `marker:${signalSlug(label)}`;
}

function latestDexaDate(markers: MarkerLike[]): string | null {
  let latest: string | null = null;
  for (const marker of markers) {
    const name = lc(marker.name);
    const looksDexa =
      marker.latest?.kind === "dexa" ||
      marker.points?.some((p) => p.kind === "dexa") ||
      /\b(dexa|visceral|almi|ffmi|bmd|t-score|z-score)\b/.test(name);
    if (!looksDexa) continue;
    const date = markerDate(marker);
    if (!latest || date > latest) latest = date;
  }
  return latest;
}

function applyDexaAttention(markers: MarkerLike[]): AttentionScheduleEntry | null {
  const date = latestDexaDate(markers);
  if (!date) return null;
  const bodyFat = markers.find((m) => lc(markerLabel(m)) === "body fat" || /\bbody fat\b/.test(lc(m.name)));
  const spec = policyForLabel("Body fat");
  if (!spec) return null;
  const status = bodyFat ? markerStatus(bodyFat) : "normal";
  return applyAttentionObservation({
    signal_key: "dexa:body-composition",
    policy: cadencePolicy(spec),
    observation: {
      checked_at: date,
      status,
      source: "dexa",
      reason:
        status === "flagged" || status === "active"
          ? "Body composition is actively moving or off optimal; batch the next DEXA/body-comp check after a real response window."
          : undefined,
    },
  });
}

function parseWhenDays(text: unknown): number | null {
  const s = lc(text);
  if (!s) return null;
  const range = s.match(/(\d{1,2})\s*[-–]\s*(\d{1,2})\s*(week|weeks|wk|wks|month|months|mo|mos)\b/);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    const unit = range[3];
    const mid = Math.round((a + b) / 2);
    return /mo/.test(unit) || /month/.test(unit) ? mid * 30 : mid * 7;
  }
  const single = s.match(/\b(?:in\s*)?(\d{1,2})\s*(week|weeks|wk|wks|month|months|mo|mos)\b/);
  if (single) {
    const n = Number(single[1]);
    const unit = single[2];
    return /mo/.test(unit) || /month/.test(unit) ? n * 30 : n * 7;
  }
  if (/\bannual|yearly|1 year|12 months\b/.test(s)) return 365;
  if (/\bquarter|3 months|90 days\b/.test(s)) return 90;
  return null;
}

function labelsInText(text: string): string[] {
  const out: string[] = [];
  for (const spec of POLICY_SPECS) {
    for (const label of spec.labels) {
      const needle = lc(label).replace(/[()]/g, "");
      const hay = lc(text).replace(/[()]/g, "");
      if (hay.includes(needle)) out.push(label);
    }
  }
  if (/\bdexa|body comp|body composition\b/i.test(text)) out.push("Body fat");
  return [...new Set(out)];
}

function applyReviewFollowups(): AttentionScheduleEntry[] {
  const review = getLatestHealthReview() as any;
  const parsed = review?.parsed;
  const followups = Array.isArray(parsed?.followups) ? parsed.followups : [];
  const created = String(review?.created_at ?? "").slice(0, 10);
  const checkedAt = /^\d{4}-\d{2}-\d{2}$/.test(created) ? created : todayISO();
  const out: AttentionScheduleEntry[] = [];
  for (const f of followups) {
    const what = String(f?.what ?? "").replace(/\s+/g, " ").trim();
    if (!what || !/\b(retest|recheck|repeat|draw|labs?|dexa|scan)\b/i.test(what)) continue;
    const labels = labelsInText(`${what} ${f?.when ?? ""}`);
    const days = parseWhenDays(f?.when) ?? parseWhenDays(what);
    for (const label of labels.length ? labels : ["lab follow-up"]) {
      const spec = policyForLabel(label) ?? {
        signalClass: "review-followup",
        labels: [label],
        activeDays: days ?? 84,
        confirmingDays: 84,
        surveillanceInitialDays: 180,
        surveillanceMaxDays: 365,
        reason: "The latest health review named this as a follow-up to batch into the next clinician-style checkpoint.",
        release: "The review follow-up has been completed or superseded by newer data.",
      };
      const policy = cadencePolicy({ ...spec, activeDays: days ?? spec.activeDays }, `Health review follow-up: ${what}${f?.when ? ` (${f.when})` : ""}.`);
      out.push(applyAttentionObservation({
        signal_key: `review-followup:${signalSlug(label)}:${signalSlug(what)}`,
        policy,
        observation: {
          checked_at: checkedAt,
          status: "active",
          source: "health_review",
          reason: policy.reason,
        },
      }));
    }
  }
  return out;
}

function markerKeysOnFile(markers: MarkerLike[]): Set<string> {
  const keys = new Set<string>();
  for (const marker of markers) {
    const name = String(marker.name ?? marker.key ?? "");
    if (!name) continue;
    keys.add(lc(name));
    keys.add(lc(marker.key));
    keys.add(lc(canonicalMarker(name).name));
    keys.add(lc(canonicalMarker(name).key));
    const zone = matchOptimalZone(name);
    if (zone) keys.add(lc(zone.label));
  }
  return keys;
}

function hasAny(keys: Set<string>, labels: string[]): boolean {
  return labels.some((label) => keys.has(lc(label)) || keys.has(lc(canonicalMarker(label).name)) || keys.has(lc(canonicalMarker(label).key)));
}

export function recommendedPanel(): MissingWorkupItem[] {
  const { markers } = getMarkerHistory() as { markers: MarkerLike[] };
  const keys = markerKeysOnFile(markers);
  const hasDexa = latestDexaDate(markers) != null;
  return MISSING_PANEL.filter((item) => {
    if (item.key === "thyroid-axis") return !hasAny(keys, ["TSH", "Free T4", "Free T3"]);
    if (item.key === "dexa-body-composition") return !hasDexa;
    if (item.key === "fasting-insulin") return !hasAny(keys, ["Fasting insulin", "Insulin"]);
    if (item.key === "urine-acr") return !hasAny(keys, ["Urine albumin/creatinine ratio", "Albumin/Creatinine Ratio", "UACR"]);
    return !hasAny(keys, [item.label]);
  });
}

export function refreshDoctorLoopAttention(): AttentionScheduleEntry[] {
  const { markers } = getMarkerHistory() as { markers: MarkerLike[] };
  const activeMarkers = activeDirectiveMarkers();
  const out: AttentionScheduleEntry[] = [];
  const seen = new Set<string>();
  for (const marker of markers) {
    const entry = applyMarkerAttention(marker, activeMarkers);
    if (!entry || seen.has(entry.signal_key)) continue;
    seen.add(entry.signal_key);
    out.push(entry);
  }
  const dexa = applyDexaAttention(markers);
  if (dexa && !seen.has(dexa.signal_key)) out.push(dexa);
  for (const entry of applyReviewFollowups()) {
    if (seen.has(entry.signal_key)) continue;
    seen.add(entry.signal_key);
    out.push(entry);
  }
  return out;
}

export function doctorLoopRead(opts: { refresh?: boolean; asOf?: string } = {}): DoctorLoopRead {
  if (opts.refresh) refreshDoctorLoopAttention();
  return {
    attention: [
      ...listAttentionSchedule({ domain: "health", limit: 80 }),
      ...listAttentionSchedule({ domain: "body", limit: 20 }),
    ],
    due: [
      ...listDueAttention(opts.asOf ?? todayISO(), { domain: "health", limit: 50 }),
      ...listDueAttention(opts.asOf ?? todayISO(), { domain: "body", limit: 20 }),
    ],
    missing_workup: recommendedPanel(),
    frame: "Informational, not medical advice. Retests are batched into calm clinician-style checkpoints; fully normal, stable signals are allowed to go quiet until new data, symptoms, a goal change, or a question brings them back.",
  };
}
