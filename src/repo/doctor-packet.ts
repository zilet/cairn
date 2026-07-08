import { todayISO } from "../db.js";
import { annotateDirectiveFreshness, prioritizeMarkers } from "./propagation.js";
import { listDirectives } from "./coach.js";
import { doctorLoopRead, type DoctorLoopRead } from "./doctor-loop.js";
import { cardiovascularRiskRead } from "./risk.js";
import { healthFocus, type HealthFocus } from "./health-focus.js";
import { healthOutcomeAnnotations, type HealthOutcomeRead } from "./health-outcomes.js";

export const DOCTOR_PACKET_VERSION = 1;

type PacketMarker = {
  name: string;
  group: string | null;
  value: unknown;
  unit: string | null;
  effective_date: string | null;
  lab_flag: string | null;
  in_optimal: boolean | null;
  trend: string | null;
  forecast: string | null;
};

type PacketDirective = {
  id: number | null;
  domain: string | null;
  marker: string | null;
  directive: string | null;
  rationale: string | null;
  citation: string | null;
  uncertain: boolean;
  freshness: {
    stale: boolean;
    reason: string | null;
    acute: boolean;
    age_days: number | null;
  };
};

export interface DoctorPacketRead {
  meta: {
    resourceType: "CairnDoctorPacket";
    exportVersion: number;
    generated: string;
    asOf: string;
    note: string;
  };
  health_focus: Pick<HealthFocus, "headline" | "lead" | "surfaced" | "act_now" | "track">;
  priority_markers: PacketMarker[];
  active_directives: PacketDirective[];
  doctor_loop: Pick<DoctorLoopRead, "due" | "missing_workup" | "frame"> & {
    attention: DoctorLoopRead["attention"];
    upcoming: DoctorLoopRead["attention"];
  };
  cardiovascular_risk: ReturnType<typeof cardiovascularRiskRead>;
  outcomes: HealthOutcomeRead;
  discussion_points: string[];
  frame: string;
}

