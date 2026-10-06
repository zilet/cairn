// @ts-check
// The race page (/app/horizon/race), the view: the depth behind Horizon's race glance.
// Top to bottom: the race with its estimate line, THIS WEEK (the one focal card), next
// week, the build week by week, how the lifting fits, and the estimate's basis with the
// paces. Pure strings: the model carries every word, and each state (loading, empty,
// error) has its own renderer here.
{
  /** The week's layout in the server's words (the strength layout, the ride), one tap deeper. */
  function moreHtml(model: ClientRaceViewModel): string {
    if (!model.notes.length) return "";
    const notes = model.notes.map((note) => `<p class="race-view-note">${escHtml(note)}</p>`).join("");
    return `<details class="race-view-more">
      <summary class="race-view-more-sum">The week's layout</summary>
      <div class="race-view-more-body">${notes}</div>
    </details>`;
  }

  /**
   * The week's volume as one figure: "9.7 of 19.5 km" once something is run, else the
   * week's volume named as the PLAN ("19.5 km planned") — a bare "19.5 km this week"
   * over an empty bar read as done — and never a zero. `cls` is the surface's prefix.
   */
  function volumeFigureHtml(week: ClientRaceThisWeek | null | undefined, cls: string): string {
    if (!week) return "";
    if (week.done_text && week.target_text) {
      return `<span class="${cls}-num numeral">${escHtml(week.done_text)}<span class="${cls}-of"> of ${escHtml(week.target_text)}</span></span>`;
    }
    const alone = week.done_text || week.target_text;
    if (!alone) return "";
    return `<span class="${cls}-num numeral">${escHtml(alone)}<span class="${cls}-of"> ${week.done_text ? "run" : "planned"}</span></span>`;
  }

  /**
   * The week's volume as a segmented bar: one segment per logged run in its tone (easy,
   * quality, long — a quality run also hatched, an extra dashed, so colour is never the
   * only cue), a tick where the plan sits, the bar scaled to whichever is bigger so a
   * week run past its plan shows the overflow. A key names the tones drawn.
   */
  function segmentBarHtml(week: ClientRaceThisWeek): string {
    const segments = Array.isArray(week.segments) ? week.segments : [];
    if (!segments.length && week.plan_frac == null) return "";
    const segs = segments
      .map(
        (seg) =>
          `<span class="race-week-seg is-${escAttr(seg.tone)}${seg.extra ? " is-extra" : ""}" style="--frac:${seg.frac}"></span>`
      )
      .join("");
    const tick =
      week.plan_frac != null
        ? `<span class="race-week-tick" style="--frac:${week.plan_frac}"><span class="race-week-tick-word">plan</span></span>`
        : "";
    const said = segments.map((seg) => seg.label).filter(Boolean);
    const label = [[week.logged_text, week.plan_text].filter(Boolean).join(", "), said.length ? said.join("; ") : ""]
      .filter(Boolean)
      .join(": ");
    const tones = (["easy", "quality", "long"] as const).filter((tone) =>
      segments.some((seg) => seg.tone === tone && seg.label)
    );
    const extra = segments.some((seg) => seg.extra);
    const key = tones.length
      ? `<span class="race-week-key" aria-hidden="true">${tones
          .map((tone) => `<span class="race-week-key-item is-${tone}">${tone}</span>`)
          .join("")}${extra ? `<span class="race-week-key-item is-extra">extra</span>` : ""}</span>`
      : "";
    return `<span class="race-week-bar${week.over ? " is-over" : ""}" role="img" aria-label="${escAttr(label)}">${segs}${tick}</span>${key}`;
  }

  /** "35.8 km · plan 19.5", or "19.5 km planned" before anything is run. */
  function cardFigureHtml(week: ClientRaceThisWeek): string {
    if (!week.logged_text && !week.plan_text) return "";
    const plan = week.plan_text
      ? `<span class="race-week-of">${week.logged_text ? " · " : ""}${escHtml(week.plan_text)}</span>`
      : "";
    return `<span class="race-week-num numeral">${escHtml(week.logged_text || "")}${plan}</span>`;
  }

  /**
   * THIS WEEK, the page's one focal card: the kicker (stage, weeks out), the server's
   * sentence for the week and one detail line, the volume as a segmented bar, then the
   * week's runs — what was run first, what was planned second (`sessionsHtml`, handed in
   * by the page). Works without a race: a runner's week has no stage and says so plainly.
   */
  function thisWeekHtml(
    week: ClientRaceThisWeek | null,
    opts: { sessionsHtml?: string; focus?: string; units?: "km" | "mi" } = {}
  ): string {
    const sessions = opts.sessionsHtml || "";
    const detail = week?.detail ?? week?.focus ?? "";
    const focus = detail || opts.focus || "";
    if (!week && !sessions && !focus) return "";
    const figure = week ? cardFigureHtml(week) : "";
    const ran = !!week?.runs?.length;
    // The planned long run, until a run is in: then the rows say what the long run was.
    const long = week?.long_text && !ran ? `<span class="race-week-long">${escHtml(week.long_text)}</span>` : "";
    const bar = week ? segmentBarHtml(week) : "";
    const volume =
      figure || long || bar
        ? `<div class="race-week-volume"><div class="race-week-row">${figure}${long}</div>${bar}</div>`
        : "";
    const kicker = week?.kicker || "This week";
    return `<section class="race-week${week?.closed ? " is-closed" : ""}" aria-labelledby="raceWeekTitle">
      <div class="race-week-head">
        <div class="race-view-kickrow"><span class="lbl">${escHtml(kicker)}</span></div>
        <h3 class="race-week-stage" id="raceWeekTitle">${escHtml(week?.headline || week?.stage_word || "Your running week")}</h3>
        ${focus ? `<p class="race-week-focus">${escHtml(focus)}</p>` : ""}
      </div>
      ${volume}
      ${sessions}
    </section>`;
  }

  /**
   * "With your lifting": how the lifts and the runs fit, one row a week (a run of weeks
   * saying the same thing is one row), in the server's words. "" for a running-only athlete.
   */
  function liftingHtml(lines: ClientRaceLiftingLine[]): string {
    if (!lines.length) return "";
    const rows = lines
      .map(
        (line) => `<li class="race-lifting-row${line.current ? " is-current" : ""}">
          <span class="race-lifting-when">${escHtml(line.when)}${line.stage ? ` · ${escHtml(line.stage)}` : ""}</span>
          <p class="race-lifting-text">${escHtml(line.text)}</p>
        </li>`
      )
      .join("");
    return `<section class="race-section race-lifting" aria-label="With your lifting">
      <span class="lbl">With your lifting</span>
      <ol class="race-lifting-list">${rows}</ol>
    </section>`;
  }

  /**
   * The whole race page, top to bottom: the race (name, countdown, race day, the units,
   * the estimate's one line), THIS WEEK, next week (its own section, `nextWeekHtml`), the
   * build week by week, how the lifting fits, then the estimate's basis and the paces.
   * No chart here: the terrain is Horizon's glance, and the ladder below is the same
   * build as a table. `enter` settles it in once.
   */
  function viewHtml(
    model: ClientRaceViewModel,
    opts: { enter?: boolean; sessionsHtml?: string; nextWeekHtml?: string; units?: "km" | "mi" } = {}
  ): string {
    const when = [model.countdown, model.race_day].filter(Boolean).join(" · ");
    const ladder = CairnRaceLadder.ladderHtml(model.ladder, { reveal: false });
    const estimate = CairnRaceEstimate.estimateHtml(model.estimate, { paces: model.paces, finishes: model.finishes });
    return `<section class="race-view${opts.enter ? " settle-in is-entering" : ""}" aria-label="Race" data-race-view>
      <header class="race-view-head">
        <div class="race-view-kickrow">
          <span class="lbl">Race</span>
        </div>
        <h2 class="race-view-event">${escHtml(model.event)}</h2>
        ${when ? `<p class="race-view-when">${escHtml(when)}</p>` : ""}
        ${model.fit_text ? `<p class="race-view-fit${model.estimate.fit ? ` is-${escAttr(model.estimate.fit)}` : ""}">${escHtml(model.fit_text)}</p>` : ""}
      </header>
      ${thisWeekHtml(model.this_week, { sessionsHtml: opts.sessionsHtml })}
      ${opts.nextWeekHtml || ""}
      ${ladder ? `<section class="race-section" aria-label="The build, week by week">${ladder}</section>` : ""}
      ${liftingHtml(model.lifting)}
      ${estimate ? `<section class="race-section">${estimate}</section>` : ""}
      ${moreHtml(model)}
    </section>`;
  }

  /** Cold load: the shape of the view, nothing said. */
  function skeletonHtml(): string {
    const bars = Array.from({ length: 5 }, () => `<div class="hshimmer race-view-skel-bar"></div>`).join("");
    return `<section class="race-view race-view-skel" aria-busy="true" aria-label="Race">
      <div class="hshimmer hshimmer-sm race-view-skel-kicker"></div>
      <div class="hshimmer hshimmer-lg race-view-skel-title"></div>
      ${bars}
    </section>`;
  }

  /** No build to show: what fills it and where that comes from, never blame. */
  function emptyHtml(reason?: unknown): string {
    const body =
      String(reason || "").trim() || "Set a dated half marathon in You → Profile and the build reads from it.";
    return `<section class="race-view race-view-empty" aria-label="Race">
      ${CairnUi.emptyStateHtml({ title: "No race build yet", body, className: "empty-state race-view-empty-state" })}
    </section>`;
  }

  function errorHtml(): string {
    return `<section class="race-view race-view-error" aria-label="Race">
      <p class="race-view-error-line" role="status" aria-live="polite">The race build couldn't be read just now.</p>
      <button class="linkbtn race-view-retry" type="button" data-race-view-retry>Try again</button>
    </section>`;
  }

  const CAIRN_RACE_VIEW = {
    viewHtml,
    thisWeekHtml,
    volumeFigureHtml,
    liftingHtml,
    skeletonHtml,
    emptyHtml,
    errorHtml,
  };

  Object.assign(globalThis, { CairnRaceView: CAIRN_RACE_VIEW });
}
