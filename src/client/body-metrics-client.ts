// @ts-check
// Body Metrics — a calm at-home measurements + indicators + trend view.
//
// Self-contained: renderBodyMetrics(mount) fetches /api/body-metrics, paints the
// derived indicators (BMI, waist-to-height, waist-to-hip, Navy body-fat estimate)
// in plain language (no scores), a compact "log a session" form, an optional
// "set your height" affordance (unlocks BMI/body-fat), and per-site sparkline
// trends with words ("waist down 0.8 in over 6 weeks"). Atelier-flavoured with
// existing classes + inline styles only, so it ships without a stylesheet change.
//
// Wave D exposes it; the mount point (a Progress segment / Me sub-tab) + the
// client-build/index.html/sw wiring are SEAMed to the surface owners.

type BmTone = "ok" | "watch" | "warn" | "info";

interface BmMeasurement {
  id: number;
  date: string;
  waist_in: number | null;
  hip_in: number | null;
  chest_in: number | null;
  shoulder_in: number | null;
  neck_in: number | null;
  thigh_in: number | null;
  upper_arm_in: number | null;
  calf_in: number | null;
  forearm_in: number | null;
  note: string | null;
  source: string | null;
}
interface BmIndicator {
  key: string;
  label: string;
  value: number | null;
  unit: string;
  zone: string | null;
  tone: BmTone;
  read: string;
  estimate?: boolean;
  needs?: string[];
}
interface BmTrend {
  key: string;
  label: string;
  unit: string;
  latest: number | null;
  n: number;
  points: number[];
  direction: "up" | "down" | "steady" | null;
  text: string;
}
interface BmSummary {
  latest: BmMeasurement | null;
  measurements: BmMeasurement[];
  indicators: BmIndicator[];
  trends: { window_days: number | null; sites: BmTrend[]; weight: BmTrend };
  profile: { height_in: number | null; sex: string; weight_lb: number | null; goal_weight_lb: number | null };
  needs_height: boolean;
  sites: { key: string; label: string }[];
}

