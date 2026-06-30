// ==== 09-plan-chat.js ====
// ---------- Plan editor (manual) ----------
// SWR over /plan (key `plan`, shared with Today — one revalidate feeds both): a
// warm re-entry paints the training editor instantly, then revalidates. A changed
// payload re-renders, but only when the user isn't mid-edit (a day flipped into the
// editor) so an in-flight edit is never clobbered by a background refresh.
async function renderPlanEditor() {
  headerTitle.textContent = "Plan";
  state.planSeg = "edit";
  const token = ++pollToken;
  const peek = peekCached("plan");
  if (!peek) view.innerHTML = segSkeleton("edit", planSeg(), 3); // cold: skeleton-first
  // Background revalidate populates the shared `plan` key for both surfaces; on a
  // changed payload re-render, but only when idle (no open day editor / unsaved
  // structural edit) so an in-flight edit is never clobbered by the refresh.
  const revalidate = cachedApi("/plan", {
    key: "plan",
    onUpgrade: (_data, { changed }) => {
      if (peek && !peek.fresh) markRefreshing(false);
      if (!changed || !peek) return; // cold load already rendered; no-op revalidate stays quiet
      if (state.tab !== "plan" || token !== pollToken || !view.querySelector("#planedit")) return; // moved on
      if (view.querySelector(".pday") || document.querySelector(".savebar.show")) return; // mid-edit — don't clobber
      renderPlanEditor();
    },
  });
  // Cold: wait on the revalidate's data (one fetch). Warm: paint from the peek now,
  // and let the background revalidate above upgrade in place.
  const plan = peek ? peek.data : await revalidate.catch(() => []);
  if (token !== pollToken || state.tab !== "plan") return;
  if (peek && !peek.fresh) markRefreshing(true);
  // Pull-not-push calendar: subscribe to the plan as a weekly iCal feed. webcal://
  // hands most OSes straight to "add to calendar"; the (.ics) link is the fallback.
  const icsUrl = withToken("/api/plan.ics");
  const calFooter = CairnPlanEditor.calendarFooterHtml(plan, location.host, icsUrl);
  view.innerHTML = segBar("edit", planSeg()) + `<div id="planedit"></div>
    <button id="addDay" class="ghostbtn" style="width:100%;text-align:center;padding:11px;margin-top:8px">+ Add day</button>
    <div id="planstatus" style="margin-top:8px;color:var(--muted);font-size:.82rem"></div>${calFooter}`;
  wireSeg(PLAN_HANDLERS);

  const model = plan.map((d) => CairnPlanEditor.dayModelFromPlan(d));
  const editing = new Set(); // day indices currently flipped into the editor

  function sync() {
    view.querySelectorAll(".pday").forEach((dayEl) => {
      const d = model[+dayEl.dataset.d]; if (!d) return;
      d.name = dayEl.querySelector(".pday-name").value;
      d.focus = dayEl.querySelector(".pday-focus").value;
    });
    view.querySelectorAll(".pitem").forEach((itEl) => {
      const d = model[+itEl.dataset.d]; const it = d && d.items[+itEl.dataset.i]; if (!it) return;
      const num = (sel) => { const el = itEl.querySelector(sel); if (!el) return null; const v = el.value; return v === "" ? null : Number(v); };
      const txt = (sel) => { const el = itEl.querySelector(sel); return el ? el.value : ""; };
      if (itEl.dataset.kind === "cardio") {
        // The cardio label rides in `note`; the exercise input doubles as the label.
        it.note = txt(".pi-ex");
        it.target_distance_km = num(".pi-km");
        it.target_duration_min = num(".pi-min");
        it.target_zone = (txt(".pi-zone") || "").trim() || null;
        it.interval_note = (txt(".pi-ivl") || "").trim();
        return;
      }
      it.exercise = txt(".pi-ex");
      it.sets = num(".pi-sets") ?? 3; it.rep_low = num(".pi-lo"); it.rep_high = num(".pi-hi"); it.target_weight = num(".pi-tw");
      it.warmup_sets = num(".pi-wu"); it.note = txt(".pi-note");
    });
  }

  function draw() {
    $("#planedit").innerHTML = model.map((d, di) => editing.has(di) ? CairnPlanEditor.pdayHtml(d, di) : CairnPlanEditor.progDayHtml(d, di)).join("");
    wireGuides($("#planedit"));

    view.querySelectorAll("[data-editday]").forEach((b) => b.addEventListener("click", () => {
      sync(); editing.add(+b.dataset.editday); draw();
    }));
    view.querySelectorAll("[data-doneday]").forEach((b) => b.addEventListener("click", () => {
      sync(); editing.delete(+b.dataset.doneday); draw();
    }));
    view.querySelectorAll("[data-delday]").forEach((b) => b.addEventListener("click", () => {
      sync();
      const del = +b.dataset.delday;
      model.splice(del, 1);
      const keep = [...editing].filter((i) => i !== del).map((i) => (i > del ? i - 1 : i));
      editing.clear(); keep.forEach((i) => editing.add(i));
      planBar.markDirty(); draw();
    }));
    view.querySelectorAll("[data-delitem]").forEach((b) => b.addEventListener("click", () => {
      sync(); const [di, ii] = b.dataset.delitem.split(":").map(Number); model[di].items.splice(ii, 1); planBar.markDirty(); draw();
    }));
    view.querySelectorAll("[data-additem]").forEach((b) => b.addEventListener("click", () => {
      sync(); model[+b.dataset.additem].items.push(CairnPlanEditor.blankStrength()); planBar.markDirty(); draw();
    }));
    view.querySelectorAll("[data-addcardio]").forEach((b) => b.addEventListener("click", () => {
      sync(); model[+b.dataset.addcardio].items.push(CairnPlanEditor.blankCardio()); planBar.markDirty(); draw();
    }));
    // Flip one item between a lift and a cardio prescription — preserves the note/label,
    // resets the kind-specific numbers (they don't translate between modalities).
    view.querySelectorAll("[data-pikind]").forEach((b) => b.addEventListener("click", () => {
      sync(); const [di, ii, kind] = b.dataset.pikind.split(":");
      const it = model[+di] && model[+di].items[+ii]; if (!it) return;
      if (it.kind === kind) return; // already this kind
      const label = it.kind === "cardio" ? (it.note || "") : (it.exercise || "");
      const next = kind === "cardio" ? CairnPlanEditor.blankCardio() : CairnPlanEditor.blankStrength();
      if (kind === "cardio") next.note = label; else next.exercise = label;
      model[+di].items[+ii] = next; planBar.markDirty(); draw();
    }));
    view.querySelectorAll("[data-upitem]").forEach((b) => b.addEventListener("click", () => {
      sync(); const [di, ii] = b.dataset.upitem.split(":").map(Number);
      const items = model[di].items;
      if (ii > 0) { [items[ii - 1], items[ii]] = [items[ii], items[ii - 1]]; planBar.markDirty(); draw(); }
    }));
    view.querySelectorAll("[data-downitem]").forEach((b) => b.addEventListener("click", () => {
      sync(); const [di, ii] = b.dataset.downitem.split(":").map(Number);
      const items = model[di].items;
      if (ii < items.length - 1) { [items[ii + 1], items[ii]] = [items[ii], items[ii + 1]]; planBar.markDirty(); draw(); }
    }));
  }

  $("#addDay").addEventListener("click", () => {
    sync();
    const next = model.reduce((m, d) => Math.max(m, d.day_number), 0) + 1;
    model.push({ day_number: next, name: `Day ${next}`, focus: "", items: [] });
    editing.add(model.length - 1); // a fresh day opens straight into the editor
    planBar.markDirty(); draw();
  });

  const persistPlan = async () => {
    sync();
    const days = model.map((d, i) => ({
      day_number: i + 1, name: d.name || `Day ${i + 1}`, focus: d.focus || null,
      items: d.items
        // a cardio item is kept when it has any prescription or a label; a strength
        // item still needs a non-empty exercise name (an empty row is dropped).
        .filter((it) => isCardioItem(it)
          ? ((it.note && it.note.trim()) || it.target_distance_km != null || it.target_duration_min != null || (it.target_zone && String(it.target_zone).trim()))
          : (it.exercise && it.exercise.trim()))
        .map((it) => {
          if (isCardioItem(it)) {
            const ivl = (it.interval_note || "").trim();
            return {
              kind: "cardio",
              note: it.note && it.note.trim() ? it.note.trim() : null,
              target_distance_km: it.target_distance_km ?? null,
              target_duration_min: it.target_duration_min ?? null,
              target_zone: it.target_zone && String(it.target_zone).trim() ? String(it.target_zone).trim() : null,
              interval: ivl ? { note: ivl } : null,
            };
          }
          return {
            kind: "strength",
            exercise: it.exercise.trim(), sets: it.sets, rep_low: it.rep_low, rep_high: it.rep_high,
            target_weight: it.target_weight, note: it.note && it.note.trim() ? it.note.trim() : null,
            warmup_sets: it.warmup_sets ?? null,
            target_seconds: it.target_seconds ?? null, // preserve timed targets across edits
          };
        }),
    }));
    if (!days.length) { $("#planstatus").textContent = "Add at least one day before saving."; return false; }
    const r = await api("/plan", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ days }) });
    if (r.error) { $("#planstatus").textContent = "Couldn't save your plan — try again."; return false; }
    state.plan = [];
    swrInvalidate("plan"); // the shared plan cache (Today + this editor) is now stale
    renderPlanEditor(); // fresh render — the save bar finishes its success flash on top
    return true;
  };
  // floating save bar: edits inside any day editor (or structural changes via
  // markDirty above) surface Save/Discard right above the tab bar
  const planBar = mountSaveBar({
    sentinel: $("#planedit"),
    fields: $("#planedit"),
    onSave: persistPlan,
    onDiscard: () => renderPlanEditor(),
  });

  draw();
}

