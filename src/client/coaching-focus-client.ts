// @ts-check
// Whole-picture focus card renderer and routing bridge.

type ClientCoachingFocus = import("../contracts/client.js").ClientCoachingFocus;
type ClientCoachingFocusDomain = import("../contracts/client.js").ClientCoachingFocusDomain;
type ClientCoachingFocusItem = import("../contracts/client.js").ClientCoachingFocusItem;

const CFOCUS_DOMAIN_LABEL: Record<ClientCoachingFocusDomain, string> = {
  training: "Training",
  running: "Running",
  nutrition: "Nutrition",
  health: "Health",
  recovery: "Recovery",
  body: "Body",
};

function isCoachingFocusDomain(domain: unknown): domain is ClientCoachingFocusDomain {
  return typeof domain === "string" && domain in CFOCUS_DOMAIN_LABEL;
}

function cfocusDomainTag(domain: unknown): string {
  return isCoachingFocusDomain(domain)
    ? `<span class="cfocus-dom lbl">${escHtml(CFOCUS_DOMAIN_LABEL[domain])}</span>`
    : "";
}

function focusItems(items: unknown): ClientCoachingFocusItem[] {
  return Array.isArray(items) ? items.filter((item): item is ClientCoachingFocusItem => !!item) : [];
}

// The block calendar belongs to the training program — it reads right under a
// training/running/recovery lever, and wrong under a health/nutrition one (it
// would imply the lab work is block-scoped volume work).
function cfocusBlockDomains(domain: unknown): boolean {
  return domain === "training" || domain === "running" || domain === "recovery";
}

// ---------------------------------------------------------------------------
// ONE "Where to focus" renderer, four display variants.
//
// Four hand-rolled copies of /api/coaching-focus once drifted apart; everything now
// flows through `coachingFocusHtml(focus, {variant})`, and a variant SPEC below says
// which parts each surface shows and in whose class family.
//
//   full     — Progress → Program: the plan under Train's headline (headline:false)
//              — lead + actions, Alongside, Next, connections, the retest card.
//   compact  — the Stand overview slot. One voice (masthead, headline, calendar
//              line, THE lead) with the full plan one tap away, so the conductor and
//              the health synthesis never make rival whole-picture claims.
//   overview — Progress → Overview. A `.well-accent` lever: title, why, move,
//              a one-line retest, and the read-through link.
//   hero     — Stand's DEGRADED read: renders even when the focus is not available
//              (masthead + headline + one line), so a thin payload says something calm.
// ---------------------------------------------------------------------------

const CFOCUS_VARIANTS: Record<ClientCoachingFocusVariant, CfocusVariantSpec> = {
  full: {
    wrap: "cfocus settle-in",
    mastClass: "cfocus-mast lbl",
    mastTag: "span",
    headlineClass: "cfocus-headline",
    headlineTag: "p",
    blockLine: "option",
    lead: "route",
    leadWrap: "cfocus-lead",
    leadTitleClass: "cfocus-lead-title",
    leadWhyClass: "cfocus-lead-why",
    moveClass: "cfocus-lead-move",
    requireTitle: false,
    allowUnavailable: false,
    parallel: true,
    later: true,
    connections: true,
    retest: "card",
    footer: "",
  },
  compact: {
    wrap: "cfocus cfocus-compact settle-in",
    mastClass: "cfocus-mast lbl",
    mastTag: "span",
    headlineClass: "cfocus-headline",
    headlineTag: "p",
    blockLine: "domain",
    lead: "route",
    leadWrap: "cfocus-lead",
    leadTitleClass: "cfocus-lead-title",
    leadWhyClass: "cfocus-lead-why",
    moveClass: "",
    requireTitle: false,
    allowUnavailable: false,
    parallel: false,
    later: false,
    connections: false,
    retest: "never",
    footer: `<button class="cfocus-full-link" type="button" data-cfocus-go="program">The full focus plan →</button>`,
  },
  overview: {
    wrap: "well-accent tov-focus reveal",
    mastClass: "lbl",
    mastTag: "div",
    headlineClass: "",
    headlineTag: "p",
    blockLine: "never",
    lead: "flat",
    leadWrap: "",
    leadTitleClass: "tov-focus-title",
    leadWhyClass: "tov-focus-why",
    moveClass: "tov-focus-move",
    requireTitle: true,
    fold: true,
    allowUnavailable: false,
    parallel: false,
    later: false,
    connections: false,
    retest: "line",
    // The Train overview wires [data-tovgo] itself, so this link stays in that family.
    footer: `<button class="linkbtn linkbtn-sm" type="button" data-tovgo="program">Full program read ›</button>`,
  },
  hero: {
    wrap: "stand-focus reveal",
    mastClass: "stand-focus-k",
    mastTag: "span",
    headlineClass: "stand-focus-h",
    headlineTag: "h2",
    blockLine: "never",
    lead: "line",
    leadWrap: "",
    leadTitleClass: "",
    leadWhyClass: "stand-focus-p",
    moveClass: "",
    requireTitle: false,
    allowUnavailable: true,
    parallel: false,
    later: false,
    connections: false,
    retest: "never",
    footer: "",
  },
};

