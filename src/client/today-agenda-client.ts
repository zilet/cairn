// @ts-check
// Pure Today agenda/fuel rendering helpers for the vanilla PWA.

type ClientTodayAgenda = import("../contracts/client.js").ClientTodayAgenda;
type ClientTodayAgendaCandidate = import("../contracts/client.js").ClientTodayAgendaCandidate;
type ClientDayIntake = import("../contracts/client.js").ClientDayIntake;
type ClientMacroTotals = import("../contracts/client.js").ClientMacroTotals;
type TodayAgendaBuckets = { primary: ClientTodayAgendaCandidate[]; more: ClientTodayAgendaCandidate[] };

// The slot markup for each rail client_card (stable ids the loaders bind to). A
// candidate naming a card not in here is a forward card the client can't yet draw
// (a sibling shipped server-side but not in this build) and is skipped gracefully.
const TODAY_RAIL_SLOTS: Record<string, string> = {
  fuel: `<div id="fuelSlot" class="fuel-slot card-stack-item"></div>`,
  "fueling-followup": `<div id="fuelingSlot" class="fueling-slot card-stack-item"></div>`,
  "week-ahead": `<div id="weekAheadSlot" class="weekahead-slot card-stack-item"></div>`,
  "program-adjustments": `<div id="adjustSlot" class="adjust-slot card-stack-item"></div>`,
  "weekly-read": `<div id="weeklySlot" class="weekly-slot card-stack-item"></div>`,
  "connection-insight": `<div id="insightSlot" class="insight-slot card-stack-item"></div>`,
  "garmin-reconcile": `<div id="garminReconcileSlot" class="garmin-reconcile-slot card-stack-item"></div>`,
  lately: `<div id="qlRecent" class="ql-recent lately-slot card-stack-item"></div>`,
};
const TODAY_PRIMARY_CLIENT_MAX = 2;

function todayAgendaCanRenderCard(candidate: ClientTodayAgendaCandidate | null | undefined): boolean {
  if (!candidate) return false;
  return candidate.client_card ? !!TODAY_RAIL_SLOTS[candidate.client_card] : true;
}

function todayAgendaRenderableBuckets(agenda: Partial<ClientTodayAgenda> | null | undefined): TodayAgendaBuckets {
  // Respect the SERVER's tier split — it is the salience arbiter, and its
  // surprise budget may deliberately leave primary under-filled while a
  // deferred newcomer waits at the top of `more`. Re-flattening and re-slicing
  // here would promote that newcomer inline, defeating the one-new-thing-per-day
  // budget. Only backfill across the boundary when an inline card was dropped
  // as UNRENDERABLE (a forward card from a newer server) — restoring exactly
  // the forward-compat case the old flatten existed for. Server-primary items
  // beyond the client cap still flow into `more` (never silently dropped).
  const renderablePrimary = (agenda?.primary || []).filter(todayAgendaCanRenderCard);
  const primary = renderablePrimary.slice(0, TODAY_PRIMARY_CLIENT_MAX);
  const more = [
    ...renderablePrimary.slice(TODAY_PRIMARY_CLIENT_MAX),
    ...(agenda?.more || []).filter(todayAgendaCanRenderCard),
  ];
  const droppedUnrenderable = (agenda?.primary || []).length - renderablePrimary.length;
  const backfillCount = Math.min(droppedUnrenderable, TODAY_PRIMARY_CLIENT_MAX - primary.length);
  const backfill = backfillCount > 0 ? more.splice(0, backfillCount) : [];
  return {
    primary: [...primary, ...backfill],
    more,
  };
}

function todayAgendaGenericCardHtml(candidate: ClientTodayAgendaCandidate, revealIdx: number): string {
  const kicker = candidate.kicker ? `<div class="agenda-kicker lbl">${escHtml(candidate.kicker)}</div>` : "";
  const title = candidate.title ? `<div class="agenda-title">${escHtml(candidate.title)}</div>` : "";
  const body = candidate.body ? `<div class="agenda-body">${escHtml(candidate.body)}</div>` : "";
  const act =
    candidate.action && candidate.action.label
      ? `<button class="agenda-act" type="button" data-agenda-act="${escAttr(candidate.action.kind || "")}" data-agenda-id="${escAttr(candidate.id || "")}">${escHtml(candidate.action.label)}</button>`
      : "";
  const dismiss = candidate.dismissible
    ? `<button class="xbtn agenda-x" type="button" data-agenda-dismiss="${escAttr(candidate.id || "")}" aria-label="Dismiss">✕</button>`
    : "";
  return `<div class="agenda-card card-stack-item reveal" data-agenda-card="${escAttr(candidate.id || "")}" data-agenda-kind="${escAttr(candidate.kind || "")}" style="${stagger(revealIdx || 0)}">
      ${dismiss}
      ${kicker}${title}${body}
      ${act ? `<div class="agenda-foot">${act}</div>` : ""}
    </div>`;
}