// ---------- Plan → Endurance (the running plan home) ----------
// The forward-looking counterpart to Progress → Endurance (which reads how running is
// GOING): here you see the periodized RAMP toward race day, THIS WEEK's prescribed
// runs, and SHAPE the running — ask the coach to plan/adjust runs, which lands as a
// draft you apply surgically (each run attaches to its day, lifts untouched). Bound to
// the constitution: pull-never-push, suggestion-not-a-gate, no 0–100 scores. Reuses
// enduranceGoalCard/runComplianceLine (05), the cardio helpers (02), cardioSyncLine/
// wireCardioSync (03), runTargetText/applyProposalById (06) — all global at runtime.

// Pure ramp, preset, and drafted-run card renderers live in plan-endurance-client.js.

async function renderPlanEndurance() {
  headerTitle.textContent = "Plan";
  state.planSeg = "endurance";
  view.innerHTML = segBar("endurance", planSeg()) + `<div id="endPlanBody">${loadingState("Reading your running…")}</div>`;
  wireSeg(PLAN_HANDLERS);
  const token = ++pollToken;
  let goal = null, compliance = null, plan = [], settings = null;
  try {
    [goal, compliance, plan, settings] = await Promise.all([
      api("/endurance-goal").catch(() => null),
      api("/run-compliance").catch(() => null),
      api("/plan").catch(() => []),
      api("/settings").then((r) => (r && r.settings) || null).catch(() => null),
    ]);
  } catch { /* paint with whatever resolved */ }
  if (token !== pollToken || !view.querySelector("#endPlanBody")) return;
  paintPlanEndurance(goal, compliance, plan, settings);
}

