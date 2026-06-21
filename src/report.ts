// Clinician-facing health report — a doctor-ready, print-to-PDF document.
//
// Distinct from `buildHealthExport()` (the FHIR-inspired JSON interchange slice):
// this is a HUMAN artifact. It renders the same marker history Cairn already
// derives (prioritizeMarkers → latest value + lab flag + optimal band + trend +
// full dated history, grouped into clinical panels) as a self-contained,
// print-optimized HTML page a physician can read — or "Save as PDF" and attach
// to a MyChart message. A plain-text twin is generated for pasting straight into
// a MyChart message body.
//
// CONSTITUTION: no 0-100 scores anywhere (the internal impact_score never crosses
// the prioritizeMarkers boundary). "Optimal target" bands are evidence-anchored
// preventive/longevity references, clearly labeled as DISTINCT from a lab's
// population reference interval — informational, not medical advice.

import * as repo from "./repo.js";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(iso?: string | null): string {
  if (!iso) return "";
  const [y, m, d] = String(iso).split("-").map(Number);
  if (!y) return String(iso);
  return `${MON[(m || 1) - 1]} ${d || 1}, ${y}`;
}

function fmtShort(iso?: string | null): string {
  if (!iso) return "";
  const [y, m] = String(iso).split("-").map(Number);
  if (!y) return String(iso);
  return `${MON[(m || 1) - 1]} '${String(y).slice(2)}`;
}

function fmtVal(v: unknown): string {
  if (v == null || v === "") return "—";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  return String(v);
}

function heightText(cm?: number | null): string {
  if (!cm || !Number.isFinite(cm)) return "";
  const totalIn = cm / 2.54;
  const ft = Math.floor(totalIn / 12);
  const inch = Math.round(totalIn - ft * 12);
  return `${ft}'${inch}" (${Math.round(cm)} cm)`;
}

// The optimal band as a target phrase. `dir` is the WORSE direction: 'high' →
// lower is better (≤ high), 'low' → higher is better (≥ low), else a band.
function optimalText(o: { low: number; high: number; dir: string } | null): string | null {
  if (!o) return null;
  if (o.dir === "high") return `≤ ${fmtVal(o.high)}`;
  if (o.dir === "low") return `≥ ${fmtVal(o.low)}`;
  return `${fmtVal(o.low)}–${fmtVal(o.high)}`;
}

// Span in human words from a day count.
function spanText(days?: number | null): string {
  if (!days || days < 1) return "";
  if (days < 60) return `${days} d`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `${months} mo`;
  return `${Math.round((days / 365.25) * 10) / 10} yr`;
}

export interface ReportMarker {
  name: string;
  unit: string | null;
  value: unknown;
  flag: "high" | "low" | null; // the lab's own out-of-range flag (normal stripped to null)
  abnormal: boolean; // lab-flagged OR out of optimal target
  optimal: { low: number; high: number; dir: string } | null;
  optimalText: string | null;
  inOptimal: boolean | null;
  latestDate: string | null;
  trendDir: string | null;
  trendText: string | null;
  history: Array<{ value: unknown; date: string; flag: string | null }>;
}

export interface ReportGroup {
  key: string;
  label: string;
  markers: ReportMarker[];
}

export interface ClinicalReportData {
  subject: { name: string | null; sex: string | null; age: number | null; heightText: string; weightLb: number | null };
  generated: string;
  dateRange: { from: string; to: string } | null;
  findings: ReportMarker[];
  groups: ReportGroup[];
  bodyComp: { summary: string; asOf: string | null } | null;
  supplements: Array<{ name: string; dose: string | null; frequency: string | null }>;
  sources: Array<{ date: string | null; kind: string; name: string }>;
}