function dateOnly(value: unknown): string | null {
  const s = String(value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function cleanText(value: unknown, max = 280): string | null {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

function packetMarkers(limit: number): PacketMarker[] {
  const read = prioritizeMarkers() as any;
  const markers = Array.isArray(read?.markers) ? read.markers : [];
  const n = Math.max(1, Math.min(20, Number(limit) || 8));
  return markers.slice(0, n).map((m: any) => ({
    name: cleanText(m?.name, 120) ?? "Unknown marker",
    group: cleanText(m?.group_label ?? m?.group, 120),
    value: m?.latest?.value ?? null,
    unit: cleanText(m?.unit ?? m?.latest?.unit, 40),
    effective_date: dateOnly(m?.latest?.date),
    lab_flag: cleanText(m?.latest?.flag, 40),
    in_optimal: typeof m?.in_optimal === "boolean" ? m.in_optimal : null,
    trend: cleanText(m?.trend?.dir, 40),
    forecast: cleanText(m?.forecast?.eta_text ?? m?.trend?.projection, 240),
  }));
}

function activeDirectivePacket(): PacketDirective[] {
  const directives = annotateDirectiveFreshness(listDirectives() as any[]);
  return directives.map((d: any) => ({
    id: Number.isFinite(Number(d?.id)) ? Number(d.id) : null,
    domain: cleanText(d?.domain, 40),
    marker: cleanText(d?.marker, 120),
    directive: cleanText(d?.directive, 320),
    rationale: cleanText(d?.rationale, 320),
    citation: cleanText(d?.citation, 240),
    uncertain: !!d?.uncertain,
    freshness: {
      stale: !!d?.stale,
      reason: cleanText(d?.stale_reason ?? d?.freshness_reason ?? d?.reason, 240),
      acute: !!d?.acute,
      age_days: Number.isFinite(Number(d?.age_days)) ? Number(d.age_days) : null,
    },
  }));
}

function upcomingAttention(loop: DoctorLoopRead, asOf: string, limit: number) {
  const n = Math.max(1, Math.min(20, Number(limit) || 12));
  return loop.attention
    .filter((entry) => entry.next_due && entry.next_due >= asOf)
    .sort((a, b) => String(a.next_due).localeCompare(String(b.next_due)))
    .slice(0, n);
}

function discussionPoints(args: {
  focus: HealthFocus;
  loop: DoctorLoopRead;
  risk: ReturnType<typeof cardiovascularRiskRead>;
  outcomes: HealthOutcomeRead;
  directives: PacketDirective[];
}): string[] {
  const out: string[] = [];
  if (args.focus.lead?.group) {
    out.push(`${args.focus.lead.group}: ${args.focus.lead.why}`);
  }
  const due = args.loop.due
    .slice(0, 3)
    .map((d) => d.signal_key.replace(/^[^:]+:/, "").replace(/-/g, " "))
    .filter(Boolean);
  if (due.length) {
    out.push(`Retest/checkpoint due: ${due.join(", ")}.`);
  } else if (args.loop.missing_workup.length) {
    out.push(`Next-draw additions worth discussing: ${args.loop.missing_workup.slice(0, 4).map((w) => w.label).join(", ")}.`);
  }
  if (args.risk.prevent?.estimates?.total_cvd?.ten_year != null) {
    const pct = Math.round(args.risk.prevent.estimates.total_cvd.ten_year * 1000) / 10;
    out.push(`AHA PREVENT total-CVD 10-year estimate: ${pct}%${args.risk.prevent.provisional ? " (provisional)" : ""}.`);
  } else if (Array.isArray(args.risk.inputs?.missing_inputs) && args.risk.inputs.missing_inputs.length) {
    out.push(`Cardiovascular risk read needs: ${args.risk.inputs.missing_inputs.slice(0, 4).join(", ")}.`);
  }
  const enhancers = Array.isArray(args.risk.enhancers) ? args.risk.enhancers.slice(0, 3).map((e: any) => e.label).filter(Boolean) : [];
  if (enhancers.length) out.push(`Risk enhancers to discuss: ${enhancers.join(", ")}.`);
  if (args.outcomes.annotations.length) {
    out.push(`Latest outcome read: ${args.outcomes.annotations[0].summary}`);
  }
  if (!out.length && !args.directives.length) {
    out.push("No urgent health focus is currently surfaced; keep this packet as a baseline for the next clinician conversation.");
  }
  return out.slice(0, 6);
}

export function doctorPacketRead(opts: { refresh?: boolean; asOf?: string; markerLimit?: number; outcomeLimit?: number } = {}): DoctorPacketRead {
  const asOf = dateOnly(opts.asOf) ?? todayISO();
  const focus = healthFocus();
  const directives = activeDirectivePacket();
  const loop = doctorLoopRead({ refresh: opts.refresh ?? true, asOf });
  const risk = cardiovascularRiskRead();
  const outcomes = healthOutcomeAnnotations(opts.outcomeLimit ?? 8);

  return {
    meta: {
      resourceType: "CairnDoctorPacket",
      exportVersion: DOCTOR_PACKET_VERSION,
      generated: new Date().toISOString(),
      asOf,
      note: "Export-ready clinician discussion packet. Informational, not medical advice; no disease-labeling and no wellness scores.",
    },
    health_focus: {
      headline: focus.headline,
      lead: focus.lead,
      surfaced: focus.surfaced,
      act_now: focus.act_now,
      track: focus.track,
    },
    priority_markers: packetMarkers(opts.markerLimit ?? 12),
    active_directives: directives,
    doctor_loop: {
      attention: loop.attention,
      upcoming: upcomingAttention(loop, asOf, 12),
      due: loop.due,
      missing_workup: loop.missing_workup,
      frame: loop.frame,
    },
    cardiovascular_risk: risk,
    outcomes,
    discussion_points: discussionPoints({ focus, loop, risk, outcomes, directives }),
    frame:
      "Use this as a concise doctor/export packet: current focus, active connected-brain directives, retest/workup plan, PREVENT cardiovascular-risk read, and latest outcome annotations. It is informational, not medical advice, and never auto-applies a clinical change.",
  };
}