(() => {
const BM_TONE_COLOR: Record<BmTone, string> = {
  ok: "var(--sage, #6e7f5c)",
  watch: "var(--gold, #c9a86a)",
  warn: "var(--terra, #b4552d)",
  info: "var(--muted, #8a8578)",
};

function bmNum(el: Element | null): number | null {
  if (!el) return null;
  const raw = (el as HTMLInputElement).value.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// Feet + inches → total inches (either field optional).
function bmHeightInches(mount: HTMLElement): number | null {
  const ft = bmNum(mount.querySelector("#bmHeightFt"));
  const inch = bmNum(mount.querySelector("#bmHeightIn"));
  if (ft == null && inch == null) return null;
  return (ft ?? 0) * 12 + (inch ?? 0);
}

function indicatorCard(ind: BmIndicator): string {
  const color = BM_TONE_COLOR[ind.tone] || BM_TONE_COLOR.info;
  const known = ind.value != null;
  const big = known
    ? `${escHtml(String(ind.value))}${ind.unit ? escHtml(ind.unit) : ""}`
    : "—";
  const zone = ind.zone ? `<span class="bm-ind-zone" style="color:${color}">${escHtml(ind.zone)}</span>` : "";
  const est = ind.estimate ? `<span class="bm-ind-est" style="color:var(--muted,#8a8578);font-size:.72rem"> · estimate</span>` : "";
  return `<div class="sess bm-ind" style="border-left:3px solid ${color};padding:10px 12px">
      <div class="bm-ind-top" style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
        <span class="bm-ind-label" style="font-weight:600">${escHtml(ind.label)}${est}</span>
        <span class="bm-ind-val" style="font-size:1.15rem;font-weight:700;color:${color}">${big}</span>
      </div>
      <div class="bm-ind-read sess-line" style="color:var(--muted,#8a8578);margin-top:2px">${zone ? zone + " · " : ""}${escHtml(ind.read)}</div>
    </div>`;
}

function heightForm(profile: BmSummary["profile"]): string {
  const inches = profile.height_in;
  const ft = inches != null ? Math.floor(inches / 12) : "";
  const rem = inches != null ? Math.round((inches - Math.floor(inches / 12) * 12) * 10) / 10 : "";
  const known = inches != null;
  return `<div class="sess bm-height reveal" style="padding:12px">
      <div style="font-weight:600;margin-bottom:6px">${known ? "Height" : "Set your height"}</div>
      <div class="sess-line" style="color:var(--muted,#8a8578);margin-bottom:8px">${known ? "Used for BMI, waist-to-height and the body-fat estimate." : "BMI, waist-to-height and body-fat need your height."}</div>
      <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
        <label class="field" style="margin:0"><span>Feet</span><input id="bmHeightFt" class="form-input" type="number" inputmode="numeric" min="3" max="8" value="${escAttr(String(ft))}" style="width:5rem"></label>
        <label class="field" style="margin:0"><span>Inches</span><input id="bmHeightIn" class="form-input" type="number" inputmode="decimal" min="0" max="11.9" step="0.5" value="${escAttr(String(rem))}" style="width:5rem"></label>
        <button id="bmHeightSave" class="chip" type="button">Save height</button>
      </div>
    </div>`;
}

function logForm(sites: { key: string; label: string }[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const inputs = sites
    .map(
      (s) =>
        `<label class="field" style="margin:0"><span>${escHtml(s.label)}</span><input class="form-input bm-site" data-site="${escAttr(s.key)}" type="number" inputmode="decimal" min="1" max="100" step="0.1" placeholder="in" style="width:100%"></label>`
    )
    .join("");
  return `<details class="sess bm-log reveal" style="padding:12px">
      <summary style="font-weight:600;cursor:pointer">Log measurements</summary>
      <div class="sess-line" style="color:var(--muted,#8a8578);margin:6px 0 10px">Tape, relaxed, same time of day. Fill in what you measured — the rest stays blank.</div>
      <div class="bm-site-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(6.5rem,1fr));gap:8px">${inputs}</div>
      <div style="display:flex;gap:8px;align-items:flex-end;margin-top:10px;flex-wrap:wrap">
        <label class="field" style="margin:0"><span>Date</span><input id="bmDate" class="form-input" type="date" value="${escAttr(today)}"></label>
        <label class="field" style="margin:0;flex:1;min-width:9rem"><span>Note</span><input id="bmNote" class="form-input" type="text" placeholder="optional" style="width:100%"></label>
        <button id="bmLogSave" class="chip" type="button">Log session</button>
      </div>
    </details>`;
}

function goalMovement(weight: BmTrend, profile: BmSummary["profile"]): string {
  if (profile.goal_weight_lb == null || weight.latest == null) return "";
  const remaining = Math.round((weight.latest - profile.goal_weight_lb) * 10) / 10;
  if (Math.abs(remaining) < 0.5) return `<span class="bm-goal" style="color:var(--sage,#6e7f5c)"> · at your goal weight</span>`;
  const dir = remaining > 0 ? "to lose" : "to gain";
  return `<span class="bm-goal" style="color:var(--muted,#8a8578)"> · ${escHtml(String(Math.abs(remaining)))} lb ${dir} to goal</span>`;
}

function trendRow(t: BmTrend, extra = ""): string {
  const spark = t.points.length >= 2 ? `<span class="bm-trend-spark">${sparklineSvg(t.points)}</span>` : "";
  const latest = t.latest != null ? `${escHtml(String(t.latest))} ${escHtml(t.unit)}` : "—";
  const arrow = t.direction === "down" ? "↓" : t.direction === "up" ? "↑" : t.direction === "steady" ? "→" : "";
  return `<div class="sess-line bm-trend-row" style="display:flex;align-items:center;gap:10px;padding:6px 0">
      <span class="bm-trend-label" style="min-width:6rem;font-weight:600">${escHtml(t.label)}</span>
      <span class="bm-trend-latest" style="min-width:5rem;color:var(--muted,#8a8578)">${latest} ${escHtml(arrow)}</span>
      ${spark}
      <span class="bm-trend-text" style="flex:1;color:var(--muted,#8a8578)">${escHtml(t.text)}${extra}</span>
    </div>`;
}

function summaryHtml(data: BmSummary): string {
  const indicators = data.indicators.map(indicatorCard).join("");
  const trendSites = data.trends.sites.filter((s) => s.n >= 1).map((s) => trendRow(s)).join("");
  const weightRow = data.trends.weight.n >= 1 ? trendRow(data.trends.weight, goalMovement(data.trends.weight, data.profile)) : "";
  const empty = !data.latest
    ? `<div class="sess-line" style="color:var(--muted,#8a8578);padding:8px 0">No measurements yet — log a session below and your indicators + trends fill in.</div>`
    : "";
  const trends = trendSites || weightRow
    ? `<div class="bm-trends" style="margin-top:14px">
        <div class="bm-sechead" style="font-weight:600;margin-bottom:4px">Trends</div>
        ${weightRow}${trendSites}
      </div>`
    : "";
  return `<div class="bm-root">
      <div class="bm-eyebrow" style="text-transform:uppercase;letter-spacing:.08em;font-size:.72rem;color:var(--muted,#8a8578);margin-bottom:8px">Body</div>
      ${data.needs_height ? heightForm(data.profile) : ""}
      <div class="bm-indicators" style="display:grid;gap:8px;margin-bottom:12px">${indicators}</div>
      ${empty}
      ${!data.needs_height ? heightForm(data.profile) : ""}
      ${logForm(data.sites)}
      ${trends}
    </div>`;
}

async function loadAndRender(mount: HTMLElement): Promise<void> {
  const data = (await api("/body-metrics")) as unknown as BmSummary;
  mount.innerHTML = summaryHtml(data);
  wire(mount);
}

function wire(mount: HTMLElement): void {
  const heightBtn = mount.querySelector("#bmHeightSave");
  if (heightBtn) {
    heightBtn.addEventListener("click", async () => {
      const inches = bmHeightInches(mount);
      if (inches == null) {
        toast("Enter your height first.");
        return;
      }
      try {
        await api("/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ height_in: inches }) });
        toast("Height saved.");
        await loadAndRender(mount);
      } catch {
        toast("Could not save height.");
      }
    });
  }

  const logBtn = mount.querySelector("#bmLogSave");
  if (logBtn) {
    logBtn.addEventListener("click", async () => {
      const body: Record<string, unknown> = {};
      mount.querySelectorAll(".bm-site").forEach((el) => {
        const site = (el as HTMLInputElement).dataset.site;
        const value = bmNum(el);
        if (site && value != null) body[site] = value;
      });
      if (!Object.keys(body).length) {
        toast("Fill in at least one measurement.");
        return;
      }
      const dateEl = mount.querySelector("#bmDate") as HTMLInputElement | null;
      const noteEl = mount.querySelector("#bmNote") as HTMLInputElement | null;
      if (dateEl?.value) body.date = dateEl.value;
      if (noteEl?.value.trim()) body.note = noteEl.value.trim();
      try {
        await api("/body-metrics", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        toast("Measurements logged.");
        await loadAndRender(mount);
      } catch {
        toast("Could not log measurements.");
      }
    });
  }
}

function renderBodyMetrics(mount: HTMLElement | null): void {
  if (!mount) return;
  mount.innerHTML = `<div class="bm-loading sess-line" style="color:var(--muted,#8a8578);padding:12px">Reading your measurements…</div>`;
  loadAndRender(mount).catch(() => {
    mount.innerHTML = `<div class="bm-error sess-line" style="color:var(--muted,#8a8578);padding:12px">Couldn't load body metrics right now.</div>`;
  });
}

const CAIRN_BODY_METRICS = { renderBodyMetrics };
Object.assign(globalThis, { CairnBodyMetrics: CAIRN_BODY_METRICS, renderBodyMetrics });
if (typeof window !== "undefined") {
  (window as unknown as { CairnBodyMetrics: typeof CAIRN_BODY_METRICS }).CairnBodyMetrics = CAIRN_BODY_METRICS;
}
})();
