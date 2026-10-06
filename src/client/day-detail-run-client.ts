// @ts-check
// The day detail's run section (day-detail-client.ts composes it): the run's label and
// distance under a mono mast, what it is for, its structure as ONE bar drawn to scale —
// warm-up, the work (one block per rep for intervals), cool-down, each in its zone's
// fill — the parts in rows with their distance and pace, and three facts: the zone,
// its heart-rate band and the pace band, in the athlete's run units. Pure strings;
// every caller string escaped; zones are classes, never colours.
//
// LAZY ("day" bundle), after the model and before the view.
{
  type DayDetailRun = import("../contracts/day-detail.js").DayDetailRun;

  const M = () => CairnDayDetailModel;

  /** The run's parts as one bar to scale, then a row per part when there is more than one. */
  function stripHtml(run: DayDetailRun): string {
    const segs = M().runSegments(run);
    if (!segs.length) return "";
    const pct = (f: number) => `${Math.round(f * 1000) / 10}%`;
    const bars = segs
      .map((s) => {
        const reps =
          s.part === "main" && s.reps > 1
            ? `<span class="ddv-reps">${Array.from({ length: s.reps }, () => `<i class="ddv-rep"></i>`).join("")}</span>`
            : "";
        const k = s.zoneKey ? `<span class="ddv-seg-k">${escHtml(s.zoneKey)}</span>` : "";
        return `<span class="ddv-seg is-${escAttr(s.part)}${s.zone ? ` is-${escAttr(s.zone)}` : ""}${reps ? " has-reps" : ""}" style="--w:${pct(s.frac)}">${reps || k}</span>`;
      })
      .join("");
    const aria = segs.map((s) => [s.label, s.dist, s.zoneKey].filter(Boolean).join(" ")).join(", then ");
    const rows =
      segs.length > 1
        ? `<ol class="ddv-segs">${segs
            .map(
              (s) => `<li class="ddv-segrow">
          <span class="ddv-segrow-k${s.zone ? ` is-${escAttr(s.zone)}` : ""}" aria-hidden="true"></span>
          <span class="ddv-segrow-main"><span class="ddv-segrow-t">${escHtml(s.label)}</span>${s.text ? `<span class="ddv-segrow-s">${escHtml(s.text)}</span>` : ""}</span>
          <span class="ddv-segrow-n">${escHtml([s.dist, s.pace].filter(Boolean).join(" · "))}</span>
        </li>`
            )
            .join("")}</ol>`
        : "";
    return `<div class="ddv-strip" role="img" aria-label="${escAttr(aria)}">${bars}</div>${rows}`;
  }

  function factsHtml(run: DayDetailRun): string {
    const facts: Array<[string, string]> = [];
    const zone = run.zone;
    if (zone && (zone.key || zone.label)) facts.push(["Zone", [zone.key, zone.label].filter(Boolean).join(" · ")]);
    const band = zone ? M().bandText(zone.low_bpm, zone.high_bpm) : "";
    if (band) facts.push(["Heart rate", band]);
    else if (run.hr_ceiling_bpm) facts.push(["Heart rate", `under ${Math.round(run.hr_ceiling_bpm)} bpm`]);
    const pace = M().paceText(run.pace, run.run_units);
    if (pace) facts.push(["Pace", pace]);
    if (!facts.length) return "";
    return `<dl class="ddv-facts">${facts
      .map(
        ([k, v]) => `<div class="ddv-fact"><dt class="lbl">${escHtml(k)}</dt><dd class="num">${escHtml(v)}</dd></div>`
      )
      .join("")}</dl>`;
  }

  /**
   * The run section. `hidePoint` when the hero already says the run's point (a run-only
   * day), so the day never says it twice. A completed run's numbers are in "What you
   * did"; here stays the plan it answered.
   */
  function runHtml(run: DayDetailRun | null, opts: { hidePoint?: boolean } = {}): string {
    if (!run) return "";
    const dist = M().distText(run.km, run.run_units);
    const notes = [
      run.adjusted ? `<p class="ddv-run-note is-adjusted">${escHtml(run.adjusted)}</p>` : "",
      run.short ? `<p class="ddv-run-note">A short set this week: that morning decides whether it runs.</p>` : "",
    ].join("");
    return `<section class="ddv-sec ddv-run" aria-label="The run">
      <div class="ddv-mast"><h3 class="lbl ddv-h">The run · ${escHtml(run.label)}</h3>${dist ? `<span class="ddv-mast-m">${escHtml(dist)}</span>` : ""}</div>
      ${run.point && !opts.hidePoint ? `<p class="ddv-intent">${escHtml(run.point)}</p>` : ""}
      ${stripHtml(run)}
      ${factsHtml(run)}
      ${notes}
    </section>`;
  }

  const CAIRN_DAY_DETAIL_RUN = { runHtml, stripHtml, factsHtml };

  Object.assign(globalThis, { CairnDayDetailRun: CAIRN_DAY_DETAIL_RUN });
}
