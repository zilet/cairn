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

function captureReadRenderWeeklyInSlot(target: HTMLElement, ins: CaptureInsight, deps: CaptureReadCardDeps): void {
  if (!target || !ins) return;
  captureReadRenderWeeklyCard(target, ins, deps);
  if (ins.status === "new") {
    deps.api(`/insights/${ins.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "seen" }),
    }).catch(() => {});
  }
}

function captureReadRenderWeeklyCard(target: HTMLElement, ins: CaptureInsight, deps: CaptureReadCardDeps): void {
  const text = deps.escapeHtml(String(ins.text || ""));
  const change = String(ins.next_step || "").trim();
  const why = String(ins.rationale || "").trim();
  const range = deps.weekRangeLabel(ins.created_at);
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
};

Object.assign(globalThis, { CairnCaptureReadCards: CAIRN_CAPTURE_READ_CARDS });

if (typeof window !== "undefined") {
  Object.assign(window, { CairnCaptureReadCards: CAIRN_CAPTURE_READ_CARDS });
}
