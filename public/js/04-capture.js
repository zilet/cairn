// ==== 04-capture.js ====
// ====================================================================
// Connected-brain provenance — make the product's deepest differentiator
// FELT at the point of consumption. When a flagged lab marker shaped a meal
// plan or the day's training (via a cross-domain directive), surface ONE quiet
// causal line right where the consequence lands ("tilted toward fish — ApoB
// came back high · why"), deep-linking to Me → Health → Brain. Informational,
// never a verdict; soft/uncertain directives read tentative.
// ====================================================================

// Active directives for a domain, newest-first. Short-lived in-memory cache so the
// Brief + Meals don't double-fetch within one render pass. Always degrades to [].
let _provCache = null;
async function activeDirectives() {
  if (_provCache && Date.now() - _provCache.at < 4000) return _provCache.rows;
  let rows = [];
  try {
    const res = await api("/directives");
    rows = (res && Array.isArray(res.directives) ? res.directives : []).filter((d) => !d.status || d.status === "active");
  } catch { rows = []; }
  _provCache = { at: Date.now(), rows };
  return rows;
}

// Build the quiet causal line for one directive. The "consequence" half comes from
// the directive text (already plain-language); the "because" half is the marker.
// Returns {html} or null when there's nothing worth saying.
function provenanceLineHtml(d, label) {
  if (!d) return null;
  const consequence = String(d.directive || "").trim();
  if (!consequence) return null;
  const soft = d.uncertain && !d.citation;
  const because = d.marker ? `<span class="prov-marker">${escHtml(String(d.marker))}</span>` : "";
  const lead = soft ? `<span class="prov-soft">Worth looking into · </span>` : "";
  // The whole line is the deep-link to Me → Health → Brain (where the directive lives).
  return `<button class="prov-line" data-prov aria-label="${escAttr(label + ": " + consequence)}">
      <span class="prov-glyph" aria-hidden="true">✦</span>
      <span class="prov-text">${lead}${escHtml(consequence)}${because ? ` — ${because}` : ""}</span>
      <span class="prov-why" aria-hidden="true">why</span>
    </button>`;
}

// Wire any rendered provenance line to deep-link into Me → Health → Brain.
function wireProvenance(scope) {
  (scope || view).querySelectorAll("[data-prov]").forEach((b) => b.addEventListener("click", () => {
    state.meSeg = "health";
    state.healthSeg = "brain"; // the directives live in the Brain view
    activateTab("me");
  }));
}

// Today's Brief: the training/watch directive shaping the day, rendered under the why.
async function loadTrainingProvenance(_isToday) {
  const slot = view.querySelector("#briefProvenance");
  if (!slot) return;
  const rows = await activeDirectives();
  if (state.tab !== "today" || !slot.isConnected) return;
  // training first (it's what shapes the session), then a watch item. Skip STALE acute
  // findings (e.g. a 2-week-old hs-CRP) — they no longer represent today, so they must
  // not pose as the line shaping the session (the server flags them `stale`).
  const d = rows.find((x) => (x.domain || "watch") === "training" && !x.stale)
    || rows.find((x) => (x.domain || "watch") === "watch" && !x.stale);
  const html = provenanceLineHtml(d, "Training shaped by your labs");
  if (!html) { slot.innerHTML = ""; return; }
  slot.innerHTML = html;
  wireProvenance(slot);
}

// Meals: the nutrition directive that tilted the plan, rendered under the hero.
async function loadMealProvenance() {
  const slot = view.querySelector("#mealProvenance");
  if (!slot) return;
  const rows = await activeDirectives();
  if (state.tab !== "plan" || !slot.isConnected) return;
  const d = rows.find((x) => (x.domain || "watch") === "nutrition" && !x.stale);
  const html = provenanceLineHtml(d, "Meals shaped by your labs");
  if (!html) { slot.innerHTML = ""; return; }
  slot.innerHTML = html;
  wireProvenance(slot);
}