function paintPlanEndurance(goal, compliance, plan, settings) {
  const body = view.querySelector("#endPlanBody");
  if (!body) return;
  _endDrafting = false; // fresh composer — never inherit a stuck in-flight lock (any
  // truly in-flight proposal job re-attaches via reconnectProposal and re-locks the UI)

  // No goal yet → invite setting one (the ramp + race-coach framing need an objective).
  const goalHtml = (goal && goal.mode)
    ? enduranceGoalCard(goal)
    : `<div class="end-goal reveal" style="${stagger(0)}">
         <div class="end-goal-head"><span class="lbl">Running goal</span></div>
         <div class="end-goal-name">No goal set yet</div>
         <div class="end-goal-sub">Set a race or a standing readiness target in <b>Me → Profile</b> and the coach will periodize your running toward it.</div>
       </div>`;

  const rampHtml = CairnPlanEndurance.rampHtml(goal);
  const standingNote = (goal && goal.mode === "standing")
    ? `<div class="end-ramp-note reveal" style="${stagger(1)}"><span class="lbl">Steady readiness</span> — no race to peak for, so the plan holds a sustainable rhythm rather than ramping.${goal.weekly_km ? ` Target around <b>${escHtml(goal.weekly_km)} km/wk</b>.` : ""}</div>`
    : "";

  // This week's prescribed runs, from the plan's cardio items.
  const runs = [];
  (plan || []).forEach((d) => (d.items || []).forEach((it) => { if (isCardioItem(it)) runs.push({ it, day_number: d.day_number }); }));
  // Weekly volume at a glance — a runner thinks in total mileage first. Plain words,
  // never a score; shown against the goal's weekly_km anchor when one is set.
  const totalKm = runs.reduce((s, { it }) => s + (Number(it.target_distance_km) || 0), 0);
  const totalMin = runs.reduce((s, { it }) => s + (Number(it.target_duration_min) || 0), 0);
  let volText = `${runs.length} run${runs.length === 1 ? "" : "s"}`;
  if (totalKm > 0) volText += ` · ${fmtKm(totalKm)} km planned`;
  else if (totalMin > 0) volText += ` · ${Math.round(totalMin)} min planned`;
  if (totalKm > 0 && goal && goal.weekly_km) volText += ` · target ~${goal.weekly_km} km/wk`;
  const volLine = runs.length ? `<div class="end-runs-total numeral">${escHtml(volText)}</div>` : "";
  const runRows = runs.map(({ it, day_number }, i) => `
      <div class="end-run-row reveal" style="${stagger(i + 2)}">
        <span class="run-pin" aria-hidden="true">▸</span>
        <div class="end-run-main">
          <span class="end-run-name">${escHtml(cardioLabel(it))}</span>
          <span class="end-run-day lbl">Day ${escHtml(day_number)}</span>
        </div>
        <span class="end-run-pres numeral">${escHtml(cardioPrescription(it) || "—")}</span>
      </div>`).join("");
  const complianceHtml = (typeof runComplianceLine === "function") ? runComplianceLine(compliance) : "";
  const syncHtml = (typeof cardioSyncLine === "function") ? cardioSyncLine(settings, {}) : "";
  const runsSection = runs.length
    ? `<div class="end-runs reveal" style="${stagger(2)}">
         <div class="end-runs-h"><span class="lbl">This week's runs</span>
           <button class="end-link" id="endEditRuns">Edit in Training →</button></div>
         ${volLine}
         ${runRows}
       </div>${complianceHtml}${syncHtml}`
    : `<div class="end-runs-empty reveal" style="${stagger(2)}">
         <div class="lbl">This week's runs</div>
         <p>No runs in your plan yet. Ask the coach below to build your week — each run lands on its day and keeps your lifts intact.</p>
       </div>${complianceHtml}${syncHtml}`;

  // Shape-your-running composer — the adjust/comment surface.
  const presets = CairnPlanEndurance.presets(goal);
  const chips = presets.map((p, i) => `<button class="end-chip" data-egi="${i}">${escHtml(p.t)}</button>`).join("");
  const composer = `<div class="end-shape reveal" style="${stagger(3)}">
      <div class="end-shape-h"><span class="lbl">Shape your running</span></div>
      <p class="end-shape-sub">Tell the coach what you want — it drafts run prescriptions you review and apply. Your lifting plan is never touched.</p>
      <div class="end-chips">${chips}</div>
      <textarea id="endInstr" class="form-textarea" rows="2" placeholder="e.g. ease my long run, my knee's cranky — or add a tempo on Thursday"></textarea>
      <button id="endDraftBtn" class="logbtn" style="width:100%;height:44px;letter-spacing:.05em">ASK THE COACH</button>
      <div id="endDraftStatus" class="end-shape-status"></div>
      <div id="endDraft"></div>
    </div>`;

  // A one-line lead so this reads as the PLANNING home, distinct from Progress →
  // Endurance (which is the backward-looking analytics on the same goal banner).
  const leadHtml = (goal && goal.mode)
    ? `<p class="end-lead">Your running plan — the build, this week's runs, and a quick way to shape them.</p>`
    : "";
  body.innerHTML = goalHtml + leadHtml + rampHtml + standingNote + runsSection + composer;

  const editBtn = body.querySelector("#endEditRuns");
  if (editBtn) editBtn.addEventListener("click", () => renderPlanEditor());
  if (syncHtml && typeof wireCardioSync === "function") wireCardioSync(body, () => renderPlanEndurance());
  body.querySelectorAll(".end-chip").forEach((b) => b.addEventListener("click", () => {
    const p = presets[+b.dataset.egi]; if (p) draftEnduranceRuns(p.i);
  }));
  const draftBtn = body.querySelector("#endDraftBtn");
  if (draftBtn) draftBtn.addEventListener("click", () => {
    const txt = (body.querySelector("#endInstr")?.value || "").trim();
    draftEnduranceRuns(txt || presets[0].i);
  });
}

// Drafted run proposal card rendering lives in plan-endurance-client.js.

// Ask the coach to draft (or adjust) this week's runs. Runs as a durable background
// `proposal` job (the SAME elite loader the Coach tab + session-suggest use): the
// evolving caption + filament stream into #endDraftStatus and survive a reload —
// replacing the old blocking ~80s await that sat on a static "Asking the coach…".
// The created proposal's run prescriptions render inline to apply here (surgical
// setWeeklyRuns via the shared applyProposalById), degrading calmly when the coach
// returns no runs or no agent is configured.
let _endDrafting = false; // chip + button both call this; never race two drafts in one render

// Lock the composer for the length of a draft: hold the in-flight flag + disable the
// chips so a chip tap can't race a second job. Used by the live trigger AND the reload
// reconnector (reconnectProposal) — so a job still streaming after a reload re-locks
// the whole composer, not just the button. enduranceComposerRestore() is the inverse.
function enduranceComposerLock() {
  _endDrafting = true;
  view.querySelectorAll(".end-chip").forEach((c) => { c.disabled = true; });
}
function enduranceComposerRestore() {
  view.querySelectorAll(".end-chip").forEach((c) => { c.disabled = false; });
  const btn = view.querySelector("#endDraftBtn");
  if (btn && btn._busyRestore) btn._busyRestore();
  _endDrafting = false;
}

function draftEnduranceRuns(instruction) {
  if (_endDrafting) return;
  enduranceComposerLock();
  const btn = view.querySelector("#endDraftBtn");
  if (btn) btnBusy(btn, "Asking…");
  const status = view.querySelector("#endDraftStatus");
  if (status) status.innerHTML = CairnUi.jobCaptionHtml();
  const draftWrap = view.querySelector("#endDraft");
  if (draftWrap) draftWrap.innerHTML = "";
  runOp("proposal", { agent: "auto", instruction }, enduranceProposalOpOpts());
}

