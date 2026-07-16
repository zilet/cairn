// @ts-check
// Next-checkup renderer: the doctor-loop made visible. Pure HTML from a
// ClientNextCheckup payload — a lead sentence, rechecks due/coming up, visible
// follow-through on what you've started, and a calm prep list. Reading grammar:
// plain-language lead, qualitative chips, direction-as-words (never a score).

type ClientNextCheckup = import("../contracts/client-api.js").ClientNextCheckup;
type ClientCheckupItem = import("../contracts/client-api.js").ClientCheckupItem;
type ClientFollowThroughItem = import("../contracts/client-api.js").ClientFollowThroughItem;
type ClientCheckupOrderedLab = import("../contracts/client-api.js").ClientCheckupOrderedLab;

(() => {
  const uir = () =>
    (globalThis as unknown as { CairnUiReads?: Record<string, (...a: unknown[]) => string> }).CairnUiReads;

  function levelChip(label: string, detail = ""): string {
    const fn = uir()?.levelChipHtml;
    if (fn) return fn({ label, detail });
    // Fallback if the primitives module didn't load — a plain, escaped chip.
    const d = detail ? `<span class="level-chip-detail">${escHtml(detail)}</span>` : "";
    return label ? `<span class="level-chip">${escHtml(label)}${d}</span>` : "";
  }

  function dateChipFor(item: ClientCheckupItem): string {
    if (item.when_text) return levelChip(item.when_text);
    if (item.next_due) return levelChip(relAge(item.next_due));
    return "";
  }

  // Due → terracotta (act now), coming-up dated → sage-ish watch, add-ons → muted.
  function itemTone(item: ClientCheckupItem, kind: "due" | "upcoming"): string {
    if (kind === "due") return "warn";
    return item.kind === "add" ? "mute" : "watch";
  }

  function itemHtml(item: ClientCheckupItem, kind: "due" | "upcoming"): string {
    const tone = itemTone(item, kind);
    const chip = kind === "due" ? levelChip("window open") : dateChipFor(item);
    return `<div class="chk-item">
      <span class="hdot hdot-${tone}"></span>
      <div class="chk-item-body">
        <div class="chk-item-top"><span class="chk-item-label">${escHtml(item.label)}</span>${chip}</div>
        ${item.why ? `<div class="chk-item-why">${escHtml(item.why)}</div>` : ""}
      </div>
    </div>`;
  }

  // moving_your_way → sage (toward optimal), not_yet → terracotta (away/actionable),
  // awaiting_recheck → muted (nothing to read yet).
  const FT_TONE: Record<string, "toward" | "away" | "stable"> = {
    moving_your_way: "toward",
    not_yet: "away",
    awaiting_recheck: "stable",
  };

  function followThroughCard(ft: ClientFollowThroughItem): string {
    const tone = FT_TONE[ft.status] || "stable";
    const head =
      uir()?.trendLeadHtml?.({ name: ft.marker, phrase: ft.status_text, tone }) ||
      `<div class="trend-lead"><span class="trend-lead-name">${escHtml(ft.marker)}</span><span class="trend-lead-phrase ${tone}">${escHtml(ft.status_text)}</span></div>`;
    const metaBits: string[] = [];
    if (ft.latest_value) {
      const age = ft.latest_date ? ` · read ${escHtml(relAge(ft.latest_date))}` : "";
      const title = ft.latest_date ? ` title="${escAttr(absDate(ft.latest_date))}"` : "";
      metaBits.push(`<span${title}>${escHtml(ft.latest_value)}${age}</span>`);
    }
    if (ft.trend_text) metaBits.push(`<span>${escHtml(ft.trend_text)}</span>`);
    const meta = metaBits.length ? `<div class="chk-ft-meta">${metaBits.join(" · ")}</div>` : "";
    const via = ft.via && ft.via.length ? `<div class="chk-ft-via lbl">via ${escHtml(ft.via.join(", "))}</div>` : "";
    const recheckTone = ft.recheck === "due" ? "warn" : ft.recheck === "upcoming" ? "watch" : "mute";
    const recheck = ft.recheck_text
      ? `<div class="chk-ft-recheck"><span class="hdot hdot-${recheckTone}"></span>${escHtml(ft.recheck_text)}</div>`
      : "";
    return `<div class="chk-ft">${head}${meta}${via}${recheck}</div>`;
  }

  function orderedLabHtml(o: ClientCheckupOrderedLab): string {
    return `<li><span class="chk-ol-name">${escHtml(o.label)}</span>${o.detail ? `<span class="chk-ol-detail"> — ${escHtml(o.detail)}</span>` : ""}</li>`;
  }

  function prepHtml(data: ClientNextCheckup | null): string {
    const prep = data?.prep || { ordered_labs: [], bring: [], questions: [] };
    const ordered = Array.isArray(prep.ordered_labs) ? prep.ordered_labs : [];
    const bring = Array.isArray(prep.bring) ? prep.bring : [];
    const questions = Array.isArray(prep.questions) ? prep.questions : [];
    if (!ordered.length && !bring.length && !questions.length) return "";
    const orderedBlock = ordered.length
      ? `<div class="chk-prep-block well-accent-sm">
          <span class="lbl">Labs already on order</span>
          <ul class="chk-ol">${ordered.map(orderedLabHtml).join("")}</ul>
        </div>`
      : "";
    const bringBlock = bring.length
      ? `<div class="chk-prep-block"><span class="lbl">Worth bringing</span><ul class="chk-list">${bring.map((b) => `<li>${escHtml(b)}</li>`).join("")}</ul></div>`
      : "";
    const askBlock = questions.length
      ? `<div class="chk-prep-block"><span class="lbl">Worth asking</span><ul class="chk-list">${questions.map((q) => `<li>${escHtml(q)}</li>`).join("")}</ul></div>`
      : "";
    return `<section class="chk-sec reveal">
      <div class="stand-browse lbl">Prep for your visit</div>
      ${orderedBlock}${bringBlock}${askBlock}
    </section>`;
  }

  function checkupHtml(data: ClientNextCheckup | null | undefined): string {
    const d = data || null;
    const lede = d && typeof d.lede === "string" ? d.lede : "";
    const due = Array.isArray(d?.due_now) ? d!.due_now : [];
    const upcoming = Array.isArray(d?.upcoming) ? d!.upcoming : [];
    const followThrough = Array.isArray(d?.follow_through) ? d!.follow_through : [];
    const dated = upcoming.filter((u) => u.kind !== "add");
    const addOns = upcoming.filter((u) => u.kind === "add");

    const ledeBlock = `<div class="stand-read reveal"><p class="stand-read-lede">${escHtml(lede || "Nothing's due for a recheck right now.")}</p></div>`;

    const dueBlock = due.length
      ? `<section class="chk-sec reveal"><div class="stand-browse lbl">Due now</div>${due.map((i) => itemHtml(i, "due")).join("")}</section>`
      : "";

    const upcomingBlock =
      dated.length || addOns.length
        ? `<section class="chk-sec reveal"><div class="stand-browse lbl">Coming up</div>
            ${dated.map((i) => itemHtml(i, "upcoming")).join("")}
            ${addOns.length ? `<div class="chk-subhead lbl">Worth adding to the next draw</div>${addOns.map((i) => itemHtml(i, "upcoming")).join("")}` : ""}
          </section>`
        : "";

    const ftBlock = followThrough.length
      ? `<section class="chk-sec reveal"><div class="stand-browse lbl">What you've started</div>
          <p class="chk-sec-sub">Interventions in motion and where their target markers stand. Direction only — never a verdict.</p>
          <div class="chk-ft-grid">${followThrough.map(followThroughCard).join("")}</div>
        </section>`
      : "";

    const prepBlock = prepHtml(d);

    const body = dueBlock + upcomingBlock + ftBlock + prepBlock;
    const empty = body
      ? ""
      : `<div class="empty-state reveal"><div class="empty-state-line">No rechecks on the calendar</div>
          <div class="hpic-hero-sub">As you add labs and Cairn tracks what you're working on, this fills with what's worth checking next — and how the changes you've made are landing.</div>
        </div>`;

    const frame = d && typeof d.frame === "string" && d.frame ? `<p class="chk-frame">${escHtml(d.frame)}</p>` : "";

    return `<div class="chk stand-root">${ledeBlock}${body}${empty}${frame}</div>`;
  }

  const CAIRN_HEALTH_CHECKUP = { checkupHtml };
  Object.assign(globalThis, { CairnHealthCheckup: CAIRN_HEALTH_CHECKUP, checkupHtml });
  if (typeof window !== "undefined") {
    Object.assign(window, { CairnHealthCheckup: CAIRN_HEALTH_CHECKUP, checkupHtml });
  }
})();
