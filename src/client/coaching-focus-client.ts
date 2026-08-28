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

// One-tap variation swaps for a stalled lift (same movement pattern): rotate the
// stalled lift out for a fresh stimulus. Up to two. Shared by the LEAD block and
// the parallel Alongside rows — on real data the plateau often rides alongside a
// recovery lead, and the tap must work wherever the lever renders. Callers gate
// on options.actions (only the Program view wires [data-cfocus-act]).
function cfocusSwapButtonsHtml(item: ClientCoachingFocusItem): string {
  if (item.domain !== "training" || !item.swap || !Array.isArray(item.swap.to)) return "";
  const from = item.swap.from || "";
  let html = "";
  for (const to of item.swap.to.slice(0, 2)) {
    if (!to) continue;
    html += `<button class="draftbtn cfocus-act" type="button" data-cfocus-act="swap" data-swap-from="${escAttr(from)}" data-swap-to="${escAttr(to)}">Rotate in ${escHtml(to)}</button>`;
  }
  return html;
}

// ---------------------------------------------------------------------------
// ONE "Where to focus" renderer, four display variants.
//
// The same /api/coaching-focus payload used to be rendered by four hand-rolled
// copies (the Program card, the Stand compact conductor, the Stand degraded
// hero, and the Progress-overview well). They drifted: a payload field added for
// one surface silently missed the other three. Everything now flows through
// `coachingFocusHtml(focus, {variant})`; a variant SPEC below says which parts
// that surface shows and in whose class family, so each surface keeps its own
// density and Atelier chrome without owning its own copy of the read.
//
//   full     — Progress → Program. The whole conductor: lead + actions,
//              Alongside, Next, connections, the retest card.
//   compact  — the Stand overview slot. One voice (masthead, headline, calendar
//              line, THE lead) with the full plan one tap away, so the conductor
//              and the health synthesis below it never make rival whole-picture
//              claims on one screen.
//   overview — Progress → Overview. A `.well-accent` lever: title, why, move,
//              a one-line retest, and the read-through link.
//   hero     — Stand's DEGRADED read. The one variant that renders when the
//              server says the focus is not available: masthead + headline +
//              one line, so a thin payload still says something calm.
// ---------------------------------------------------------------------------

type ClientCoachingFocusVariant = "full" | "compact" | "hero" | "overview";

type CoachingFocusRenderOptions = {
  variant?: ClientCoachingFocusVariant;
  // `full` only: false omits the block calendar line — the Program view already
  // owns block truth via its own "Current block · week N of M" card.
  blockLine?: boolean;
  // `full` only: render the [data-cfocus-act] buttons. Only Program wires them;
  // every navigate-only surface keeps the default so a button never renders dead.
  actions?: boolean;
  // Inline style for the wrapper (the Progress overview's reveal stagger).
  style?: string;
};

type CfocusVariantSpec = {
  wrap: string;
  mastClass: string;
  // The masthead's own element. Block-level where the surface's label is a row
  // of its own (the Progress-overview well), inline where the class supplies it.
  mastTag: "span" | "div";
  headlineClass: string;
  headlineTag: "p" | "h2";
  // "option" honours options.blockLine; "domain" gates on the training family
  // (a lifting calendar under a lab lever would imply the lab work is
  // block-scoped volume work); "never" omits it.
  blockLine: "option" | "domain" | "never";
  // "route" = the navigable lead block with domain tag + arrow;
  // "flat" = title/why/move with no route chrome (the surface links out itself);
  // "line" = headline + one line only, no lead block at all.
  lead: "route" | "flat" | "line";
  leadWrap: string;
  leadTitleClass: string;
  leadWhyClass: string;
  // "" omits the Move line.
  moveClass: string;
  // The lead's title is required for this variant to render at all.
  requireTitle: boolean;
  // Renders even when the server says the focus is not available (hero only).
  allowUnavailable: boolean;
  parallel: boolean;
  later: boolean;
  connections: boolean;
  retest: "card" | "line" | "never";
  footer: string;
};

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
    allowUnavailable: false,
    parallel: false,
    later: false,
    connections: false,
    retest: "line",
    // The Progress overview wires [data-tovgo] itself (a view-transitioned seg
    // handler), so this link stays in that family rather than [data-cfocus-go].
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