// Shared runOp options for an Endurance "shape your running" draft — used by the
// trigger and the reload reconnector (reconnectProposal) so render/fail are identical.
function enduranceProposalOpOpts() {
  return {
    path: "/agent/run",
    anchor: "#endDraftStatus",
    caption: "endurance_runs",
    guard: () => !view.querySelector("#endDraftStatus")?.isConnected,
    // The coach must return a parsed proposal; a parsed proposal with NO runs is NOT a
    // failure — it's the calm "proposed changes but no runs" branch, handled in render.
    isFail: (r) => !r || r.ok === false || !r.proposal || !r.proposal.parsed,
    render: (r) => renderEnduranceDraftResult(r.proposal),
    onFail: (err) => {
      enduranceComposerRestore();
      const status = view.querySelector("#endDraftStatus");
      if (!status) return;
      status.textContent = (err && err.agent_status === "unconfigured")
        ? "Drafting runs needs a coaching agent — connect one in Settings. You can still edit runs in Training."
        : "The coach couldn't finish — try again, or pick another agent in Settings.";
    },
  };
}

// Render a drafted proposal's run prescriptions inline (or the calm no-runs line),
// then wire APPLY (surgical setWeeklyRuns) + DISCARD. Shared by the live draft and the
// reload reconnector.
function renderEnduranceDraftResult(p) {
  enduranceComposerRestore();
  const status = view.querySelector("#endDraftStatus");
  const draftWrap = view.querySelector("#endDraft");
  if (!status || !draftWrap) return;
  const cardio = p && p.parsed && Array.isArray(p.parsed.cardio) ? p.parsed.cardio : [];
  if (!cardio.length) {
    // The coach answered, but with strength / restructure changes rather than runs.
    status.innerHTML = `The coach proposed plan changes but no runs this time. <button class="end-link" id="endToCoach">Review in Coach →</button>`;
    const toCoach = status.querySelector("#endToCoach");
    if (toCoach) toCoach.addEventListener("click", () => renderCoach());
    return;
  }
  status.textContent = "";
  draftWrap.innerHTML = CairnPlanEndurance.draftCardHtml(p);
  const ab = draftWrap.querySelector("[data-egapply]");
  if (ab) ab.addEventListener("click", async () => {
    await applyProposalById(ab.dataset.egapply, ab);
    renderPlanEndurance(); // re-read so the applied runs show under "This week's runs"
  });
  const db = draftWrap.querySelector("[data-egdiscard]");
  if (db) db.addEventListener("click", async () => {
    try { await api(`/proposals/${db.dataset.egdiscard}/discard`, { method: "POST" }); } catch {}
    draftWrap.innerHTML = "";
    if (status) status.textContent = "Discarded.";
  });
}

// ---------- Chat ----------
// Document-level paste listener for the chat view; swapped on every renderChat.
let chatPasteHandler = null;
let chatFuelContext = [];
const CHAT_UPLOAD_IMAGE_MAX_BYTES = CairnChatClient.CHAT_IMAGE_MAX_BYTES; // mirrors src/api.ts CHAT_IMAGE_MAX_BYTES
const CHAT_UPLOAD_IMAGE_EDGE_STEPS = CairnChatClient.CHAT_IMAGE_EDGE_STEPS;
const CHAT_UPLOAD_IMAGE_QUALITY_STEPS = CairnChatClient.CHAT_IMAGE_QUALITY_STEPS;

function base64DecodedBytes(base64) {
  return CairnChatClient.base64DecodedBytes(base64);
}

function chatImagePayload(dataUrl) {
  return CairnChatClient.imagePayload(dataUrl);
}

// Downscale + re-encode a picked photo to JPEG before upload: phone camera
// shots are 3-12MB HEIC/JPEG; ~1280px @ q0.82 is plenty for a plate estimate
// (and Safari decodes HEIC natively, so re-encoding also normalizes the type).
// If the first pass still exceeds the server cap, step down deterministically
// instead of letting Express reject the whole JSON body with a generic 413.
async function compressChatImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Couldn't read that image"));
      i.src = url;
    });
    let last = null;
    for (const maxEdge of CHAT_UPLOAD_IMAGE_EDGE_STEPS) {
      const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.naturalWidth * scale));
      c.height = Math.max(1, Math.round(img.naturalHeight * scale));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      for (const quality of CHAT_UPLOAD_IMAGE_QUALITY_STEPS) {
        last = chatImagePayload(c.toDataURL("image/jpeg", quality));
        if (last.bytes <= CHAT_UPLOAD_IMAGE_MAX_BYTES) return last;
      }
    }
    const err = new Error("image-too-large");
    err.bytes = last ? last.bytes : 0;
    throw err;
  } finally { URL.revokeObjectURL(url); }
}

// Convert a SQLite UTC timestamp ("YYYY-MM-DD HH:MM:SS") to a local YYYY-MM-DD
// for day grouping; falls back to today on anything unparseable.
function chatDayISO(ts) {
  return CairnChatClient.dayISO(ts, localISO);
}

function chatDivider(iso) {
  const template = document.createElement("template");
  template.innerHTML = CairnChatClient.dividerHtml(iso, dateLabel(iso)).trim();
  const el = template.content.firstElementChild;
  if (el) return el;
  const fallback = document.createElement("div");
  fallback.className = "chat-divider";
  fallback.dataset.day = iso;
  fallback.textContent = dateLabel(iso);
  return fallback;
}

// Starter chips shown while the conversation is empty (fresh chat / after a
// fresh start); tapping one prefills the input and sends through the normal
// send path. They vanish as soon as the first message lands (appendMsg removes them).
function drawChatChips(log) {
  const template = document.createElement("template");
  template.innerHTML = CairnChatClient.starterChipsHtml().trim();
  const wrap = template.content.firstElementChild;
  if (!wrap) return;
  log.appendChild(wrap);
  wrap.querySelectorAll(".chat-chip").forEach((b) => b.addEventListener("click", () => {
    const input = $("#chatInput");
    if (!input) return;
    input.value = b.textContent;
    const send = $("#chatSend");
    if (send) send.click();
  }));
}

// Chat gets the logged-food glance only when the active thread is already about
// food capture or today's fuel. The durable food log still feeds the coach prompt
// everywhere; this UI guard keeps broad health/nutrition chats from carrying a
// persistent food banner.
function chatMessageHasFoodAction(m) {
  return CairnChatClient.messageHasFoodAction(m);
}

