// @ts-check
// The day detail, the view: ONE view family for a day, in four variants over one model
// (day-detail-model.ts) — the chip (a day in Today's week strip) and the row (a day in
// a week list: Program's week ahead), both in day-glance-view.ts (CairnDayGlanceView),
// the compact form (`dayDetailHtml(d, {inline})`, a peek under Today's strip) and the
// full page (the day page, day-record-client.ts).
// The chip and the row read the same glance, so a lift or a run is said in the same
// words wherever a week shows it. The full and compact forms, top to
// bottom: the hero (where the day sits, the read's line naming it, the one point of
// it, the week's place), today's strength line, a heavy-legs-beside-a-key-run note,
// what was done, the lift (its figure, the anchor first, every movement with its sets
// × reps and load), the run (its structure drawn to scale in zone colour, the zone's
// heart-rate and pace bands), what to watch, and why the day sits where it does.
//
// The movement row is SHARED: `exerciseRowHtml` draws the Program gallery's rows
// (plan-editor-client.ts's progDayHtml) as well as this view's, so a lift reads the
// same in the plan and on its day. Pure string builders; every caller string goes
// through escHtml/escAttr, no colour is written here (zone and stone hues are classes).
//
// LAZY ("calendar" bundle). Train and Today's lower half depend on it (LAZY_BUNDLE_DEPS)
// for the shared movement row and the chip/row variants.
{
  type DayDetail = import("../contracts/day-detail.js").DayDetail;
  type DayDetailLift = import("../contracts/day-detail.js").DayDetailLift;
  type DayDetailExercise = import("../contracts/day-detail.js").DayDetailExercise;
  type DayDetailWatch = import("../contracts/day-detail.js").DayDetailWatch;
  type DayDetailDone = import("../contracts/day-detail.js").DayDetailDone;

  type ExerciseRow = {
    name: string;
    muscleGroup?: string | null;
    /** "3 × 8–10", "3 × 0:45". */
    prescription: string;
    /** "185 lb", "30 lb assist"; "" for none. */
    load?: string | null;
    /** The progression's step when it moves ("+5 lb", "+1 rep"); "" when it holds. */
    change?: string | null;
    /** Muted second lines ("2 warmup", the item's note). */
    hints?: Array<string | null | undefined>;
    anchor?: boolean;
  };

  type ViewOpts = {
    /** Inline under Today's strip: a smaller hero, no separate "why" foot. */
    inline?: boolean;
    /** Heading level for the day's title (the day view's page heading is h2). */
    titleId?: string;
  };

  const M = () => CairnDayDetailModel;

  function tileHtml(name: string, muscleGroup: string | null | undefined): string {
    if (typeof artImg !== "function") return "";
    const svg =
      typeof (globalThis as { art?: unknown }).art === "function"
        ? (globalThis as unknown as { art(kind: string, q: string, group?: unknown): string }).art(
            "exercise",
            name,
            muscleGroup
          )
        : null;
    return artImg("exercise", name, "artile-sm", svg);
  }

  /**
   * One movement as the Program gallery draws it: its art, the name (a button that opens
   * the exercise detail through `data-guide`), muted hints, and the dose right-aligned —
   * sets × reps over the load, the progression's step beside it.
   */
  function exerciseRowHtml(row: ExerciseRow): string {
    const name = String(row.name || "");
    const hints = (row.hints || []).map((h) => String(h ?? "").trim()).filter(Boolean);
    const anchor = row.anchor ? `<span class="prog-row-anchor">Anchor</span>` : "";
    const load = String(row.load ?? "").trim();
    const change = String(row.change ?? "").trim();
    return `<div class="prog-row${row.anchor ? " is-anchor" : ""}">
          ${tileHtml(name, row.muscleGroup)}
          <div class="prog-row-main">
            <button class="prog-row-name" type="button" data-guide="${escAttr(encodeURIComponent(name))}">${escHtml(name)}</button>
            ${anchor || hints.length ? `<div class="prog-row-hint">${anchor}${escHtml(hints.join(" · "))}</div>` : ""}
          </div>
          <div class="prog-row-nums">
            <span class="numeral">${escHtml(row.prescription)}</span>
            ${load ? `<span class="numeral prog-row-wt">${escHtml(load)}</span>` : ""}
            ${change ? `<span class="prog-row-step">${escHtml(change)}</span>` : ""}
          </div>
        </div>`;
  }

  /** The progression's step, only when it moves the slot (a hold already reads as the load). */
  function stepOf(ex: DayDetailExercise): string {
    const load = ex.load;
    if (!load || !load.change) return "";
    // A step the athlete takes ("+5 lb", "+1 rep", "−10 lb"); a hold already reads as the load.
    return /^[+−-]/.test(String(load.change).trim()) ? String(load.change).trim() : "";
  }

  /** A day's movements as the gallery draws them (the day page, and Program's undated rows opened in place). */
  function exerciseListHtml(exercises: readonly DayDetailExercise[]): string {
    return exercises
      .map((ex) =>
        exerciseRowHtml({
          name: ex.name,
          muscleGroup: ex.muscle_group,
          prescription: ex.prescription,
          load: ex.load?.text ?? "",
          change: stepOf(ex),
          hints: [ex.note],
          anchor: ex.anchor,
        })
      )
      .join("");
  }

  function exerciseRowsHtml(lift: DayDetailLift): string {
    return exerciseListHtml(lift.exercises);
  }

  // ---- hero ----

  function chipsHtml(detail: DayDetail): string {
    const chips: string[] = [];
    if (detail.lift) {
      chips.push(
        `<span class="ddv-chip is-strength"><span class="ddv-chip-k" aria-hidden="true"></span>${escHtml(detail.lift.title)}</span>`
      );
    }
    if (detail.run) {
      const dist = M().distText(detail.run.completed?.km ?? detail.run.km, detail.run_units);
      chips.push(
        `<span class="ddv-chip is-endurance"><span class="ddv-chip-k" aria-hidden="true"></span>${escHtml(detail.run.label)}${dist ? `<span class="ddv-chip-n">${escHtml(dist)}</span>` : ""}</span>`
      );
    }
    return chips.length ? `<div class="ddv-chips">${chips.join("")}</div>` : "";
  }

  /** The one point of the day: the lift's when there is one, else the run's. */
  function pointOf(detail: DayDetail): string {
    if (detail.status === "rest") return "";
    return String(detail.lift?.point || detail.run?.point || "").trim();
  }

  function heroHtml(detail: DayDetail, opts: ViewOpts): string {
    const context = M().contextLine(detail);
    const point = pointOf(detail);
    const caveats = detail.caveats.length
      ? `<ul class="ddv-caveats">${detail.caveats
          .map(
            (c) => `<li class="ddv-caveat"><span class="ddv-caveat-dot" aria-hidden="true"></span>${escHtml(c)}</li>`
          )
          .join("")}</ul>`
      : "";
    const id = opts.titleId ? ` id="${escAttr(opts.titleId)}"` : "";
    return `<div class="ddv-hero">
      <span class="lbl ddv-kicker">${escHtml(M().kicker(detail))}</span>
      <h2 class="ddv-title"${id}>${escHtml(detail.headline)}</h2>
      ${point ? `<p class="ddv-point">${escHtml(point)}</p>` : ""}
      ${chipsHtml(detail)}
      ${context ? `<p class="ddv-context lbl">${escHtml(context)}</p>` : ""}
      ${caveats}
    </div>`;
  }

  function todayHtml(detail: DayDetail): string {
    const lift = detail.lift;
    if (!lift?.today_line && !lift?.suggestion) return "";
    const line = lift.today_line
      ? `<p class="ddv-today-line"><span class="ddv-today-dot" aria-hidden="true"></span>${escHtml(lift.today_line)}</p>`
      : "";
    const s = lift.suggestion;
    const caveat = s
      ? `<p class="ddv-today-caveat">${escHtml([s.label, s.caveat].filter(Boolean).join(" — "))}</p>`
      : "";
    return `<div class="ddv-today">${line}${caveat}</div>`;
  }

  function stackHtml(detail: DayDetail): string {
    const stack = detail.stack;
    if (!stack) return "";
    const near = stack.neighbours
      .map(
        (n) =>
          `<span class="ddv-stack-n is-${escAttr(n.kind.replace(/[^a-z_]/g, ""))}">${escHtml(`${n.weekday} · ${n.what}`)}</span>`
      )
      .join("");
    return `<aside class="ddv-stack well-accent-sm" aria-label="Beside a key run">
      <p class="ddv-stack-t">${escHtml(stack.text)}</p>
      ${near ? `<div class="ddv-stack-ns">${near}</div>` : ""}
    </aside>`;
  }

  // ---- what was done ----

  function doneHtml(detail: DayDetail): string {
    const done: DayDetailDone | null = detail.done;
    if (!done) return "";
    const rows: string[] = [];
    const s = done.session;
    if (s) {
      const moves = s.movements
        .map(
          (m) =>
            `<li class="dayrec-mv"><span class="dayrec-mv-name">${escHtml(m.name)}</span><span class="dayrec-mv-best">${escHtml(m.best)}<span class="dayrec-mv-sets"> · ${escHtml(`${m.sets} set${m.sets === 1 ? "" : "s"}`)}</span></span></li>`
        )
        .join("");
      rows.push(`<li class="ddv-done-row">
        <span class="ddv-done-k is-strength" aria-hidden="true">✓</span>
        <span class="ddv-done-main"><span class="ddv-done-t">${escHtml(s.title)}</span><span class="ddv-done-s">${escHtml(`${s.sets} set${s.sets === 1 ? "" : "s"}${s.finished ? "" : " · left open"}`)}</span>${moves ? `<ul class="dayrec-mvs">${moves}</ul>` : ""}${s.notes ? `<span class="ddv-done-note">${escHtml(s.notes)}</span>` : ""}</span>
      </li>`);
    }
    const completed = detail.run?.completed;
    done.runs.forEach((r, i) => {
      // The agenda's own completion evidence carries the effort and pace of the planned run.
      const line =
        i === 0 && completed ? M().doneRunText(completed, detail.run_units) : M().doneRunText(r, detail.run_units);
      const title = i === 0 && completed?.title ? completed.title : r.note || r.title;
      rows.push(`<li class="ddv-done-row">
        <span class="ddv-done-k is-endurance" aria-hidden="true">✓</span>
        <span class="ddv-done-main"><span class="ddv-done-t">${escHtml(i === 0 && detail.run ? detail.run.label : "Run")}</span>${line ? `<span class="ddv-done-s">${escHtml(line)}</span>` : ""}${title && title !== "run" ? `<span class="ddv-done-note">${escHtml(title)}</span>` : ""}</span>
      </li>`);
    });
    for (const o of done.other) {
      const line = M().doneRunText(o, detail.run_units);
      rows.push(`<li class="ddv-done-row">
        <span class="ddv-done-k" aria-hidden="true">✓</span>
        <span class="ddv-done-main"><span class="ddv-done-t">${escHtml(String(o.title || "").replace(/^./, (c) => c.toUpperCase()))}</span>${line ? `<span class="ddv-done-s">${escHtml(line)}</span>` : ""}</span>
      </li>`);
    }
    if (!rows.length) return "";
    return `<section class="ddv-sec ddv-done" aria-label="What you did">
      <h3 class="lbl ddv-h">What you did</h3>
      <ul class="ddv-done-rows">${rows.join("")}</ul>
    </section>`;
  }

  // ---- the lift ----

  function figureHtml(lift: DayDetailLift): string {
    const lib = (
      globalThis as {
        CairnBodyFigure?: {
          figureSvg(side: string, tones: Record<string, string>, opts?: Record<string, unknown>): string;
        };
      }
    ).CairnBodyFigure;
    if (!lib || typeof lib.figureSvg !== "function") return "";
    const { tones, front, back } = M().muscleTones(lift.exercises);
    if (!front && !back) return "";
    const sides = [front ? "front" : "", back ? "back" : ""].filter(Boolean);
    const regions = Object.keys(tones);
    return `<div class="ddv-fig" role="img" aria-label="${escAttr(`Works the ${regions.join(", ")}`)}">${sides
      .map((side) => lib.figureSvg(side, tones, { className: "ddv-fig-svg", anatomyInk: 0.1 }))
      .join("")}</div>`;
  }

  function anchorHtml(lift: DayDetailLift): string {
    const anchor = lift.exercises.find((e) => e.anchor);
    if (!anchor) return "";
    const step = stepOf(anchor);
    return `<div class="ddv-anchor">
      <span class="lbl ddv-anchor-k">Leads the day</span>
      <span class="ddv-anchor-name">${escHtml(anchor.name)}</span>
      <span class="ddv-anchor-dose num">${escHtml([anchor.prescription, anchor.load?.text].filter(Boolean).join(" · "))}</span>
      ${step ? `<span class="ddv-anchor-step">${escHtml(step)}</span>` : ""}
    </div>`;
  }

  function liftHtml(detail: DayDetail): string {
    const lift = detail.lift;
    if (!lift) return "";
    const n = lift.exercises.length;
    const meta = [n ? `${n} movement${n === 1 ? "" : "s"}` : "", lift.total_sets ? `${lift.total_sets} sets` : ""]
      .filter(Boolean)
      .join(" · ");
    const figure = figureHtml(lift);
    const anchor = anchorHtml(lift);
    const lead = figure || anchor ? `<div class="ddv-lift-lead">${figure}${anchor}</div>` : "";
    const rows = n ? `<div class="prog-list ddv-moves">${exerciseRowsHtml(lift)}</div>` : "";
    return `<section class="ddv-sec ddv-lift" aria-label="The lift">
      <div class="ddv-mast"><h3 class="lbl ddv-h">The lift · ${escHtml(lift.title)}</h3>${meta ? `<span class="ddv-mast-m">${escHtml(meta)}</span>` : ""}</div>
      ${lift.intent ? `<p class="ddv-intent">${escHtml(lift.intent)}</p>` : ""}
      ${lead}
      ${rows}
    </section>`;
  }

  // ---- where to look, and why the day ----

  const WATCH_WORD: Readonly<Record<string, string>> = {
    symptom: "On watch",
    constraint: "Form",
    recent_best: "Recent best",
    progression: "Next step",
    untested: "New",
  };

  function watchHtml(watch: readonly DayDetailWatch[]): string {
    if (!watch.length) return "";
    return `<section class="ddv-sec ddv-watch" aria-label="Worth watching">
      <h3 class="lbl ddv-h">Worth watching</h3>
      <ul class="ddv-watch-rows">${watch
        .map(
          (w) => `<li class="ddv-watch-row is-${escAttr(w.kind.replace(/[^a-z_]/g, ""))}">
          <span class="ddv-watch-k lbl">${escHtml(WATCH_WORD[w.kind] || "Note")}</span>
          <span class="ddv-watch-t">${escHtml(w.text)}</span>
        </li>`
        )
        .join("")}</ul>
    </section>`;
  }

  function whyHtml(detail: DayDetail): string {
    const why = M().whyRest(detail);
    if (!why) return "";
    return `<section class="ddv-sec ddv-why" aria-label="Why this day">
      <h3 class="lbl ddv-h">Why this day</h3>
      <p class="ddv-why-t">${escHtml(why)}</p>
    </section>`;
  }

  /**
   * The whole day. A lived day leads with what was done and keeps its plan below; a day
   * ahead leads with the plan. `opts.inline` is the compact form under Today's strip.
   */
  function dayDetailHtml(detail: DayDetail, opts: ViewOpts = {}): string {
    const lived = detail.status === "done" || detail.status === "open";
    const plan = `${liftHtml(detail)}${CairnDayDetailRun.runHtml(detail.run, { hidePoint: !!detail.run && detail.run.point === pointOf(detail) })}`;
    const body = lived
      ? `${doneHtml(detail)}${plan ? `<details class="ddv-planned"><summary class="ddv-planned-sum"><span class="lbl">What was planned</span><span class="ddv-planned-chev" aria-hidden="true">▾</span></summary>${plan}</details>` : ""}`
      : `${doneHtml(detail)}${plan}`;
    return `<article class="ddv ddv-${escAttr(detail.status)}${opts.inline ? " ddv-inline" : ""}">
      ${heroHtml(detail, opts)}
      ${todayHtml(detail)}
      ${stackHtml(detail)}
      ${body}
      ${watchHtml(detail.watch)}
      ${opts.inline ? "" : whyHtml(detail)}
    </article>`;
  }

  /** The shape of a day before its read lands: nothing said, the space held. */
  function skeletonHtml(): string {
    return `<div class="ddv ddv-pending" aria-busy="true" aria-label="Opening the day">
      <div class="hshimmer ddv-skel-k"></div>
      <div class="hshimmer hshimmer-lg ddv-skel-t"></div>
      <div class="hshimmer ddv-skel-row"></div><div class="hshimmer ddv-skel-row"></div><div class="hshimmer ddv-skel-row is-short"></div>
    </div>`;
  }

  function errorHtml(): string {
    return `<p class="ddv-empty" role="status">This day couldn't be opened just now.</p>`;
  }

  const CAIRN_DAY_DETAIL_VIEW = { dayDetailHtml, exerciseRowHtml, exerciseListHtml, skeletonHtml, errorHtml };

  Object.assign(globalThis, { CairnDayDetailView: CAIRN_DAY_DETAIL_VIEW });
}