function coachingFocusHtml(
  focus: ClientCoachingFocus | null | undefined,
  options: CoachingFocusRenderOptions = {}
): string {
  const spec = CFOCUS_VARIANTS[options.variant || "full"] || CFOCUS_VARIANTS.full;
  if (!focus) return "";
  const lead = focus.lead || null;
  if (!spec.allowUnavailable && (!focus.available || !lead)) return "";
  if (spec.requireTitle && !cfocusText(lead?.title)) return "";

  const rawHeadline = cfocusText(focus.headline);
  const headline =
    lead && (spec.lead === "route" || spec.lead === "flat")
      ? cfocusHeadlineWithoutLead(rawHeadline, cfocusText(lead.title))
      : rawHeadline;
  // The degraded hero speaks the lead's own line (or its why) as the one
  // sentence; it renders only when it actually has something to say.
  // `line` is not in the typed contract — it is a tolerated older payload shape the
  // Stand fallback has always preferred over `why`; read it defensively, not as a field.
  const heroLine =
    spec.lead === "line"
      ? cfocusText((lead as unknown as { line?: unknown } | null)?.line) || cfocusText(lead?.why)
      : "";
  if (spec.lead === "line" && !headline && !heroLine) return "";

  // Lead mode owns the actions server-side (focus.acts === false): the coach applies
  // bounded changes itself, so the card offers no one-tap swap/draft ask, only state
  // and a review LINK. Absent → true (the legacy navigate-and-act surfaces).
  const acts = focus.acts !== false;
  const style = options.style ? ` style="${escAttr(options.style)}"` : "";
  if (spec.fold && lead && spec.lead === "flat" && typeof cfocusTrainCardHtml === "function") return cfocusTrainCardHtml(focus, lead, spec, headline, style);

  let html = `<div class="${spec.wrap}"${style}>`;
  const saidElsewhere = spec === CFOCUS_VARIANTS.full && options.headline === false; // said once, on Train; linked back
  html += saidElsewhere ? `<div class="cfocus-plan-head"><${spec.mastTag} class="${spec.mastClass}">The focus plan</${spec.mastTag}><button class="cfocus-full-link" type="button" data-cfocus-go="train">Where to focus ›</button></div>` : `<${spec.mastTag} class="${spec.mastClass}">Where to focus</${spec.mastTag}>`;
  if (headline && !saidElsewhere)
    html +=
      spec.headlineTag === "h2"
        ? `<h2 class="${spec.headlineClass}">${escHtml(headline)}</h2>`
        : `<p class="${spec.headlineClass}">${escHtml(headline)}</p>`;

  const showBlockLine =
    spec.blockLine === "option"
      ? options.blockLine !== false
      : spec.blockLine === "domain"
        ? cfocusBlockDomains(lead?.domain)
        : false;
  if (focus.block_line && showBlockLine) html += `<p class="cfocus-blockline">${escHtml(focus.block_line)}</p>`;

  if (lead) {
    if (spec.lead === "route") html += cfocusRouteLeadHtml(lead, spec, options, acts);
    else if (spec.lead === "flat") html += cfocusFlatLeadHtml(lead, spec, spec.fold ? cfocusRetestHtml(focus, spec) : "");
  }
  if (spec.lead === "line" && heroLine) html += `<p class="${spec.leadWhyClass}">${escHtml(heroLine)}</p>`;

  if (spec.parallel) {
    const parallel = focusItems(focus.parallel);
    if (parallel.length) {
      html += `<div class="cfocus-along"><span class="cfocus-sec-lbl lbl">Alongside</span>`;
      for (const item of parallel) {
        html += `<div class="cfocus-along-row cfocus-go" data-cfocus-go="${escAttr(item.domain || "")}" role="link" tabindex="0">${cfocusDomainTag(item.domain)}`;
        html += `<span class="cfocus-along-title">${escHtml(item.title || "")}</span>`;
        html += `<span class="cfocus-go-arrow" aria-hidden="true">→</span>`;
        if (item.why) html += `<span class="cfocus-along-why">${escHtml(item.why)}</span>`;
        if (item.move) html += `<span class="cfocus-along-move">${escHtml(item.move)}</span>`;
        if (options.actions && acts) html += cfocusSwapButtonsHtml(item);
        html += `</div>`;
      }
      html += `</div>`;
    }
  }

  if (spec.later) {
    const later = Array.isArray(focus.later) ? focus.later.filter((item) => item && item.title) : [];
    if (later.length)
      html += `<p class="cfocus-later"><span class="cfocus-later-lbl">Next:</span> ${later.map((item) => escHtml(item.title)).join(" · ")}</p>`;
  }

  if (spec.connections) {
    const connections = Array.isArray(focus.connections) ? focus.connections.filter(Boolean) : [];
    for (const connection of connections) html += `<p class="cfocus-conn">${escHtml(connection)}</p>`;
  }

  if (!(spec.fold && lead && spec.lead === "flat")) html += cfocusRetestHtml(focus, spec);
  return `${html}${spec.footer}</div>`;
}

