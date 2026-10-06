// @ts-check
// The Plan screen's head: the reads and slots that sit ABOVE the day gallery (the
// week strip, the recovery-week banner, "Coming up"), split out of
// plan-editor-controller.ts. The Plan edit segment and the endurance segment both
// paint these slots; renderPlanEditor asks the reads up front (headReads) so they
// land in one frame with the gallery.
(() => {
// The recovery-week banner — a reshaped week announces itself instead of arriving
// silently. Three states from /plan/recovery-status: review-only DRAFT, an UPCOMING
// lead-mode week that lands automatically, or the APPLIED lighter week (heads-up +
// the coach's own summary of what changed + when building resumes). Painted
// asynchronously into its slot; a null status leaves the plan untouched.
function planRecoveryBannerHtml(rs: import("../contracts/client.js").ClientRecoveryWeekStatus): string {
  if (!rs || (rs.state !== "drafted" && rs.state !== "upcoming" && rs.state !== "applied")) return "";
  if (rs.state === "drafted") {
    return `<div class="plan-recovery-banner reveal">
      <span class="lbl plan-recovery-mast">YOUR RECOVERY WEEK</span>
      <p class="plan-recovery-line">Drafted and waiting — nothing changes until you review and apply it.</p>
      ${rs.summary ? `<p class="plan-recovery-summary">${escHtml(rs.summary)}</p>` : ""}
      <button class="draftbtn plan-recovery-review" id="planRecoveryReview" type="button">Review and apply it →</button>
    </div>`;
  }
  if (rs.state === "upcoming") {
    const when = upcomingWhenLabel(rs.effective_date);
    return `<div class="plan-recovery-banner reveal">
      <span class="lbl plan-recovery-mast">YOUR RECOVERY WEEK</span>
      <p class="plan-recovery-line">Set for ${escHtml(when || "the week boundary")} — it lands automatically at the week boundary, with no Apply step.</p>
      ${rs.summary ? `<p class="plan-recovery-summary">${escHtml(rs.summary)}</p>` : ""}
      <p class="plan-recovery-until">Hold it before then or Undo after it lands; your word always wins.</p>
    </div>`;
  }
  const until = fmtDate(rs.until);
  return `<div class="plan-recovery-banner plan-recovery-on reveal">
    <span class="lbl plan-recovery-mast">RECOVERY WEEK</span>
    <p class="plan-recovery-line">Heads up — this week is deliberately lighter: about half the working volume, same movements, crisp easy efforts. Don't chase PRs; this is where the adaptation lands.</p>
    ${rs.summary ? `<p class="plan-recovery-summary">${escHtml(rs.summary)}</p>` : ""}
    ${until ? `<p class="plan-recovery-until">Back to building around ${escHtml(until)}.</p>` : ""}
  </div>`;
}

// A local date-label helper (rs.until is a plain YYYY-MM-DD local day).
function fmtDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  if (!m) return "";
  return CairnFmt.date(iso, { fmt: { weekday: "long", month: "short", day: "numeric" } });
}

// "lands Monday" for something inside the week, else "Mon, Jul 21" further out —
// a plain YYYY-MM-DD local day (the decision's effective_date).
function upcomingWhenLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  if (!m) return "";
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((d.getTime() - today.getTime()) / 86400000);
  return CairnFmt.date(iso, days >= 0 && days <= 6 ? { fmt: { weekday: "long" } } : { style: "label" });
}

// The calm forward look: queued training/recovery changes the brain will land
// soon, one quiet line each. Pull-never-push — a heads-up that a reshaped week is
// coming, never a retrospective "what your team did" feed. Capped at 2.
function planUpcomingRowsHtml(items: import("../contracts/client.js").ClientPlanUpcomingItem[]): string {
  return items
    .map((it) => {
      const summary = String(it?.summary ?? "").trim();
      if (!summary) return "";
      const when = upcomingWhenLabel(String(it?.effective_date ?? ""));
      const explanation = String(it?.explanation ?? "").trim();
      return `<div class="plan-upcoming-item">
        <p class="plan-upcoming-line">${when ? `<span class="plan-upcoming-when">${escHtml(when)}</span> — ` : ""}${escHtml(summary)}</p>
        ${explanation ? `<p class="plan-upcoming-why">${escHtml(explanation)}</p>` : ""}
      </div>`;
    })
    .join("");
}

// Items a section actually renders (non-empty summary) — the same filter
// planUpcomingRowsHtml applies, kept in sync so the collapsed strip's counts
// always match what's behind the disclosure.
function planUpcomingCount(items: import("../contracts/client.js").ClientPlanUpcomingItem[]): number {
  return items.filter((it) => String(it?.summary ?? "").trim()).length;
}

