// @ts-check
// Whole-athlete focus card renderer and routing bridge.
const CFOCUS_DOMAIN_LABEL = {
    training: "Training",
    running: "Running",
    nutrition: "Nutrition",
    health: "Health",
    recovery: "Recovery",
    body: "Body",
};
function cfocusDomainTag(domain) {
    const label = CFOCUS_DOMAIN_LABEL[String(domain || "")] || "";
    return label ? `<span class="cfocus-dom lbl">${escHtml(label)}</span>` : "";
}
function focusItems(items) {
    return Array.isArray(items) ? items.filter((item) => !!item) : [];
}
function coachingFocusCardHtml(focus) {
    if (!focus || !focus.available || !focus.lead)
        return "";
    const lead = focus.lead;
    const parallel = focusItems(focus.parallel);
    const later = Array.isArray(focus.later) ? focus.later.filter((item) => item && item.title) : [];
    const connections = Array.isArray(focus.connections) ? focus.connections.filter(Boolean) : [];
    const retest = focus.retest;
    let html = `<div class="cfocus settle-in">`;
    html += `<span class="cfocus-mast lbl">Where to focus</span>`;
    if (focus.headline)
        html += `<p class="cfocus-headline">${escHtml(focus.headline)}</p>`;
    html += `<div class="cfocus-lead cfocus-go" data-cfocus-go="${escAttr(lead.domain || "")}" role="link" tabindex="0">`;
    html += `<div class="cfocus-lead-top">${cfocusDomainTag(lead.domain)}<h3 class="cfocus-lead-title">${escHtml(lead.title || "")}</h3><span class="cfocus-go-arrow" aria-hidden="true">→</span></div>`;
    if (lead.why)
        html += `<p class="cfocus-lead-why">${escHtml(lead.why)}</p>`;
    if (lead.move)
        html += `<p class="cfocus-lead-move"><span class="lbl">Move</span>${escHtml(lead.move)}</p>`;
    html += `</div>`;
    if (parallel.length) {
        html += `<div class="cfocus-along"><span class="cfocus-sec-lbl lbl">Alongside</span>`;
        for (const item of parallel) {
            html += `<div class="cfocus-along-row cfocus-go" data-cfocus-go="${escAttr(item.domain || "")}" role="link" tabindex="0">${cfocusDomainTag(item.domain)}`;
            html += `<span class="cfocus-along-title">${escHtml(item.title || "")}</span>`;
            html += `<span class="cfocus-go-arrow" aria-hidden="true">→</span>`;
            if (item.why)
                html += `<span class="cfocus-along-why">${escHtml(item.why)}</span>`;
            if (item.move)
                html += `<span class="cfocus-along-move">${escHtml(item.move)}</span>`;
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
        const when = typeof retest.in_weeks === "number" && retest.in_weeks > 0
            ? `~${retest.in_weeks} week${retest.in_weeks === 1 ? "" : "s"}`
            : "due now";
        html += `<div class="cfocus-retest cfocus-go" data-cfocus-go="program" role="link" tabindex="0"><span class="cfocus-retest-lbl lbl">Next check-in</span>`;
        html += `<span class="cfocus-retest-body">${escHtml(retest.focus.join(" · "))} <span class="cfocus-retest-when">${escHtml(when)}</span></span>`;
        if (retest.why)
            html += `<span class="cfocus-retest-why">${escHtml(retest.why)}</span>`;
        html += `</div>`;
    }
    html += `</div>`;
    return html;
}
async function loadCoachingFocus(slotSelector, root) {
    const fallbackScope = typeof view !== "undefined" && view ? view : document;
    const scope = root || fallbackScope;
    const slot = scope.querySelector(slotSelector);
    if (!slot)
        return;
    let focus = null;
    try {
        focus = await api("/coaching-focus");
    }
    catch {
        focus = null;
    }
    if (!slot.isConnected)
        return;
    const html = coachingFocusCardHtml(focus);
    slot.innerHTML = html;
    if (html && slot.id === "cfocusStandingSlot")
        scope.querySelector(".hstand-lever")?.remove();
}
function coachingFocusThreadHtml(focus) {
    if (!focus || !focus.available || !focus.lead)
        return "";
    const title = focus.lead.title || "";
    if (!title)
        return "";
    return `<button class="cfocus-thread" type="button" data-cfocus-go="me-standing">
    <span class="cfocus-thread-arrow" aria-hidden="true">↳</span>
    <span class="cfocus-thread-lbl lbl">Focus now</span>
    <span class="cfocus-thread-txt">${escHtml(title)}</span>
    <span class="cfocus-thread-go" aria-hidden="true">→</span>
  </button>`;
}
function cfocusRoute(go) {
    switch (String(go || "")) {
        case "me-standing":
            state.meSeg = "standing";
            activateTab("me");
            break;
        case "running":
        case "endurance":
            state.progressSeg = "endurance";
            activateTab("progress");
            break;
        case "nutrition":
        case "meals":
        case "body":
            state.planJump = "meals";
            activateTab("plan");
            break;
        case "health":
        case "markers":
            state.meSeg = "health";
            state.healthSeg = "markers";
            state.healthSegPicked = true;
            activateTab("me");
            break;
        default:
            state.progressSeg = "program";
            activateTab("progress");
            break;
    }
}
function focusRouteTarget(event) {
    const target = event.target instanceof Element ? event.target : null;
    const element = target?.closest("[data-cfocus-go]");
    if (!element)
        return null;
    return element instanceof HTMLElement ? element.dataset.cfocusGo || "" : element.getAttribute("data-cfocus-go") || "";
}
document.addEventListener("click", (event) => {
    const go = focusRouteTarget(event);
    if (go != null)
        cfocusRoute(go);
});
document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ")
        return;
    const target = event.target instanceof Element ? event.target : null;
    const element = target?.closest('[data-cfocus-go][role="link"]');
    if (!element)
        return;
    event.preventDefault();
    cfocusRoute(element instanceof HTMLElement ? element.dataset.cfocusGo : element.getAttribute("data-cfocus-go"));
});
const CAIRN_COACHING_FOCUS = {
    CFOCUS_DOMAIN_LABEL,
    cfocusDomainTag,
    coachingFocusCardHtml,
    loadCoachingFocus,
    coachingFocusThreadHtml,
    cfocusRoute,
};
Object.assign(globalThis, {
    CairnCoachingFocus: CAIRN_COACHING_FOCUS,
    CFOCUS_DOMAIN_LABEL,
    cfocusDomainTag,
    coachingFocusCardHtml,
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
        loadCoachingFocus,
        coachingFocusThreadHtml,
        cfocusRoute,
    });
}
