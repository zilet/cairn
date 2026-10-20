// @ts-check
// ---------- Train: This week (the training home's landing) ----------
// What Train opens to: the week as a dated agenda the athlete can act on. The next
// session leads, opened up (its movements with their sets × reps and load, its run in
// the athlete's units with the zone or pace band), with Start session when it is
// today's; then the week Mon–Sun, a row a day (done ✓ with what was logged, today
// washed, a day ahead with its lift and run); then next week behind one fold. Every row
// opens its day page through the app's one `data-open-day` opener. Where the training
// stands (focus, the muscle map, what moved) is the Progress leaf, one row deeper.
//
// Three reads already owned elsewhere, no new endpoint: GET /api/plan/week (the week
// Today's strip reads, so a warm Today means a warm Train), GET /api/plan/look-ahead
// (Program's week ahead: each day's key lifts and next week), and GET
// /api/plan/day-detail for the next session's day. Each paints from the SWR cache first
// and repaints a slot only when its markup changed. Nothing here decides a lift, a run
// or a rest: the reads own them, and every row is the day view's ROW variant
// (CairnDayGlanceView.rowHtml), the same component Program's week ahead draws.
//
// LAZY ("train" bundle; depends on day-view → glance). Every caller string goes
// through escHtml/escAttr.

type TwkWeek = import("../contracts/client-api.js").ClientPlanWeek;
type TwkWeekDay = import("../contracts/client-api.js").ClientPlanWeekDay;
type TwkAhead = import("../contracts/client-api.js").ClientPlanLookAhead;
type TwkAheadDay = import("../contracts/client-api.js").ClientPlanLookAheadDay;
type TwkDetail = import("../contracts/day-detail.js").DayDetail;
type TwkLine = import("../contracts/client-api.js").ClientTodayStrengthLine;
type TwkNext = {
  date: string;
  glance: ClientDayGlance;
  /** The day's key lifts from the look-ahead ("Squat · Bench +2"), for the card before its detail lands. */
  lifts: string;
};

let twkToken = 0;

const TWK_WEEK: readonly [string, string] = ["/plan/week", "plan:week"];
const TWK_AHEAD: readonly [string, string] = ["/plan/look-ahead", "plan:look-ahead"];
const TWK_ISO = /^\d{4}-\d{2}-\d{2}$/;

function twkRecord<T>(value: unknown): T | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : null;
}
function twkText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}
function twkUnits(week: TwkWeek | null, ahead: TwkAhead | null): "km" | "mi" {
  return (week?.run_units || ahead?.run_units) === "mi" ? "mi" : "km";
}
/** The device's today: a cached week from yesterday never names a day "today". */
function twkToday(_week: TwkWeek | null, _ahead: TwkAhead | null): string {
  return localISO();
}
/** A held read is painted only when it was read for today; yesterday's week waits for the fresh one. */
function twkFresh<T extends { as_of?: unknown }>(value: T | null): T | null {
  return value && twkText(value.as_of) === localISO() ? value : null;
}
/** The server's one line on why a day differs from its usual slot, when the cell carries one. */
function twkNote(day: TwkWeekDay | undefined): string {
  const cell = day as { note?: { text?: unknown } | null; plan_day?: { note?: { text?: unknown } | null } | null } | undefined;
  return twkText(cell?.note?.text ?? cell?.plan_day?.note?.text);
}
function twkAheadDays(ahead: TwkAhead | null): TwkAheadDay[] {
  if (!ahead || ahead.mode !== "calendar" || !Array.isArray(ahead.weeks)) return [];
  return ahead.weeks.flatMap((week) => (Array.isArray(week?.days) ? week.days : []));
}
function twkDated(week: TwkWeek | null): TwkWeekDay[] {
  return Array.isArray(week?.days) ? week!.days.filter((day) => TWK_ISO.test(String(day?.date || ""))) : [];
}
/** Today's lift in the server's one line, when it speaks for this date ("none" is its silence). */
function twkTodayLine(line: TwkLine | null | undefined, date: string): TwkLine | null {
  return line && twkText(line.text) && line.state !== "none" && (!line.date || line.date === date) ? line : null;
}
/** The look-ahead's key lifts for a day, only when it names the same lift the week does. */
function twkLiftsFor(glance: ClientDayGlance, aheadDay: TwkAheadDay | undefined): string {
  if (!glance.lift || glance.lift.state === "done" || !aheadDay?.lift) return "";
  if (twkText(aheadDay.lift.title) !== glance.lift.name) return "";
  return CairnProgramWeekModel.liftsText(aheadDay.lift);
}

