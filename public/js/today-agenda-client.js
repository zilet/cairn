(() => {
// @ts-check
// Pure Today agenda/fuel rendering helpers for the vanilla PWA.
// The slot markup for each rail client_card (stable ids the loaders bind to). A
// candidate naming a card not in here is a forward card the client can't yet draw
// (a sibling shipped server-side but not in this build) and is skipped gracefully.
const TODAY_RAIL_SLOTS = {
    fuel: `<div id="fuelSlot" class="fuel-slot"></div>`,
    "week-ahead": `<div id="weekAheadSlot" class="weekahead-slot"></div>`,
    "program-adjustments": `<div id="adjustSlot" class="adjust-slot"></div>`,
    "weekly-read": `<div id="weeklySlot" class="weekly-slot"></div>`,
    "connection-insight": `<div id="insightSlot" class="insight-slot"></div>`,
    "garmin-reconcile": `<div id="garminReconcileSlot" class="garmin-reconcile-slot"></div>`,
    lately: `<div id="qlRecent" class="ql-recent lately-slot"></div>`,
};
const TODAY_PRIMARY_CLIENT_MAX = 2;
function todayAgendaCanRenderCard(candidate) {
    if (!candidate)
        return false;
    return candidate.client_card ? !!TODAY_RAIL_SLOTS[candidate.client_card] : true;
}
function todayAgendaRenderableBuckets(agenda) {
    const ordered = [...(agenda?.primary || []), ...(agenda?.more || [])].filter(todayAgendaCanRenderCard);
    return {
        primary: ordered.slice(0, TODAY_PRIMARY_CLIENT_MAX),
        more: ordered.slice(TODAY_PRIMARY_CLIENT_MAX),
    };
}
function todayAgendaGenericCardHtml(candidate, revealIdx) {
    const kicker = candidate.kicker ? `<div class="agenda-kicker lbl">${escHtml(candidate.kicker)}</div>` : "";
    const title = candidate.title ? `<div class="agenda-title">${escHtml(candidate.title)}</div>` : "";
    const body = candidate.body ? `<div class="agenda-body">${escHtml(candidate.body)}</div>` : "";
    const act = candidate.action && candidate.action.label
        ? `<button class="agenda-act" type="button" data-agenda-act="${escAttr(candidate.action.kind || "")}" data-agenda-id="${escAttr(candidate.id || "")}">${escHtml(candidate.action.label)}</button>`
        : "";
    const dismiss = candidate.dismissible
        ? `<button class="agenda-x" type="button" data-agenda-dismiss="${escAttr(candidate.id || "")}" aria-label="Dismiss">✕</button>`
        : "";
    return `<div class="agenda-card reveal" data-agenda-card="${escAttr(candidate.id || "")}" data-agenda-kind="${escAttr(candidate.kind || "")}" style="${stagger(revealIdx || 0)}">
      ${dismiss}
      ${kicker}${title}${body}
      ${act ? `<div class="agenda-foot">${act}</div>` : ""}
    </div>`;
}
function todayAgendaRailHtml(agenda, genericPending) {
    const buckets = todayAgendaRenderableBuckets(agenda);
    const cardHtml = (candidate) => {
        if (candidate.client_card)
            return TODAY_RAIL_SLOTS[candidate.client_card] || "";
        genericPending.push(candidate);
        return todayAgendaGenericCardHtml(candidate, genericPending.length - 1);
    };
    const primaryHtml = buckets.primary.map(cardHtml).filter(Boolean).join("");
    const moreCards = buckets.more.map(cardHtml).filter(Boolean).join("");
    const n = buckets.more.length;
    const moreHtml = n > 0 && moreCards
        ? `<details class="today-more" id="todayMore">
        <summary class="today-more-sum"><span class="today-more-lbl">${n === 1 ? "1 more" : `${n} more`}</span><span class="today-more-chev" aria-hidden="true">▾</span></summary>
        <div class="today-more-body">${moreCards}</div>
      </details>`
        : "";
    if (!primaryHtml && !moreHtml)
        return "";
    const mast = primaryHtml
        ? `<div class="rail-mast"><span class="rail-mast-mark" aria-hidden="true">✦</span><span class="rail-mast-lbl lbl">Also worth a look</span></div>`
        : "";
    return `<aside class="today-rail">${mast}${primaryHtml}${moreHtml}</aside>`;
}
function todayFuelCardHtml(day) {
    const totals = day?.totals || {};
    const kcal = Math.round(Number(totals.kcal) || 0);
    const protein = Math.round(Number(totals.protein_g) || 0);
    const count = Number(day?.count) || 0;
    if (!count)
        return "";
    let remLine = "";
    if (day?.remaining && day.target) {
        const left = Math.round(Number(day.remaining.kcal));
        remLine = left > 0
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
})();