// The named variants stay as thin aliases: every existing call site keeps its
// shape, and there is still exactly one place the read is built.
function coachingFocusCardHtml(
  focus: ClientCoachingFocus | null | undefined,
  options: { blockLine?: boolean; actions?: boolean; headline?: boolean } = {}
): string {
  return coachingFocusHtml(focus, { ...options, variant: "full" });
}

function coachingFocusCompactHtml(focus: ClientCoachingFocus | null | undefined): string {
  return coachingFocusHtml(focus, { variant: "compact" });
}

async function loadCoachingFocus(slotSelector: string, root?: ParentNode | null): Promise<void> {
  const fallbackScope = typeof view !== "undefined" && view ? view : document;
  const scope = root || fallbackScope;
  const slot = scope.querySelector(slotSelector);
  if (!slot) return;
  let focus: ClientCoachingFocus | null = null;
  try {
    focus = await api("/coaching-focus");
  } catch {
    focus = null;
  }
  if (!slot.isConnected) return;
  const html = coachingFocusCardHtml(focus);
  slot.innerHTML = html;
  if (html && slot.id === "cfocusStandingSlot") scope.querySelector(".hstand-lever")?.remove();
}

function coachingFocusThreadHtml(focus: ClientCoachingFocus | null | undefined): string {
  if (!focus || !focus.available || !focus.lead) return "";
  // The Brief already owns Today's daily rest/easy/done judgment. Repeating the
  // same posture as a compact conductor thread is duplicate narration; genuine
  // block, health, nutrition, and other distinct conductor threads still render.
  if (focus.lead.day_posture) return "";
  // The day's own state (day_state) is the Brief's to say, never a thread of its own: a
  // lead that merely restates it (an older server mixing both) stays quiet on Today.
  const dayTitle = cfocusText(focus.day_state?.title);
  if (dayTitle && cfocusText(focus.lead.title) === dayTitle) return "";
  const title = focus.lead.title || "";
  if (!title) return "";
  const domain = isCoachingFocusDomain(focus.lead.domain) ? focus.lead.domain : "stand";
  const why = focus.lead.why ? String(focus.lead.why) : "";
  // The block's calendar placement leads the context line — but only under a
  // training-family lever ("Week 3 of 5 — building volume. <why>"). Under a
  // health/nutrition lead the lifting calendar would imply the lab work is
  // block-scoped volume work; the lead's own why stands alone there.
  const blockLine = cfocusBlockDomains(focus.lead.domain) && focus.block_line ? String(focus.block_line) : "";
  const context = [blockLine, why].filter(Boolean).join(" ");
  return `<button class="cfocus-thread" type="button" data-cfocus-go="${escAttr(domain)}">
    <span class="cfocus-thread-arrow" aria-hidden="true">↳</span>
    <span class="cfocus-thread-copy">
      <span class="cfocus-thread-top"><span class="cfocus-thread-lbl lbl">This block</span><span class="cfocus-thread-txt">${escHtml(title)}</span></span>
      ${context ? `<span class="cfocus-thread-why">${escHtml(context)}</span>` : ""}
    </span>
    <span class="cfocus-thread-go" aria-hidden="true">→</span>
  </button>`;
}

// Already standing on the destination? Re-activating would tear down and
// repaint the very screen the user is reading (a pointless "flash"). Settle
// the eye on the conductor card instead — no re-render, no scroll jump race.
function cfocusSettleIfThere(tab: string, seg?: string | null): boolean {
  const here =
    state.tab === tab &&
    (seg === undefined ||
      (tab === "progress"
        ? (state.progressSeg ?? null) === seg
        : tab === "stand"
          ? (state.standSeg ?? null) === seg
          : true));
  if (!here) return false;
  const card = document.querySelector(".cfocus, .cfocus-compact");
  const reduced = reducedMotion();
  card?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  return true;
}