// Report-local guard against the shared optimal-zone matcher's substring
// over-match on composite/qualitative marker names — e.g. "Total Cholesterol /
// HDL Ratio" grabbing HDL's band, "LDL Pattern A" grabbing LDL's, a urine
// albumin grabbing serum creatinine's, or "Testosterone, Free" (pg/mL) grabbing
// total-T's (ng/dL) band. On a clinician doc a false target reads as an error,
// so we only TRUST (and thus display) an optimal band when the name isn't one of
// these traps and the value is numerically comparable. The lab's own H/L flag is
// authoritative and never suppressed; this only governs the optimal annotation.
function optimalTrustworthy(name: string, value: unknown): boolean {
  const n = name.toLowerCase();
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return false; // qualitative result (e.g. pattern "A")
  if (/\bratio\b|\bpattern\b|\burine\b/.test(n)) return false;
  if (n.includes("/")) return false; // composite "x / y" names
  if (n.includes("free") && n.includes("testosterone")) return false; // no free-T zone
  return true;
}

function toMarkerView(m: any): ReportMarker {
  const flag = m?.latest?.flag === "high" || m?.latest?.flag === "low" ? m.latest.flag : null;
  const trusted = optimalTrustworthy(String(m?.name ?? ""), m?.latest?.value);
  const inOptimal = trusted && typeof m?.in_optimal === "boolean" ? m.in_optimal : null;
  const optimal = trusted && m?.optimal && Number.isFinite(m.optimal.low) && Number.isFinite(m.optimal.high)
    ? { low: m.optimal.low, high: m.optimal.high, dir: m.optimal.dir }
    : null;
  const points = Array.isArray(m?.points) ? m.points : [];
  const t = m?.trend || {};
  // Build a plain-language trend phrase: direction + first→last over the span.
  let trendText: string | null = null;
  if (points.length >= 2 && t.dir) {
    const first = points[0];
    const last = points[points.length - 1];
    const span = spanText(t.span_days);
    trendText = `${t.dir} · ${fmtVal(first.value)}→${fmtVal(last.value)}${span ? ` over ${span}` : ""}`;
  } else if (t.projection) {
    trendText = String(t.projection);
  }
  return {
    name: String(m?.name ?? ""),
    unit: m?.unit ?? null,
    value: m?.latest?.value ?? null,
    flag,
    abnormal: !!flag || inOptimal === false,
    optimal,
    optimalText: optimalText(optimal),
    inOptimal,
    latestDate: m?.latest?.date ?? null,
    trendDir: t.dir ?? null,
    trendText,
    history: points.map((p: any) => ({ value: p.value, date: p.date, flag: p.flag ?? null })),
  };
}