async function quickLog() {
  const inp = document.querySelector("#qlInput");
  const text = inp.value.trim();
  if (!text) return;
  inp.value = "";
  const wrap = view.querySelector("#qlRecent");
  let a;
  try {
    a = await api("/activities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (_e) { toast("Couldn't log that — check your connection."); return; }
  if (a && a.error) { toast("Couldn't log that — try again."); return; }
  toast("Logged");

  // Instant feedback: show the regex result at the top of Lately right away. The
  // full rebuild (reshapeToday → loadRecentActivities) normalizes it into a feed
  // row a beat later; this just avoids an empty gap between submit and that rebuild.
  if (wrap) {
    let head = wrap.querySelector(".lately-h");
    if (!head) {
      wrap.insertAdjacentHTML("afterbegin", `<div class="lately-h"><span class="ql-recent-h lbl">Lately</span></div>`);
      head = wrap.querySelector(".lately-h");
    }
    head.insertAdjacentHTML("afterend", actEntryHtml(a));
  }

  // A logged activity is movement — refresh the Brief so it reflects the day. This
  // re-renders Today once the recomputed (agentic) read is ready; the entry above
  // persists (rebuilt from server state). reshapeToday bumps pollToken, retiring any
  // prior poll, so resume enrichment polling against the fresh DOM afterward.
  await reshapeToday();
  if (state.tab === "today" && a && a.id && enrichmentActive(a.enrichment_status)) {
    const tab = state.tab, token = pollToken;
    pollEnrichment("/activities", a.id, {
      tab, token,
      onUpdate: (row) => {
        const el = view.querySelector(`.qlent[data-actid="${row.id}"]`);
        if (el) updateActEntry(el, row);
      },
    });
  }
}

function setupWeightChip() {
  const chip = view.querySelector("#wtChip");          // compass tile (in the week fold)
  const mini = view.querySelector("#wtChipMini");      // always-on capture-row chip
  const inline = view.querySelector("#wtInline");
  const input = view.querySelector("#wtInlineInput");
  const go = view.querySelector("#wtInlineGo");
  if (!inline || !input) return;
  const toggle = () => {
    inline.hidden = !inline.hidden;
    if (!inline.hidden) { input.focus(); input.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "nearest" }); }
  };
  if (chip) chip.addEventListener("click", toggle);
  if (mini) mini.addEventListener("click", toggle);
  const save = async () => {
    const w = +input.value;
    if (!w) { input.focus(); return; }
    try {
      await api("/bodyweight", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ weight_lb: w }) });
    } catch { toast("Couldn't save your weight — try again."); return; }
    // a weigh-in syncs profile.weight_lb and moves the weight trend / pace — drop the
    // caches that read it so Today's compass + the Weight/Energy views stay honest.
    swrInvalidate("progress:weight");
    swrInvalidate("stats");
    swrInvalidate("profile");
    swrInvalidate("progress:energy");
    const valEl = chip && chip.querySelector("[data-wtval]");
    if (valEl) valEl.innerHTML = `${w}<span class="stat-plus">+</span>`;
    if (mini) mini.innerHTML = `${w}<span class="wt-mini-unit">lb</span><span class="stat-plus">+</span>`;
    input.value = ""; inline.hidden = true;
    toast("Weight logged");
  };
  if (go) go.addEventListener("click", save);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
}