function chatUserMessageSuggestsFood(m) {
  return CairnChatClient.userMessageSuggestsFood(m);
}

function chatWantsFuelSurface(messages = chatFuelContext) {
  return CairnChatClient.wantsFuelSurface(messages, { todayISO: localISO(), dayISO: chatDayISO });
}

function rememberChatFuelContext(...msgs) {
  const next = [...chatFuelContext, ...msgs.filter(Boolean)];
  chatFuelContext = next.slice(-24);
  return chatFuelContext;
}

// Expand the collapsed history block at the top of the chat log: smooth
// max-height + fade per the motion rules, while keeping the messages the
// athlete is looking at visually still. Anchoring re-measures the first
// visible element every frame (rather than accumulating deltas), so scroll
// clamping while the scroller is still shorter than its viewport self-corrects.
function expandChatEarlier(log, bar, block) {
  const logTop = log.getBoundingClientRect().top;
  const anchor = [...log.children].find((el) => el !== bar && el !== block && el.getBoundingClientRect().bottom > logTop) || null;
  const anchorY = anchor ? anchor.getBoundingClientRect().top : 0;
  const keep = () => { if (anchor) log.scrollTop += anchor.getBoundingClientRect().top - anchorY; };
  if (reducedMotion()) {
    bar.remove();
    block.hidden = false;
    keep();
    return;
  }
  block.hidden = false;
  block.style.overflow = "hidden";
  block.style.maxHeight = "0px";
  block.style.opacity = "0";
  bar.remove();
  keep();
  const target = block.scrollHeight;
  void block.offsetHeight; // commit the collapsed start state
  block.style.transition = "max-height var(--dur-3) var(--ease), opacity var(--dur-3) var(--ease)";
  block.style.maxHeight = target + "px";
  block.style.opacity = "1";
  const t0 = performance.now();
  const step = (t) => {
    if (!block.isConnected) return;
    keep();
    if (t - t0 < 600) { requestAnimationFrame(step); return; } // --dur-3 + settle
    block.style.maxHeight = ""; block.style.overflow = ""; block.style.transition = ""; block.style.opacity = "";
    keep();
  };
  requestAnimationFrame(step);
}

// Fresh-start affordance in the global header (sparkle, two-tap confirm).
// Re-created idempotently on every renderChat; renderTab removes it when the
// athlete leaves the Chat tab — no listeners outlive their element.
// Header affordances for Chat: a history/search button + the fresh-start
// (distill & archive) button, in one flex cluster anchored to the header.
// Re-created idempotently per renderChat; renderTab removes the cluster when
// the athlete leaves Chat — no listeners outlive their elements.
function ensureChatHeaderBtns() {
  document.getElementById("hdrChatActions")?.remove();
  const template = document.createElement("template");
  template.innerHTML = CairnChatClient.headerActionsHtml().trim();
  const wrap = template.content.firstElementChild;
  const hist = wrap?.querySelector("#hdrHistory");
  const b = wrap?.querySelector("#hdrFresh");
  if (!wrap || !hist || !b) return { freshBtn: null, historyBtn: null };
  hist.addEventListener("click", openChatHistory);

  // fresh start (sparkle, two-tap confirm) — unchanged behavior.
  let disarm = null;
  b.addEventListener("click", () => {
    if (!b.classList.contains("armed")) {
      b.classList.add("armed");
      clearTimeout(disarm);
      disarm = setTimeout(() => b.classList.remove("armed"), 4000);
      return;
    }
    clearTimeout(disarm);
    b.classList.remove("armed");
    chatFreshStart();
  });

  document.querySelector("header").appendChild(wrap);
  return { freshBtn: b, historyBtn: hist };
}

// POST /api/chat/reset — non-blocking fresh start. The server ARCHIVES the live
// conversation at once (so the composer is usable instantly — never disabled) and
// distills durable facts into memory in the BACKGROUND as a chat_distill job. We
// optimistically clear the log to an empty, fully-enabled composer, then settle a
// quiet "✓ N remembered" / "Fresh start" pill when the distill job lands. A message
// typed during the distill just queues as a normal chat turn (the server orders
// archive-before-turn). bg_ops OFF → the response carries `distilled` inline.
async function chatFreshStart() {
  const log = $("#chatlog");
  if (!log || state.tab !== "chat") return;
  const token = pollToken; // any full re-render bumps this — treat as stale
  const fresh = document.getElementById("hdrFresh");
  if (fresh) fresh.hidden = true; // the thread is empty now
  // Optimistic clear — empty state + chips, composer stays fully enabled & focused.
  chatFuelContext = [];
  drawChat([]);
  const fuelSlot = $("#chatFuelSlot");
  if (fuelSlot) fuelSlot.innerHTML = "";
  const input = $("#chatInput");
  if (input && matchMedia("(hover:hover)").matches) input.focus();
  let r = null;
  try {
    r = await enqueueJob("/chat/reset", {});
  } catch { /* the archive happens server-side; a blip just means no pill */ return; }
  if (token !== pollToken || state.tab !== "chat") return;

  // bg_ops OFF (legacy): the distilled count is already on the response — settle now.
  if (!r || !r.distilling) { settleFreshPill(r && r.ok ? r.distilled : 0, token); return; }

  // bg_ops ON: stream the distill job; settle the pill on done. The job lives
  // server-side, so it survives a reload (a re-render's chatReconnect leaves the
  // turn stream alone; this pill is best-effort and simply won't reappear).
  openJobStream(r.distilling, {
    guard: () => state.tab !== "chat" || token !== pollToken,
    onDone: (result) => settleFreshPill(result && result.ok ? result.distilled : 0, token),
    onError: () => {},
    onCanceled: () => {},
  });
}

// A quiet, self-dismissing "✓ N remembered" / "Fresh start" pill in the chat header
// actions row — stale-guarded on token + tab so it never lands on a navigated-away
// view. Replaces any prior pill so a fast double fresh-start doesn't stack.
function settleFreshPill(distilled, token) {
  if (token !== pollToken || state.tab !== "chat") return;
  const host = document.getElementById("hdrChatActions");
  if (!host) return;
  const n = Number(distilled) || 0;
  host.querySelector(".fresh-pill")?.remove();
  const pill = document.createElement("span");
  pill.className = "fresh-pill";
  pill.innerHTML = CairnChatClient.freshPillHtml(n);
  host.prepend(pill);
  requestAnimationFrame(() => pill.classList.add("fresh-pill-in"));
  setTimeout(() => { pill.classList.remove("fresh-pill-in"); setTimeout(() => pill.remove(), 360); }, 2600);
}

