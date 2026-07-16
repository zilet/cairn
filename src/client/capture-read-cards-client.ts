// @ts-check
// Weekly and connection insight card rendering for Capture reads.

function captureReadRenderInsightInSlot(target: HTMLElement, ins: CaptureInsight, deps: CaptureReadCardDeps): void {
  if (!target || !ins) return;
  captureReadRenderInsightCard(target, ins, deps);
  if (ins.status === "new") {
    deps.api(`/insights/${ins.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "seen" }),
    }).catch(() => {});
  }
}

function captureReadRenderInsightCard(target: HTMLElement, ins: CaptureInsight, deps: CaptureReadCardDeps): void {
  const text = deps.escapeHtml(String(ins.text || ""));
  const step = String(ins.next_step || "").trim();
  const why = String(ins.rationale || "").trim();
  const kicker = ins.kind === "weekly_read" ? "This week" : "A connection worth noting";
  const soft = ins.uncertain === true || ins.confidence === "low";
  const lead = soft ? `<span class="insight-soft">Worth looking into · </span>` : "";
  target.innerHTML = `<section class="insight-card settle-in${soft ? " insight-card-soft" : ""}">
      <div class="insight-kicker lbl"><span class="insight-glyph" aria-hidden="true">✦</span> ${kicker}</div>
      <p class="insight-text">${lead}${text}</p>
      ${step ? `<p class="insight-step"><span class="insight-step-lbl">Worth trying</span>${deps.escapeHtml(step)}</p>` : ""}
      ${why ? `<p class="insight-why" hidden>${deps.escapeHtml(why)}</p>` : ""}
      <div class="insight-foot">
        <div class="insight-acts">
          <button class="linkbtn-quiet insight-act insight-act-go" data-ifb="up">Got it</button>
          <button class="linkbtn-quiet insight-act" data-ifb="down">Not useful</button>
        </div>
        ${why ? `<button class="linkbtn-quiet insight-why-more" data-iwhy aria-expanded="false">why this</button>` : ""}
      </div>
    </section>`;
  target.querySelectorAll<HTMLElement>("[data-ifb]").forEach((button) =>
    button.addEventListener("click", () => captureReadInsightFeedback(target, ins, button.dataset.ifb, deps)));
  captureReadWireWhyToggle(target, ".insight-why");
}

async function captureReadInsightFeedback(
  target: HTMLElement,
  ins: CaptureInsight,
  dir: string | undefined,
  deps: CaptureReadCardDeps,
  cardSel = ".insight-card",
): Promise<void> {
  const card = target.querySelector(cardSel);
  const body = dir === "up"
    ? { feedback: "up", status: "dismissed" }
    : { status: "dismissed" };
  deps.api(`/insights/${ins.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
  if (dir === "up") deps.toast("Noted — I'll remember");
  if (card) deps.collapseEl(card, () => {
    target.innerHTML = "";
  });
  else target.innerHTML = "";
}

function captureReadRenderWeeklyInSlot(
  target: HTMLElement,
  ins: CaptureInsight,
  deps: CaptureReadCardDeps,
  team?: CaptureTeamWeek | null,
): void {
  if (!target || !ins) return;
  captureReadRenderWeeklyCard(target, ins, deps, team);
  if (ins.status === "new") {
    deps.api(`/insights/${ins.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "seen" }),
    }).catch(() => {});
  }
}

function captureReadRenderWeeklyCard(
  target: HTMLElement,
  ins: CaptureInsight,
  deps: CaptureReadCardDeps,
  team?: CaptureTeamWeek | null,
): void {
  const text = deps.escapeHtml(String(ins.text || ""));
  const change = String(ins.next_step || "").trim();
  const why = String(ins.rationale || "").trim();
  const range = deps.weekRangeLabel(ins.created_at);
  // The weekly card leads with the agentic sentence, then the deterministic team
  // sections beneath it. The lead line is the agent's, so the team block omits its
  // own summary lead here.
  const sections = captureTeamWeekSectionsHtml(team, deps.escapeHtml);
  target.innerHTML = `<section class="weekly-card well-accent well-accent-sage settle-in">
      <div class="weekly-head">
        <span class="weekly-kicker lbl">The week</span>
        ${range ? `<span class="weekly-range">${deps.escapeHtml(range)}</span>` : ""}
      </div>
      <p class="weekly-text">${text}</p>
      ${change ? `<div class="weekly-change well-accent-sm">
          <span class="weekly-change-lbl lbl">One change</span>
          <p class="weekly-change-text">${deps.escapeHtml(change)}</p>
        </div>` : ""}
      ${sections}
      ${why ? `<p class="weekly-why" hidden>${deps.escapeHtml(why)}</p>` : ""}
      <div class="weekly-foot">
        <div class="insight-acts">
          <button class="linkbtn-quiet insight-act insight-act-go" data-ifb="up">Got it</button>
          <button class="linkbtn-quiet insight-act" data-ifb="down">Not useful</button>
        </div>
        ${why ? `<button class="linkbtn-quiet insight-why-more" data-iwhy aria-expanded="false">why this</button>` : ""}
      </div>
    </section>`;
  target.querySelectorAll<HTMLElement>("[data-ifb]").forEach((button) =>
    button.addEventListener("click", () => captureReadInsightFeedback(target, ins, button.dataset.ifb, deps, ".weekly-card")));
  captureReadWireWhyToggle(target, ".weekly-why");
}

// The deterministic body standing alone: when no agentic weekly_read exists yet,
// the team's-week sections still surface under a calm lead sentence (graceful
// degradation, like dayRead's deterministic floor). No feedback foot — there's no
// agentic insight to react to.
function captureReadRenderTeamWeekInSlot(target: HTMLElement, team: CaptureTeamWeek | null, deps: CaptureReadCardDeps): void {
  if (!target || !captureTeamWeekHasContent(team)) return;
  const lead = String(team?.lead || "").trim();
  const range = deps.weekRangeLabel(new Date().toISOString());
  const sections = captureTeamWeekSectionsHtml(team, deps.escapeHtml);
  target.innerHTML = `<section class="weekly-card well-accent well-accent-sage settle-in">
      <div class="weekly-head">
        <span class="weekly-kicker lbl">Your team this week</span>
        ${range ? `<span class="weekly-range">${deps.escapeHtml(range)}</span>` : ""}
      </div>
      ${lead ? `<p class="weekly-text">${deps.escapeHtml(lead)}</p>` : ""}
      ${sections}
    </section>`;
}

// Any team section carrying content (the lead alone is not enough to warrant a card).
function captureTeamWeekHasContent(team: CaptureTeamWeek | null | undefined): boolean {
  if (!team) return false;
  return (
    (Array.isArray(team.did) && team.did.length > 0) ||
    (Array.isArray(team.flagged) && team.flagged.length > 0) ||
    (Array.isArray(team.watching) && team.watching.length > 0) ||
    (Array.isArray(team.landed) && team.landed.length > 0) ||
    (Array.isArray(team.insights) && team.insights.length > 0)
  );
}

// A compact "Jul 22" from a YYYY-MM-DD (or ISO) string; "" when unparseable.
function captureTeamShortDate(iso: unknown): string {
  const raw = String(iso || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return "";
  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(parsed);
}

// Per-section display caps. The server returns the full coalesced/deduped read;
// anything beyond these caps is kept, just folded behind a quiet expander so the
// card stays short. "Week in review" is additionally capped to ≤2 lines per domain.
const TEAM_DID_TOTAL_CAP = 5;
const TEAM_DID_DOMAIN_CAP = 2;
const TEAM_FLAGGED_CAP = 3;
const TEAM_WATCHING_CAP = 4;
const TEAM_CONN_CAP = 2;

// The team's-week ("week in review") sections (did / flagged / watching / landed /
// connections) as one calm block. Every server string is escaped. Empty sections are
// omitted; no content → "". Items hidden by a display cap fold into a quiet expander.
function captureTeamWeekSectionsHtml(
  team: CaptureTeamWeek | null | undefined,
  esc: (value: unknown) => string,
): string {
  if (!captureTeamWeekHasContent(team)) return "";
  const t = team as CaptureTeamWeek;
  const blocks: string[] = [];

  // "Week in review" — ≤2 lines per domain, ≤5 lines total visible; the rest fold.
  const didVisible: string[] = [];
  const didOverflow: string[] = [];
  for (const group of Array.isArray(t.did) ? t.did : []) {
    let shownInDomain = 0;
    for (const change of Array.isArray(group?.changes) ? group.changes : []) {
      const line = String(change?.text || "").trim();
      if (!line) continue;
      const voice = String(change?.specialist || "").trim();
      const li = `<li class="team-item">
          <span class="team-item-line"><span class="team-domain">${esc(group?.label || group?.domain || "")}</span> ${esc(line)}</span>
          ${voice ? `<span class="team-voice">${esc(voice)}</span>` : ""}
        </li>`;
      if (shownInDomain < TEAM_DID_DOMAIN_CAP && didVisible.length < TEAM_DID_TOTAL_CAP) {
        didVisible.push(li);
        shownInDomain++;
      } else {
        didOverflow.push(li);
      }
    }
  }
  if (didVisible.length) blocks.push(captureTeamSectionHtml("Week in review", didVisible, didOverflow));

  const flaggedItems = (Array.isArray(t.flagged) ? t.flagged : [])
    .map((f) => String(f?.text || "").trim())
    .filter(Boolean)
    .map((line) => `<li class="team-item"><span class="team-item-line">${esc(line)}</span></li>`);
  const flagged = captureTeamSplitByCap(flaggedItems, TEAM_FLAGGED_CAP);
  if (flagged.visible.length) blocks.push(captureTeamSectionHtml("Waiting for you", flagged.visible, flagged.overflow));

  const watchingItems = (Array.isArray(t.watching) ? t.watching : [])
    .map((w) => {
      const line = String(w?.text || "").trim();
      if (!line) return "";
      const through = captureTeamShortDate(w?.through);
      return `<li class="team-item"><span class="team-item-line">${esc(line)}${through ? ` <span class="team-when">· through ${esc(through)}</span>` : ""}</span></li>`;
    })
    .filter(Boolean);
  const watching = captureTeamSplitByCap(watchingItems, TEAM_WATCHING_CAP);
  if (watching.visible.length)
    blocks.push(captureTeamSectionHtml("What we're watching", watching.visible, watching.overflow));

  const landedItems = (Array.isArray(t.landed) ? t.landed : [])
    .map((l) => {
      const line = String(l?.text || "").trim();
      if (!line) return "";
      const tone = l?.verdict === "aligned" ? " team-good" : l?.verdict === "not_aligned" ? " team-watch" : "";
      return `<li class="team-item${tone}"><span class="team-item-line">${esc(line)}</span></li>`;
    })
    .filter(Boolean);
  if (landedItems.length) blocks.push(captureTeamSectionHtml("How it landed", landedItems));

  const connItems = (Array.isArray(t.insights) ? t.insights : [])
    .map((i) => String(i?.text || "").trim())
    .filter(Boolean)
    .map((line) => `<li class="team-item"><span class="team-item-line">${esc(line)}</span></li>`);
  const conn = captureTeamSplitByCap(connItems, TEAM_CONN_CAP);
  if (conn.visible.length)
    blocks.push(captureTeamSectionHtml("Connections worth a look", conn.visible, conn.overflow));

  if (!blocks.length) return "";
  return `<div class="team-week">${blocks.join("")}</div>`;
}

// Split rendered `<li>` strings into the visible head (≤cap) and the folded tail.
function captureTeamSplitByCap(items: string[], cap: number): { visible: string[]; overflow: string[] } {
  return { visible: items.slice(0, cap), overflow: items.slice(cap) };
}

// A calm native disclosure holding the items a display cap hid; "" when nothing is
// hidden. No JS wiring needed (the card HTML is set via innerHTML).
function captureTeamFoldHtml(items: string[]): string {
  if (!items.length) return "";
  return `<details class="team-fold"><summary class="team-fold-sum">Show ${items.length} more</summary>
      <ul class="team-list team-fold-list">${items.join("")}</ul>
    </details>`;
}

function captureTeamSectionHtml(label: string, items: string[], overflow: string[] = []): string {
  return `<div class="team-sec">
      <span class="team-sec-lbl lbl">${label}</span>
      <ul class="team-list">${items.join("")}</ul>
      ${captureTeamFoldHtml(overflow)}
    </div>`;
}

function captureReadWireWhyToggle(target: HTMLElement, bodySelector: string): void {
  const whyBtn = target.querySelector<HTMLButtonElement>("[data-iwhy]");
  const whyEl = target.querySelector<HTMLElement>(bodySelector);
  if (!whyBtn || !whyEl) return;
  whyBtn.addEventListener("click", () => {
    const opening = whyEl.hidden;
    whyEl.hidden = !opening;
    if (opening) {
      whyEl.classList.remove("chip-in");
      void whyEl.offsetWidth;
      whyEl.classList.add("chip-in");
    }
    whyBtn.setAttribute("aria-expanded", String(opening));
    whyBtn.textContent = opening ? "hide" : "why this";
  });
}

const CAIRN_CAPTURE_READ_CARDS: CaptureReadCardsApi = {
  renderInsightInSlot: captureReadRenderInsightInSlot,
  renderWeeklyInSlot: captureReadRenderWeeklyInSlot,
  renderTeamWeekInSlot: captureReadRenderTeamWeekInSlot,
  teamWeekSectionsHtml: captureTeamWeekSectionsHtml,
  teamWeekHasContent: captureTeamWeekHasContent,
};

Object.assign(globalThis, { CairnCaptureReadCards: CAIRN_CAPTURE_READ_CARDS });

if (typeof window !== "undefined") {
  Object.assign(window, { CairnCaptureReadCards: CAIRN_CAPTURE_READ_CARDS });
}
