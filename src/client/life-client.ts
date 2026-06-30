// @ts-check
// Me Life timeline renderers: pure HTML for trips, injuries, and life events.

type LifeKind = "trip" | "injury" | "life_event";
type LifeKindRow = readonly [LifeKind, string];

type LifeEventRow = {
  id?: unknown;
  kind?: unknown;
  title?: unknown;
  detail?: unknown;
  start_date?: unknown;
  end_date?: unknown;
  archived?: unknown;
  meta_json?: unknown;
};

type LifeImpact = {
  affected?: unknown;
};

type LifeImpactAffected = {
  exercise?: unknown;
  days?: Array<{ day_name?: unknown; day_number?: unknown }>;
  constraint_note?: unknown;
  swaps?: Array<{ name?: unknown; why?: unknown }>;
};

(() => {
const LIFE_KINDS: readonly LifeKindRow[] = [["trip", "Trip"], ["injury", "Injury"], ["life_event", "Life event"]];
const LIFE_ICONS: Record<string, string> = { trip: "✈", injury: "🤕", life_event: "◆" };

function lifeKindLabel(kind: unknown): string {
  const key = String(kind || "");
  const row = LIFE_KINDS.find((item) => item[0] === key);
  return row ? row[1] : (key || "Event");
}

function lifeKindOptionsHtml(): string {
  return LIFE_KINDS.map(([kind, label]) => `<option value="${escAttr(kind)}">${escHtml(LIFE_ICONS[kind])} ${escHtml(label)}</option>`).join("");
}

function parsedMeta(event: LifeEventRow | null | undefined): Record<string, unknown> {
  let raw = event?.meta_json;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  return raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
}

function fmtDateRange(start: unknown, end: unknown): string {
  const startText = start ? String(start) : "";
  const endText = end ? String(end) : "";
  if (startText && endText && startText !== endText) return `${escHtml(startText)} → ${escHtml(endText)}`;
  if (startText) return escHtml(startText);
  if (endText) return `until ${escHtml(endText)}`;
  return "";
}

function daysUntil(iso: unknown, todayIso = localISO()): number | null {
  const dateText = iso ? String(iso) : "";
  if (!dateText) return null;
  const today = new Date(`${todayIso}T00:00:00`);
  const date = new Date(`${dateText}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  return Math.round((date.getTime() - today.getTime()) / 86400000);
}

function eventActive(event: LifeEventRow | null | undefined, todayIso = localISO()): boolean {
  if (!event || event.archived) return false;
  const end = event.end_date ? String(event.end_date) : "";
  const start = event.start_date ? String(event.start_date) : "";
  if (end) return end >= todayIso;
  if (start) return true;
  return true;
}

function lifeFieldsHtml(kind: unknown): string {
  const text = (id: string, label: string, placeholder = "") =>
    `<div class="field" style="margin-bottom:9px"><label>${escHtml(label)}</label><input id="${escAttr(id)}" type="text" placeholder="${escAttr(placeholder)}" class="form-input"></div>`;
  const date = (id: string, label: string) =>
    `<div class="field" style="margin-bottom:9px"><label>${escHtml(label)}</label><input id="${escAttr(id)}" type="date" class="form-input" value=""></div>`;
  if (kind === "trip") {
    return text("lTitle", "Title", "e.g. Lisbon work trip") +
      text("lLocation", "Location", "e.g. Lisbon") +
      `<div class="ob-grid">${date("lStart", "Start")}${date("lEnd", "End")}</div>` +
      text("lDetail", "Detail (optional)");
  }
  if (kind === "injury") {
    return text("lTitle", "Title", "e.g. Right knee") +
      text("lArea", "Area", "e.g. knee / lower back") +
      `<div class="field" style="margin-bottom:9px"><label>Severity</label>
        <select id="lSeverity" class="selflex">
          <option value="mild">Mild</option><option value="moderate">Moderate</option><option value="severe">Severe</option>
        </select></div>` +
      date("lStart", "Since") +
      date("lEnd", "Expected resolved (optional)") +
      text("lDetail", "Detail (optional)");
  }
  return text("lTitle", "Title", "e.g. New baby") +
    `<div class="ob-grid">${date("lStart", "Start")}${date("lEnd", "End (optional)")}</div>` +
    `<div class="field" style="margin-bottom:9px"><label>Impact</label>
      <select id="lImpact" class="selflex">
        <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
      </select></div>` +
    text("lDetail", "Detail (optional)");
}

function lifeImpactsHtml(impact: LifeImpact | null | undefined): string {
  const affected = Array.isArray(impact?.affected) ? impact.affected as LifeImpactAffected[] : [];
  if (!affected.length) return "";
  const rows = affected.map((item) => {
    const where = Array.isArray(item.days) && item.days.length
      ? item.days.map((day) => escHtml(day.day_name || `Day ${day.day_number}`)).join(", ")
      : "";
    const note = item.constraint_note ? `<div class="linj-note">${escHtml(item.constraint_note)}</div>` : "";
    const swaps = Array.isArray(item.swaps) && item.swaps.length
      ? `<div class="linj-swaps"><span class="linj-swaps-lbl">try instead</span>${item.swaps
          .map((swap) => `<span class="linj-swap" title="${escAttr(swap.why || "")}">${escHtml(swap.name)}</span>`)
          .join("")}</div>`
      : "";
    return `<div class="linj-ex">
        <div class="linj-exhead">
          <span class="linj-exname">${escHtml(item.exercise)}</span>
          ${where ? `<span class="linj-exwhere">${where}</span>` : ""}
        </div>
        ${note}
        ${swaps}
      </div>`;
  }).join("");
  return `<div class="linj">
      <div class="linj-lead">Touches ${affected.length} planned move${affected.length === 1 ? "" : "s"} — ease off or swap, your call.</div>
      ${rows}
    </div>`;
}

function lifeEventInner(event: LifeEventRow, impact?: LifeImpact | null): string {
  const meta = parsedMeta(event);
  const kind = String(event.kind || "");
  const start = event.start_date ? String(event.start_date) : "";
  const end = event.end_date ? String(event.end_date) : "";
  const icon = LIFE_ICONS[kind] || "◆";
  const range = fmtDateRange(start, end);
  const delta = daysUntil(start);
  let when = "";
  if (!event.archived && delta != null) {
    if (delta > 0) when = `in ${delta} day${delta === 1 ? "" : "s"}`;
    else if (delta === 0) when = "today";
    else if (kind !== "injury" && (!end || end < localISO())) when = "past";
    else when = "active";
  }
  const metaBits = [];
  if (meta.location) metaBits.push(escHtml(meta.location));
  if (meta.area) metaBits.push(escHtml(meta.area));
  if (meta.severity) metaBits.push(escHtml(meta.severity));
  if (meta.impact) metaBits.push(`${escHtml(meta.impact)} impact`);
  const metaLine = metaBits.join(" · ");
  return `<div class="sess-head">
      <span class="sess-date"><span class="life-ico">${escHtml(icon)}</span> ${escHtml(event.title || lifeKindLabel(kind))}</span>
      ${when ? `<span class="sess-day">${escHtml(when)}</span>` : ""}
    </div>
    ${range ? `<div class="sess-line" style="color:var(--muted)">${range}</div>` : ""}
    ${metaLine ? `<div class="sess-line" style="color:var(--muted);font-size:.78rem">${metaLine}</div>` : ""}
    ${event.detail ? `<div class="sess-line">${escHtml(event.detail)}</div>` : ""}
    ${lifeImpactsHtml(impact)}
    <div class="hdoc-ctl">
      <button class="iconbtn" data-ledit="${escAttr(event.id)}" title="edit">✎</button>
      <button class="iconbtn life-del" data-ldel="${escAttr(event.id)}" title="delete">×</button>
    </div>`;
}

function lifeEventHtml(event: LifeEventRow, index: number | undefined, impactsById?: Record<string, LifeImpact>): string {
  const past = !eventActive(event) || Boolean(event.archived);
  const reveal = typeof index === "number";
  const impact = event.kind === "injury" && !past ? (impactsById || {})[String(event.id)] : null;
  return `<div class="sess life-ev${past ? " life-past" : ""}${reveal ? " reveal" : ""}" data-life="${escAttr(event.id)}"${reveal ? ` style="${stagger(index)}"` : ""}>${lifeEventInner(event, impact)}</div>`;
}

const CAIRN_LIFE = {
  LIFE_KINDS,
  LIFE_ICONS,
  lifeKindLabel,
  lifeKindOptionsHtml,
  parsedMeta,
  fmtDateRange,
  daysUntil,
  eventActive,
  lifeFieldsHtml,
  lifeImpactsHtml,
  lifeEventInner,
  lifeEventHtml,
};

Object.assign(globalThis, { CairnLife: CAIRN_LIFE });

if (typeof window !== "undefined") {
  window.CairnLife = CAIRN_LIFE;
}
})();