function chatFuelHtml(d) {
  return CairnChatClient.fuelHtml(d);
}

async function loadChatFuel(token, messages = chatFuelContext) {
  const slot = $("#chatFuelSlot");
  if (!slot) return;
  if (!chatWantsFuelSurface(messages)) { slot.innerHTML = ""; return; }
  let d = null;
  try { d = await api("/nutrition/day"); } catch { slot.innerHTML = ""; return; }
  if (token !== pollToken || state.tab !== "chat" || !slot.isConnected) return;
  slot.innerHTML = chatFuelHtml(d);
  const card = slot.querySelector("#chatFuelCard");
  if (card) card.addEventListener("click", () => { state.planJump = "food"; activateTab("plan"); });
}

async function renderChat() {
  headerTitle.textContent = "Chat";
  document.body.classList.add("chat-mode"); // the chat column owns the viewport; drop body's tab-bar padding
  chatTeardownMonitor(); // the log is about to be rebuilt — drop the old stream + bubble map
  const token = ++pollToken; // bump so the async hydrate below can detect a stale tab
  const { freshBtn } = ensureChatHeaderBtns();
  chatFuelContext = [];
  // Paint the shell FIRST so the composer is usable instantly; the log hydrates
  // in the background. The flex viewport column keeps the composer pinned above
  // the tab bar no matter how the OS zooms (height is re-measured, not magic).
  view.innerHTML = CairnChatClient.shellHtml();

  const log = $("#chatlog");
  log.innerHTML = loadingState("Catching up…");
  wireChatJump(log, $("#chatJump"));
  measureChatTop();
  requestAnimationFrame(measureChatTop); // re-measure once layout/fonts settle

  const input = $("#chatInput"), sendBtn = $("#chatSend");
  const fileInput = $("#chatFile");
  const attachBtn = $("#chatAttach"), preview = $("#chatPreview");
  let attached = null; // { dataUrl, base64, mime }

  const settleChatAfterNativePicker = () => {
    document.dispatchEvent(new CustomEvent("cairn:keyboard-settle"));
    measureChatTop();
    requestAnimationFrame(() => requestAnimationFrame(measureChatTop));
    for (const d of [120, 280, 520, 900]) setTimeout(() => { if (state.tab === "chat") measureChatTop(); }, d);
  };
  const clearAttach = () => {
    attached = null;
    fileInput.value = "";
    preview.hidden = true;
    attachBtn.classList.remove("has-img");
    settleChatAfterNativePicker();
  };
  const attachFile = async (f) => {
    if (!f) return;
    try {
      attached = await compressChatImage(f);
      preview.querySelector("img").src = attached.dataUrl;
      preview.hidden = false;
      attachBtn.classList.add("has-img");
    } catch (e) {
      const tooLarge = e && e.message === "image-too-large";
      toast(tooLarge ? "That photo is too large — try a closer crop." : "Couldn't read that image — try another.");
      clearAttach();
    } finally {
      settleChatAfterNativePicker();
    }
  };
  // One "+" control. On iOS a file input with no `capture` opens the native
  // sheet (Take Photo / Photo Library / Choose File); desktop opens the file
  // dialog. Attaching is occasional, so this keeps the bar to input + send.
  attachBtn.addEventListener("click", () => {
    if (document.activeElement === input) input.blur();
    document.body.classList.remove("kb-open");
    settleChatAfterNativePicker();
    fileInput.click();
  });
  $("#chatPreviewX").addEventListener("click", clearAttach);
  fileInput.addEventListener("change", () => {
    const f = fileInput.files && fileInput.files[0];
    if (f) attachFile(f);
    else settleChatAfterNativePicker();
  });
  // Paste-an-image support (desktop screenshots, iOS "Copy Photo"). One live
  // handler at a time: re-renders swap it out, and it bails when chat isn't
  // the active tab so it never touches a stale DOM.
  if (chatPasteHandler) document.removeEventListener("paste", chatPasteHandler);
  chatPasteHandler = (e) => {
    if (state.tab !== "chat" || !input.isConnected) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) { e.preventDefault(); attachFile(f); }
        return;
      }
    }
  };
  document.addEventListener("paste", chatPasteHandler);

  // Send = enqueue a durable turn and return immediately; the input never blocks,
  // so a follow-up typed while the coach is thinking simply queues (its own turn,
  // drained serially server-side). The monitor streams real progress + finalizes.
  const send = async () => {
    const text = input.value.trim();
    const img = attached;
    if (!text && !img) return;
    input.value = "";
    autosizeChatInput(input); // collapse the composer back to one line
    saveChatDraft("");
    clearAttach();
    // Optimistic user bubble lands instantly (the server persists it too; a full
    // re-render later draws from server truth, so no duplicate).
    const userMsg = { role: "user", content: text || "(photo)", meta: img ? { image: img.dataUrl } : null };
    const userBubble = appendMsg(userMsg);
    rememberChatFuelContext(userMsg);
    loadChatFuel(token);
    try {
      const body = { message: text };
      if (img) { body.image_base64 = img.base64; body.image_mime = img.mime; }
      const r = await api("/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (r && r.turn) { spawnPendingBubble(r.turn); chatMonitorEnsure(); }
      else appendMsg({ role: "assistant", content: (r && r.error) || "(no reply)" });
    } catch (_e) {
      // Couldn't even enqueue (offline): roll the optimistic bubble back and put
      // the text back in the composer so nothing is lost — the offline banner says why.
      userBubble?.remove();
      if (!input.value) { input.value = text; saveChatDraft(text); autosizeChatInput(input); }
      toast("Couldn't send — check your connection");
    } finally { if (matchMedia("(hover:hover)").matches) input.focus(); }
  };
  // Tapping send must NOT blur the textarea (that just dismisses the keyboard,
  // and as the layout reflows the button slides out from under your finger so
  // the first tap never sends). preventDefault on pointerdown keeps the input
  // focused — but on iOS WebKit that ALSO suppresses the synthesized click, so
  // we send on pointerup instead (fires on both touch and mouse). The click
  // handler stays for keyboard activation (Enter/Space on the focused button);
  // send()'s empty-input guard makes any second call a no-op, so pointer
  // devices never double-send. (The "+" is left alone — it opens a file picker.)
  sendBtn.addEventListener("pointerdown", (e) => e.preventDefault());
  sendBtn.addEventListener("pointerup", () => send());
  sendBtn.addEventListener("click", send);
  // Desktop: Enter sends, Shift+Enter drops a newline. Touch keyboards keep
  // Enter as a newline (so multi-line capture — pasting findings, describing a
  // meal — just works) and send via the arrow button.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && matchMedia("(hover:hover)").matches) {
      e.preventDefault();
      send();
    }
  });
  // Re-pin the column across the WHOLE keyboard slide. iOS animates the keyboard
  // over ~300ms and reports its visual-viewport metrics in steps, so a single
  // double-rAF (~32ms) catches a transitional offsetTop — the styled bar and the
  // real caret desync ("typing in the gap underneath the input"). Re-measure on
  // a few beats spanning the animation so the dock settles flush to the keyboard,
  // and once more after it drops to clear any stale gap.
  const settleChatViewport = () => {
    measureChatTop();
    requestAnimationFrame(() => requestAnimationFrame(measureChatTop));
    for (const d of [80, 160, 260, 380, 520]) setTimeout(() => { if (state.tab === "chat") measureChatTop(); }, d);
  };
  for (const ev of ["focus", "blur"]) input.addEventListener(ev, settleChatViewport);
  // Persist the unsent draft on every keystroke so it survives a tab switch /
  // reload — restored below unless a deep-link prefill takes precedence. Re-grow
  // the composer to fit what's typed/pasted.
  input.addEventListener("input", () => { saveChatDraft(input.value); autosizeChatInput(input); });
  // Deep links (e.g. the compass nudge) arrive with the question pre-written —
  // leave it editable rather than auto-sending. Otherwise restore the saved draft.
  if (state.chatPrefill) { input.value = state.chatPrefill; state.chatPrefill = null; saveChatDraft(input.value); }
  else { const d = loadChatDraft(); if (d) input.value = d; }
  autosizeChatInput(input); // fit a restored multi-line draft
  // desktop only — on mobile, auto-focus pops the keyboard over half the view
  if (matchMedia("(hover:hover)").matches) input.focus();

  // Hydrate the log in the background — the shell above is already interactive.
  let msgs = [];
  try { msgs = await api("/chat?limit=200"); } catch { msgs = []; }
  if (token !== pollToken || !log.isConnected) return; // navigated away / re-rendered
  if (freshBtn) freshBtn.hidden = !msgs.length;
  chatFuelContext = msgs.slice(-24);
  drawChat(msgs);
  loadChatFuel(token);
  // Rebuild any in-flight + queued turns from the server and resume streaming.
  chatReconnect();
  if (state.pendingChatSession) openChatHistory({ session: state.pendingChatSession });
  requestAnimationFrame(measureChatTop);
}