function planUpcomingNoteHtml(note: import("../contracts/client.js").ClientPlanUpcomingNote): string {
  const comingItems = note && Array.isArray(note.items) ? note.items.slice(0, 2) : [];
  // What already landed, and why — the half that used to vanish the moment a change
  // took effect, leaving a reshaped week with nothing to explain it.
  const landedItems = note && Array.isArray(note.landed) ? note.landed.slice(0, 2) : [];
  // Still waiting on the athlete — shown first, because it is the only one of the
  // three that is an open question rather than a report. A `for_clinician` row is not
  // theirs to answer alone: it is for them and their doctor, under its own mast.
  const awaitingAll = note && Array.isArray(note.awaiting) ? note.awaiting : [];
  const awaitingItems = awaitingAll.filter((it) => !it?.for_clinician).slice(0, 2);
  const clinicianItems = awaitingAll.filter((it) => !!it?.for_clinician).slice(0, 2);
  const rows = planUpcomingRowsHtml(comingItems);
  const landedRows = planUpcomingRowsHtml(landedItems);
  const awaitingRows = planUpcomingRowsHtml(awaitingItems);
  const clinicianRows = planUpcomingRowsHtml(clinicianItems);
  if (!rows.trim() && !landedRows.trim() && !awaitingRows.trim() && !clinicianRows.trim()) return "";
  // Collapsed by default: a single footnote-weight strip naming only the sections
  // that have items, so "Waiting on you" stays discoverable without reprinting the
  // full rationale paragraphs every time the plan opens. One tap expands to the
  // full content below; the plan itself never has to scroll past this to be seen.
  const strip = [
    awaitingRows.trim() ? `Waiting on you (${planUpcomingCount(awaitingItems)})` : "",
    clinicianRows.trim() ? `For you and your doctor (${planUpcomingCount(clinicianItems)})` : "",
    rows.trim() ? `Coming up (${planUpcomingCount(comingItems)})` : "",
    landedRows.trim() ? `Where this came from (${planUpcomingCount(landedItems)})` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `<details class="plan-upcoming reveal">
    <summary><span class="lbl plan-upcoming-strip">${escHtml(strip)}</span></summary>
    <div class="plan-upcoming-body">
      ${awaitingRows.trim() ? `<span class="lbl plan-upcoming-mast">Waiting on you</span>${awaitingRows}` : ""}
      ${clinicianRows.trim() ? `<span class="lbl plan-upcoming-mast">For you and your doctor</span>${clinicianRows}` : ""}
      ${rows.trim() ? `<span class="lbl plan-upcoming-mast">Coming up</span>${rows}` : ""}
      ${landedRows.trim() ? `<span class="lbl plan-upcoming-mast">Where this came from</span>${landedRows}` : ""}
    </div>
  </details>`;
}

// Shared by the Plan edit segment and the endurance segment (both under the
// "plan" tab) — paints into whichever slot the caller owns.
function loadPlanUpcomingNote(token: number, slotSel = "#planUpcomingSlot", pending?: Promise<unknown>): void {
  void (pending ?? api("/plan/upcoming"))
    .then((note) => {
      if (token !== pollToken || state.tab !== "plan") return;
      const slot = $(slotSel);
      if (!slot) return;
      slot.innerHTML = planUpcomingNoteHtml(note as import("../contracts/client.js").ClientPlanUpcomingNote);
    })
    .catch(() => {});
}

/** Connected week strip for Strength + Endurance. Returns annotations for gallery chips. */
function loadPlanWeekStrip(
  token: number,
  slotSel = "#planWeekSlot",
  onWeek?: (week: import("../contracts/client.js").ClientPlanWeek) => void,
  pending?: Promise<unknown>
): void {
  void (pending ?? api("/plan/week"))
    .then((week) => {
      if (token !== pollToken || state.tab !== "plan") return;
      const slot = view.querySelector(slotSel) || $(slotSel);
      if (slot && typeof CairnPlanWeek !== "undefined") {
        slot.innerHTML = CairnPlanWeek.stripHtml(week);
      }
      if (onWeek && week && typeof week === "object") {
        onWeek(week as import("../contracts/client.js").ClientPlanWeek);
      }
    })
    .catch(() => {});
}

function loadPlanRecoveryBanner(token: number, pending?: Promise<unknown>): void {
  void (pending ?? api("/plan/recovery-status"))
    .then((rs) => {
      if (token !== pollToken || state.tab !== "plan") return;
      const slot = $("#planRecoverySlot");
      if (!slot) return;
      slot.innerHTML = planRecoveryBannerHtml(rs as import("../contracts/client.js").ClientRecoveryWeekStatus);
      $("#planRecoveryReview")?.addEventListener("click", () => {
        state.planJump = "coach";
        activateTab("plan");
      });
    })
    .catch(() => {});
}

// The four reads that sit ABOVE the day gallery (week strip, recovery banner, "Coming
// up", redraw strip) each used to land on their own and push the gallery down as they
// did (a 0.37 layout shift on a cold open). They start together with /plan and the
// screen paints once they have all answered, so every slot fills in the same frame.
// The wait is bounded: a read slower than this paints when it lands, as before.
const PLAN_HEAD_WAIT_MS = 2000;
// A warm re-entry (the plan itself painted from its peek) holds for far less: its
// reads answer quickly, and the gallery should not sit behind a slow one.
const PLAN_HEAD_WARM_WAIT_MS = 350;

// A read started ahead of its consumer must not surface as an unhandled rejection;
// the consumer still sees the original outcome.
function planHeadRead(path: string): Promise<unknown> {
  const pending = api(path);
  pending.catch(() => {});
  return pending;
}

function planHeadReads(): { week: Promise<unknown>; recovery: Promise<unknown>; upcoming: Promise<unknown> } {
  return {
    week: planHeadRead("/plan/week"),
    recovery: planHeadRead("/plan/recovery-status"),
    upcoming: planHeadRead("/plan/upcoming"),
  };
}


const CAIRN_PLAN_HEAD = {
  WAIT_MS: PLAN_HEAD_WAIT_MS,
  WARM_WAIT_MS: PLAN_HEAD_WARM_WAIT_MS,
  headRead: planHeadRead,
  headReads: planHeadReads,
  recoveryBannerHtml: planRecoveryBannerHtml,
  loadRecoveryBanner: loadPlanRecoveryBanner,
};

Object.assign(globalThis, { CairnPlanHead: CAIRN_PLAN_HEAD, loadPlanUpcomingNote, loadPlanWeekStrip });
if (typeof window !== "undefined") {
  window.loadPlanUpcomingNote = loadPlanUpcomingNote;
  window.loadPlanWeekStrip = loadPlanWeekStrip;
}
})();