// ---------- effortless capture: voice (Web Speech), frequents, check-in ----------
// Inline mic glyph — static SVG, no caller text, safe for innerHTML.
const MIC_GLYPH = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="9" y1="21" x2="15" y2="21"/></svg>`;

// Feature-detect once. Absent (e.g. Firefox/older Safari) → the mic stays hidden.
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition || null;
let _voiceRec = null; // live recognition instance while listening

// Press-to-talk dictation into #qlInput. The transcript (interim + final) flows
// through the SAME quicklog routing as typed text — say "ran 50 easy" and it
// logs exactly like typing it. Degrades to text-only where speech is absent.
function setupVoiceCapture() {
  const mic = view.querySelector("#qlMic");
  const inp = view.querySelector("#qlInput");
  if (!mic || !inp) return;
  if (!SpeechRec) { mic.hidden = true; return; } // no API → no broken control
  mic.hidden = false;

  const stop = () => {
    if (_voiceRec) { try { _voiceRec.stop(); } catch {} _voiceRec = null; }
    mic.classList.remove("qlmic-live");
  };

  mic.addEventListener("click", () => {
    if (_voiceRec) { stop(); return; }          // tap again to stop early
    let rec;
    try { rec = new SpeechRec(); } catch { mic.hidden = true; return; }
    rec.lang = navigator.language || "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    // remember what was already typed so dictation appends, never clobbers
    const base = inp.value.trim();
    let finalText = "";
    let heard = false; // only auto-log when speech was actually captured
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t;
        else interim += t;
      }
      const said = (finalText + interim).trim();
      if (said) heard = true;
      inp.value = (base ? base + " " : "") + said;
    };
    rec.onerror = (e) => {
      // permission denial / no-speech / network — all handled quietly, no toast spam
      if (e && (e.error === "not-allowed" || e.error === "service-not-allowed")) {
        mic.hidden = true; // user said no; don't keep offering a control that won't work
      }
      heard = false; // an error means nothing usable was dictated
      stop();
    };
    rec.onend = () => {
      mic.classList.remove("qlmic-live");
      _voiceRec = null;
      // a finished phrase logs through the normal path, just like Enter
      if (heard && inp.value.trim()) quickLog();
    };
    _voiceRec = rec;
    mic.classList.add("qlmic-live");
    try { rec.start(); } catch { stop(); }
  });
}

// hour → meal slot, used both to label the re-logged food and to query frequents
function mealForHour(h) {
  if (h < 11) return "breakfast";
  if (h < 15) return "lunch";
  if (h < 18) return "snack";
  return "dinner";
}

// One-tap re-log of the foods most often eaten near this time of day. The chip
// POSTs the summary to /food-notes; enrichment polling then upgrades it in place.
// Quiet by default: nothing renders if there are no frequents.
async function loadFrequentFoods() {
  const wrap = view.querySelector("#freqFoods");
  if (!wrap) return;
  const hour = new Date().getHours();
  let foods = [];
  try { foods = await api("/frequent-foods?hour=" + hour); } catch { foods = []; }
  if (state.tab !== "today" || !wrap.isConnected) return;
  if (!Array.isArray(foods) || !foods.length) { wrap.innerHTML = ""; return; }
  const chips = foods.slice(0, 6).map((f) => {
    const summary = String(f.summary || "").trim();
    if (!summary) return "";
    const kcal = f.kcal != null ? `<span class="freq-chip-kcal">${Math.round(Number(f.kcal))}</span>` : "";
    return `<button class="freq-chip" data-freq="${escAttr(summary)}">
        <span class="freq-chip-art">${art("food", summary)}</span>
        <span class="freq-chip-name">${escHtml(summary)}</span>${kcal}
      </button>`;
  }).join("");
  if (!chips) { wrap.innerHTML = ""; return; }
  wrap.innerHTML = `<div class="freq-head lbl">Usual around now</div>
    <div class="freq-chips">${chips}</div>`;
  wrap.querySelectorAll("[data-freq]").forEach((b) =>
    b.addEventListener("click", () => relogFrequent(b.dataset.freq, b)));
}

let _relogInFlight = false;
async function relogFrequent(summary, chip) {
  if (_relogInFlight || !summary) return;
  _relogInFlight = true;
  if (chip) chip.classList.add("freq-chip-busy");
  const meal = mealForHour(new Date().getHours());
  let f = null;
  try {
    f = await api("/food-notes", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meal, text: summary }),
    });
  } catch { f = null; }
  _relogInFlight = false;
  if (chip) chip.classList.remove("freq-chip-busy");
  if (!f || f.error) { toast("Couldn't log that — try again."); return; }
  toast("Logged · " + meal);
  // poll the enrichment upgrade quietly (no visible row on Today; the meal lives in Plan → Food)
  if (f.id && enrichmentActive(f.enrichment_status)) {
    pollEnrichment("/food-notes", f.id, { tab: state.tab, token: pollToken });
  }
}

// ---------- optional how-you-feel (offered, never required) ----------
// A subtle, dismissible 1–5 mood/energy tap. If a check-in already exists for
// today it shows as a calm "noted" line; otherwise a small "how are you feeling?"
// affordance that expands on tap. Feeds the Brief's day-read; never nags.
async function loadCheckin() {
  const slot = view.querySelector("#checkinSlot");
  if (!slot) return;
  let existing = null;
  try { existing = await api("/checkins?date=" + localISO()); } catch { existing = null; }
  if (state.tab !== "today" || !slot.isConnected) return;
  if (existing && (existing.mood != null || existing.energy != null)) {
    renderCheckinDone(slot, existing);
    return;
  }
  // collapsed by default — one quiet line, opt-in
  slot.innerHTML = `<button class="checkin-open" id="checkinOpen" type="button">
      <span class="checkin-open-dot" aria-hidden="true"></span>
      how are you feeling?
    </button>`;
  const open = slot.querySelector("#checkinOpen");
  if (open) open.addEventListener("click", () => renderCheckinForm(slot));
}

const FEEL_FACES = ["·", "◦", "○", "◍", "●"]; // 1→5, quiet glyphs, no emoji
function feelScale(kind, label) {
  const dots = FEEL_FACES.map((g, i) =>
    `<button class="feel-dot" data-feel="${kind}" data-val="${i + 1}" aria-label="${escAttr(label + " " + (i + 1))}">${g}</button>`
  ).join("");
  return `<div class="feel-row"><span class="feel-lbl lbl">${escHtml(label)}</span><div class="feel-dots">${dots}</div></div>`;
}

function renderCheckinForm(slot) {
  slot.innerHTML = `<div class="checkin-form chip-in">
      ${feelScale("mood", "mood")}
      ${feelScale("energy", "energy")}
      <button class="checkin-dismiss" id="checkinDismiss" type="button" aria-label="Not now">✕</button>
    </div>`;
  const picked = {};
  slot.querySelectorAll(".feel-dot").forEach((b) =>
    b.addEventListener("click", async () => {
      const kind = b.dataset.feel, val = Number(b.dataset.val);
      picked[kind] = val;
      // highlight selected + everything below it (a 1–5 scale fill)
      slot.querySelectorAll(`.feel-dot[data-feel="${kind}"]`).forEach((d) =>
        d.classList.toggle("feel-dot-on", Number(d.dataset.val) <= val));
      try {
        const saved = await api("/checkins", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mood: picked.mood, energy: picked.energy }),
        });
        if (saved && !saved.error) {
          renderCheckinDone(slot, saved);
          toast("Noted");
          reshapeToday(); // a fresh check-in can shift today's read — reflect it now
        }
      } catch { /* silent — it's optional */ }
    }));
  const dismiss = slot.querySelector("#checkinDismiss");
  if (dismiss) dismiss.addEventListener("click", () => { slot.innerHTML = ""; });
}

function renderCheckinDone(slot, c) {
  const parts = [];
  if (c.mood != null) parts.push(`mood ${Number(c.mood)}/5`);
  if (c.energy != null) parts.push(`energy ${Number(c.energy)}/5`);
  if (!parts.length) { slot.innerHTML = ""; return; }
  slot.innerHTML = `<div class="checkin-done chip-in"><span class="checkin-done-mark" aria-hidden="true">✓</span> ${escHtml(parts.join(" · "))}</div>`;
}

// ---------- quiet Today reads (pull, never push) ----------
// One fetch of GET /api/insights, split into two calm surfaces under the Brief:
//   • the WEEKLY READ ("how the week went + the one change") → its own editorial
//     card (#weeklySlot), so it's never buried by a newer connection;
//   • the one-at-a-time CONNECTION insight → the smaller aside below (#insightSlot).
// Each marks itself seen on view; thumbs up/down record feedback. Empty → nothing
// (no nag); a conservative gated producer fills each surface in the background.
async function loadTodayReads() {
  const wSlot = view.querySelector("#weeklySlot");
  const iSlot = view.querySelector("#insightSlot");
  if (!wSlot && !iSlot) return;
  let list = [];
  try { list = await api("/insights"); } catch { list = []; }
  if (state.tab !== "today") return;
  const arr = Array.isArray(list) ? list : [];
  // Weekly read — the latest one, on its own card. Pull-only: surface what the
  // scheduler (or demo seed) wrote; on an empty week, a weekend-gated fallback asks.
  if (wSlot && wSlot.isConnected) {
    const weekly = arr.find((i) => i && i.kind === "weekly_read");
    if (weekly) renderWeeklyInSlot(wSlot, weekly);
    else { wSlot.innerHTML = ""; maybeGenerateWeekly(); }
  }
  // Connection insight — the latest NON-weekly read, so the two surfaces never
  // collide in one slot. Same ~20h-gated background producer as before.
  if (iSlot && iSlot.isConnected) {
    const conn = arr.find((i) => i && i.kind !== "weekly_read");
    if (conn) renderInsightInSlot(iSlot, conn);
    else { iSlot.innerHTML = ""; maybeGenerateInsight(); }
  }
}

// Render an insight card into a slot + mark it seen (fire-and-forget, only when
// still new). Shared by the existing-insight path and the background generator's
// render callback so the card looks identical either way.
function renderInsightInSlot(slot, ins) {
  if (!slot || !ins) return;
  renderInsightCard(slot, ins);
  if (ins.status === "new") {
    api(`/insights/${ins.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "seen" }),
    }).catch(() => {});
  }
}