function drawChat(msgs) {
  const log = $("#chatlog");
  log.innerHTML = "";
  if (!msgs.length) {
    log.innerHTML = CairnChatClient.emptyHtml();
    drawChatChips(log);
    return;
  }
  // Group chronologically by local calendar day, splitting only at day
  // boundaries so dividers never duplicate across the collapse seam.
  const groups = [];
  for (const m of msgs) {
    const iso = chatDayISO(m.created_at);
    if (!groups.length || groups[groups.length - 1].iso !== iso) groups.push({ iso, msgs: [] });
    groups[groups.length - 1].msgs.push(m);
  }
  // The most recent stretch stays expanded: today's messages, or — when today
  // is empty — whole recent days until ~12 messages are visible.
  let cut = groups.length - 1;
  if (groups[cut].iso !== localISO()) {
    let count = groups[cut].msgs.length;
    while (cut > 0 && count < 12) { cut--; count += groups[cut].msgs.length; }
  }
  const earlier = groups.slice(0, cut);
  if (earlier.length) {
    const template = document.createElement("template");
    template.innerHTML = CairnChatClient.earlierBarHtml().trim();
    const bar = template.content.firstElementChild;
    if (!bar) return;
    log.appendChild(bar);
    const block = document.createElement("div");
    block.className = "chat-earlier";
    block.hidden = true;
    for (const g of earlier) {
      block.appendChild(chatDivider(g.iso));
      for (const m of g.msgs) appendMsg(m, true, block);
    }
    log.appendChild(block);
    bar.querySelector("button").addEventListener("click", () => expandChatEarlier(log, bar, block));
  }
  for (const g of groups.slice(cut)) {
    log.appendChild(chatDivider(g.iso));
    for (const m of g.msgs) appendMsg(m, true);
  }
  log.scrollTop = log.scrollHeight;
}

