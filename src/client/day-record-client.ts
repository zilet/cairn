// @ts-check
// The day page (v2 wave 7, "Today is Home"; docs/IA.md): any day that is not today,
// read-only, at its home-free URL /app/day/<date>.
//
// Today only ever renders today. Every other day is a page read under the tab that
// opened it (a week strip's "Open day ›", a Program row, Horizon's week, the Train
// calendar — all through CairnDrill, drill-controller.ts): a PAST day opens its record (the session, the runs and rides, the
// food summary, a weigh-in, the read that stood), a FUTURE day its preview (the planned
// lift and run, and what is already known to shape it). One read, GET /api/day-record,
// composed on the server (src/domain/today/day-record.ts); nothing here decides what a
// day was or will be.
//
// LAZY ("calendar" bundle): the view renders here; opening a day, its back link's
// target and its name are the drill controller's (CairnDrill).
type DayRecord = import("../contracts/day-record.js").DayRecord;
type DayRecordDetail = import("../contracts/day-detail.js").DayDetail;

{
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  let renderToken = 0;

  function parts(iso: string): Date {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  }

  function shiftISO(iso: string, days: number): string {
    const d = parts(iso);
    d.setDate(d.getDate() + days);
    return localISO(d);
  }

  /** "Mon 28 Sep" — the day as every Today-home header eyebrow prints it. */
  function shortDate(iso: string): string {
    return CairnUiHeader.shortDate(iso);
  }

  // ---- markup (pure) ----

  function movementRowsHtml(record: DayRecord): string {
    const session = record.session;
    if (!session) return "";
    const rows = session.movements
      .map(
        (m) =>
          `<li class="dayrec-mv"><span class="dayrec-mv-name">${escHtml(m.name)}</span><span class="dayrec-mv-best">${escHtml(m.best)}<span class="dayrec-mv-sets"> · ${escHtml(`${m.sets} set${m.sets === 1 ? "" : "s"}`)}</span></span></li>`
      )
      .join("");
    const skipped = session.skipped.length
      ? `<p class="dayrec-note">Set aside that day: ${escHtml(session.skipped.join(", "))}.</p>`
      : "";
    const notes = session.notes ? `<p class="dayrec-note dayrec-quote">${escHtml(session.notes)}</p>` : "";
    return `${rows ? `<ul class="dayrec-mvs">${rows}</ul>` : ""}${skipped}${notes}`;
  }

  function activityRowHtml(a: DayRecord["activities"][number], units: string): string {
    const bits = [
      a.distance_km != null && a.distance_km > 0 ? fmtDist(a.distance_km, units) : "",
      a.duration_min != null && a.duration_min > 0 ? `${Math.round(a.duration_min)} min` : "",
      a.note || "",
    ].filter(Boolean);
    return `<li class="dayrec-row">
      <span class="dayrec-row-k ${a.run ? "is-endurance" : "is-other"}" aria-hidden="true"></span>
      <span class="dayrec-row-main"><span class="dayrec-row-t">${escHtml(a.title.replace(/^./, (c) => c.toUpperCase()))}</span>${bits.length ? `<span class="dayrec-row-s">${escHtml(bits.join(" · "))}</span>` : ""}</span>
    </li>`;
  }

  function trainingHtml(record: DayRecord): string {
    const session = record.session;
    const lift = session
      ? `<li class="dayrec-row dayrec-row-lift">
          <span class="dayrec-row-k is-strength" aria-hidden="true"></span>
          <span class="dayrec-row-main"><span class="dayrec-row-t">${escHtml(session.title)}</span><span class="dayrec-row-s">${escHtml(`${session.sets} set${session.sets === 1 ? "" : "s"}${session.finished ? "" : " · left open"}`)}</span>${movementRowsHtml(record)}</span>
        </li>`
      : "";
    const efforts = record.activities.map((a) => activityRowHtml(a, record.run_units)).join("");
    if (!lift && !efforts) {
      return `<section class="dayrec-sec" aria-label="Training"><h3 class="lbl dayrec-h">Training</h3><p class="dayrec-empty">No training logged.</p></section>`;
    }
    return `<section class="dayrec-sec" aria-label="Training"><h3 class="lbl dayrec-h">Training</h3><ul class="dayrec-rows">${lift}${efforts}</ul></section>`;
  }

  const COVERAGE_WORDS: Record<string, string> = {
    complete: "The whole day logged",
    partial: "Part of the day logged",
    none: "Logged without estimates",
  };

  // A meal's key column: its slot word when it is one ("Breakfast"), else the time the
  // athlete gave, else nothing (a free-text label is already the summary).
  const MEAL_SLOT = /^(breakfast|brunch|lunch|dinner|supper|snack|dessert|pre[- ]?workout|post[- ]?workout|meal)$/i;
  function mealKey(m: { meal: string | null; summary: string; logged_at: string | null }): string {
    const meal = String(m.meal || "").trim();
    if (meal && MEAL_SLOT.test(meal)) return meal.replace(/^./, (c) => c.toUpperCase());
    return String(m.logged_at || "").trim();
  }

  function fuelHtml(record: DayRecord): string {
    const intake = record.intake;
    if (!intake) {
      return `<section class="dayrec-sec" aria-label="Fuel"><h3 class="lbl dayrec-h">Fuel</h3><p class="dayrec-empty">Nothing logged, so the day's intake is unknown.</p></section>`;
    }
    const sums = [
      intake.kcal != null ? `${intake.kcal.toLocaleString()} kcal` : "",
      intake.protein_g != null ? `${intake.protein_g} g protein` : "",
      intake.carbs_g != null ? `${intake.carbs_g} g carbs` : "",
      intake.fat_g != null ? `${intake.fat_g} g fat` : "",
    ].filter(Boolean);
    const meals = intake.meals
      .map((m) => {
        const key = mealKey(m);
        return `<li class="dayrec-meal${key ? "" : " is-bare"}">${key ? `<span class="dayrec-meal-k">${escHtml(key)}</span>` : ""}<span class="dayrec-meal-t">${escHtml(m.summary)}</span></li>`;
      })
      .join("");
    return `<section class="dayrec-sec" aria-label="Fuel"><h3 class="lbl dayrec-h">Fuel</h3>
      ${sums.length ? `<p class="dayrec-sum">${escHtml(sums.join(" · "))}</p>` : ""}
      <p class="dayrec-meta">${escHtml(COVERAGE_WORDS[intake.coverage] || "")}</p>
      ${meals ? `<ul class="dayrec-meals">${meals}</ul>` : ""}
    </section>`;
  }

  function readHtml(record: DayRecord): string {
    const read = record.read;
    if (!read) return "";
    return `<section class="dayrec-sec dayrec-read" aria-label="The read that day"><h3 class="lbl dayrec-h">The read that day</h3>
      <p class="dayrec-read-h">${escHtml(read.headline)}</p>
      ${read.why ? `<p class="dayrec-read-why">${escHtml(read.why)}</p>` : ""}
    </section>`;
  }

  function planHtml(record: DayRecord): string {
    const rows: string[] = [];
    if (record.lift) {
      const sub = [record.lift.focus, record.lift.purpose].filter(Boolean).join(" · ");
      rows.push(`<li class="dayrec-row"><span class="dayrec-row-k is-strength" aria-hidden="true"></span>
        <span class="dayrec-row-main"><span class="dayrec-row-t">${escHtml(record.lift.title)}</span>${sub ? `<span class="dayrec-row-s">${escHtml(sub)}</span>` : ""}</span></li>`);
    }
    if (record.run) {
      const dist = record.run.km != null && record.run.km > 0 ? fmtDist(record.run.km, record.run_units) : "";
      rows.push(`<li class="dayrec-row"><span class="dayrec-row-k is-endurance" aria-hidden="true"></span>
        <span class="dayrec-row-main"><span class="dayrec-row-t">${escHtml(record.run.label)}</span>${dist ? `<span class="dayrec-row-s">${escHtml(dist)}</span>` : ""}</span></li>`);
    }
    const body = rows.length
      ? `<ul class="dayrec-rows">${rows.join("")}</ul>`
      : `<p class="dayrec-empty">Nothing planned. A day to recover.</p>`;
    return `<section class="dayrec-sec" aria-label="Planned"><h3 class="lbl dayrec-h">Planned</h3>${body}
      <p class="dayrec-meta">A preview. That morning's read shapes the day from how you arrive.</p></section>`;
  }

  function caveatsHtml(record: DayRecord): string {
    if (!record.caveats.length) return "";
    return `<ul class="dayrec-caveats">${record.caveats
      .map(
        (c) => `<li class="dayrec-caveat"><span class="dayrec-caveat-dot" aria-hidden="true"></span>${escHtml(c)}</li>`
      )
      .join("")}</ul>`;
  }

  function stepperHtml(date: string, today: string): string {
    const prev = shiftISO(date, -1);
    const next = shiftISO(date, 1);
    const label = (iso: string) => (iso === today ? "Today" : shortDate(iso));
    return `<nav class="dayrec-step" aria-label="Other days">
      <button type="button" class="dayrec-step-btn" data-open-day="${escAttr(prev)}" aria-label="${escAttr(`Previous day, ${label(prev)}`)}">‹</button>
      <button type="button" class="dayrec-step-btn" data-open-day="${escAttr(next)}" aria-label="${escAttr(`Next day, ${label(next)}`)}">›</button>
    </nav>`;
  }

  function topHtml(date: string, today: string, backLabel: string): string {
    return `<div class="dayrec-top">
        <button class="home-back linkbtn linkbtn-plain" type="button" data-day-back>‹ ${escHtml(backLabel)}</button>
        ${stepperHtml(date, today)}
      </div>`;
  }

  /** A past day's fuel, the read that stood, a weigh-in and the way to log there. */
  function pastExtrasHtml(record: DayRecord): string {
    const weight =
      record.weight_lb != null
        ? `<p class="dayrec-meta dayrec-weight">Weighed ${escHtml(fmtWeightLb(record.weight_lb))}</p>`
        : "";
    const log = `<div class="dayrec-foot"><button type="button" class="linkbtn dayrec-log" data-day-log="${escAttr(record.date)}">${record.session ? "Edit this day's session" : "Log a session to this day"}</button></div>`;
    return `${fuelHtml(record)}${readHtml(record)}${weight}${log}`;
  }

  /** The day from its record alone: a day the detail read does not reach (past next week's end). */
  function dayHtml(record: DayRecord, opts: { backLabel: string }): string {
    const past = record.relation === "past";
    const kicker = `${CairnFmt.relDay(record.date, record.today)} · ${past ? "the day's record" : "a preview"}`;
    return `<article class="dayrec dayrec-${escAttr(record.relation)}" aria-labelledby="dayrecTitle">
      ${topHtml(record.date, record.today, opts.backLabel)}
      <div class="dayrec-head">
        <span class="lbl dayrec-kicker">${escHtml(kicker)}</span>
        <h2 class="dayrec-title" id="dayrecTitle">${escHtml(record.line)}</h2>
        ${caveatsHtml(record)}
      </div>
      ${past ? `${trainingHtml(record)}${pastExtrasHtml(record)}` : planHtml(record)}
    </article>`;
  }

  /**
   * The day opened: the shared day detail (the hero, what was done, the lift, the run,
   * what to watch, why the day) — the same view Today's strip opens inline — and, on a
   * past day, its record's fuel, the read that stood and a weigh-in under it. Without a
   * detail read (a day past next week's end) the record stands alone.
   */
  function composedHtml(record: DayRecord | null, detail: DayRecordDetail | null, opts: { backLabel: string; date: string; today: string }): string {
    if (!detail) return record ? dayHtml(record, opts) : errorHtml(opts.backLabel);
    const past = detail.date < detail.today;
    return `<div class="dayrec dayrec-${past ? "past" : "future"} has-detail" aria-labelledby="dayrecTitle">
      ${topHtml(detail.date, detail.today, opts.backLabel)}
      ${CairnDayDetailView.dayDetailHtml(detail, { titleId: "dayrecTitle" })}
      ${past && record ? pastExtrasHtml(record) : ""}
    </div>`;
  }

  function fmtWeightLb(lb: number): string {
    const r = Math.round(lb * 10) / 10;
    return `${Number.isInteger(r) ? r : r.toFixed(1)} lb`;
  }

  function skeletonHtml(backLabel: string): string {
    return `<article class="dayrec is-pending" aria-busy="true">
      <div class="dayrec-top"><button class="home-back linkbtn linkbtn-plain" type="button" data-day-back>‹ ${escHtml(backLabel)}</button></div>
      <div class="dayrec-head"><div class="hshimmer dayrec-skel-k"></div><div class="hshimmer hshimmer-lg dayrec-skel-t"></div></div>
      <div class="hshimmer dayrec-skel-row"></div><div class="hshimmer dayrec-skel-row"></div><div class="hshimmer dayrec-skel-row is-short"></div>
    </article>`;
  }

  function errorHtml(backLabel: string): string {
    return `<article class="dayrec">
      <div class="dayrec-top"><button class="home-back linkbtn linkbtn-plain" type="button" data-day-back>‹ ${escHtml(backLabel)}</button></div>
      <p class="dayrec-empty" role="status">This day couldn't be read just now.</p>
    </article>`;
  }

  // ---- render ----

  function wire(root: HTMLElement): void {
    root.querySelector<HTMLElement>("[data-day-back]")?.addEventListener("click", () => {
      // Opened from inside the app: step back through history, so Back and this link
      // agree and no loop of entries builds up. A cold deep link has nowhere to go
      // back to: it lands on the opener tab's root (drill-controller.ts).
      CairnDrill.back();
    });
    const log = root.querySelector<HTMLElement>("[data-day-log]");
    log?.addEventListener("click", () => {
      const date = log.dataset.dayLog || "";
      if (!ISO.test(date) || typeof openSession !== "function") return;
      state.logDate = date;
      state.day = null;
      state.dayPicked = false;
      state.dayPickedOn = null;
      void openSession(date, { trigger: log, provenance: { entry: "day_record" } });
    });
  }

  async function renderDay(): Promise<void> {
    const date = String(state.dayDate || "");
    const backLabel = CairnDrill.fromLabel();
    if (!ISO.test(date) || date === localISO()) {
      activateTab("today", { replace: true });
      return;
    }
    const token = ++renderToken;
    CairnUiHeader.setEyebrowTitle(headerTitle, shortDate(date));
    const today = localISO();
    const opts = { backLabel, date, today };
    const key = `day-record:${date}`;
    const detailKey = CairnDayDetailController.keyOf(date);
    const cached = peekCached<DayRecord>(key, 5 * 60_000);
    const cachedDetail = peekCached<DayRecordDetail | null>(detailKey, 5 * 60_000);
    const warmDetail = cachedDetail && CairnDayDetailController.isDetail(cachedDetail.data) ? cachedDetail.data : null;
    let painted = "";
    const paint = (html: string): void => {
      if (html === painted) return;
      painted = html;
      view.innerHTML = html;
      wire(view);
      if (typeof wireGuides === "function") {
        try {
          wireGuides(view);
        } catch {}
      }
    };
    paint(cached?.data || warmDetail ? composedHtml(cached?.data ?? null, warmDetail, opts) : skeletonHtml(backLabel));
    const current = () => token === renderToken && state.tab === "day" && state.dayDate === date;
    // Both reads at once: the detail (the plan, what was done) and the record (fuel, the read).
    const [record, detail] = await Promise.all([
      api(`/day-record?date=${encodeURIComponent(date)}`)
        .then((value) => (value && typeof value === "object" && "relation" in value ? (value as DayRecord) : null))
        .catch(() => null),
      api(CairnDayDetailController.pathOf(date))
        .then((value) => (CairnDayDetailController.isDetail(value) ? value : null))
        .catch(() => null),
    ]);
    if (!current()) return;
    if (record) swrSet(key, record);
    if (detail) swrSet(detailKey, detail);
    if (!record && !detail) {
      // A failed read keeps a warm paint; a cold one says so in one line.
      if (!cached?.data && !warmDetail) paint(errorHtml(backLabel));
      return;
    }
    // A warm open whose reads did not change keeps its paint (no flash, no jump).
    paint(composedHtml(record ?? cached?.data ?? null, detail ?? warmDetail, opts));
  }

  const CAIRN_DAY_RECORD = { dayHtml, composedHtml, shortDate, renderDay };
  Object.assign(globalThis, { CairnDayRecord: CAIRN_DAY_RECORD, renderDay });
}