export function buildClinicalReportData(): ClinicalReportData {
  const profile = (repo.getProfile() as any) || {};
  const { markers, groups } = repo.prioritizeMarkers() as any;

  const views: ReportMarker[] = (Array.isArray(markers) ? markers : []).map(toMarkerView);

  // Findings to discuss: the abnormal subset, kept in prioritizeMarkers' priority
  // order (lab-flagged first, then furthest-from-optimal / worst trajectory).
  const findings = views.filter((v) => v.abnormal);

  // Group in canonical order (groups[] from prioritizeMarkers is already ordered).
  const order: Array<{ key: string; label: string }> = Array.isArray(groups) ? groups : [];
  const byGroup = new Map<string, ReportMarker[]>();
  const groupLabel = new Map<string, string>();
  for (const m of markers as any[]) {
    const k = m?.group || "other";
    groupLabel.set(k, m?.group_label || "Other Markers");
    if (!byGroup.has(k)) byGroup.set(k, []);
    byGroup.get(k)!.push(toMarkerView(m));
  }
  const grouped: ReportGroup[] = [];
  const seen = new Set<string>();
  for (const g of order) {
    const list = byGroup.get(g.key);
    if (list && list.length) {
      grouped.push({ key: g.key, label: g.label || groupLabel.get(g.key) || g.key, markers: list });
      seen.add(g.key);
    }
  }
  // Any group present in the data but not in the canonical order (defensive).
  for (const [k, list] of byGroup) {
    if (!seen.has(k) && list.length) grouped.push({ key: k, label: groupLabel.get(k) || k, markers: list });
  }

  // Whole date span covered by every reading.
  let from: string | null = null;
  let to: string | null = null;
  for (const v of views) {
    for (const h of v.history) {
      if (!h.date) continue;
      if (!from || h.date < from) from = h.date;
      if (!to || h.date > to) to = h.date;
    }
  }

  // DEXA caption — the latest dexa document's plain summary, for the body-comp panel.
  let bodyComp: ClinicalReportData["bodyComp"] = null;
  try {
    const docs = (repo.listHealthDocuments() as any[]) || [];
    const dexa = docs
      .filter((d) => (d.kind === "dexa" || /dexa|dxa/i.test(String(d.original_name || ""))) && d.summary)
      .sort((a, b) => String(b.doc_date || "").localeCompare(String(a.doc_date || "")))[0];
    if (dexa) bodyComp = { summary: String(dexa.summary), asOf: dexa.doc_date ?? null };
  } catch {
    bodyComp = null;
  }

  // Active supplements — what the athlete takes (a clinician wants the list).
  let supplements: ClinicalReportData["supplements"] = [];
  try {
    supplements = ((repo.listSupplements({ activeOnly: true }) as any[]) || []).map((s) => ({
      name: String(s.name ?? ""),
      dose: s.dose ?? null,
      frequency: s.frequency ?? null,
    }));
  } catch {
    supplements = [];
  }

  // Source provenance — the documents these readings came from, by date.
  let sources: ClinicalReportData["sources"] = [];
  try {
    sources = ((repo.listHealthDocuments() as any[]) || [])
      .map((d) => ({ date: d.doc_date ?? null, kind: String(d.kind || "other"), name: String(d.original_name || "document") }))
      .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  } catch {
    sources = [];
  }

  return {
    subject: {
      name: (profile.name && String(profile.name).trim()) || null,
      sex: profile.sex ?? null,
      age: profile.age ?? null,
      heightText: heightText(profile.height_cm),
      weightLb: profile.weight_lb ?? null,
    },
    generated: new Date().toISOString(),
    dateRange: from && to ? { from, to } : null,
    findings,
    groups: grouped,
    bodyComp,
    supplements,
    sources,
  };
}

// ---- flag / result rendering ----

function flagChip(flag: string | null): string {
  if (flag === "high") return `<span class="flag flag-h">High</span>`;
  if (flag === "low") return `<span class="flag flag-l">Low</span>`;
  return "";
}

// Plain wording for a lab-normal value sitting outside its optimal band — relative
// to the optimal target, not an alarm ("above optimal" / "below optimal").
function optimalSide(m: ReportMarker): string {
  if (!m.optimal) return "outside optimal";
  const num = typeof m.value === "number" ? m.value : Number(m.value);
  if (!Number.isFinite(num)) return "outside optimal";
  return num > m.optimal.high ? "above optimal" : num < m.optimal.low ? "below optimal" : "outside optimal";
}

// A subtle "vs target" note when a value is lab-normal but outside the optimal band.
function optimalNote(m: ReportMarker): string {
  if (m.flag || m.inOptimal !== false || !m.optimal) return "";
  const num = typeof m.value === "number" ? m.value : Number(m.value);
  if (!Number.isFinite(num)) return "";
  return `<span class="offt">${optimalSide(m)}</span>`;
}

function resultCell(m: ReportMarker): string {
  // Out-of-range values are HIGHLIGHTED (calm amber), not painted red.
  const cls = m.abnormal ? "res hl" : "res";
  return `<span class="${cls}">${esc(fmtVal(m.value))}${m.unit ? ` <span class="u">${esc(m.unit)}</span>` : ""}</span> ${flagChip(m.flag)}${optimalNote(m)}`;
}

function historyCell(m: ReportMarker): string {
  // A single reading is not a history — show only WHEN it was drawn, never a lone
  // "previous value" or a trend (there is nothing to trend off one point).
  if (m.history.length <= 1) {
    const only = m.history[0]?.date || m.latestDate;
    return only ? `<span class="dt">${esc(fmtShort(only))}</span>` : "—";
  }
  const seq = m.history
    .slice(-6)
    .map((h) => {
      const fc = h.flag === "high" || h.flag === "low" ? " hi" : "";
      return `<span class="hv${fc}">${esc(fmtVal(h.value))}</span> <span class="dt">${esc(fmtShort(h.date))}</span>`;
    })
    .join(`<span class="sep">·</span>`);
  const dir = m.trendDir;
  const arrow = dir === "rising" ? "↗" : dir === "falling" ? "↘" : dir === "stable" ? "→" : "";
  const trend = arrow ? `<span class="trend ${esc(dir || "")}">${arrow} ${esc(dir || "")}</span> ` : "";
  return `${trend}${seq}`;
}