// Local clock time for a chat turn ("2:14 PM"); now when no timestamp (the
// optimistic user bubble). Empty string if unparseable.
function chatClock(ts) {
  const d = ts ? new Date(String(ts).replace(" ", "T") + "Z") : new Date();
  if (isNaN(d.getTime())) return "";
  try { return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
  catch { return ""; }
}

// Copy text to the clipboard with a graceful fallback + a confirming toast.
function copyText(text) {
  const t = String(text || "");
  if (!t) return;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(t).then(() => toast("Copied"), () => toast("Couldn't copy"));
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.focus(); ta.select();
  try { document.execCommand("copy"); toast("Copied"); } catch { toast("Couldn't copy"); }
  ta.remove();
}
// Touch long-press → copy (the hover copy button is desktop-only).
function attachLongPressCopy(el, text) {
  let timer = 0;
  const cancel = () => clearTimeout(timer);
  el.addEventListener("touchstart", () => { cancel(); timer = setTimeout(() => copyText(text), 500); }, { passive: true });
  el.addEventListener("touchmove", cancel, { passive: true });
  el.addEventListener("touchend", cancel);
  el.addEventListener("touchcancel", cancel);
}

const COPY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></svg>`;

// Render one chat turn. `opts.readonly` (history overlay) renders drafts as a
// static note instead of an Apply button. Consecutive same-role turns group:
// the previous one drops its tail + time, this one becomes the run's last.
function appendMsg(m, noScroll, parent, opts = {}) {
  const log = $("#chatlog");
  const host = parent || log;
  if (!host) return null; // log torn down (tab switch mid-stream) — bail safely
  const readonly = !!opts.readonly;
  // Optional position-preserving insert: a streaming turn finalizes in place even
  // when a queued follow-up's pending bubble already sits below it.
  const before = opts.before && opts.before.isConnected && opts.before.parentElement === host ? opts.before : null;
  if (!noScroll && !parent) {
    // a live turn: clear the loading/empty state + starter chips, and make sure
    // it lands under a "Today" divider
    log.querySelector(".loadstate")?.remove();
    log.querySelector(".empty")?.remove();
    log.querySelector(".chat-chips")?.remove();
    const divs = log.querySelectorAll(".chat-divider[data-day]");
    const last = divs[divs.length - 1];
    if (!last || last.dataset.day !== localISO()) log.appendChild(chatDivider(localISO()));
    const fresh = document.getElementById("hdrFresh");
    if (fresh && state.tab === "chat") fresh.hidden = false;
  }
  // Grouping: continue a same-role run (skip for the pending typing bubble).
  const prev = m.pending ? null : (before ? before.previousElementSibling : host.lastElementChild);
  const cont = !!prev && prev.classList?.contains("bubble") && prev.classList.contains(m.role) && !prev.classList.contains("pending");
  if (cont) { prev.classList.add("grouped"); prev.querySelector(".bubble-time")?.remove(); }

  const el = document.createElement("div");
  el.className = `bubble ${m.role}${m.pending ? " pending" : ""}${cont ? " cont" : ""}${noScroll ? "" : " bubble-in"}`;
  if (m.id != null) el.dataset.mid = m.id; // anchor for re-attaching a turn's pending bubble after reload

  // Pending = the house typing indicator (breathing dots); an optional caption
  // ("Reading your plate…") leads, the dots follow. Early-return so a pending
  // bubble never picks up a timestamp or copy affordance.
  if (m.pending) {
    // role=status + aria-busy couples the visible "thinking" dots to a screen-
    // reader signal; the caption is the live phase ("Thinking…" → "Drafting…").
    el.setAttribute("role", "status");
    el.setAttribute("aria-busy", "true");
    const lead = m.content && m.content !== "…" ? `${escHtml(m.content)} ` : "";
    el.innerHTML = `<div class="bubble-text"><span class="typing-cap">${lead}</span><span class="typing" aria-hidden="true"><i></i><i></i><i></i></span></div>`;
    host.appendChild(el);
    if (!noScroll && log) log.scrollTop = log.scrollHeight;
    return el;
  }

  const meta = m.meta;
  let extra = "";
  if (meta?.applied?.length) {
    extra += `<div class="bubble-meta">${meta.applied.map((a) => `<span class="bubble-tag">✓ ${escHtml(String(a.type).replace(/_/g, " "))}${a.error ? " ⚠" : ""}</span>`).join("")}</div>`;
  }
  if (meta?.drafts?.length) {
    // Each draft reflects its CURRENT proposal status (stamped server-side). An
    // applied one is a calm "done" note — no more Apply button to re-trigger it.
    extra += meta.drafts.map((d) => {
      const label = escHtml(d.summary || (d.kind === "restructure" ? "plan restructure" : "plan update"));
      if (d.status === "applied")
        return `<div class="draftbtn applied" aria-disabled="true">✓ Applied · ${label}</div>`;
      if (readonly)
        return `<div class="bubble-meta"><span class="bubble-tag">plan draft</span></div>`;
      return `<button class="draftbtn" data-apply="${escAttr(d.id)}">Apply: ${label}</button>`;
    }).join("");
  }
  const hideText = meta?.image && (!m.content || m.content === "(photo)");
  const body = hideText ? "" : m.role === "assistant"
    ? `<div class="bubble-text md">${mdToHtml(m.content)}</div>`
    : `<div class="bubble-text">${escHtml(m.content)}</div>`;
  const photoSrc = meta?.image && String(meta.image).startsWith("/api/chat-images/")
    ? withToken(meta.image)
    : meta?.image;
  const photo = photoSrc ? `<img class="bubble-img" alt="attached photo" loading="lazy" src="${escAttr(photoSrc)}" data-remove-on-error="1">` : "";
  const time = `<span class="bubble-time">${escHtml(chatClock(m.created_at))}</span>`;
  const canCopy = m.role === "assistant" && !hideText && !!m.content;
  const copyBtn = canCopy ? `<button class="bubble-copy" aria-label="Copy reply" title="Copy">${COPY_ICON}</button>` : "";
  el.innerHTML = `${copyBtn}${photo}${body}${extra}${time}`;
  if (before) host.insertBefore(el, before); else host.appendChild(el);
  el.querySelectorAll("[data-apply]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    let r = null;
    try { r = await api(`/proposals/${b.dataset.apply}/apply`, { method: "POST" }); } catch { r = null; }
    // Honest failure (shared with the Coach list via applyResultMessage): a transport
    // drop, a 400 {error}, or ok:false must NOT read as "Applied". Re-enable the button
    // so the draft stays actionable instead of settling into a false "done" note.
    const m = applyResultMessage(r);
    if (m.failed) { b.disabled = false; toast(m.message); return; }
    const clamped = Array.isArray(r.clamped) && r.clamped.length;
    toast(m.message);
    state.plan = []; swrInvalidate("plan"); // a chat-applied plan change makes the cache stale
    // Settle into the same calm "done" note the message renders on reload, so a
    // just-applied draft and a long-applied one look identical.
    const label = b.textContent.replace(/^Apply:\s*/, "");
    const done = document.createElement("div");
    done.className = "draftbtn applied";
    done.setAttribute("aria-disabled", "true");
    done.textContent = `✓ Applied · ${label}`;
    b.replaceWith(done);
    // A code guardrail nudged a load to a safe step — show the honest hairline note
    // inline under the bubble's actions (it persists exactly here on this turn).
    if (clamped) done.insertAdjacentHTML("afterend", clampNoteHtml(r.clamped));
  }));
  if (canCopy) {
    el.querySelector(".bubble-copy")?.addEventListener("click", () => copyText(m.content));
    attachLongPressCopy(el, m.content);
  }
  if (!noScroll && log && (!before || before === host.lastElementChild)) log.scrollTop = log.scrollHeight;
  return el;
}

// ============================================================================
// Durable agent job helpers live in /js/agent-job-client.js.
// ============================================================================

// ============================================================================
// Durable chat turn helpers live in /js/chat-turn-client.js.
// ============================================================================


// ============================================================================
// Chat history/search helpers live in /js/chat-history-client.js.
// ============================================================================
