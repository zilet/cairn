// @ts-check
// marker-row (docs/V2-PLAN.md wave 3): the `.hmk` row every marker list prints — the
// Records catalog, a Stand domain, the Body view's DEXA rows and the older Health tab.
// The row leads with what the marker is doing (the trend lead), keeps the latest value
// and its reference as supporting detail, and carries two SEPARATE marks:
//   - the LAB FLAG (`.hmk-flag`): the lab's own high/low (or a value outside the lab's
//     printed range), and
//   - the OPTIMAL phrase (`.hmk-opt`): above/below the evidence-anchored optimal band.
// They are two facts and never one word (the v2 law "the lab flag stays separate from
// the optimal band"); an optimal zone is not the lab range. The status dot keeps its
// tone, and the marks say in words what the colour says, so colour is never the only
// signal. The row's expand button carries `data-hmk-toggle` for a delegating host.
{
  type Row = Record<string, unknown> & {
    key?: unknown;
    name?: unknown;
    unit?: unknown;
    // `reported`: the value as its lab printed it when that was another unit system
    // (src/repo/lab-display.ts) — the shown value is in the athlete's lab units.
    latest?: { value?: unknown; date?: unknown; flag?: unknown; reported?: unknown } | null;
    prev?: { value?: unknown } | null;
    status_basis?: unknown;
    status_note?: unknown;
    active_directive?: unknown;
    trend?: { dir?: unknown; span_days?: unknown } | null;
    points?: Array<{ value?: unknown; date?: unknown }> | null;
  };

  const HM = () => CairnHealthMarkers;

  /** The lab-flag mark, or "" when the lab has no complaint. */
  function labFlagHtml(marker: Row | null | undefined): string {
    const word = HM().labFlagWord(marker);
    if (!word) return "";
    return `<span class="hmk-flag" data-flag="${escAttr(word)}" title="${escAttr(`The lab reads this ${word}`)}"><span class="hmk-flag-src">Lab</span> ${escHtml(word)}</span>`;
  }

  /** The optimal phrase ("above optimal"), or "" when inside the band or unjudged. */
  function optimalHtml(marker: Row | null | undefined): string {
    const phrase = HM().offOptimalWord(marker);
    return phrase ? `<span class="hmk-opt">${escHtml(phrase)}</span>` : "";
  }

  /** Both marks, side by side as two elements; "" when neither applies. */
  function marksHtml(marker: Row | null | undefined): string {
    const flag = labFlagHtml(marker);
    const opt = optimalHtml(marker);
    return flag || opt ? `<span class="hmk-marks">${[flag, opt].filter(Boolean).join(" ")}</span>` : "";
  }

  function deltaHtml(marker: Row | null | undefined): string {
    const lv = Number(marker?.latest?.value);
    const pv = marker?.prev ? Number(marker.prev.value) : NaN;
    if (!Number.isFinite(lv) || !Number.isFinite(pv) || lv === pv) return "";
    const df = lv - pv;
    return `<span class="hmk-delta">${df > 0 ? "▲" : "▼"} ${escHtml(HM().formatMarkerNumber(Math.abs(df)))}</span>`;
  }

  // The sub-line: when, the number it is compared to (optimal band, else lab range —
  // never a written-out "in range"), and a wearable's weekly basis in plain words.
  function whenHtml(marker: Row | null | undefined): string {
    const latest = marker?.latest || {};
    const age = latest.date ? relAge(String(latest.date)) : "";
    const ref = HM().markerReferenceSub(marker);
    const weekly = marker?.status_basis === "week" && marker?.status_note ? String(marker.status_note) : "";
    const sub = [age, ref, weekly].filter(Boolean).join(" · ");
    if (!sub) return "";
    const title = latest.date ? ` title="${escAttr(absDate(String(latest.date)))}"` : "";
    return `<span class="hmk-when"${title}>${escHtml(sub)}</span>`;
  }

  function rowHtml(marker: Row | null | undefined, index = 0): string {
    const latest = marker?.latest || {};
    const panel = HM().markerPanelHtml(marker);
    const exp = !!panel;
    const unit = marker?.unit ? `<span class="hmk-unit">${escHtml(marker.unit)}</span>` : "";
    const st = HM().markerStatus(marker);
    const valClass = st === "watch" ? " mst-watch" : st === "warn" ? " mst-warn" : "";
    const trendLead = CairnUiReads.trendLeadHtml({
      name: marker?.name || marker?.key || "",
      phrase: HM().markerTrendWord(marker),
      tone: HM().markerTrendTone(marker),
    });
    const rowInner = `<span class="hdot hdot-${st}" aria-hidden="true"></span>
      <div class="hmk-id">
        ${trendLead}
        ${marksHtml(marker)}
        ${whenHtml(marker)}
      </div>
      <span class="hmk-right">
        ${deltaHtml(marker)}
        <span class="hmk-val${valClass}"${latest.reported ? ` title="${escAttr(`As reported: ${String(latest.reported)}`)}"` : ""}>${escHtml(HM().formatMarkerNumber(latest.value))}${unit}</span>
        <span class="hmk-chev${exp ? "" : " hmk-chev-ghost"}" aria-hidden="true">${exp ? "▾" : ""}</span>
      </span>`;
    // A marker currently shaping training/meals/watch says so in the directive's OWN
    // athlete-facing words (never re-derived here); a tap shows it on Connections.
    const directiveText = String(marker?.active_directive || "").trim();
    const directiveLine = directiveText
      ? `<button type="button" class="hmk-directive" data-directive-link>${escHtml(directiveText)}<span class="hmk-directive-arw" aria-hidden="true"> →</span></button>`
      : "";
    return `<div class="hmk reveal${exp ? " hmk-x" : ""}" style="${stagger(index)}" data-mkey="${escAttr(marker?.key || "")}">
    ${
      exp
        ? `<button class="hmk-row" type="button" aria-expanded="false" data-hmk-toggle>${rowInner}</button>
        <div class="hmk-panel"><div class="hmk-panel-in">${panel}</div></div>`
        : `<div class="hmk-row">${rowInner}</div>`
    }
    ${directiveLine}
  </div>`;
  }

  const CAIRN_MARKER_ROW = { rowHtml, labFlagHtml, optimalHtml, marksHtml };

  Object.assign(globalThis, { CairnMarkerRow: CAIRN_MARKER_ROW });
}