// Opportunistic, gated insight generation — the pull-based producer for the Brief
// insight card. At most ~once per 20h: the agent "looking" (a real RESULT, ok:true
// or ok:false) burns the gate; a transport failure (the POST itself never landing)
// does NOT, so a transient drop retries on the next open. Runs as a durable
// background job (runOp), fully non-blocking — the card settles in when an insight
// lands and stays quiet otherwise. Never a push.
function maybeGenerateInsight() {
  const slot = view.querySelector("#insightSlot");
  if (!slot) return;
  const last = Number(localStorage.getItem("cairn:lastInsightGen") || 0);
  if (Date.now() - last < 20 * 3600 * 1000) return;
  // Don't paint a loading state — an empty insight slot stays silent until (and
  // unless) a genuine connection lands. The job streams in the background only.
  const burnGate = () => { try { localStorage.setItem("cairn:lastInsightGen", String(Date.now())); } catch {} };
  runOp("insight", {}, {
    path: "/insights/generate",
    anchor: "#insightSlot",
    // The slot leaving the DOM (tab switch / re-render) drops the stream; the job
    // keeps running server-side and re-attaches via jobReconnect.
    guard: () => !view.querySelector("#insightSlot")?.isConnected,
    isFail: (r) => !r || r.ok === false || !r.insight,
    render: (r) => {
      burnGate(); // a genuine connection landed — the agent looked
      if (state.tab !== "today") return;
      const s = view.querySelector("#insightSlot");
      if (s) renderInsightInSlot(s, r.insight);
    },
    onFail: (err) => {
      // A RESULT-shaped failure (ok:false / no insight) still means the agent looked
      // → burn the gate. A null err is a transport drop → leave the gate so it
      // retries next open. The slot stays silent either way (never a nag).
      if (err) burnGate();
    },
  });
}