/**
 * The next session: the first day from today on that holds work still to do — today
 * while its lift or run is open (or under way), else the next lifting or running day,
 * reading into next week when this one is finished.
 */
function twkNextOf(week: TwkWeek | null, ahead: TwkAhead | null): TwkNext | null {
  const today = twkToday(week, ahead);
  const units = twkUnits(week, ahead);
  const aheadDays = twkAheadDays(ahead);
  const byDate = new Map(aheadDays.map((day) => [String(day.date), day]));
  const seen = new Set<string>();
  const candidates: TwkNext[] = [];
  for (const day of twkDated(week)) {
    const date = String(day.date);
    if (date < today) continue;
    seen.add(date);
    const glance = CairnDayDetailModel.glanceOfWeekDay(day, today, units);
    if (glance) candidates.push({ date, glance, lifts: twkLiftsFor(glance, byDate.get(date)) });
  }
  for (const day of aheadDays) {
    const date = String(day.date);
    if (date < today || seen.has(date)) continue;
    const glance = CairnDayDetailModel.glanceOfLookAheadDay(day, units);
    if (glance) candidates.push({ date, glance, lifts: day.lift ? CairnProgramWeekModel.liftsText(day.lift) : "" });
  }
  candidates.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return candidates.find((c) => !c.glance.rest && !c.glance.done) || null;
}

