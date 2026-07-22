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

// options.blockLine=false omits the calendar line — for the Program view, which
// already owns block truth via its own "Current block · week N of M" card.
// options.actions=true renders the [data-cfocus-act] buttons — only where they
// are wired (Program). Every navigate-only surface (the Standing slot) keeps the
// default, so an action button never renders dead.
function coachingFocusCardHtml(
  focus: ClientCoachingFocus | null | undefined,
  options: { blockLine?: boolean; actions?: boolean } = {}
): string {
  if (!focus || !focus.available || !focus.lead) return "";
  const lead = focus.lead;
  // Lead mode owns the actions server-side (focus.acts === false): the coach applies
  // bounded changes itself, so the card offers no one-tap swap/draft ask, only state
  // and a review LINK. Absent → true (the legacy navigate-and-act surfaces).
  const acts = focus.acts !== false;
  const parallel = focusItems(focus.parallel);
  const later = Array.isArray(focus.later) ? focus.later.filter((item) => item && item.title) : [];
  const connections = Array.isArray(focus.connections) ? focus.connections.filter(Boolean) : [];
  const retest = focus.retest;

  let html = `<div class="cfocus settle-in">`;
  html += `<span class="cfocus-mast lbl">Where to focus</span>`;
  if (focus.headline) html += `<p class="cfocus-headline">${escHtml(focus.headline)}</p>`;
  if (focus.block_line && options.blockLine !== false)
    html += `<p class="cfocus-blockline">${escHtml(focus.block_line)}</p>`;

  // A RUNNING recovery week is a confirmation, not a destination — the lead renders
  // non-interactive (no navigation, no arrow); every other lead keeps its route.
  const leadConfirm = lead.domain === "recovery" && lead.recovery_active === true;
  html += leadConfirm
    ? `<div class="cfocus-lead cfocus-confirm">`
    : `<div class="cfocus-lead cfocus-go" data-cfocus-go="${escAttr(lead.domain || "")}" role="link" tabindex="0">`;
  html += `<div class="cfocus-lead-top">${cfocusDomainTag(lead.domain)}<h3 class="cfocus-lead-title">${escHtml(lead.title || "")}</h3>${leadConfirm ? "" : `<span class="cfocus-go-arrow" aria-hidden="true">→</span>`}</div>`;
  if (lead.why) html += `<p class="cfocus-lead-why">${escHtml(lead.why)}</p>`;
  if (lead.move) html += `<p class="cfocus-lead-move"><span class="lbl">Move</span>${escHtml(lead.move)}</p>`;
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
  html += `</div>`;

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

  if (later.length) {
    html += `<p class="cfocus-later"><span class="cfocus-later-lbl">Next:</span> ${later.map((item) => escHtml(item.title)).join(" · ")}</p>`;
  }

  for (const connection of connections) {
    html += `<p class="cfocus-conn">${escHtml(connection)}</p>`;
  }

  if (retest && Array.isArray(retest.focus) && retest.focus.length) {
    const when =
      typeof retest.in_weeks === "number" && retest.in_weeks > 0
        ? `~${retest.in_weeks} week${retest.in_weeks === 1 ? "" : "s"}`
        : "due now";
    html += `<div class="cfocus-retest cfocus-go" data-cfocus-go="program" role="link" tabindex="0"><span class="cfocus-retest-lbl lbl">Next check-in</span>`;
    html += `<span class="cfocus-retest-body">${escHtml(retest.focus.join(" · "))} <span class="cfocus-retest-when">${escHtml(when)}</span></span>`;
    if (retest.why) html += `<span class="cfocus-retest-why">${escHtml(retest.why)}</span>`;
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

// The COMPACT conductor — for surfaces that already carry their own depth (the
// Stand overview renders the health synthesis right below). One voice: masthead,
// headline, calendar line, THE lead lever — no parallel/later/connections/retest
// (those live in the full card on Progress → Program, one tap away), so the
// conductor and the synthesis never make rival whole-picture claims on one screen.
function coachingFocusCompactHtml(focus: ClientCoachingFocus | null | undefined): string {
  if (!focus || !focus.available || !focus.lead) return "";
  const lead = focus.lead;
  let html = `<div class="cfocus cfocus-compact settle-in">`;
  html += `<span class="cfocus-mast lbl">Where to focus</span>`;
  if (focus.headline) html += `<p class="cfocus-headline">${escHtml(focus.headline)}</p>`;
  if (focus.block_line && cfocusBlockDomains(lead.domain))
    html += `<p class="cfocus-blockline">${escHtml(focus.block_line)}</p>`;
  // A RUNNING recovery week leads as a confirmation, not a route (see the full card).
  const leadConfirm = lead.domain === "recovery" && lead.recovery_active === true;
  html += leadConfirm
    ? `<div class="cfocus-lead cfocus-confirm">`
    : `<div class="cfocus-lead cfocus-go" data-cfocus-go="${escAttr(lead.domain || "")}" role="link" tabindex="0">`;
  html += `<div class="cfocus-lead-top">${cfocusDomainTag(lead.domain)}<h3 class="cfocus-lead-title">${escHtml(lead.title || "")}</h3>${leadConfirm ? "" : `<span class="cfocus-go-arrow" aria-hidden="true">→</span>`}</div>`;
  if (lead.why) html += `<p class="cfocus-lead-why">${escHtml(lead.why)}</p>`;
  html += `</div>`;
  html += `<button class="cfocus-full-link" type="button" data-cfocus-go="program">The full focus plan →</button>`;
  html += `</div>`;
  return html;
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
