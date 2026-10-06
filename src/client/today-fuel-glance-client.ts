// @ts-check
// Fuel today, the glance on Today (Atelier v2, the reference phone's "Fuel today"):
// under the NOW card, one compact card — protein then energy as slim meters with the
// logged amount beside the day's number, and ONE idea for the rest of the day. The
// numbers are the day's own (GET /api/nutrition/day, the Fuel view's SWR key), the
// idea is the first of GET /api/fuel/ideas (the same deterministic read the Fuel
// view's idea cards paint), so opening Fuel after this never refetches.
//
// Laws: a day with nothing logged is ABSENT, never low — no meters are drawn at zero,
// only a quiet line and the way in. No score: a value beside its number, nothing
// graded. Every tap opens Fuel, where logging and the full ideas live.
{
  type Day = import("../contracts/client.js").ClientDayIntake;
  type Ideas = import("../contracts/fuel.js").ClientFuelIdeas;
  type Idea = import("../contracts/fuel.js").ClientFuelIdea;

  type GlanceModel = {
    count: number;
    protein: { value: number | null; of: number | null };
    energy: { value: number | null; of: number | null };
    idea: { title: string; nums: string } | null;
  };

  type GlanceDeps = {
    date: string;
    peek<T>(key: string): { data: T; fresh: boolean } | null;
    load<T>(path: string, options: { key: string }): Promise<T>;
    open(): void;
  };

  const dayKey = (date: string): string => `food:day:${date}`;
  const ideasKey = (date: string): string => `fuel:ideas:${date}`;
  const dayPath = (date: string): string => `/nutrition/day?date=${encodeURIComponent(date)}`;
  const ideasPath = (date: string): string =>
    `/fuel/ideas?date=${encodeURIComponent(date)}&hour=${new Date().getHours()}`;

  function num(value: unknown): number | null {
    if (value == null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : null;
  }

  function isDay(value: unknown): value is Day {
    return !!value && typeof value === "object" && Array.isArray((value as Day).entries);
  }

  function isIdeas(value: unknown): value is Ideas {
    return (
      !!value && typeof value === "object" && (value as Ideas).kind === "ideas" && Array.isArray((value as Ideas).ideas)
    );
  }

  function ideaNums(idea: Idea): string {
    const bits: string[] = [];
    if (idea.protein_g != null) bits.push(`${Math.round(idea.protein_g)} g protein`);
    if (idea.kcal != null) bits.push(`~${Math.round(idea.kcal)} kcal`);
    return bits.join(" · ");
  }

  /** The glance's view model, or null when there is no day read to speak from. */
  function glanceModel(dayIn: unknown, ideasIn: unknown): GlanceModel | null {
    if (!isDay(dayIn)) return null;
    const day = dayIn;
    const ideas = isIdeas(ideasIn) ? ideasIn : null;
    const count = Number(day.count) || day.entries.length;
    const known = (key: "protein_g" | "kcal"): number | null =>
      count > 0 && day.known?.[key] !== false ? num(day.totals?.[key]) : null;
    const proteinOf = num(ideas?.protein_anchor?.protein_g) ?? num(day.target?.protein_g);
    const energyOf = num(day.target?.kcal);
    const first = ideas?.ideas?.find((idea) => idea && typeof idea.title === "string" && idea.title.trim()) || null;
    return {
      count,
      protein: { value: known("protein_g"), of: proteinOf && proteinOf > 0 ? proteinOf : null },
      energy: { value: known("kcal"), of: energyOf && energyOf > 0 ? energyOf : null },
      idea: first ? { title: first.title.trim(), nums: ideaNums(first) } : null,
    };
  }

  function grouped(n: number): string {
    return n.toLocaleString("en-US");
  }

  function meterHtml(label: string, meter: { value: number | null; of: number | null }, unit: string): string {
    if (meter.value == null) return "";
    const share = meter.of ? Math.max(0, Math.min(1, meter.value / meter.of)) : 0;
    const text = meter.of ? `${grouped(meter.value)} / ${grouped(meter.of)}${unit}` : `${grouped(meter.value)}${unit}`;
    return `<div class="tfuel-m">
        <span class="tfuel-k">${escHtml(label)}</span>
        <span class="tfuel-bar" aria-hidden="true">${meter.of ? `<i style="--p:${share.toFixed(3)}"></i>` : ""}</span>
        <span class="tfuel-v">${escHtml(text)}</span>
      </div>`;
  }

  function glanceHtml(model: GlanceModel | null): string {
    if (!model) return "";
    const meters =
      model.count > 0 ? `${meterHtml("Protein", model.protein, " g")}${meterHtml("Energy", model.energy, "")}` : "";
    // Nothing logged yet is a quiet line, never a pair of empty bars.
    const body = meters
      ? `<div class="tfuel-meters">${meters}</div>`
      : `<p class="tfuel-empty">Nothing logged yet today.</p>`;
    const idea = model.idea
      ? `<button class="tfuel-idea" type="button" data-tfuel-open aria-label="${escAttr(`An idea for later: ${model.idea.title}. Open Fuel`)}">
          <span class="tfuel-idea-k lbl">An idea for later</span>
          <span class="tfuel-idea-t">${escHtml(model.idea.title)}</span>
          ${model.idea.nums ? `<span class="tfuel-idea-n">${escHtml(model.idea.nums)}</span>` : ""}
          <span class="tfuel-idea-go" aria-hidden="true">›</span>
        </button>`
      : "";
    return `<section class="tfuel" aria-label="Fuel today">
      <div class="tfuel-head"><span class="lbl">Fuel today</span><button class="tfuel-log" type="button" data-tfuel-open>Log a meal</button></div>
      ${body}${idea}
    </section>`;
  }

  /**
   * Cold start: the card's own shape, so nothing jumps when the numbers land — the
   * idea row included unless the last-known ideas carried none (most days carry one).
   */
  function skeletonHtml(opts: { idea?: boolean } = {}): string {
    const idea =
      opts.idea === false
        ? ""
        : `<div class="tfuel-idea tfuel-idea-skel" aria-hidden="true"><span class="hshimmer hshimmer-sm"></span><span class="hshimmer"></span></div>`;
    return `<section class="tfuel tfuel-skel" aria-busy="true" aria-label="Fuel today">
      <div class="tfuel-head"><span class="lbl">Fuel today</span><span class="tfuel-log tfuel-log-ghost" aria-hidden="true">Log a meal</span></div>
      <div class="tfuel-meters"><span class="hshimmer hshimmer-sm"></span><span class="hshimmer hshimmer-sm"></span></div>${idea}
    </section>`;
  }

  // Under the NOW card (after its steer line), inside the Brief; under the Brief when
  // it carries no NOW. Moves the node only when it is not already there.
  function placeGlance(brief: Element, slot: Element): void {
    // Last in the Brief's own run, just before its provenance line: the state line (NOW)
    // now leads under the why, so anchoring after it would put fuel above the week.
    const prov = brief.querySelector("#briefProvenance");
    if (prov && prov.parentNode === brief) {
      if (prov.previousElementSibling !== slot) prov.before(slot);
      return;
    }
    const anchor = brief.querySelector(".brief-steer") || brief.querySelector(".brief-now");
    if (anchor && anchor.parentNode) {
      if (anchor.nextElementSibling !== slot) anchor.after(slot);
      return;
    }
    if (brief.nextElementSibling !== slot) brief.after(slot);
  }

  function mountGlance(host: Element, deps: GlanceDeps): () => void {
    let live = true;
    let painted = "";
    let day: unknown = null;
    let ideas: unknown = null;

    function paint(): void {
      if (!live || !host.isConnected) return;
      const html = glanceHtml(glanceModel(day, ideas));
      if (html === painted) return;
      painted = html;
      host.innerHTML = html;
    }

    const warmDay = deps.peek<unknown>(dayKey(deps.date));
    const warmIdeas = deps.peek<unknown>(ideasKey(deps.date));
    if (warmIdeas && isIdeas(warmIdeas.data)) ideas = warmIdeas.data;
    // Cold: the card paints once BOTH reads have answered (the idea row lives under
    // the meters, and landing second it grew the card under the reader's eye).
    let ideasSettled = !!warmIdeas;
    if (warmDay && isDay(warmDay.data)) {
      day = warmDay.data;
      paint();
    } else {
      const lastHadIdea =
        !!warmIdeas && isIdeas(warmIdeas.data) && !!warmIdeas.data.ideas?.some((idea) => idea && typeof idea.title === "string" && idea.title.trim());
      host.innerHTML = skeletonHtml({ idea: warmIdeas ? lastHadIdea : true });
    }

    const onClick = (event: Event): void => {
      const target = event.target as Element | null;
      if (target && typeof target.closest === "function" && target.closest("[data-tfuel-open]")) deps.open();
    };
    host.addEventListener("click", onClick);

    deps
      .load<unknown>(ideasPath(deps.date), { key: ideasKey(deps.date) })
      .then((data) => {
        if (isIdeas(data)) ideas = data;
      })
      .catch(() => {})
      .then(() => {
        ideasSettled = true;
        if (isDay(day)) paint();
      });
    deps
      .load<unknown>(dayPath(deps.date), { key: dayKey(deps.date) })
      .then((data) => {
        if (!isDay(data)) return;
        day = data;
        if (ideasSettled || painted) paint();
      })
      .catch(() => {
        // No read to speak from: the slot leaves the page rather than shimmering on,
        // so a rail drawn after this keeps its own fuel card (today-screen strips that
        // card only while #todayFuelSlot stands).
        if (live && host.isConnected && !isDay(day)) host.remove();
      });

    return () => {
      live = false;
      host.removeEventListener("click", onClick);
    };
  }

  /**
   * Today's one mount: makes (or reuses) `#todayFuelSlot` inside the Brief, under the
   * NOW card, and paints the glance into it. Today only — a past date's fuel is read
   * on the Fuel view, where it can be corrected.
   */
  function mountToday(
    root: ParentNode,
    deps: { date: string; activateTab(tab: string): unknown; state: { planJump?: string | null } }
  ): () => void {
    const brief = root.querySelector(".brief");
    if (!brief || !deps.date) return () => {};
    let slot = root.querySelector("#todayFuelSlot");
    const fresh = !slot;
    if (!slot) {
      slot = brief.ownerDocument.createElement("div");
      slot.id = "todayFuelSlot";
      slot.className = "tfuel-slot";
      // Inside the Brief's polite live region: a skeleton filling in is not news.
      slot.setAttribute("aria-live", "off");
    }
    placeGlance(brief, slot);
    if (!fresh) return () => {};
    return mountGlance(slot, {
      date: deps.date,
      peek: <T>(key: string) => peekCached<T>(key),
      load: <T>(path: string, options: { key: string }) => cachedApi(path, options) as Promise<T>,
      open: () => {
        deps.state.planJump = "food";
        deps.activateTab("plan");
      },
    });
  }

  const CAIRN_TODAY_FUEL_GLANCE = {
    model: glanceModel,
    html: glanceHtml,
    skeletonHtml,
    place: placeGlance,
    mount: mountGlance,
    mountToday,
  };

  Object.assign(globalThis, { CairnTodayFuelGlance: CAIRN_TODAY_FUEL_GLANCE });
}