/** "Today", "Tomorrow", else "Thu 23". */
function twkWhen(date: string, today: string, glance: ClientDayGlance): string {
  if (date === today) return "Today";
  const next = new Date(`${today}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  if (date === next.toISOString().slice(0, 10)) return "Tomorrow";
  return `${glance.weekday} ${glance.num}`;
}

/** One movement: "name · 3 × 5–8 · 185 lb", the day's anchor marked. */
function twkExerciseHtml(ex: import("../contracts/day-detail.js").DayDetailExercise): string {
  const rx = [twkText(ex.prescription), twkText(ex.load?.text)].filter(Boolean).join(" · ");
  const anchor = ex.anchor ? `<span class="twk-anchor lbl">Anchor</span>` : "";
  return `<li class="twk-ex${ex.anchor ? " is-anchor" : ""}"><span class="twk-ex-n">${escHtml(twkText(ex.name))}${anchor}</span>${
    rx ? `<span class="twk-ex-rx num">${escHtml(rx)}</span>` : ""
  }</li>`;
}

/** The run in a line or two: distance · zone · pace band, then its structure when it has parts. */
function twkRunHtml(run: NonNullable<TwkDetail["run"]> | null, fallback: string, titled = true): string {
  if (!run) return fallback ? `<div class="twk-run"><span class="twk-run-t">${escHtml(fallback)}</span></div>` : "";
  const M = CairnDayDetailModel;
  const zone = run.zone ? [run.zone.key, run.zone.label].filter(Boolean).join(" · ") : "";
  const meta = [M.distText(run.km, run.run_units), zone, M.paceText(run.pace, run.run_units)].filter(Boolean).join(" · ");
  const segs = M.runSegments(run);
  const structure =
    segs.length > 1
      ? segs.map((s) => (s.part === "main" && s.text ? s.text : [s.label, s.dist].filter(Boolean).join(" "))).join(" → ")
      : "";
  return `<div class="twk-run">
    ${titled ? `<span class="twk-run-t">${escHtml(twkText(run.label) || "Run")}</span>` : ""}
    ${meta ? `<span class="twk-run-m num">${escHtml(meta)}</span>` : ""}
    ${structure ? `<span class="twk-run-s">${escHtml(structure)}</span>` : ""}
    ${run.adjusted ? `<span class="twk-run-s">${escHtml(run.adjusted)}</span>` : ""}
  </div>`;
}

/**
 * The next session, opened up. Before its day detail lands it says what the week knows
 * (the lift's name and key lifts, the run's words); the detail adds the movements.
 */
function twkNextHtml(next: TwkNext | null, detail: TwkDetail | null, today: string, line: TwkLine | null): string {
  if (!next) {
    return `<p class="twk-none">Nothing else is planned this week. <button class="linkbtn" type="button" data-pahead-edit>Look at the plan</button></p>`;
  }
  const g = next.glance;
  const isToday = next.date === today;
  const d = detail && detail.date === next.date ? detail : null;
  const liftOpen = !!g.lift && g.lift.state !== "done";
  const runOpen = !!g.run && g.run.state !== "done";
  // Half of the day already in (the lift logged, the run still to go): that half is one done line.
  const doneHalf = [g.lift && !liftOpen ? g.lift.words : "", g.run && !runOpen ? g.run.words : ""].filter(Boolean);
  let lift = "";
  if (liftOpen) {
    const title = twkText(d?.lift?.title) || g.lift!.name;
    const caveat = isToday ? twkText(twkTodayLine(line, next.date)?.caveat) : "";
    const exercises = d?.lift?.exercises?.length
      ? `<ol class="twk-exs">${d.lift.exercises.map(twkExerciseHtml).join("")}</ol>`
      : next.lifts
        ? `<p class="twk-lifts">${escHtml(next.lifts)}</p>`
        : "";
    lift = `<div class="twk-lift"><h3 class="twk-next-t" id="twkNextTitle">${escHtml(title)}</h3>${
      caveat ? `<p class="twk-caveat">${escHtml(caveat)}</p>` : ""
    }${exercises}</div>`;
  }
  const runWords = g.run?.words || "";
  const run = runOpen ? twkRunHtml(d?.run || null, runWords, !!lift) : "";
  const head = lift ? "" : `<h3 class="twk-next-t" id="twkNextTitle">${escHtml(g.run?.label || "Run")}</h3>`;
  const done = doneHalf.length ? `<p class="twk-done">${escHtml(doneHalf.join(" · "))} <span aria-hidden="true">✓</span><span class="sr-only"> done</span></p>` : "";
  // ONE primary action, off the states as served: today's open lift starts (or resumes) its
  // session, today's open run is logged from its day, a later day only opens. A rest day says
  // so in the server's own line above the next session.
  const startName = twkText(d?.lift?.title) || g.lift?.name || "session";
  const start =
    isToday && liftOpen
      ? `<button class="btn btn-solid twk-start" type="button" data-twk-start>${g.lift!.state === "live" ? "Resume session" : `Start ${escHtml(startName)}`}</button>`
      : isToday && runOpen
        ? `<button class="btn btn-solid twk-start" type="button" data-open-day="${escAttr(next.date)}">Log this run</button>`
        : "";
  const rest = twkTodayLine(line, today);
  const restLine =
    !isToday && rest && (rest.state === "rest_day" || rest.state === "no_lift") ? `<p class="twk-done">${escHtml(twkText(rest.text))}</p>` : "";
  return `<article class="card twk-next" aria-labelledby="twkNextTitle">
    ${restLine}<div class="twk-next-k lbl">Next · ${escHtml(twkWhen(next.date, today, g))}</div>
    ${head}${lift}${run}${done}
    <div class="twk-acts">${start}${start.includes("data-open-day") ? "" : `<button class="linkbtn twk-open" type="button" data-open-day="${escAttr(next.date)}">Open day ›</button>`}</div>
  </article>`;
}

/** This week, Mon–Sun, a row a day; the week's one progress line under its label. */
function twkDaysHtml(week: TwkWeek | null, ahead: TwkAhead | null): string {
  const today = twkToday(week, ahead);
  const units = twkUnits(week, ahead);
  const byDate = new Map(twkAheadDays(ahead).map((day) => [String(day.date), day]));
  const line = twkText(week?.progress?.line);
  let rows = "";
  const dated = twkDated(week);
  if (dated.length) {
    rows = dated
      .map((day) => {
        const glance = CairnDayDetailModel.glanceOfWeekDay(day, today, units);
        if (!glance) return "";
        const line = glance.today ? twkTodayLine(week?.strength_line, glance.date) : null;
        // A reshaped today names its own movements on the line; the plan's list would contradict it.
        return CairnDayGlanceView.rowHtml(glance, {
          line,
          lifts: line?.reshaped ? "" : twkLiftsFor(glance, byDate.get(glance.date)),
          hard: day.hard === true,
          note: twkNote(day),
        });
      })
      .join("");
  } else {
    // No calendar on the week read: the look-ahead's own this-week rows, else its order or empty state.
    const view = CairnProgramWeekModel.programWeekModel(ahead);
    const group = view?.mode === "calendar" ? view.groups.find((g) => g.label === "This week") : null;
    if (!group) return `<div class="twk-week">${CairnProgramWeek.bodyHtml(view)}</div>`;
    rows = group.rows
      .map((row) => CairnDayGlanceView.rowHtml(row.glance, { line: row.line, lifts: row.lift?.lifts || "", hard: row.hard }))
      .join("");
  }
  // A displaced day no weekday could take is said under the strip, never silently dropped.
  const unplaced = (week?.unplaced ?? [])
    .map((u) => twkText(u?.text))
    .filter(Boolean)
    .map((text) => `<p class="twk-line" data-twk-unplaced>${escHtml(text)}</p>`)
    .join("");
  return `<div class="twk-week pahead-group">
    <div class="pahead-group-head"><span class="pahead-group-k lbl">This week</span></div>
    ${line ? `<p class="twk-line">${escHtml(line)}</p>` : ""}
    <ol class="pahead-days" aria-label="This week, day by day">${rows}</ol>${unplaced}
  </div>`;
}

/** Next week behind one quiet fold; "" when the look-ahead has no next week. */
function twkNextWeekHtml(ahead: TwkAhead | null): string {
  const view = CairnProgramWeekModel.programWeekModel(ahead);
  const group = view?.mode === "calendar" ? view.groups.find((g) => g.label === "Next week") : null;
  if (!group?.rows.length) return "";
  const marks = group.markers.map((m) => `<span class="pahead-mark is-${escAttr(m.kind.replace(/[^a-z_]/g, ""))}">${escHtml(m.word)}</span>`).join("");
  const rows = group.rows
    .map((row) => CairnDayGlanceView.rowHtml(row.glance, { line: null, lifts: row.lift?.lifts || "", hard: row.hard }))
    .join("");
  return `<summary class="twk-fold-sum"><span class="lbl">Next week</span>${marks}<span class="twk-fold-go" aria-hidden="true">›</span></summary>
    <ol class="pahead-days" aria-label="Next week, day by day">${rows}</ol>`;
}

function twkSkeletonHtml(): string {
  const rows = Array.from({ length: 7 }, () => `<div class="hshimmer pahead-skel-row"></div>`).join("");
  return `<div class="pahead-skel" aria-busy="true" aria-label="This week"><div class="hshimmer pahead-skel-k"></div>${rows}</div>`;
}

/** The frame: the group bar, the three slots and the landing's deeper rows (Progress first). */
function twkFrameHtml(): string {
  return `${segBar("week", PROGRESS_SEG)}<section class="twk" aria-label="This week" data-twk>
    <div class="twk-next-slot" data-twk-next></div>
    <div data-twk-days>${twkSkeletonHtml()}</div>
    <details class="twk-fold" data-twk-ahead hidden></details>
  </section><div data-train-deeper-slot></div>`;
}

/** The view's paint over whatever has landed: each slot rewritten only on a change. */
function twkPaint(reads: { week: TwkWeek | null; ahead: TwkAhead | null; detail: TwkDetail | null }, loaded: boolean): void {
  const root = view.querySelector<HTMLElement>("[data-twk]");
  if (!root) return;
  const { week, ahead } = reads;
  const set = (sel: string, html: string): void => {
    const el = root.querySelector<HTMLElement>(sel);
    if (el && el.innerHTML !== html) el.innerHTML = html;
  };
  if (!week && !ahead) {
    if (loaded) set("[data-twk-days]", `<p class="pahead-empty" role="status">This week couldn't be read just now.</p>`);
    return;
  }
  const today = twkToday(week, ahead);
  const next = twkNextOf(week, ahead);
  set("[data-twk-next]", twkNextHtml(next, reads.detail, today, week?.strength_line || ahead?.strength_line || null));
  set("[data-twk-days]", twkDaysHtml(week, ahead));
  const fold = root.querySelector<HTMLElement>("[data-twk-ahead]");
  if (fold) {
    const html = twkNextWeekHtml(ahead);
    if (fold.innerHTML !== html) fold.innerHTML = html;
    if (html) fold.removeAttribute("hidden");
    else fold.setAttribute("hidden", "");
  }
}