// Reconnector: an insight job running across a reload re-attaches and settles its
// card into #insightSlot when it lands. Stays silent on no-connection / failure —
// the insight surface is quiet by default. No loading state to rebuild (the slot
// shows nothing while generating).
function reconnectInsight() {
  if (state.tab !== "today") return null; // not on Today — a later renderToday() retries
  const slot = view.querySelector("#insightSlot");
  if (!slot) return null;
  const burnGate = () => { try { localStorage.setItem("cairn:lastInsightGen", String(Date.now())); } catch {} };
  const isFail = (r) => !r || r.ok === false || !r.insight;
  return {
    guard: () => !view.querySelector("#insightSlot")?.isConnected,
    onDone: (r) => {
      if (isFail(r)) { burnGate(); return; }
      burnGate();
      if (state.tab !== "today") return;
      const s = view.querySelector("#insightSlot");
      if (s) renderInsightInSlot(s, r.insight);
    },
    onError: () => {},
    onCanceled: () => {},
  };
}

// The card leads with the headline (the one thing to read), renders an optional
// concrete suggestion as its own scannable line, and tucks the reasoning behind a
// quiet "why this" disclosure — same calm idiom as the Brief's "tap to see why",
// so the card is a glance with depth on demand, never a wall of text on open.
function renderInsightCard(slot, ins) {
  const text = escHtml(String(ins.text || ""));
  const step = String(ins.next_step || "").trim();
  const why = String(ins.rationale || "").trim();
  const kicker = ins.kind === "weekly_read" ? "This week" : "A connection worth noting";
  // Honest uncertainty — a low-confidence / explicitly-tentative read reads soft and
  // leads with the same "Worth looking into ·" phrasing as a soft directive, so
  // tentativeness is consistent across every surface (degrades to nothing today —
  // the insight schema has no such field yet, so this is forward-safe).
  const soft = ins.uncertain === true || ins.confidence === "low";
  const lead = soft ? `<span class="insight-soft">Worth looking into · </span>` : "";
  slot.innerHTML = `<section class="insight-card settle-in${soft ? " insight-card-soft" : ""}">
      <div class="insight-kicker lbl"><span class="insight-glyph" aria-hidden="true">✦</span> ${kicker}</div>
      <p class="insight-text">${lead}${text}</p>
      ${step ? `<p class="insight-step"><span class="insight-step-lbl">Worth trying</span>${escHtml(step)}</p>` : ""}
      ${why ? `<p class="insight-why" hidden>${escHtml(why)}</p>` : ""}
      <div class="insight-foot">
        <div class="insight-acts">
          <button class="insight-act insight-act-go" data-ifb="up">Got it</button>
          <button class="insight-act" data-ifb="down">Not useful</button>
        </div>
        ${why ? `<button class="insight-why-more" data-iwhy aria-expanded="false">why this</button>` : ""}
      </div>
    </section>`;
  slot.querySelectorAll("[data-ifb]").forEach((b) =>
    b.addEventListener("click", () => insightFeedback(slot, ins, b.dataset.ifb)));
  const whyBtn = slot.querySelector("[data-iwhy]");
  const whyEl = slot.querySelector(".insight-why");
  if (whyBtn && whyEl) {
    whyBtn.addEventListener("click", () => {
      const opening = whyEl.hidden;
      whyEl.hidden = !opening;
      if (opening) { whyEl.classList.remove("chip-in"); void whyEl.offsetWidth; whyEl.classList.add("chip-in"); }
      whyBtn.setAttribute("aria-expanded", String(opening));
      whyBtn.textContent = opening ? "hide" : "why this";
    });
  }
}