function cfocusText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// The navigable lead block (full/compact). A RUNNING recovery week is a
// confirmation, not a destination — it renders non-interactive (no route, no
// arrow); every other lead keeps its route.
function cfocusRouteLeadHtml(
  lead: ClientCoachingFocusItem,
  spec: CfocusVariantSpec,
  options: CoachingFocusRenderOptions,
  acts: boolean
): string {
  const confirm = lead.domain === "recovery" && lead.recovery_active === true;
  let html = confirm
    ? `<div class="${spec.leadWrap} cfocus-confirm">`
    : `<div class="${spec.leadWrap} cfocus-go" data-cfocus-go="${escAttr(lead.domain || "")}" role="link" tabindex="0">`;
  html += `<div class="cfocus-lead-top">${cfocusDomainTag(lead.domain)}<h3 class="${spec.leadTitleClass}">${escHtml(lead.title || "")}</h3>${confirm ? "" : `<span class="cfocus-go-arrow" aria-hidden="true">→</span>`}</div>`;
  if (lead.why) html += `<p class="${spec.leadWhyClass}">${escHtml(lead.why)}</p>`;
  if (spec.moveClass && lead.move)
    html += `<p class="${spec.moveClass}"><span class="lbl">Move</span>${escHtml(lead.move)}</p>`;
  // Action buttons render ONLY when options.actions — they are wired where the
  // card lives (Program); a navigate-only surface would render them dead. The
  // surrounding lead row still navigates (focusRouteTarget ignores [data-cfocus-act]).
  if (options.actions) {
    // A recovery lead is ACTIONABLE off lead mode: one tap drafts next week as a
    // recovery week (a reviewable proposal via the propose→apply loop — the same
    // durable /program/evolve job as "Evolve my plan"). Once the draft has landed
    // (draft_pending) — or under lead mode where the coach set it up itself — the
    // button gives way to a review LINK: state, not a repeatable ask. The link is
    // pure navigation via data-cfocus-go, so it renders in every posture.
    if (lead.domain === "recovery" && !lead.recovery_active && !lead.day_posture) {
      // recovery_active renders NOTHING — the week is running, the lead is a
      // confirmation, and re-offering the draft would be the same ask twice.
      // role="link" so the keydown navigator resolves the BUTTON's target
      // (plan-coach), not the surrounding lead row's.
      if (lead.draft_pending) {
        html += `<button class="draftbtn cfocus-review" type="button" role="link" data-cfocus-go="plan-coach">Review your recovery week →</button>`;
      } else if (acts) {
        html += `<button class="draftbtn cfocus-act" type="button" data-cfocus-act="recovery-week">Draft my recovery week</button>`;
      }
    }
    // Swap asks only where the athlete drives them (non-lead mode) — under lead the
    // coach rotates at the boundary itself, so the server also emits no swap payload.
    if (acts) html += cfocusSwapButtonsHtml(lead);
  }
  return `${html}</div>`;
}

// The flat lead (the Progress-overview well): the same words with no route
// chrome, because the well itself is not a link — its footer is.
function cfocusFlatLeadHtml(lead: ClientCoachingFocusItem, spec: CfocusVariantSpec): string {
  let html = `<div class="${spec.leadTitleClass}">${escHtml(lead.title || "")}</div>`;
  if (lead.why) html += `<div class="${spec.leadWhyClass}">${escHtml(lead.why)}</div>`;
  if (spec.moveClass && lead.move) html += `<div class="${spec.moveClass}">${escHtml(lead.move)}</div>`;
  return html;
}

function cfocusRetestHtml(focus: ClientCoachingFocus, spec: CfocusVariantSpec): string {
  const retest = focus.retest;
  if (spec.retest === "never" || !retest || !Array.isArray(retest.focus) || !retest.focus.length) return "";
  if (spec.retest === "line") {
    // The compact one-liner drops a placeholder lift name and only speaks when
    // the timing is real — "Re-test unknown in ~0 wk" is not a sentence.
    const names = retest.focus
      .map((name) => cfocusText(name))
      .filter((name) => name && name.toLowerCase() !== "unknown");
    const weeks = Number(retest.in_weeks);
    if (!names.length || !Number.isFinite(weeks) || weeks < 1) return "";
    return `<div class="tov-focus-retest">Re-test ${escHtml(names.join(", "))} in ~${Math.round(weeks)} wk</div>`;
  }
  const when =
    typeof retest.in_weeks === "number" && retest.in_weeks > 0
      ? `~${retest.in_weeks} week${retest.in_weeks === 1 ? "" : "s"}`
      : "due now";
  let html = `<div class="cfocus-retest cfocus-go" data-cfocus-go="program" role="link" tabindex="0"><span class="cfocus-retest-lbl lbl">Next check-in</span>`;
  html += `<span class="cfocus-retest-body">${escHtml(retest.focus.join(" · "))} <span class="cfocus-retest-when">${escHtml(when)}</span></span>`;
  if (retest.why) html += `<span class="cfocus-retest-why">${escHtml(retest.why)}</span>`;
  return `${html}</div>`;
}

function coachingFocusHtml(
  focus: ClientCoachingFocus | null | undefined,
  options: CoachingFocusRenderOptions = {}
): string {
  const spec = CFOCUS_VARIANTS[options.variant || "full"] || CFOCUS_VARIANTS.full;
  if (!focus) return "";
  const lead = focus.lead || null;
  if (!spec.allowUnavailable && (!focus.available || !lead)) return "";
  if (spec.requireTitle && !cfocusText(lead?.title)) return "";

  const headline = cfocusText(focus.headline);
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

  let html = `<div class="${spec.wrap}"${style}>`;
  html += `<${spec.mastTag} class="${spec.mastClass}">Where to focus</${spec.mastTag}>`;
  if (headline)
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
    else if (spec.lead === "flat") html += cfocusFlatLeadHtml(lead, spec);
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

  html += cfocusRetestHtml(focus, spec);
  html += spec.footer;
  return `${html}</div>`;
}

// The named variants stay as thin aliases: every existing call site keeps its
// shape, and there is still exactly one place the read is built.
function coachingFocusCardHtml(
  focus: ClientCoachingFocus | null | undefined,
  options: { blockLine?: boolean; actions?: boolean } = {}
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
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
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

document.addEventListener("click", (event) => {
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