function todayAgendaRailHtml(
  agenda: Partial<ClientTodayAgenda> | null | undefined,
  genericPending: ClientTodayAgendaCandidate[]
): string {
  const buckets = todayAgendaRenderableBuckets(agenda);
  const cardHtml = (candidate: ClientTodayAgendaCandidate) => {
    if (candidate.client_card) return TODAY_RAIL_SLOTS[candidate.client_card] || "";
    genericPending.push(candidate);
    return todayAgendaGenericCardHtml(candidate, genericPending.length - 1);
  };
  const primaryHtml = buckets.primary.map(cardHtml).filter(Boolean).join("");
  const moreCards = buckets.more.map(cardHtml).filter(Boolean).join("");
  const n = buckets.more.length;
  // A genuinely-new attention item waiting behind the disclosure gets a quiet
  // "· one new" whisper on the summary — legible pull (the athlete can peek or
  // let it take tomorrow's inline slot), never a badge, count, or push.
  const nWaiting = buckets.more.filter((c) => c.waiting).length;
  const waitingCue =
    nWaiting > 0 ? `<span class="today-more-new">· ${nWaiting === 1 ? "one new" : "new things"} inside</span>` : "";
  const moreHtml =
    n > 0 && moreCards
      ? `<details class="today-more card-stack-item" id="todayMore">
        <summary class="today-more-sum"><span class="today-more-lbl">${n === 1 ? "1 more" : `${n} more`}</span>${waitingCue}<span class="today-more-chev" aria-hidden="true">▾</span></summary>
        <div class="today-more-body card-stack">${moreCards}</div>
      </details>`
      : "";
  if (!primaryHtml && !moreHtml) return "";
  const mast = primaryHtml
    ? `<div class="rail-mast"><span class="rail-mast-mark" aria-hidden="true">✦</span><span class="rail-mast-lbl lbl">Also worth a look</span></div>`
    : "";
  return `<aside class="today-rail card-stack">${mast}${primaryHtml}${moreHtml}</aside>`;
}

function todayFuelCardHtml(day: ClientDayIntake | null | undefined): string {
  const totals: Partial<ClientMacroTotals> = day?.totals || {};
  const kcal = Math.round(Number(totals.kcal) || 0);
  const protein = Math.round(Number(totals.protein_g) || 0);
  const count = Number(day?.count) || 0;
  if (!count) return "";
  let remLine = "";
  if (day?.remaining && day.target) {
    const left = Math.round(Number(day.remaining.kcal));
    remLine =
      left > 0
        ? `<span class="fuel-rem">~${left} left</span>`
        : `<span class="fuel-rem fuel-rem-done">fuel's in for today</span>`;
  }
  const word = count === 1 ? "item" : "items";
  return `<button class="fuel-card reveal" id="fuelCard" style="--i:0" type="button" title="Review &amp; edit today's food">
      <span class="fuel-ico" aria-hidden="true">◷</span>
      <span class="fuel-body">
        <span class="fuel-h lbl">Today's fuel · ${count} ${word}</span>
        <span class="fuel-stats">
          <span class="numeral" data-cu="${kcal}">0</span><span class="fuel-unit">kcal</span>
          <span class="fuel-dot" aria-hidden="true">·</span>
          <span class="numeral" data-cu="${protein}">0</span><span class="fuel-unit">g protein</span>
          ${remLine}
        </span>
      </span>
      <span class="fuel-go" aria-hidden="true">→</span>
    </button>`;
}

Object.assign(globalThis, {
  CairnTodayAgenda: {
    TODAY_RAIL_SLOTS,
    TODAY_PRIMARY_CLIENT_MAX,
    canRenderCard: todayAgendaCanRenderCard,
    renderableBuckets: todayAgendaRenderableBuckets,
    genericCardHtml: todayAgendaGenericCardHtml,
    railHtml: todayAgendaRailHtml,
    fuelCardHtml: todayFuelCardHtml,
  },
});