function groupTable(g: ReportGroup): string {
  const rows = g.markers
    .map(
      (m) => `<tr class="${m.abnormal ? "row-abn" : ""}">
      <td class="m-name">${esc(m.name)}</td>
      <td class="m-res">${resultCell(m)}</td>
      <td class="m-tgt">${m.optimalText ? esc(m.optimalText) : "—"}</td>
      <td class="m-hist">${historyCell(m)}</td>
    </tr>`
    )
    .join("\n");
  return `<section class="group">
    <h2>${esc(g.label)}</h2>
    <table class="markers">
      <thead><tr><th>Marker</th><th>Result</th><th>Optimal target<span class="th-note">†</span></th><th>History</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function findingsBox(findings: ReportMarker[]): string {
  if (!findings.length) {
    return `<section class="findings none"><h2>Findings</h2><p>No markers fall outside their lab reference range or optimal target.</p></section>`;
  }
  const CAP = 24;
  const shown = findings.slice(0, CAP);
  const items = shown
    .map((m) => {
      const status = m.flag === "high" ? "High" : m.flag === "low" ? "Low" : m.inOptimal === false ? optimalSide(m) : "";
      const tgt = m.optimalText ? ` <span class="f-tgt">optimal ${esc(m.optimalText)}</span>` : "";
      const tr = m.trendText ? ` <span class="f-tr">${esc(m.trendText)}</span>` : "";
      return `<li><span class="f-name">${esc(m.name)}</span> <span class="f-val">${esc(fmtVal(m.value))}${m.unit ? ` ${esc(m.unit)}` : ""}</span> <span class="f-flag ${m.flag || "off"}">${esc(status)}</span>${tgt}${tr}</li>`;
    })
    .join("\n");
  const more = findings.length > CAP ? `<li class="f-more">+ ${findings.length - CAP} more outside range — see panels below</li>` : "";
  return `<section class="findings">
    <h2>Findings to discuss</h2>
    <ul class="f-list">${items}${more}</ul>
  </section>`;
}

// ---- plain-text twin (for pasting into a MyChart message body) ----

export function renderClinicalReportText(data: ClinicalReportData, opts: { name?: string } = {}): string {
  const L: string[] = [];
  // An explicit ?name= override wins; otherwise stamp the name set in the profile.
  const name = ((opts.name || "").trim()) || (data.subject.name || "");
  L.push(`HEALTH SUMMARY${name ? ` — ${name}` : ""}`);
  const sub: string[] = [];
  if (data.subject.sex) sub.push(data.subject.sex);
  if (data.subject.age != null) sub.push(`age ${data.subject.age}`);
  if (data.subject.heightText) sub.push(data.subject.heightText.replace(/\s*\(.*\)/, ""));
  if (data.subject.weightLb != null) sub.push(`${data.subject.weightLb} lb`);
  L.push(`Generated ${fmtDate(data.generated.slice(0, 10))}${sub.length ? ` · ${sub.join(", ")}` : ""}`);
  if (data.dateRange) L.push(`Readings ${fmtDate(data.dateRange.from)} – ${fmtDate(data.dateRange.to)}`);
  L.push("");

  if (data.findings.length) {
    L.push("FINDINGS TO DISCUSS");
    for (const m of data.findings) {
      const status = m.flag === "high" ? "High" : m.flag === "low" ? "Low" : optimalSide(m);
      const tgt = m.optimalText ? ` · optimal ${m.optimalText}` : "";
      const tr = m.trendText ? ` · ${m.trendText}` : "";
      L.push(`  • ${m.name} — ${fmtVal(m.value)}${m.unit ? ` ${m.unit}` : ""} (${status})${tgt}${tr}`);
    }
    L.push("");
  }

  for (const g of data.groups) {
    L.push(g.label.toUpperCase());
    for (const m of g.markers) {
      const flag = m.flag === "high" ? " [High]" : m.flag === "low" ? " [Low]" : m.inOptimal === false ? ` [${optimalSide(m)}]` : "";
      const hist = m.history.length > 1 ? `   {${m.history.slice(-6).map((h) => `${fmtVal(h.value)} ${fmtShort(h.date)}`).join(" · ")}}` : "";
      const tgt = m.optimalText ? `  (optimal ${m.optimalText})` : "";
      L.push(`  ${m.name}: ${fmtVal(m.value)}${m.unit ? ` ${m.unit}` : ""}${flag}${tgt}${hist}`);
    }
    L.push("");
  }

  if (data.bodyComp) {
    L.push(`BODY COMPOSITION (DEXA${data.bodyComp.asOf ? `, ${fmtDate(data.bodyComp.asOf)}` : ""})`);
    L.push(`  ${data.bodyComp.summary}`);
    L.push("");
  }

  if (data.supplements.length) {
    L.push("SUPPLEMENTS / WHAT I TAKE");
    for (const s of data.supplements) {
      const detail = [s.dose, s.frequency].filter(Boolean).join(", ");
      L.push(`  • ${s.name}${detail ? ` — ${detail}` : ""}`);
    }
    L.push("");
  }

  L.push("— Optimal targets are evidence-anchored preventive/longevity bands, DISTINCT from the");
  L.push("  lab's population reference interval. Informational, not medical advice. Generated by Cairn.");
  return L.join("\n");
}

// ---- the self-contained, print-optimized HTML document ----

const STYLE = `
:root{
  --ink:#2b2724; --soft:#6b635c; --faint:#9a9089; --line:#e7e0d6; --paper:#fbf8f3;
  --card:#fffdf9; --terra:#b4533a; --terra-bg:#f7e9e3; --sage:#5f7355; --sage-bg:#eaefe6;
  --amber:#9a6a1c; --amber-bg:#f6ecd9;
}
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;background:var(--paper);color:var(--ink);
  font-family:'Schibsted Grotesk',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  font-size:13px;line-height:1.5}