function twkWire(root: HTMLElement): void {
  root.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const start = target?.closest<HTMLElement>("[data-twk-start]");
    if (start) {
      state.dayPicked = false;
      state.dayPickedOn = null;
      if (typeof openSession === "function") {
        void openSession(localISO(), { source: "adaptive_plan", trigger: start, provenance: { entry: "train_week" } });
      }
      return;
    }
    // The order / empty states' doors (Program's week-ahead body, reused here).
    const ask = target?.closest<HTMLElement>("[data-pahead-ask]");
    if (ask) {
      const text = ask.dataset.paheadAsk;
      if (text && typeof gotoChatWith === "function") gotoChatWith(text);
      else activateTab("chat");
      return;
    }
    if (target?.closest("[data-pahead-edit]")) void PROGRESS_HANDLERS.plan?.();
  });
}

/**
 * The landing. Paints the frame at once (rows from the cache when Today or Program read
 * the week moments ago), then revalidates both week reads and the next day's detail;
 * guarded against painting over a view the athlete has left.
 */
async function renderTrainWeek(): Promise<void> {
  headerTitle.textContent = "Train";
  state.progressSeg = "week";
  const token = ++twkToken;
  const current = (): boolean => token === twkToken && state.tab === "progress" && state.progressSeg === "week";
  view.innerHTML = twkFrameHtml();
  wireSeg(PROGRESS_HANDLERS);
  const root = view.querySelector<HTMLElement>("[data-twk]");
  if (root) twkWire(root);
  const reads = {
    week: twkFresh(twkRecord<TwkWeek>(peekCached(TWK_WEEK[1])?.data)),
    ahead: twkFresh(twkRecord<TwkAhead>(peekCached(TWK_AHEAD[1])?.data)),
    detail: null as TwkDetail | null,
  };
  let detailFor = "";
  const loadDetail = (): void => {
    const next = twkNextOf(reads.week, reads.ahead);
    if (!next || next.date === detailFor) return;
    detailFor = next.date;
    const key = `plan:day-detail:${next.date}`;
    const held = twkRecord<TwkDetail>(peekCached(key)?.data);
    if (held) reads.detail = held;
    cachedApi<string>(`/plan/day-detail?date=${encodeURIComponent(next.date)}`, { key })
      .then((value) => {
        const detail = twkRecord<TwkDetail>(value);
        if (!current() || !detail || detail.date !== detailFor) return;
        reads.detail = detail;
        twkPaint(reads, true);
      })
      .catch(() => {});
  };
  if (reads.week || reads.ahead) {
    loadDetail();
    twkPaint(reads, false);
  }
  const land = (which: "week" | "ahead", value: unknown): void => {
    if (!current()) return;
    if (which === "week") reads.week = twkRecord<TwkWeek>(value) || reads.week;
    else reads.ahead = twkRecord<TwkAhead>(value) || reads.ahead;
    loadDetail();
    twkPaint(reads, true);
  };
  const ask = (entry: readonly [string, string], which: "week" | "ahead") =>
    cachedApi<string>(entry[0], { key: entry[1] }).then(
      (value) => land(which, value),
      () => land(which, null)
    );
  await Promise.all([ask(TWK_WEEK, "week"), ask(TWK_AHEAD, "ahead")]);
}

const CAIRN_TRAIN_WEEK = {
  nextOf: twkNextOf,
  nextHtml: twkNextHtml,
  daysHtml: twkDaysHtml,
  nextWeekHtml: twkNextWeekHtml,
};

Object.assign(globalThis, { renderTrainWeek, CairnTrainWeek: CAIRN_TRAIN_WEEK });
if (typeof window !== "undefined") Object.assign(window, { renderTrainWeek, CairnTrainWeek: CAIRN_TRAIN_WEEK });
