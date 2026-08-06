// @ts-check
// Health Read synthesis card rendering and background job orchestration.
type HealthReadSynthesisRecord = Record<string, unknown>;
type HealthReadSynthesisPriority = HealthReadSynthesisRecord & {
  label?: string;
  why_it_matters?: string;
  the_move?: string;
  recheck?: string;
};
type HealthReadSynthesisPayload = HealthReadSynthesisRecord & {
  synthesis?: (HealthReadSynthesisRecord & {
    headline?: string;
    story?: string;
    priorities?: HealthReadSynthesisPriority[];
    one_change?: string;
    stale_note?: string;
    generated_at?: string;
    stale?: unknown;
  }) | null;
  focus?: HealthReadSynthesisRecord & { priorities?: unknown[] };
  stale?: unknown;
};

(() => {
  function synthesisRecord(value: unknown): HealthReadSynthesisRecord {
    return value && typeof value === "object" ? (value as HealthReadSynthesisRecord) : {};
  }

  function synthesisRows<T extends HealthReadSynthesisRecord = HealthReadSynthesisRecord>(value: unknown): T[] {
    return Array.isArray(value) ? (value.filter((row) => !!row && typeof row === "object") as T[]) : [];
  }

  function select<T extends Element = Element>(deps: ClientHealthReadControllerDeps, selector: string): T | null {
    return deps.root.querySelector<T>(selector) || deps.select<T>(selector);
  }

  function render(data: unknown, deps: ClientHealthReadControllerDeps, token?: number | null): void {
    const wrap = select<HTMLElement>(deps, "#hSynthesis");
    if (!wrap || !wrap.isConnected || (token != null && token !== deps.pollToken())) return;
    const payload = synthesisRecord(data) as HealthReadSynthesisPayload;
    const s = payload.synthesis && typeof payload.synthesis === "object" ? payload.synthesis : null;
    const focus = synthesisRecord(payload.focus);
    const hasFocus = Array.isArray(focus.priorities) && focus.priorities.length;
    if (!s && !hasFocus) {
      wrap.innerHTML = "";
      return;
    }
    const stale = payload.stale ?? (s && s.stale) ?? false;
    const prios = s && Array.isArray(s.priorities)
      ? synthesisRows<HealthReadSynthesisPriority>(s.priorities).filter((p) => p.label || p.the_move)
      : [];
    let body: string;
    if (s && s.headline) {
      body = `
      <h3 class="hsyn-headline">${deps.escapeHtml(s.headline)}</h3>
      ${s.story ? `<p class="hsyn-story">${deps.escapeHtml(s.story)}</p>` : ""}
      ${stale && s.stale_note ? `<div class="hsyn-onechange well-accent-sm"><span class="lbl">Updated picture</span><span>${deps.escapeHtml(s.stale_note)}</span></div>` : ""}
      ${prios.length ? `<div class="hsyn-prios">${prios.map((p) => `
        <div class="hsyn-prio">
          <div class="hsyn-ptop">
            <span class="hsyn-plabel">${deps.escapeHtml(p.label || "")}</span>
            <button class="linkbtn linkbtn-plain linkbtn-sm hsyn-ask" type="button" data-ask="${deps.escapeAttr(prioQuestion(p))}" aria-label="Ask the coach about ${deps.escapeAttr(p.label || "this")}">Ask<span aria-hidden="true"> →</span></button>
          </div>
          ${p.why_it_matters ? `<p class="hsyn-pwhy">${deps.escapeHtml(p.why_it_matters)}</p>` : ""}
          ${p.the_move ? `<div class="hsyn-pmove"><span class="hsyn-pmove-k lbl">Do</span> ${deps.escapeHtml(p.the_move)}</div>` : ""}
          ${p.recheck ? `<div class="hsyn-precheck"><span class="hsyn-precheck-k lbl">Recheck</span>${deps.escapeHtml(p.recheck)}</div>` : ""}
        </div>`).join("")}</div>` : ""}
      ${s.one_change ? `<div class="hsyn-onechange well-accent-sm"><span class="lbl">If you change one thing</span><span>${deps.escapeHtml(s.one_change)}</span></div>` : ""}
      <div class="hsyn-foot">
        <button class="linkbtn linkbtn-plain linkbtn-sm hsyn-askall" type="button" data-ask="${deps.escapeAttr(WHOLE_PICTURE_Q)}">Ask about my whole picture<span aria-hidden="true"> →</span></button>
        <span class="hsyn-foot-r">
          <span class="lbl">${s.generated_at ? `read ${deps.escapeHtml(deps.relTime(s.generated_at))}` : ""}</span>${stale
          ? `<button id="hsynRefresh" class="hpic-refresh hpic-refresh-stale" type="button" title="New results since this read"><span class="hdot hdot-warn"></span>New results — refresh</button>`
          : `<button class="linkbtn" id="hsynRefresh" type="button">refresh</button>`}
        </span>
      </div>`;
    } else {
      body = `
      <p class="hsyn-invite">Your labs, training, recovery and nutrition — read as one connected, prioritized picture.</p>
      <button class="draftbtn hsyn-gen" id="hsynGen" type="button">Read my whole picture</button>`;
    }
    wrap.innerHTML = `<div class="hsyn reveal"><div class="hsyn-kicker lbl">Your health — one picture</div>${body}</div>`;
    select(deps, "#hsynRefresh")?.addEventListener("click", () => trigger(deps));
    select(deps, "#hsynGen")?.addEventListener("click", () => trigger(deps));
    wrap.querySelectorAll<HTMLElement>(".hsyn-ask, .hsyn-askall").forEach((button) =>
      button.addEventListener("click", () => CairnHealthClient.askCoach(button.getAttribute("data-ask"))));
  }

  const WHOLE_PICTURE_Q = "Walk me through my whole health picture — what matters most right now, and the single most effective thing I can do about it?";

  // A grounded, ready-to-send question about ONE priority for the ask deep-link.
  function prioQuestion(p: HealthReadSynthesisPriority): string {
    const label = String(p.label || "this").replace(/\s+/g, " ").trim();
    const why = String(p.why_it_matters || "").replace(/\s+/g, " ").trim();
    return `Tell me more about ${label} in my health picture.${why ? ` (${why})` : ""} What's the most effective thing I can do about it?`;
  }

  function load(deps: ClientHealthReadControllerDeps, token: number): void {
    const wrap = select<HTMLElement>(deps, "#hSynthesis");
    if (!wrap || !wrap.isConnected) return;
    deps.api("/health/synthesis")
      .then((data) => render(data || {}, deps, token))
      .catch(() => { /* leave quiet */ });
  }

  function trigger(deps: ClientHealthReadControllerDeps): void {
    const wrap = select<HTMLElement>(deps, "#hSynthesis");
    if (!wrap) return;
    const card = wrap.querySelector(".hsyn");
    if (card && !card.querySelector(".job-cap")) {
      const cap = document.createElement("div");
      cap.className = "job-cap lbl hsyn-cap";
      card.appendChild(cap);
    }
    void deps.runOp("health_synthesis", {}, {
      path: "/health/synthesis",
      anchor: "#hSynthesis .hsyn",
      caption: "health_synthesis",
      stream: true,
      guard: () => !select(deps, "#hSynthesis")?.isConnected,
      render: (result) => {
        const payload = synthesisRecord(result) as HealthReadSynthesisPayload;
        if (payload.synthesis) render(payload, deps, deps.pollToken());
        else load(deps, deps.pollToken());
        deps.swrInvalidate("plan:coach");
      },
      onFail: () => {
        deps.toast("Couldn't read the picture right now — try again in a bit.");
        load(deps, deps.pollToken());
      },
    });
  }

  const CAIRN_HEALTH_READ_SYNTHESIS = {
    load,
    render,
    trigger,
  };

  Object.assign(globalThis, { CairnHealthReadSynthesis: CAIRN_HEALTH_READ_SYNTHESIS });

  if (typeof window !== "undefined") {
    window.CairnHealthReadSynthesis = CAIRN_HEALTH_READ_SYNTHESIS;
  }
})();