// Shared by the connection insight and the weekly read (both PUT /api/insights/:id).
// cardSel is the card element to collapse on dismiss — ".insight-card" by default,
// ".weekly-card" for the weekly read.
async function insightFeedback(slot, ins, dir, cardSel = ".insight-card") {
  // Both actions CLEAR the card — these are momentary surfacings, not a to-do
  // list, so the positive path needs a graceful exit too (the old up-thumb just
  // lingered with no way to resolve it). "Got it" records the up-vote AND
  // dismisses in one PUT (the server writes the text to memory so the brain learns
  // this kind of connection lands); "Not useful" dismisses with no positive signal.
  const card = slot.querySelector(cardSel);
  const body = dir === "up"
    ? { feedback: "up", status: "dismissed" }
    : { status: "dismissed" };
  api(`/insights/${ins.id}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
  if (dir === "up") toast("Noted — I'll remember");
  if (card) collapseEl(card, () => { slot.innerHTML = ""; });
  else slot.innerHTML = "";
}

// ---------- the weekly read (E3): a calm Sunday card, not a buried insight ----------
// "How the week went + the one change." Distinct from the connection insight: a
// sage-mastheaded editorial card whose keystone is the single "One change" — the
// whole point of a weekly read. Pull-never-push; surfaces only when one is waiting.

// "Jun 9–15" — the Monday→Sunday week containing the read's date. Empty when
// the date is missing/unparseable (then the masthead shows just "The week").
function weekRangeLabel(iso) {
  const s = String(iso || "").slice(0, 10);
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return "";
  const date = new Date(y, m - 1, d);
  if (isNaN(date.getTime())) return "";
  const dow = (date.getDay() + 6) % 7; // 0 = Monday
  const mon = new Date(date); mon.setDate(date.getDate() - dow);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  const long = (dt) => dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return mon.getMonth() === sun.getMonth()
    ? `${mon.toLocaleDateString(undefined, { month: "short" })} ${mon.getDate()}–${sun.getDate()}`
    : `${long(mon)} – ${long(sun)}`;
}

// Render the weekly card + mark it seen (fire-and-forget, only when still new).
function renderWeeklyInSlot(slot, ins) {
  if (!slot || !ins) return;
  renderWeeklyCard(slot, ins);
  if (ins.status === "new") {
    api(`/insights/${ins.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "seen" }),
    }).catch(() => {});
  }
}