function cfocusDomainRoute(domain: ClientCoachingFocusDomain): void {
  switch (domain) {
    case "running":
      state.progressSeg = "endurance";
      activateTab("progress");
      return;
    case "nutrition":
    case "body":
      state.planJump = "meals";
      activateTab("plan");
      return;
    case "health":
      if (cfocusSettleIfThere("stand", null)) return;
      state.standSeg = null;
      activateTab("stand");
      return;
    case "training":
    case "recovery":
      if (cfocusSettleIfThere("progress", "program")) return;
      state.progressSeg = "program";
      activateTab("progress");
      return;
  }
  const _exhaustive: never = domain;
  void _exhaustive;
}

function cfocusRoute(go: unknown): void {
  switch (String(go || "")) {
    case "stand":
    case "me-standing":
      state.standSeg = null;
      activateTab("stand");
      break;
    case "endurance":
      state.progressSeg = "endurance";
      activateTab("progress");
      break;
    case "meals":
      state.planJump = "meals";
      activateTab("plan");
      break;
    case "markers":
      state.standSeg = "markers";
      activateTab("stand");
      break;
    case "train": // Train's overview carries the "Where to focus" read; Program links back to it
      if (!cfocusSettleIfThere("progress", "overview")) { state.progressSeg = "overview"; activateTab("progress"); }
      break;
    case "plan-coach":
      // The waiting recovery-week draft (and any future "review it in Coach" link).
      state.planJump = "coach";
      activateTab("plan");
      break;
    default:
      if (isCoachingFocusDomain(go)) {
        cfocusDomainRoute(go);
      } else {
        // The literal "program" targets (retest chip, full-plan link) get the
        // same already-there guard as the training/recovery domain leads — the
        // retest chip RENDERS on Program, so without this it re-flashes it.
        if (cfocusSettleIfThere("progress", "program")) break;
        state.progressSeg = "program";
        activateTab("progress");
      }
      break;
  }
}

function focusRouteTarget(event: Event): string | null {
  const target = event.target instanceof Element ? event.target : null;
  // An action button inside a navigable block acts — it never also navigates.
  if (target?.closest("[data-cfocus-act]")) return null;
  const element = target?.closest("[data-cfocus-go]");
  if (!element) return null;
  return element instanceof HTMLElement ? element.dataset.cfocusGo || "" : element.getAttribute("data-cfocus-go") || "";
}

// The Train card's one expander: aria-expanded on the button, `hidden` on its panel.
function cfocusToggle(button: Element): void {
  const open = button.getAttribute("aria-expanded") !== "true";
  button.setAttribute("aria-expanded", open ? "true" : "false");
  const panel = document.getElementById(button.getAttribute("aria-controls") || "");
  if (panel) panel.hidden = !open;
}

document.addEventListener("click", (event) => {
  const toggle = event.target instanceof Element ? event.target.closest("[data-cfocus-toggle]") : null;
  if (toggle) {
    cfocusToggle(toggle);
    return;
  }
  const go = focusRouteTarget(event);
  if (go != null) cfocusRoute(go);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const target = event.target instanceof Element ? event.target : null;
  // A focused action button acts on Enter/Space — it never also navigates.
  if (target?.closest("[data-cfocus-act]")) return;
  const element = target?.closest('[data-cfocus-go][role="link"]');
  if (!element) return;
  event.preventDefault();
  cfocusRoute(element instanceof HTMLElement ? element.dataset.cfocusGo : element.getAttribute("data-cfocus-go"));
});

const CAIRN_COACHING_FOCUS = {
  CFOCUS_DOMAIN_LABEL,
  cfocusDomainTag,
  coachingFocusHtml,
  coachingFocusCardHtml,
  coachingFocusCompactHtml,
  loadCoachingFocus,
  coachingFocusThreadHtml,
  cfocusRoute,
};

Object.assign(globalThis, {
  CairnCoachingFocus: CAIRN_COACHING_FOCUS,
  CFOCUS_DOMAIN_LABEL,
  cfocusDomainTag,
  coachingFocusHtml,
  coachingFocusCardHtml,
  coachingFocusCompactHtml,
  loadCoachingFocus,
  coachingFocusThreadHtml,
  cfocusRoute,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnCoachingFocus: CAIRN_COACHING_FOCUS,
    CFOCUS_DOMAIN_LABEL,
    cfocusDomainTag,
    coachingFocusCardHtml,
    coachingFocusCompactHtml,
    loadCoachingFocus,
    coachingFocusThreadHtml,
    cfocusRoute,
  });
}