.wrap{max-width:880px;margin:0 auto;padding:22px 26px 60px}
h1,h2,.brand{font-family:'Fraunces',Georgia,'Times New Roman',serif;font-weight:600;letter-spacing:-.01em}
a{color:var(--terra)}

/* screen-only toolbar */
.toolbar{position:sticky;top:0;z-index:5;background:rgba(251,248,243,.94);backdrop-filter:blur(6px);
  border-bottom:1px solid var(--line);padding:11px 26px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.toolbar .hint{color:var(--soft);font-size:11.5px;flex:1 1 240px;min-width:200px}
.btn{font:inherit;font-size:12.5px;font-weight:600;border:1px solid var(--line);background:var(--card);
  color:var(--ink);border-radius:9px;padding:8px 14px;cursor:pointer}
.btn.primary{background:var(--terra);border-color:var(--terra);color:#fff}
.btn.on{background:var(--ink);border-color:var(--ink);color:var(--paper)}
.copied{color:var(--sage);font-size:12px;font-weight:600;display:none}

/* header */
.head{display:flex;justify-content:space-between;align-items:flex-end;gap:18px;
  border-bottom:2px solid var(--ink);padding-bottom:12px;margin:8px 0 18px}
h1{font-size:25px;margin:0 0 3px}
.brand{font-size:12px;color:var(--terra);text-transform:uppercase;letter-spacing:.13em;font-weight:600}
.pname{font-size:15px;font-weight:600;outline:none;border-bottom:1px dashed transparent;padding:0 1px}
.pname:empty:before{content:'Add your name';color:var(--faint);font-weight:400}
.pname[contenteditable]:hover,.pname[contenteditable]:focus{border-bottom-color:var(--line)}
.meta{text-align:right;color:var(--soft);font-size:11.5px;line-height:1.7}
.meta .sub{color:var(--ink);font-weight:600;font-size:13px}

/* findings */
.findings{background:var(--amber-bg);border:1px solid #e7d4ac;border-radius:13px;padding:15px 18px;margin:0 0 22px;break-inside:avoid}
.findings.none{background:var(--sage-bg);border-color:#d7e2cf}
.findings h2{font-size:16px;margin:0 0 10px;color:var(--amber)}
.findings.none h2{color:var(--sage)}
.f-list{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:5px 22px}
.f-list li{font-size:12px;line-height:1.45;padding:2px 0;border-bottom:1px solid rgba(180,83,58,.12)}
.f-name{font-weight:600}
.f-val{font-variant-numeric:tabular-nums}
.f-flag{font-weight:700;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--amber)}
.f-flag.low{color:var(--amber)}
.f-flag.off{color:var(--soft)}
.f-tgt,.f-tr{color:var(--soft);font-size:11px}
.f-more{grid-column:1 / -1;color:var(--soft);font-style:italic;border:0}

/* group tables */
.group{margin:0 0 18px}
.group h2{font-size:14px;margin:0 0 6px;color:var(--ink);break-after:avoid;
  border-bottom:1px solid var(--line);padding-bottom:4px}
table.markers{width:100%;border-collapse:collapse;font-size:12px}
table.markers thead th{text-align:left;font-weight:600;color:var(--soft);font-size:10.5px;
  text-transform:uppercase;letter-spacing:.04em;padding:4px 8px;border-bottom:1px solid var(--line)}
.th-note{color:var(--faint);font-weight:400}
table.markers td{padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top}
table.markers tr{break-inside:avoid}
.row-abn{background:rgba(154,106,28,.05)}
.m-name{font-weight:600;width:30%}
.m-res{width:23%;font-variant-numeric:tabular-nums}
.m-tgt{width:14%;color:var(--soft);font-variant-numeric:tabular-nums}
.m-hist{width:33%;color:var(--soft);font-size:11px}
.res{font-weight:600}
.res.hl{background:var(--amber-bg);border-radius:4px;padding:1px 5px}
.res .u{color:var(--faint);font-weight:400;font-size:11px}
.flag{display:inline-block;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;
  padding:1px 5px;border-radius:5px;vertical-align:1px}
.flag-h{background:var(--amber-bg);color:var(--amber)}
.flag-l{background:var(--amber-bg);color:var(--amber)}
.offt{color:var(--amber);font-size:10.5px;font-style:italic;margin-left:3px}
.hv{font-variant-numeric:tabular-nums;color:var(--ink)}
.hv.hi{color:var(--amber);font-weight:600}
.dt{color:var(--faint)}
.sep{color:var(--faint);margin:0 4px}
/* trend direction is neutral — rising/falling is not good/bad without context */
.trend{font-weight:600;margin-right:5px;font-size:10.5px;color:var(--soft)}
.trend.rising,.trend.falling,.trend.stable{color:var(--soft)}

/* body comp caption + supplements + footnotes */
.cap{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--sage);
  border-radius:0 8px 8px 0;padding:9px 13px;margin:0 0 14px;font-size:12px;color:var(--soft)}
.supps{font-size:12px;color:var(--ink);margin:0 0 16px}
.supps li{margin:2px 0}
.foot{margin-top:26px;padding-top:12px;border-top:1px solid var(--line);color:var(--faint);font-size:10.5px;line-height:1.6}
.foot .srcs{margin-top:6px}
.foot b{color:var(--soft);font-weight:600}

@media print{
  .toolbar,.no-print{display:none!important}
  .wrap{max-width:none;padding:0}
  @page{size:letter;margin:13mm}
  body{font-size:11px;background:#fff}
  .findings{background:#f6ecd9!important}
  thead{display:table-header-group}
}
.body.findings-only .group,.body.findings-only .bodycomp,.body.findings-only .suppwrap{display:none}
`;

export function renderClinicalReportHTML(data: ClinicalReportData, opts: { name?: string } = {}): string {
  // An explicit ?name= override wins; otherwise stamp the name set in the profile.
  // The header span stays contenteditable so it can still be filled/changed on paper.
  const name = esc(((opts.name || "").trim()) || (data.subject.name || ""));
  const sub: string[] = [];
  if (data.subject.sex) sub.push(esc(data.subject.sex));
  if (data.subject.age != null) sub.push(`${esc(data.subject.age)}`);
  if (data.subject.heightText) sub.push(esc(data.subject.heightText));
  if (data.subject.weightLb != null) sub.push(`${esc(data.subject.weightLb)} lb`);

  const bodyComp = data.bodyComp
    ? `<div class="cap bodycomp"><b>DEXA${data.bodyComp.asOf ? ` · ${esc(fmtDate(data.bodyComp.asOf))}` : ""}:</b> ${esc(data.bodyComp.summary)}</div>`
    : "";

  const supps = data.supplements.length
    ? `<section class="suppwrap"><h2 style="font-family:'Fraunces',Georgia,serif;font-size:14px;border-bottom:1px solid var(--line);padding-bottom:4px;margin:0 0 6px">Supplements</h2>
       <ul class="supps">${data.supplements
         .map((s) => `<li>${esc(s.name)}${[s.dose, s.frequency].filter(Boolean).length ? ` — ${esc([s.dose, s.frequency].filter(Boolean).join(", "))}` : ""}</li>`)
         .join("")}</ul></section>`
    : "";

  const plain = renderClinicalReportText(data, opts);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Health Summary${name ? ` — ${name}` : ""}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600&family=Schibsted+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${STYLE}</style>
</head>
<body>
<div class="toolbar no-print">
  <button class="btn primary" onclick="window.print()">⬇ Save as PDF</button>
  <button class="btn" id="copyBtn">⧉ Copy for MyChart</button>
  <button class="btn" id="toggleBtn">Findings only</button>
  <span class="copied" id="copied">Copied ✓</span>
  <span class="hint">Tap <b>Save as PDF</b>, then choose “Save as PDF” in the print dialog. On iPhone: Share → Print → pinch the preview → Share → Save to Files.</span>
</div>
<div class="wrap body" id="body">
  <div class="head">
    <div>
      <div class="brand">Cairn · Health Summary</div>
      <h1><span class="pname" contenteditable="true" spellcheck="false">${name}</span></h1>
      <div style="color:var(--soft);font-size:12px">${sub.join(" · ")}</div>
    </div>
    <div class="meta">
      <div class="sub">Generated ${esc(fmtDate(data.generated.slice(0, 10)))}</div>
      ${data.dateRange ? `<div>Readings ${esc(fmtDate(data.dateRange.from))} – ${esc(fmtDate(data.dateRange.to))}</div>` : ""}
    </div>
  </div>

  ${findingsBox(data.findings)}
  ${bodyComp}
  ${data.groups.map(groupTable).join("\n")}
  ${supps}

  <div class="foot">
    <b>†&nbsp;Optimal target</b> bands are evidence-anchored preventive / longevity references — DISTINCT from a lab's population reference interval (a value can read “in range” yet sit outside an optimal target). This summary is informational and is not medical advice. No 0–100 scores are used.
  </div>
</div>
<textarea id="plain" style="position:absolute;left:-9999px;top:-9999px" readonly>${esc(plain)}</textarea>
<script>
(function(){
  var copyBtn=document.getElementById('copyBtn'),copied=document.getElementById('copied'),
      toggleBtn=document.getElementById('toggleBtn'),body=document.getElementById('body'),
      plain=document.getElementById('plain');
  copyBtn&&copyBtn.addEventListener('click',function(){
    var text=plain.value;
    function ok(){copied.style.display='inline';setTimeout(function(){copied.style.display='none'},2200);}
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(ok,function(){plain.select();document.execCommand('copy');ok();});}
    else{plain.select();document.execCommand('copy');ok();}
  });
  toggleBtn&&toggleBtn.addEventListener('click',function(){
    var on=body.classList.toggle('findings-only');
    toggleBtn.textContent=on?'Show all markers':'Findings only';
    toggleBtn.classList.toggle('on',on);
  });
})();
</script>
</body>
</html>`;
}