function renderWeeklyCard(slot, ins) {
  const text = escHtml(String(ins.text || ""));
  const change = String(ins.next_step || "").trim();
  const why = String(ins.rationale || "").trim();
  const range = weekRangeLabel(ins.created_at);
  slot.innerHTML = `<section class="weekly-card settle-in">
      <div class="weekly-head">
        <span class="weekly-kicker lbl">The week</span>
        ${range ? `<span class="weekly-range">${escHtml(range)}</span>` : ""}
      </div>
      <p class="weekly-text">${text}</p>
      ${change ? `<div class="weekly-change">
          <span class="weekly-change-lbl lbl">One change</span>
          <p class="weekly-change-text">${escHtml(change)}</p>
        </div>` : ""}
      ${why ? `<p class="weekly-why" hidden>${escHtml(why)}</p>` : ""}
      <div class="weekly-foot">
        <div class="insight-acts">
          <button class="insight-act insight-act-go" data-ifb="up">Got it</button>
          <button class="insight-act" data-ifb="down">Not useful</button>
        </div>
        ${why ? `<button class="insight-why-more" data-iwhy aria-expanded="false">why this</button>` : ""}
      </div>
    </section>`;
  slot.querySelectorAll("[data-ifb]").forEach((b) =>
    b.addEventListener("click", () => insightFeedback(slot, ins, b.dataset.ifb, ".weekly-card")));
  const whyBtn = slot.querySelector("[data-iwhy]");
  const whyEl = slot.querySelector(".weekly-why");
  if (whyBtn && whyEl) {
    whyBtn.addEventListener("click", () => {
      const opening = whyEl.hidden;
      whyEl.hidden = !opening;
      if (opening) { whyEl.classList.remove("chip-in"); void whyEl.offsetWidth; whyEl.classList.add("chip-in"); }
      whyBtn.setAttribute("aria-expanded", String(opening));
      whyBtn.textContent = opening ? "hide" : "why this";
    });
  }
}

// Fallback producer for the weekly card: the scheduler precomputes the weekly read
// on real installs, but when none is waiting we ask the agent ONCE — gated to the
// back half of the week (Fri–Sun, an end-of-week reflection) and at most once per
// ~6 days, so it never fires mid-week or repeatedly. Fully background + non-blocking
// (a durable job), and pull-never-push: the card settles in if a read lands, stays
// silent otherwise. Never a notification.
function maybeGenerateWeekly() {
  const slot = view.querySelector("#weeklySlot");
  if (!slot) return;
  const dow = new Date().getDay(); // 0 Sun … 6 Sat
  if (!(dow === 0 || dow === 5 || dow === 6)) return; // weekend reflection only
  const last = Number(localStorage.getItem("cairn:lastWeeklyGen") || 0);
  if (Date.now() - last < 6 * 24 * 3600 * 1000) return;
  const burnGate = () => { try { localStorage.setItem("cairn:lastWeeklyGen", String(Date.now())); } catch {} };
  runOp("weekly_read", { kind: "weekly_read" }, {
    path: "/insights/generate",
    anchor: "#weeklySlot",
    guard: () => !view.querySelector("#weeklySlot")?.isConnected,
    isFail: (r) => !r || r.ok === false || !r.insight,
    render: (r) => {
      burnGate(); // a genuine weekly read landed — the agent looked
      if (state.tab !== "today") return;
      const s = view.querySelector("#weeklySlot");
      if (s) renderWeeklyInSlot(s, r.insight);
    },
    onFail: (err) => { if (err) burnGate(); },
  });
}
