// @ts-check
// Shared UI feedback/loading primitives for the vanilla PWA.

type UiFeedbackCountOptions = { dur?: number; fmt?: (value: number) => string };
type UiFeedbackSnapOptions = { snap?: boolean };

// Staggered entrance delay for `.reveal` cards; index capped so long lists do not crawl in.
function stagger(i?: number | null): string {
  return `--i:${Math.min(i ?? 0, 12)}`;
}

function reducedMotion(): boolean {
  return "matchMedia" in window && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Put a button into a calm "working" state for the length of an agentic call.
function btnBusy(
  btn: Element | null | undefined,
  label?: unknown,
  { ghost = false }: { ghost?: boolean } = {},
): () => void {
  if (!btn) return () => {};
  const busyBtn = btn as BusyButton;
  const button = btn as HTMLButtonElement;
  if (busyBtn._busyRestore) return busyBtn._busyRestore;
  const html = button.innerHTML;
  const wasDisabled = button.disabled;
  const minW = button.style.minWidth;
  const text = label != null ? label : (button.textContent || "").trim();
  button.style.minWidth = button.offsetWidth + "px";
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.classList.add("btn-busy");
  button.innerHTML = `<span class="btn-working"><span class="aspin aspin-sm${ghost ? " aspin-ghost" : ""}"></span>${escHtml(text)}</span>`;
  const restore = () => {
    if (busyBtn._busyRestore !== restore) return;
    busyBtn._busyRestore = null;
    button.innerHTML = html;
    button.disabled = wasDisabled;
    button.removeAttribute("aria-busy");
    button.classList.remove("btn-busy");
    button.style.minWidth = minW;
  };
  busyBtn._busyRestore = restore;
  return restore;
}

// Count a numeral up from 0 -> target. Respects prefers-reduced-motion by snapping.
function countUp(
  el: Element | null | undefined,
  target: unknown,
  { dur = 750, fmt = (v: number) => Math.round(v).toLocaleString() }: UiFeedbackCountOptions = {},
): void {
  if (!el) return;
  const t = Number(target) || 0;
  if (reducedMotion() || !t) {
    el.textContent = fmt(t);
    return;
  }
  const t0 = performance.now();
  const tick = (now: number) => {
    const p = Math.min(1, (now - t0) / dur);
    const eased = 1 - (1 - p) ** 3;
    el.textContent = fmt(t * eased);
    if (p < 1 && el.isConnected) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function loadingState(label: unknown): string {
  return CairnUi.loadingStateHtml({ label });
}

// The ONE place a job's "what's happening" lines live, keyed by the op name a
// caller passes as `caption`. It is a REGISTRY on purpose: an op's script belongs
// with every other op's, where a new one is written next to its neighbours rather
// than inline at a call site.
//
// It used to be possible to pass the lines inline as an array instead, and four
// call sites did — evolve-program, the recovery week, and the whole-picture read
// from both of its two entry points. None of them ever rendered. thinkingCaption
// looks its lines up by `String(op)`, so an array stringified to a comma-joined
// key, missed, and fell through to the "Thinking…" fallback — silently, because a
// missing script is also what a legitimately unregistered op gets. Authored copy
// that never reached a screen, in the surface whose whole job is telling the
// athlete what their team is doing.
//
// So the array form is gone from the contract (`caption?: string`), those four
// sites are entries below, and the two health-synthesis copies — the same four
// lines, written twice — are now one. Add a script HERE and pass its key.
const THINKING_SCRIPTS: Record<string, string[]> = {
  session_suggest: ["Reading your week…", "Weighing recovery…", "Shaping today's session…", "Choosing the right load…"],
  proposal: ["Reading your training…", "Weighing your recent sessions…", "Drafting next week's targets…", "Keeping the progression honest…"],
  compose_week: ["Reading where you're starting…", "Placing the hard days apart…", "Shaping your first week…", "Keeping the first dose honest…"],
  evolve_program: ["Reading how your lifts are trending…", "Spotting what's stalled…", "Drafting how your plan should evolve…", "Checking it against your constraints…"],
  recovery_week: ["Reading the load you've accumulated…", "Halving the working volume, keeping the patterns…", "Drafting your recovery week…", "Checking it against your constraints…"],
  health_synthesis: ["Reading your labs…", "Connecting it to your training & recovery…", "Finding what matters most…", "Writing your picture…"],
  endurance_runs: ["Reading your running…", "Checking your mileage and goal…", "Shaping this week's runs…", "Keeping it aerobic and conservative…"],
  meal_plan: ["Reading your week…", "Balancing the macros…", "Plating the days…", "Checking the protein floor…"],
  meal_swap: ["Reading the meal…", "Finding a match…", "Holding the macros…", "Plating the swap…"],
  recipe: ["Opening the kitchen…", "Sourcing the ingredients…", "Writing the steps…", "Tasting as it goes…"],
  nutrition_checkin: ["Reading your intake…", "Tracing the trend…", "Weighing the drift…", "Settling on a number…"],
  day_read_override: ["Hearing you…", "Re-reading the day…", "Reshaping the brief…"],
  chat_distill: ["Looking back over the thread…", "Keeping what matters…", "Tidying the rest away…"],
  onboard: ["Hearing you out…", "Folding it into your picture…", "Noting what matters…", "Setting things up…"],
  insight: ["Connecting the dots…", "Crossing the domains…", "Listening for one real thread…"],
};

function thinkingCaption(el: Element | null | undefined, op: unknown): () => void {
  if (!el) return () => {};
  const target = el as HTMLElement;
  const lines = THINKING_SCRIPTS[String(op)] || ["Thinking…"];
  const paint = (txt: string) => {
    target.textContent = txt;
    if (!reducedMotion()) {
      target.style.animation = "none";
      void target.offsetWidth;
      target.style.animation = "";
    }
  };
  target.classList.add("typing-cap");
  paint(lines[0]);
  if (reducedMotion() || lines.length < 2) return () => {};
  let i = 0;
  const timer = setInterval(() => {
    if (!target.isConnected) {
      clearInterval(timer);
      return;
    }
    i = i + 1 >= lines.length ? Math.max(1, lines.length - 2) : i + 1;
    paint(lines[i]);
  }, 2600);
  return () => clearInterval(timer);
}

function tabErrorState(tab: unknown): void {
  view.innerHTML = `<div class="loadstate" role="alert">
    <div class="loadstate-label">Couldn't load this view — check your connection.</div>
    <button class="ghostbtn" data-tabretry style="margin-top:10px">Try again</button>
  </div>`;
  const btn = view.querySelector("[data-tabretry]");
  if (btn) btn.addEventListener("click", () => switchTab(tab));
}

function skelLines(n = 3): string {
  let s = `<div class="skel-card" aria-hidden="true"><div class="hshimmer hshimmer-lg"></div>`;
  for (let i = 0; i < n; i++) s += `<div class="hshimmer${i === n - 1 ? " hshimmer-sm" : ""}"></div>`;
  return s + `</div>`;
}

function todaySkeleton(): string {
  return `<div class="today-wrap today-skel" aria-busy="true">
    <div class="skel-brief" aria-hidden="true">
      <div class="hshimmer hshimmer-sm" style="width:34%"></div>
      <div class="hshimmer hshimmer-lg" style="width:64%;height:26px"></div>
      <div class="hshimmer"></div>
    </div>
    ${skelLines(2)}
    ${skelLines(3)}
  </div>`;
}

function segSkeleton(active: string, seg: readonly UiSegment[], cards = 2): string {
  let s = segBar(active, seg) + `<div class="skel-region" aria-busy="true">${skelLines(2)}`;
  for (let i = 0; i < cards; i++) s += skelLines(3);
  return s + `</div>`;
}

function fmtK(n: unknown): string {
  const v = Number(n) || 0;
  return v >= 10000 ? `${Math.round(v / 100) / 10}k` : Math.round(v).toLocaleString();
}

function runCountUps(scope?: ParentNode | null, { snap = false }: UiFeedbackSnapOptions = {}): void {
  (scope || view).querySelectorAll<HTMLElement>("[data-cu]").forEach((el) => {
    const fmt = el.dataset.cufmt === "k" ? fmtK : (x: number) => Math.round(x).toLocaleString();
    if (snap) {
      el.textContent = fmt(Number(el.dataset.cu) || 0);
      return;
    }
    countUp(el, Number(el.dataset.cu) || 0, { fmt });
  });
}

const CAIRN_UI_FEEDBACK = {
  stagger,
  reducedMotion,
  btnBusy,
  countUp,
  fmtK,
  runCountUps,
  loadingState,
  thinkingCaption,
  tabErrorState,
  skelLines,
  todaySkeleton,
  segSkeleton,
};

Object.assign(globalThis, {
  CairnUiFeedback: CAIRN_UI_FEEDBACK,
  stagger,
  reducedMotion,
  btnBusy,
  countUp,
  fmtK,
  runCountUps,
  loadingState,
  thinkingCaption,
  tabErrorState,
  skelLines,
  todaySkeleton,
  segSkeleton,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnUiFeedback: CAIRN_UI_FEEDBACK,
    stagger,
    reducedMotion,
    btnBusy,
    countUp,
    fmtK,
    runCountUps,
    loadingState,
    thinkingCaption,
    tabErrorState,
    skelLines,
    todaySkeleton,
    segSkeleton,
  });
}
