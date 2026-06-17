// ==== 09-plan-chat.js ====
// ---------- Plan editor (manual) ----------
// SWR over /plan (key `plan`, shared with Today — one revalidate feeds both): a
// warm re-entry paints the training editor instantly, then revalidates. A changed
// payload re-renders, but only when the user isn't mid-edit (a day flipped into the
// editor) so an in-flight edit is never clobbered by a background refresh.
async function renderPlanEditor() {
  headerTitle.textContent = "Plan";
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
      if (state.tab !== "plan" || state.planJump === "meals") return; // moved on
      if (view.querySelector(".pday") || document.querySelector(".savebar.show")) return; // mid-edit — don't clobber
      renderPlanEditor();
    },
  });
  // Cold: wait on the revalidate's data (one fetch). Warm: paint from the peek now,
  // and let the background revalidate above upgrade in place.
  const plan = peek ? peek.data : await revalidate.catch(() => []);
  if (peek && !peek.fresh) markRefreshing(true);
  // Pull-not-push calendar: subscribe to the plan as a weekly iCal feed. webcal://
  // hands most OSes straight to "add to calendar"; the (.ics) link is the fallback.
  const icsUrl = withToken("/api/plan.ics");
  const calFooter = (plan && plan.length)
    ? `<div id="planCal" style="margin-top:16px;text-align:center;font-size:.82rem;color:var(--muted)">
         <a href="webcal://${escAttr(location.host)}${escAttr(icsUrl)}" style="color:var(--muted);text-decoration:none">📅 Subscribe to this plan in your calendar</a>
         <a href="${escAttr(icsUrl)}" target="_blank" rel="noopener" style="color:var(--muted);opacity:.7;margin-left:8px">(.ics)</a>
       </div>`
    : "";
  view.innerHTML = segBar("edit", planSeg()) + `<div id="planedit"></div>
    <button id="addDay" class="ghostbtn" style="width:100%;text-align:center;padding:11px;margin-top:8px">+ Add day</button>
    <div id="planstatus" style="margin-top:8px;color:var(--muted);font-size:.82rem"></div>${calFooter}`;
  wireSeg(PLAN_HANDLERS);

  const model = plan.map((d) => ({
    day_number: d.day_number, name: d.name, focus: d.focus || "",
    items: d.items.map((it) => ({
      kind: it.kind === "cardio" ? "cardio" : "strength",
      exercise: it.exercise, sets: it.sets, rep_low: it.rep_low, rep_high: it.rep_high, target_weight: it.target_weight,
      note: it.note ?? "", warmup_sets: it.warmup_sets ?? null, muscle_group: it.muscle_group ?? null,
      target_seconds: it.target_seconds ?? null, mode: it.mode ?? null, // carried through so saving never drops timed targets
      // cardio prescription (kind:'cardio') — null on a strength item, preserved on save.
      target_distance_km: it.target_distance_km ?? null,
      target_duration_min: it.target_duration_min ?? null,
      target_zone: it.target_zone ?? null,
      // the interval is structured JSON server-side; the editor surfaces a plain note,
      // read from a {note} blob (or a bare string) when present.
      interval_note: cardioIntervalNote(it.interval),
    })),
  }));
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

  // A blank item of a given kind, used by "+ exercise" / "+ cardio" / the kind toggle.
  const blankStrength = () => ({ kind: "strength", exercise: "", sets: 3, rep_low: 8, rep_high: 10, target_weight: null, note: "", warmup_sets: null, target_distance_km: null, target_duration_min: null, target_zone: null, interval_note: "" });
  const blankCardio = () => ({ kind: "cardio", exercise: "", sets: 1, rep_low: null, rep_high: null, target_weight: null, note: "", warmup_sets: null, target_distance_km: null, target_duration_min: null, target_zone: null, interval_note: "" });

  // Gallery card: the default, beautiful state of a plan day (read-only catalog page).
  function progDayHtml(d, di) {
    const strip = d.items.map((it) => {
      if (isCardioItem(it)) {
        const t = artImg("activity", cardioArtPhrase(it), "artile-md strip-tile", art("activity", cardioArtPhrase(it)));
        return t ? `<div>${t}</div>` : "";
      }
      const t = artImg("exercise", it.exercise, "artile-md strip-tile", art("exercise", it.exercise, it.muscle_group));
      return t ? `<div data-guide="${encodeURIComponent(it.exercise)}" style="cursor:pointer">${t}</div>` : "";
    }).join("");
    const rows = d.items.map((it) => {
      if (isCardioItem(it)) {
        const t = artImg("activity", cardioArtPhrase(it), "artile-sm", art("activity", cardioArtPhrase(it)));
        const pres = cardioPrescription(it);
        return `<div class="prog-row prog-row-cardio">
            ${t}
            <div class="prog-row-main">
              <span class="prog-row-name prog-row-name-static">${escHtml(cardioLabel(it))}</span>
              <div class="prog-row-hint"><span class="cardio-tag lbl">cardio</span></div>
            </div>
            <div class="prog-row-nums"><span class="numeral prog-row-cardio-pres">${escHtml(pres || "—")}</span></div>
          </div>`;
      }
      const t = artImg("exercise", it.exercise, "artile-sm", art("exercise", it.exercise, it.muscle_group));
      const timed = it.mode === "timed" || it.target_seconds != null;
      const range = timed
        ? (it.target_seconds != null ? fmtDur(it.target_seconds) : "time")
        : (it.rep_low === it.rep_high ? `${it.rep_low ?? ""}` : `${it.rep_low ?? "?"}–${it.rep_high ?? "?"}`);
      const hints = [
        it.warmup_sets ? `${it.warmup_sets} warmup` : null,
        it.note ? escHtml(it.note) : null,
      ].filter(Boolean).join(" · ");
      return `<div class="prog-row">
          ${t}
          <div class="prog-row-main">
            <button class="prog-row-name" data-guide="${encodeURIComponent(it.exercise)}">${escHtml(it.exercise)}</button>
            ${hints ? `<div class="prog-row-hint">${hints}</div>` : ""}
          </div>
          <div class="prog-row-nums">
            <span class="numeral">${it.sets ?? "?"} × ${range}</span>
            ${!timed && it.target_weight != null ? `<span class="numeral prog-row-wt">${fmtWeight(it.target_weight)}</span>` : ""}
          </div>
        </div>`;
    }).join("");
    return `<div class="prog-day reveal" style="${stagger(di)}" data-pd="${di}">
        <div class="prog-head">
          <div class="prog-head-main">
            <div class="lbl">Day ${d.day_number}</div>
            <div class="prog-name">${escHtml(d.name || `Day ${d.day_number}`)}</div>
            ${d.focus ? `<div class="prog-focus">${escHtml(d.focus)}</div>` : ""}
          </div>
          <button class="ghostbtn prog-edit" data-editday="${di}">Edit day</button>
        </div>
        ${strip ? `<div class="prog-strip">${strip}</div>` : ""}
        <div class="prog-list">${rows || `<div class="empty">No exercises yet — tap Edit day.</div>`}</div>
      </div>`;
  }

  // One item editor: a strength prescription (the original .pi-* markup) or a cardio
  // prescription (distance/duration/zone/interval). A kind toggle flips between them.
  function pitemHtml(it, di, ii, lastIdx) {
    const cardio = isCardioItem(it);
    const ord = `<div class="pi-ord">
        <button class="ordbtn" data-upitem="${di}:${ii}" ${ii === 0 ? "disabled" : ""}>↑</button>
        <button class="ordbtn" data-downitem="${di}:${ii}" ${ii === lastIdx ? "disabled" : ""}>↓</button>
      </div>`;
    const kindToggle = `<div class="pi-kind" role="group" aria-label="Item type">
        <button type="button" class="pi-kindbtn${cardio ? "" : " active"}" data-pikind="${di}:${ii}:strength">Lift</button>
        <button type="button" class="pi-kindbtn${cardio ? " active" : ""}" data-pikind="${di}:${ii}:cardio">Cardio</button>
      </div>`;
    if (cardio) {
      return `<div class="pitem pitem-cardio" data-d="${di}" data-i="${ii}" data-kind="cardio">
          <div class="pi-row1">
            <input class="pi-ex" value="${escAttr(it.note || "")}" placeholder="e.g. Long run, Tempo, Easy ride">
            ${ord}
          </div>
          ${kindToggle}
          <div class="pi-nums pi-nums-cardio">
            <input class="pi-km" type="number" inputmode="decimal" step="0.1" value="${it.target_distance_km ?? ""}" placeholder="km">
            <input class="pi-min" type="number" inputmode="numeric" value="${it.target_duration_min ?? ""}" placeholder="min">
            <input class="pi-zone" type="text" value="${escAttr(it.target_zone || "")}" placeholder="zone (Z2)">
            <button class="delbtn" data-delitem="${di}:${ii}">✕</button>
          </div>
          <input class="pi-ivl" value="${escAttr(it.interval_note || "")}" placeholder="Interval note (optional, e.g. 6×400m @ Z4)">
        </div>`;
    }
    return `<div class="pitem" data-d="${di}" data-i="${ii}" data-kind="strength">
        <div class="pi-row1">
          <input class="pi-ex" value="${escAttr(it.exercise)}" placeholder="Exercise">
          ${ord}
        </div>
        ${kindToggle}
        <div class="pi-nums">
          <input class="pi-sets" type="number" inputmode="numeric" value="${it.sets ?? ""}" placeholder="sets">
          <input class="pi-lo" type="number" inputmode="numeric" value="${it.rep_low ?? ""}" placeholder="lo">
          <input class="pi-hi" type="number" inputmode="numeric" value="${it.rep_high ?? ""}" placeholder="hi">
          <input class="pi-tw" type="number" inputmode="decimal" value="${it.target_weight ?? ""}" placeholder="wt">
          <input class="pi-wu" type="number" inputmode="numeric" value="${it.warmup_sets ?? ""}" placeholder="WU">
          <button class="delbtn" data-delitem="${di}:${ii}">✕</button>
        </div>
        <input class="pi-note" value="${escAttr(it.note || "")}" placeholder="Note (optional)">
      </div>`;
  }

  // Editor card: the pre-existing .pday / .pi-* markup, flipped in per day via "Edit day".
  function pdayHtml(d, di) {
    return `<div class="pday" data-d="${di}">
        <div class="pday-head">
          <input class="pday-name" value="${escAttr(d.name)}" placeholder="Day name">
          <button class="ghostbtn pday-done" data-doneday="${di}">Done</button>
          <button class="delbtn" data-delday="${di}">✕</button>
        </div>
        <input class="pday-focus" value="${escAttr(d.focus)}" placeholder="Focus (optional)">
        ${d.items.map((it, ii) => pitemHtml(it, di, ii, d.items.length - 1)).join("")}
        <div class="pday-add">
          <button class="ghostbtn" data-additem="${di}">+ exercise</button>
          <button class="ghostbtn" data-addcardio="${di}">+ cardio</button>
        </div>
      </div>`;
  }

  function draw() {
    $("#planedit").innerHTML = model.map((d, di) => editing.has(di) ? pdayHtml(d, di) : progDayHtml(d, di)).join("");
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
      sync(); model[+b.dataset.additem].items.push(blankStrength()); planBar.markDirty(); draw();
    }));
    view.querySelectorAll("[data-addcardio]").forEach((b) => b.addEventListener("click", () => {
      sync(); model[+b.dataset.addcardio].items.push(blankCardio()); planBar.markDirty(); draw();
    }));
    // Flip one item between a lift and a cardio prescription — preserves the note/label,
    // resets the kind-specific numbers (they don't translate between modalities).
    view.querySelectorAll("[data-pikind]").forEach((b) => b.addEventListener("click", () => {
      sync(); const [di, ii, kind] = b.dataset.pikind.split(":");
      const it = model[+di] && model[+di].items[+ii]; if (!it) return;
      if (it.kind === kind) return; // already this kind
      const label = it.kind === "cardio" ? (it.note || "") : (it.exercise || "");
      const next = kind === "cardio" ? blankCardio() : blankStrength();
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

// The four periodization phases, in race order. `when` mirrors the deterministic
// cutoffs in repo.getEnduranceGoal (taper ≤2wk, sharpen ≤4wk, build ≤10wk, else base);
// we CONSUME the server's `goal.phase` and never recompute the thresholds here.
const ENDURANCE_PHASES = [
  { key: "base", label: "Base", when: "11+ weeks out", desc: "Build aerobic volume — easy, conversational running." },
  { key: "build", label: "Build", when: "5–10 weeks out", desc: "Add tempo and longer runs; raise the ceiling." },
  { key: "sharpen", label: "Sharpen", when: "3–4 weeks out", desc: "Race-pace work as volume trims back." },
  { key: "taper", label: "Taper", when: "final 2 weeks", desc: "Freshen up — let the training surface." },
];

// The ramp ladder — race mode only. Highlights the current phase (from goal.phase),
// marks earlier phases done. Standing / past / no-goal → "" (nothing to ramp toward).
function enduranceRampHtml(goal) {
  if (!goal || goal.mode !== "race" || !goal.phase || goal.phase === "past") return "";
  const curIdx = ENDURANCE_PHASES.findIndex((p) => p.key === goal.phase);
  if (curIdx < 0) return "";
  const steps = ENDURANCE_PHASES.map((p, i) => {
    const cls = i < curIdx ? "is-done" : i === curIdx ? "is-current" : "is-next";
    const here = i === curIdx ? `<span class="ramp-here lbl">You're here</span>` : "";
    return `<li class="ramp-step ${cls}">
        <span class="ramp-dot" aria-hidden="true"></span>
        <div class="ramp-body">
          <div class="ramp-top"><span class="ramp-name">${escHtml(p.label)}</span><span class="ramp-when lbl">${escHtml(p.when)}</span>${here}</div>
          <div class="ramp-desc">${escHtml(p.desc)}</div>
        </div>
      </li>`;
  }).join("");
  return `<div class="end-ramp reveal" style="${stagger(1)}">
      <div class="end-ramp-h"><span class="lbl">The ramp to race day</span></div>
      <ol class="ramp-list">${steps}</ol>
      <p class="end-ramp-cap">A typical arc — the coach adapts each phase to the running you've actually banked, not a fixed schedule.</p>
    </div>`;
}

// Preset "comments" the coach turns into run prescriptions — phrased like things you'd
// actually say, phase/mode-aware. Each is just an instruction string for /agent/run.
function endurancePresets(goal) {
  const out = [{ t: "Plan this week's runs", i: "Plan my runs for this coming week toward my running goal — concrete sessions (easy / long / tempo or intervals) on specific days, conservative and aerobic-first." }];
  if (goal && goal.mode === "race") {
    out.push({ t: "Progress my long run", i: "Gently progress my long run this week toward my race, keeping it easy and aerobic — no more than about a 10% step up." });
    out.push({ t: "Ease back — feeling flat", i: "I'm feeling flat and a bit run-down. Ease my running this week — hold or reduce volume, keep it easy, protect recovery." });
  } else {
    out.push({ t: "Keep me race-ready", i: "Plan a steady week of running that keeps me ready for my standing distance goal — maintain, don't peak." });
    out.push({ t: "Ease back this week", i: "Ease my running this week — keep it light and easy, I want to recover." });
  }
  return out;
}

async function renderPlanEndurance() {
  headerTitle.textContent = "Plan";
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

  // No goal yet → invite setting one (the ramp + race-coach framing need an objective).
  const goalHtml = (goal && goal.mode)
    ? enduranceGoalCard(goal)
    : `<div class="end-goal reveal" style="${stagger(0)}">
         <div class="end-goal-head"><span class="lbl">Running goal</span></div>
         <div class="end-goal-name">No goal set yet</div>
         <div class="end-goal-sub">Set a race or a standing readiness target in <b>Me → Profile</b> and the coach will periodize your running toward it.</div>
       </div>`;

  const rampHtml = enduranceRampHtml(goal);
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
  const presets = endurancePresets(goal);
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
    const p = presets[+b.dataset.egi]; if (p) draftEnduranceRuns(p.i, b);
  }));
  const draftBtn = body.querySelector("#endDraftBtn");
  if (draftBtn) draftBtn.addEventListener("click", () => {
    const txt = (body.querySelector("#endInstr")?.value || "").trim();
    draftEnduranceRuns(txt || presets[0].i, draftBtn);
  });
}

// One drafted run-prescription proposal, rendered inline with an APPLY button (the
// surgical setWeeklyRuns apply, shared with the Coach list via applyProposalById).
function endDraftCardHtml(p) {
  const cardio = (p.parsed && Array.isArray(p.parsed.cardio)) ? p.parsed.cardio : [];
  const rows = cardio.map((c) =>
    `<div class="sess-line run-line"><span class="run-pin" aria-hidden="true">▸</span><b>D${escHtml(c.day_number)} ${escHtml(c.label || c.exercise || "Run")}</b> <span class="numeral">${escHtml(runTargetText(c))}</span>${(c.reason || c.note) ? ` <span style="color:var(--muted)">(${escHtml(c.reason || c.note)})</span>` : ""}</div>`
  ).join("");
  return `<div class="mp-card end-draft-card reveal">
      <div class="mp-hero"><span class="lbl">Proposed runs · ${escHtml(p.agent)} · #${escHtml(p.id)}</span></div>
      ${p.parsed && p.parsed.summary ? `<div class="sess-line">${escHtml(p.parsed.summary)}</div>` : ""}
      ${rows}
      <div class="logrow" style="margin-top:10px">
        <button class="logbtn" style="width:auto;padding:0 16px;font-size:.85rem" data-egapply="${escAttr(p.id)}">APPLY TO MY PLAN</button>
        <button class="ghostbtn" style="width:auto;padding:0 14px" data-egdiscard="${escAttr(p.id)}">DISCARD</button>
      </div>
    </div>`;
}

// Ask the coach to draft (or adjust) this week's runs. The created proposal comes back
// on /agent/run directly (r.proposal) — we render its run prescriptions inline to apply
// here, mirror it into the Coach list, and degrade calmly if the coach returned no runs.
let _endDrafting = false; // serialize: chip + button both call this; never race two agent runs
async function draftEnduranceRuns(instruction, triggerEl) {
  if (_endDrafting) return;
  _endDrafting = true;
  const myToken = pollToken; // a re-render (here or another tab) bumps it → our DOM refs go stale
  const chips = [...view.querySelectorAll(".end-chip")];
  chips.forEach((c) => { c.disabled = true; });
  const restore = btnBusy(triggerEl, "Asking the coach…");
  let status = view.querySelector("#endDraftStatus");
  let draftWrap = view.querySelector("#endDraft");
  if (status) status.textContent = "Reading your running and your goal… this can take 10–60s.";
  if (draftWrap) draftWrap.innerHTML = "";
  let r = null;
  try {
    r = await api("/agent/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: "auto", instruction }) });
  } catch { r = null; }
  restore();
  chips.forEach((c) => { c.disabled = false; });
  _endDrafting = false;
  // Stale guard: if the view re-rendered (or we left), the captured refs are detached —
  // re-query the LIVE nodes after confirming we're still the current render.
  if (myToken !== pollToken) return;
  status = view.querySelector("#endDraftStatus");
  draftWrap = view.querySelector("#endDraft");
  if (!status || !draftWrap) return;
  const p = r && r.proposal;
  const cardio = p && p.parsed && Array.isArray(p.parsed.cardio) ? p.parsed.cardio : [];
  if (!p || (r && r.error) || !p.parsed) {
    // Honest cause: no agent configured → point at Settings (the rest of the app does).
    status.textContent = (r && r.agent_status === "unconfigured")
      ? "Drafting runs needs a coaching agent — connect one in Settings. You can still edit runs in Training."
      : "The coach couldn't finish — try again, or pick another agent in Settings.";
    return;
  }
  if (!cardio.length) {
    // The coach answered, but with strength / restructure changes rather than runs.
    status.innerHTML = `The coach proposed plan changes but no runs this time. <button class="end-link" id="endToCoach">Review in Coach →</button>`;
    const toCoach = status.querySelector("#endToCoach");
    if (toCoach) toCoach.addEventListener("click", () => renderCoach());
    return;
  }
  status.textContent = "";
  draftWrap.innerHTML = endDraftCardHtml(p);
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
// Downscale + re-encode a picked photo to JPEG before upload: phone camera
// shots are 3-12MB HEIC/JPEG; ~1280px @ q0.82 is plenty for a plate estimate
// (and Safari decodes HEIC natively, so re-encoding also normalizes the type).
async function compressChatImage(file, maxEdge = 1280, quality = 0.82) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Couldn't read that image"));
      i.src = url;
    });
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL("image/jpeg", quality);
    return { dataUrl, base64: dataUrl.split(",")[1], mime: "image/jpeg" };
  } finally { URL.revokeObjectURL(url); }
}

// Convert a SQLite UTC timestamp ("YYYY-MM-DD HH:MM:SS") to a local YYYY-MM-DD
// for day grouping; falls back to today on anything unparseable.
function chatDayISO(ts) {
  if (!ts) return localISO();
  const d = new Date(String(ts).replace(" ", "T") + "Z");
  return isNaN(d.getTime()) ? localISO() : localISO(d);
}

function chatDivider(iso) {
  const el = document.createElement("div");
  el.className = "chat-divider";
  el.dataset.day = iso;
  el.innerHTML = `<span>${escHtml(dateLabel(iso))}</span>`;
  return el;
}

// Starter chips shown while the conversation is empty (fresh chat / after a
// fresh start); tapping one prefills the input and sends through the normal
// send path. They vanish as soon as the first message lands (appendMsg removes them).
const CHAT_STARTERS = ["Plan my week", "Evaluate my last meal", "How's my progress?", "Swap today's workout"];
function drawChatChips(log) {
  const wrap = document.createElement("div");
  wrap.className = "chat-chips";
  wrap.innerHTML = CHAT_STARTERS.map((t, i) => `<button class="chat-chip" style="--i:${i}">${escHtml(t)}</button>`).join("");
  log.appendChild(wrap);
  wrap.querySelectorAll(".chat-chip").forEach((b) => b.addEventListener("click", () => {
    const input = $("#chatInput");
    if (!input) return;
    input.value = b.textContent;
    const send = $("#chatSend");
    if (send) send.click();
  }));
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
  const wrap = document.createElement("div");
  wrap.id = "hdrChatActions";
  wrap.className = "hdr-chat-actions";

  // history + search: always available (past conversations live on even when
  // the current thread is empty).
  const hist = document.createElement("button");
  hist.id = "hdrHistory";
  hist.className = "hdrcircbtn";
  hist.setAttribute("aria-label", "Past conversations & search");
  hist.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3.5 12a8.5 8.5 0 1 1 2.5 6"/><path d="M3.5 12H6M3.5 12V9.5"/><path d="M12 7.5V12l3 2"/>
    </svg>`;
  hist.addEventListener("click", openChatHistory);

  // fresh start (sparkle, two-tap confirm) — unchanged behavior.
  const b = document.createElement("button");
  b.id = "hdrFresh";
  b.className = "freshbtn";
  b.hidden = true;
  b.setAttribute("aria-label", "Start a fresh conversation");
  b.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 4.2l1.7 4.1 4.1 1.7-4.1 1.7L12 15.8l-1.7-4.1-4.1-1.7 4.1-1.7Z"/>
      <path d="M18.6 14.6l.7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7-1.7-.7 1.7-.7Z"/>
      <path d="M5.4 16.2l.55 1.35 1.35.55-1.35.55-.55 1.35-.55-1.35-1.35-.55 1.35-.55Z"/>
    </svg><span class="freshbtn-txt">Start fresh?</span>`;
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

  wrap.appendChild(hist);
  wrap.appendChild(b);
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
  drawChat([]);
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
  pill.innerHTML = `<span class="distill-check">✓</span><span>${n ? `${n} thing${n === 1 ? "" : "s"} remembered` : "Fresh start"}</span>`;
  host.prepend(pill);
  requestAnimationFrame(() => pill.classList.add("fresh-pill-in"));
  setTimeout(() => { pill.classList.remove("fresh-pill-in"); setTimeout(() => pill.remove(), 360); }, 2600);
}

async function renderChat() {
  headerTitle.textContent = "Chat";
  document.body.classList.add("chat-mode"); // the chat column owns the viewport; drop body's tab-bar padding
  chatTeardownMonitor(); // the log is about to be rebuilt — drop the old stream + bubble map
  const token = ++pollToken; // bump so the async hydrate below can detect a stale tab
  const { freshBtn } = ensureChatHeaderBtns();
  // Paint the shell FIRST so the composer is usable instantly; the log hydrates
  // in the background. The flex viewport column keeps the composer pinned above
  // the tab bar no matter how the OS zooms (height is re-measured, not magic).
  view.innerHTML = `
    <div class="chatview">
      <div class="chatlog-wrap">
        <div id="chatlog" class="chatlog" aria-live="polite"></div>
        <button id="chatJump" class="chat-jump" hidden aria-label="Jump to latest">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 10l6 6 6-6"/></svg>
        </button>
      </div>
      <div class="chatdock">
        <div id="chatPreview" class="chat-preview" hidden>
          <img alt="">
          <span class="chat-preview-hint">Photo attached — I'll estimate &amp; log it</span>
          <button id="chatPreviewX" class="chip-x" aria-label="Remove photo">✕</button>
        </div>
        <div class="chatbar">
          <button id="chatCam" class="attachbtn cambtn" aria-label="Take a photo of your plate">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.2l1.1-1.7A1.5 1.5 0 0 1 10.05 3.6h3.9a1.5 1.5 0 0 1 1.25.7L16.3 6h1.2A2.5 2.5 0 0 1 20 8.5V17a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17Z"/>
              <circle cx="12" cy="12.5" r="3.4"/>
            </svg>
          </button>
          <button id="chatAttach" class="attachbtn" aria-label="Attach a photo from your library or files">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="4" y="5" width="16" height="14" rx="2.5"/>
              <circle cx="9.2" cy="10" r="1.5"/>
              <path d="M4 16.5l4.4-4.2 3.4 3.2 3.1-2.9L20 16.5"/>
            </svg>
          </button>
          <input id="chatCamFile" type="file" accept="image/*" capture="environment" hidden>
          <input id="chatFile" type="file" accept="image/*" hidden>
          <textarea id="chatInput" rows="1" autocomplete="off" placeholder="Ask your coach, log a ride, snap a plate…"></textarea>
          <button id="chatSend" class="logbtn">↑</button>
        </div>
        <div class="chatnote">Logs save instantly. Plan changes arrive as drafts for you to apply.</div>
      </div>
    </div>`;

  const log = $("#chatlog");
  log.innerHTML = loadingState("Catching up…");
  wireChatJump(log, $("#chatJump"));
  measureChatTop();
  requestAnimationFrame(measureChatTop); // re-measure once layout/fonts settle

  const input = $("#chatInput"), sendBtn = $("#chatSend");
  const fileInput = $("#chatFile"), camInput = $("#chatCamFile");
  const attachBtn = $("#chatAttach"), camBtn = $("#chatCam"), preview = $("#chatPreview");
  let attached = null; // { dataUrl, base64, mime }

  const clearAttach = () => {
    attached = null;
    fileInput.value = "";
    camInput.value = "";
    preview.hidden = true;
    attachBtn.classList.remove("has-img");
    camBtn.classList.remove("has-img");
  };
  const attachFile = async (f) => {
    if (!f) return;
    try {
      attached = await compressChatImage(f);
      preview.querySelector("img").src = attached.dataUrl;
      preview.hidden = false;
      attachBtn.classList.add("has-img");
      camBtn.classList.add("has-img");
    } catch { toast("Couldn't read that image — try another."); clearAttach(); }
  };
  attachBtn.addEventListener("click", () => fileInput.click());
  camBtn.addEventListener("click", () => camInput.click());
  $("#chatPreviewX").addEventListener("click", clearAttach);
  for (const inp of [fileInput, camInput]) {
    inp.addEventListener("change", () => {
      const f = inp.files && inp.files[0];
      if (f) attachFile(f);
    });
  }
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
    const userBubble = appendMsg({ role: "user", content: text || "(photo)", meta: img ? { image: img.dataUrl } : null });
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
  // Re-pin the column when the keyboard opens/closes. iOS reports the new
  // visual-viewport metrics a frame or two late, so settle with a double rAF —
  // this is what kills the stale gap left behind after the keyboard drops.
  for (const ev of ["focus", "blur"]) {
    input.addEventListener(ev, () => {
      measureChatTop();
      requestAnimationFrame(() => requestAnimationFrame(measureChatTop));
    });
  }
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
  freshBtn.hidden = !msgs.length;
  drawChat(msgs);
  // Rebuild any in-flight + queued turns from the server and resume streaming.
  chatReconnect();
  requestAnimationFrame(measureChatTop);
}

function drawChat(msgs) {
  const log = $("#chatlog");
  log.innerHTML = "";
  if (!msgs.length) {
    log.innerHTML = `<div class="empty">Say hi, log a ride, or ask the coach to change your plan.</div>`;
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
    const bar = document.createElement("div");
    bar.className = "chat-earlierbar";
    bar.innerHTML = `<button class="earlierbtn">Show earlier ↑</button>`;
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
  const photo = meta?.image ? `<img class="bubble-img" alt="attached photo" loading="lazy" src="${escAttr(meta.image)}" onerror="this.remove()">` : "";
  const time = `<span class="bubble-time">${escHtml(chatClock(m.created_at))}</span>`;
  const canCopy = m.role === "assistant" && !hideText && !!m.content;
  const copyBtn = canCopy ? `<button class="bubble-copy" aria-label="Copy reply" title="Copy">${COPY_ICON}</button>` : "";
  el.innerHTML = `${copyBtn}${photo}${body}${extra}${time}`;
  if (before) host.insertBefore(el, before); else host.appendChild(el);
  el.querySelectorAll("[data-apply]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    const r = await api(`/proposals/${b.dataset.apply}/apply`, { method: "POST" });
    const clamped = r && Array.isArray(r.clamped) && r.clamped.length;
    if (clamped) toast("Applied · adjusted to a safe step");
    else toast(r.restructured ? "Plan restructured" : "Applied");
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
// Durable agent jobs — kind-agnostic non-blocking ops + live (SSE) progress.
//
// The general-purpose counterpart to the chat-turn client below: any heavy/agentic
// op (session-suggest, meal-plan, recipe, nutrition-checkin, day-read override,
// insight, chat-distill) is enqueued as a server-side job and streamed for
// evolving progress. Structurally mirrors the chat SSE client (chatOpenStream /
// chatReconnect / teardown), but with a SEPARATE jobStreams Map so the single chat
// EventSource is never disturbed, and no `delta` (these are one-shot JSON results).
//
// THE WIRE CONTRACT (the server toggle makes this robust to either shape):
//   • Enqueue: the op's POST returns {ok, job:{id,kind,status,phase,created_at}}
//     when backgrounding is ON; the LEGACY inline result (no `.job`) when OFF.
//     `runOp` branches on `.job` — stream it, or render the inline result now.
//   • GET /api/agent-jobs            → {ok, jobs:[…]} active, oldest-first
//   • GET /api/agent-jobs/:id        → {ok, job}  (a done job carries job.result)
//   • SSE /api/agent-jobs/:id/stream → snapshot{job,result?} · phase{job}
//       (job.meta.frac={done,total} drives the determinate filament) ·
//       done{job,result} · error{job,message} · canceled{job}
//   • POST /api/agent-jobs/:id/cancel → {ok, job}
//   • CRUCIAL: a done event's `result` is byte-for-byte the object the endpoint
//     returned synchronously before — so a `done` handler reuses the old await-path
//     render verbatim.
//
// HOW A CALL SITE ADOPTS IT (askForSession before/after):
//   BEFORE: btnBusy + a client AbortController + `await api('/session-suggest',…)`
//           then render r.session.
//   AFTER:  runOp('session_suggest', body, {
//             anchor:'#sugSlot', caption:'session_suggest',
//             render: (result) => { /* same render the await path used: r.session */ },
//             onFail: () => { /* the gentle inline failure line */ },
//           });
//   No client timeout/AbortController — the job lives server-side and reconnects
//   after a reload via jobReconnect().
// ============================================================================

const jobStreams = new Map();   // jobId -> its open EventSource
const jobDone = new Set();      // job ids already finalized — keeps `done` idempotent
const jobHandlers = new Map();  // jobId -> { onPhase, onDone, onError, onCanceled, anchor }
// kind -> (job) => handlers | null. Lets jobReconnect rebuild a stream's handlers
// after a RELOAD (when the in-memory jobHandlers map is gone) — a call site that
// wants its op to survive a reload registers a reconnector here once. The factory
// recreates the host/caption and returns the same handlers runOp would have used.
const jobReconnectors = new Map();
function registerJobReconnector(kind, factory) { jobReconnectors.set(kind, factory); }

// POST the op's endpoint and return the parsed response. Callers branch on `.job`
// (background mode) vs a legacy inline result (toggle off). Throws on transport
// failure so the caller can show its own gentle failure line.
async function enqueueJob(path, body) {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
}

// Open an SSE stream on a job, wiring snapshot/phase/done/error/canceled exactly
// like the chat client. Each handler is guarded by `guard()` (the anchor leaving
// the DOM drops the stream but leaves the job running server-side). `done` is
// idempotent via the jobDone Set. `handlers` = { guard?, onSnapshot?, onPhase?,
// onDone?, onError?, onCanceled? }.
function openJobStream(jobId, handlers = {}) {
  if (jobStreams.has(jobId)) return; // already streaming this job
  let es;
  try { es = new EventSource(withToken(`/api/agent-jobs/${jobId}/stream`)); }
  catch { return; }
  jobStreams.set(jobId, es);
  jobHandlers.set(jobId, handlers);

  const close = () => {
    const cur = jobStreams.get(jobId);
    if (cur === es) jobStreams.delete(jobId);
    try { es.close(); } catch {}
  };
  // Leaving the host DOM: drop the connection, keep the job alive server-side.
  const guard = () => {
    if (typeof handlers.guard === "function" && handlers.guard()) { close(); return true; }
    return false;
  };
  const terminal = () => { close(); jobHandlers.delete(jobId); };
  const finish = (job, result) => {
    if (jobDone.has(jobId)) return;
    jobDone.add(jobId);
    try { handlers.onDone?.(result, job); } catch {}
  };

  es.addEventListener("snapshot", (e) => {
    if (guard()) return;
    let d; try { d = JSON.parse(e.data); } catch { return; }
    const job = d.job || d;
    if (job && ["done", "error", "canceled"].includes(job.status)) {
      if (job.status === "done") finish(job, d.result != null ? d.result : job.result);
      else if (job.status === "canceled") { try { handlers.onCanceled?.(job); } catch {} }
      else { try { handlers.onError?.(d.message || job.error, job); } catch {} }
      terminal();
    } else { try { handlers.onSnapshot?.(job); handlers.onPhase?.(job); } catch {} }
  });
  es.addEventListener("phase", (e) => {
    if (guard()) return;
    let d; try { d = JSON.parse(e.data); } catch { return; }
    try { handlers.onPhase?.(d.job || d); } catch {}
  });
  es.addEventListener("done", (e) => {
    if (guard()) return;
    let d; try { d = JSON.parse(e.data); } catch { return; }
    finish(d.job, d.result); terminal();
  });
  es.addEventListener("canceled", (e) => {
    if (guard()) return;
    let d; try { d = JSON.parse(e.data); } catch { return; }
    try { handlers.onCanceled?.(d.job); } catch {}
    terminal();
  });
  es.addEventListener("error", (e) => {
    // App-level error carries data; a bare native connection blip does not — leave
    // the latter so EventSource auto-reconnects (it just re-receives the snapshot).
    if (!e.data) return;
    if (guard()) return;
    let d; try { d = JSON.parse(e.data); } catch { return; }
    try { handlers.onError?.(d.message || d.job?.error, d.job); } catch {}
    terminal();
  });
}

// Re-attach a stream to every active job whose host still exists (or can be
// recreated). Called at boot so a running op picks back up after a reload/restart.
// Hosts are rebuilt by the kind's registered reconnector (jobReconnectors), keyed
// by job.kind — not by any DOM attribute.
async function jobReconnect() {
  let jobs = [];
  try { const r = await api("/agent-jobs"); jobs = (r && r.jobs) || (Array.isArray(r) ? r : []); } catch { jobs = []; }
  for (const job of jobs) {
    if (!job || jobStreams.has(job.id)) continue;
    // Prefer live handlers (this session); else rebuild them via the kind's
    // registered reconnector (survives a reload — the in-memory map is empty then).
    let handlers = jobHandlers.get(job.id);
    if (!handlers) {
      const factory = jobReconnectors.get(job.kind);
      if (!factory) continue; // unknown op (or no host yet) — a later render retries
      try { handlers = factory(job); } catch { handlers = null; }
    }
    if (handlers) openJobStream(job.id, handlers);
  }
}

// Drop streams for jobs matching `pred(jobId)` (default: all) — used when leaving
// a hosting surface. Leaves the jobs running server-side; jobReconnect re-attaches.
function teardownJobs(pred) {
  for (const [id, es] of [...jobStreams.entries()]) {
    if (pred && !pred(id)) continue;
    try { es.close(); } catch {}
    jobStreams.delete(id);
    jobHandlers.delete(id);
  }
}

// The one-call adoption helper. Enqueues the op (at `path`), then:
//   • background mode ({.job}) → open the stream, run `caption` on the anchor,
//     wire a determinate filament from phase frac, render `result` on `done`;
//   • toggle OFF (legacy inline result) → render immediately, exactly as today.
// Options:
//   path     — the op's POST endpoint (e.g. "/session-suggest"). The endpoint
//              decides background-vs-inline; runOp handles both shapes. Required.
//   anchor   — CSS selector for the host element (the caption slot + the
//              determinate filament render here).
//   render   — (result, job?) => void. The SAME render the old await path used.
//   onFail   — (errOrNull) => void. Designed-failure / unreachable line.
//   caption  — a THINKING_SCRIPTS key (or omit for the host's existing caption).
//   isFail   — (result) => bool. Treats a truthy result as a designed failure
//              (e.g. r.ok === false). Default: !result || result.ok === false.
//   guard    — () => bool, true when the host left the DOM (default: the anchor
//              is gone). Drops the stream, keeps the job alive server-side.
// `kind` is the op discriminator + reconnect key: the server echoes it as job.kind,
// and jobReconnect rebuilds this host via the matching registered reconnector.
async function runOp(_kind, body, opts = {}) {
  const { path, anchor, render, onFail, caption, isFail, guard } = opts;
  if (!path) return;
  const failCheck = isFail || ((r) => !r || r.ok === false);
  const host = anchor ? document.querySelector(anchor) : null;
  const anchorGone = () => (anchor ? !document.querySelector(anchor)?.isConnected : false);
  const guardFn = guard || anchorGone;
  const clearFilament = (h) => { if (h) { h.classList.remove("is-thinking", "is-thinking--determinate"); h.style.removeProperty("--frac"); } };

  // Start a caption + filament on the host while we wait (warm, evolving).
  let stopCaption = () => {};
  const capEl = host ? host.querySelector(".job-cap, .typing-cap") : null;
  if (capEl && caption) stopCaption = thinkingCaption(capEl, caption);
  if (host && !reducedMotion()) host.classList.add("is-thinking");

  const renderResult = (result, job) => {
    stopCaption();
    clearFilament(anchor ? document.querySelector(anchor) : null);
    if (failCheck(result)) { onFail?.(result); return; }
    try { render?.(result, job); } catch {}
  };
  const fail = (err) => { stopCaption(); clearFilament(anchor ? document.querySelector(anchor) : null); onFail?.(err); };

  let resp;
  try { resp = await enqueueJob(path, body); }
  catch { fail(null); return; }

  // Toggle OFF: a legacy inline result — render now, exactly as the old await path.
  if (!resp || !resp.job) { renderResult(resp); return; }

  // Background mode: stream the job.
  const job = resp.job;
  openJobStream(job.id, {
    guard: guardFn,
    onPhase: (j) => {
      const h = anchor ? document.querySelector(anchor) : null;
      const frac = j && j.meta && j.meta.frac;
      if (h && frac && frac.total > 0 && !reducedMotion()) {
        h.classList.add("is-thinking--determinate");
        h.style.setProperty("--frac", String(Math.max(0, Math.min(1, frac.done / frac.total))));
      }
    },
    onDone: (result, j) => renderResult(result, j),
    onError: (msg) => fail(msg || null),
    onCanceled: () => fail(null),
  });
  return job;
}

// ============================================================================
// Durable chat turns — non-blocking queue + live (SSE) progress.
//
// A chat turn is now a server-side job (chat_turns): POST /api/chat enqueues it
// and returns at once, so the composer is never blocked — a follow-up typed
// while the coach is thinking just queues. Each active turn gets a pending
// "Queued…/Thinking…" bubble; a SINGLE EventSource streams the oldest active
// turn's real phases (the server emits them — never faked tokens) and advances
// to the next as each finishes. The queue + draft survive a tab switch, reload,
// or server restart: the unsent draft is mirrored to localStorage, and the
// in-flight + queued thread is rebuilt from GET /api/chat/turns on every render.
// ============================================================================

const CHAT_DRAFT_KEY = "cairn.chat.draft";
function saveChatDraft(v) { try { v ? localStorage.setItem(CHAT_DRAFT_KEY, v) : localStorage.removeItem(CHAT_DRAFT_KEY); } catch {} }
function loadChatDraft() { try { return localStorage.getItem(CHAT_DRAFT_KEY) || ""; } catch { return ""; } }

let chatStream = null;        // the single open EventSource
let chatStreamId = null;      // the turn id it's streaming
const chatPendingBubbles = new Map(); // turnId -> its pending/streaming assistant bubble
const chatStreamText = new Map();     // turnId -> accumulated streamed reply text (live tokens)
const chatDoneTurns = new Set();      // turn ids already finalized — keeps finalize idempotent

// Honest, server-driven phase caption (NOT a faked token stream / timer).
function chatPhaseCaption(turn) {
  if (!turn) return "Thinking…";
  if (turn.status === "queued") return "Queued";
  if (turn.phase === "applying") return "Saving…";
  return turn.image_url ? "Reading your plate…" : "Thinking…";
}

// Build a pending bubble (same vocabulary as appendMsg's typing indicator) with
// a Stop control, WITHOUT appending it — the caller positions it.
function makePendingBubble(turn) {
  const el = document.createElement("div");
  el.className = "bubble assistant pending bubble-in";
  el.setAttribute("role", "status");
  el.setAttribute("aria-busy", "true");
  el.dataset.turn = turn.id;
  const cap = chatPhaseCaption(turn);
  el.innerHTML = `<div class="bubble-text"><span class="typing-cap">${escHtml(cap)} </span>` +
    `<span class="typing" aria-hidden="true"><i></i><i></i><i></i></span>` +
    `<button class="turn-stop" type="button" aria-label="Stop this turn">Stop</button></div>`;
  el.querySelector(".turn-stop").addEventListener("click", () => cancelTurn(turn.id));
  return el;
}

function setPendingCaption(el, txt) {
  const cap = el && el.querySelector(".typing-cap");
  if (!cap) return;
  cap.textContent = txt + " ";
  if (!reducedMotion()) { cap.style.animation = "none"; void cap.offsetWidth; cap.style.animation = ""; }
}

// First live token: convert a pending (typing-dots) bubble into a streaming text
// bubble — a growing text node + a blinking caret + the Stop control. Built once;
// later tokens just update the text node (cheap — markdown is rendered only at
// finalize). Returns the bubble, or null if it's gone (navigated away).
function ensureStreamingBubble(id) {
  const el = chatPendingBubbles.get(id);
  if (!el || !el.isConnected) return null;
  if (!el.classList.contains("streaming")) {
    el.classList.remove("pending");
    el.removeAttribute("aria-busy");
    el.classList.add("streaming");
    el.innerHTML =
      `<div class="bubble-text"><span class="stream-text"></span><span class="stream-caret" aria-hidden="true"></span></div>` +
      `<button class="turn-stop" type="button" aria-label="Stop this turn">Stop</button>`;
    el.querySelector(".turn-stop").addEventListener("click", () => cancelTurn(id));
  }
  return el;
}

function appendStreamDelta(id, text) {
  if (!text) return;
  const el = ensureStreamingBubble(id);
  if (!el) return;
  const next = (chatStreamText.get(id) || "") + text;
  chatStreamText.set(id, next);
  const span = el.querySelector(".stream-text");
  if (span) span.textContent = next;
  // Keep pinned to the latest only if the reader is already near the bottom.
  const log = $("#chatlog");
  if (log && log.scrollHeight - log.scrollTop - log.clientHeight < 200) log.scrollTop = log.scrollHeight;
}

// A streaming attempt fell back to one-shot: drop the partial text and return the
// bubble to its calm "Thinking…" state until the final reply lands.
function resetStreamingBubble(id) {
  chatStreamText.delete(id);
  const el = chatPendingBubbles.get(id);
  if (!el || !el.isConnected) return;
  el.classList.remove("streaming");
  el.classList.add("pending");
  el.setAttribute("aria-busy", "true");
  el.innerHTML =
    `<div class="bubble-text"><span class="typing-cap">Thinking… </span>` +
    `<span class="typing" aria-hidden="true"><i></i><i></i><i></i></span>` +
    `<button class="turn-stop" type="button" aria-label="Stop this turn">Stop</button></div>`;
  el.querySelector(".turn-stop").addEventListener("click", () => cancelTurn(id));
}

// Place a turn's pending bubble after its user message (so order holds even with
// several queued), tracked in chatPendingBubbles.
function spawnPendingBubble(turn) {
  const log = $("#chatlog");
  if (!log || chatPendingBubbles.has(turn.id)) return chatPendingBubbles.get(turn.id) || null;
  const el = makePendingBubble(turn);
  const anchor = turn.user_message_id ? log.querySelector(`[data-mid="${turn.user_message_id}"]`) : null;
  if (anchor && anchor.parentElement === log) anchor.after(el);
  else log.appendChild(el);
  chatPendingBubbles.set(turn.id, el);
  log.scrollTop = log.scrollHeight;
  return el;
}

// Replace a turn's pending bubble with its final message, in place.
function finalizeTurn(turn, message) {
  const id = turn?.id;
  if (id != null) { if (chatDoneTurns.has(id)) return; chatDoneTurns.add(id); } // idempotent: never append twice
  const el = chatPendingBubbles.get(id);
  chatPendingBubbles.delete(id);
  chatStreamText.delete(id);
  const m = message || {
    role: "assistant",
    content: (turn && (turn.reply || turn.error)) || "(no reply)",
    meta: turn && turn.meta,
    created_at: turn && turn.finished_at,
    id: turn && turn.assistant_message_id,
  };
  appendMsg(m, false, null, { before: el });
  if (el && el.isConnected) el.remove();
  if (turn && (turn.meta?.drafts || []).length) { state.plan = []; toast("Draft ready — Apply below"); }
}

// A stopped turn settles into a quiet "Stopped" note in place.
function finalizeCanceled(turn) {
  const id = turn?.id;
  if (id != null) { if (chatDoneTurns.has(id)) return; chatDoneTurns.add(id); } // idempotent
  const el = chatPendingBubbles.get(id);
  chatPendingBubbles.delete(id);
  chatStreamText.delete(id);
  if (el && el.isConnected) {
    el.classList.remove("pending");
    el.removeAttribute("aria-busy");
    el.classList.add("turn-stopped");
    el.innerHTML = `<span class="turn-stopped-note">Stopped</span>`;
  }
}

// Stop a queued or running turn. The POST returns the canceled turn; we finalize
// locally (the SSE 'canceled' event, if this is the streamed turn, is idempotent).
async function cancelTurn(id) {
  let r = null;
  try { r = await api(`/chat/turns/${id}/cancel`, { method: "POST" }); } catch {}
  finalizeCanceled(r?.turn || { id });
  if (chatStreamId === id) closeChatStream();
  chatMonitorEnsure();
}

function closeChatStream() {
  if (chatStream) { try { chatStream.close(); } catch {} }
  chatStream = null;
  chatStreamId = null;
}

function chatTeardownMonitor() {
  closeChatStream();
  chatPendingBubbles.clear();
  chatStreamText.clear();
  chatDoneTurns.clear();
}

// Open the single EventSource on the oldest active turn that still has a bubble.
function chatMonitorEnsure() {
  if (chatStream || state.tab !== "chat") return;
  const ids = [...chatPendingBubbles.keys()].filter((id) => chatPendingBubbles.get(id)?.isConnected).sort((a, b) => a - b);
  if (!ids.length) return;
  chatOpenStream(ids[0]);
}

function chatOpenStream(id) {
  chatStreamId = id;
  let es;
  try { es = new EventSource(withToken(`/api/chat/turns/${id}/stream`)); }
  catch { chatStreamId = null; return; }
  chatStream = es;

  // If we navigated away mid-stream, drop the connection — the turn keeps running
  // server-side and is rebuilt from /chat + /chat/turns when chat re-renders.
  const guard = () => {
    if (state.tab === "chat" && document.getElementById("chatlog")) return false;
    if (chatStream === es) closeChatStream();
    else { try { es.close(); } catch {} }
    return true;
  };
  const terminal = () => { if (chatStream === es) closeChatStream(); else { try { es.close(); } catch {} } chatMonitorEnsure(); };
  const phase = (turn) => { const el = chatPendingBubbles.get(id); if (el?.isConnected) setPendingCaption(el, chatPhaseCaption(turn)); };

  es.addEventListener("snapshot", (e) => {
    if (guard()) return;
    const d = JSON.parse(e.data);
    if (d.turn && ["done", "error", "canceled"].includes(d.turn.status)) {
      if (d.turn.status === "canceled") finalizeCanceled(d.turn); else finalizeTurn(d.turn, d.message);
      terminal();
    } else { phase(d.turn || d); }
  });
  es.addEventListener("phase", (e) => { if (guard()) return; phase(JSON.parse(e.data).turn); });
  es.addEventListener("delta", (e) => { if (guard()) return; appendStreamDelta(id, JSON.parse(e.data).text); });
  es.addEventListener("reset", () => { if (guard()) return; resetStreamingBubble(id); });
  es.addEventListener("done", (e) => { if (guard()) return; const d = JSON.parse(e.data); finalizeTurn(d.turn, d.message); terminal(); });
  es.addEventListener("canceled", (e) => { if (guard()) return; finalizeCanceled(JSON.parse(e.data).turn); terminal(); });
  es.addEventListener("error", (e) => {
    // Our app-level error carries data; the native EventSource connection-error
    // event does not — leave the latter alone so it auto-reconnects (a blip just
    // re-receives the snapshot). On an app error, finalize and stop reconnecting.
    if (e.data) { if (guard()) return; const d = JSON.parse(e.data); finalizeTurn(d.turn, d.message); terminal(); }
  });
}

// Rebuild the in-flight + queued thread from the server (durable across reload /
// restart). User messages are already drawn from /chat; we add a pending bubble
// for each active turn that doesn't yet have one, then stream the oldest.
async function chatReconnect() {
  let turns = [];
  try { turns = await api("/chat/turns"); } catch { turns = []; }
  if (state.tab !== "chat" || !$("#chatlog")) return;
  for (const t of turns) spawnPendingBubble(t);
  chatMonitorEnsure();
}

// Show/hide the "jump to latest" pill as the log scrolls away from the bottom.
function wireChatJump(log, jump) {
  if (!log || !jump) return;
  const update = () => {
    const off = log.scrollHeight - log.scrollTop - log.clientHeight;
    jump.hidden = off < 120;
  };
  log.addEventListener("scroll", update, { passive: true });
  jump.addEventListener("click", () =>
    log.scrollTo({ top: log.scrollHeight, behavior: reducedMotion() ? "auto" : "smooth" }));
  update();
}

// Grow the chat composer to fit multi-line input (paste findings, describe a
// meal) up to a cap, then scroll inside it. The flex chat column lets the log
// shrink as the composer grows, so the conversation is never pushed off-screen.
function autosizeChatInput(el) {
  if (!el) return;
  const MAX = 140; // ~5 lines, mirrors the textarea's CSS max-height
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, MAX) + "px";
  el.style.overflowY = el.scrollHeight > MAX ? "auto" : "hidden";
}

// Size the chat surface to the live viewport so the composer is always pinned
// above the tab bar / keyboard — re-measured on zoom/keyboard/orientation, never
// a magic number. On mobile the header + column are pinned to the *visual*
// viewport via CSS vars (see the body.chat-mode block in styles.css): --cvt
// tracks iOS panning the visual viewport down (so the OS chrome can't slide over
// the input), and --chat-h fills the gap between the header and the tab bar
// (keyboard closed) or the keyboard (open). Desktop keeps the in-flow column.
function measureChatTop() {
  const cv = document.querySelector(".chatview");
  if (!cv) return;
  if (cv.style.height) cv.style.height = ""; // drop any inline height from an older build
  const header = document.querySelector("header");
  const tab = document.querySelector(".tabbar");
  const vv = window.visualViewport;
  const vh = vv ? vv.height : window.innerHeight;
  const offTop = vv ? vv.offsetTop : 0;
  const root = document.documentElement;
  if (matchMedia("(min-width:960px)").matches) {
    const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
    root.style.setProperty("--cvt", "0px");
    root.style.setProperty("--chat-top", "0px");
    root.style.setProperty("--chat-h", Math.max(220, vh - headerBottom - 18) + "px");
    return;
  }
  const headerH = header ? header.getBoundingClientRect().height : 0;
  // The tab bar's footprint in the visible viewport — collapses to 0 once the
  // keyboard is open (the bar sits behind it), so the column extends to the keyboard.
  const reserve = tab ? Math.max(0, vh - (tab.getBoundingClientRect().top - offTop)) : 0;
  root.style.setProperty("--cvt", Math.round(offTop) + "px");
  root.style.setProperty("--chat-top", Math.round(headerH) + "px");
  root.style.setProperty("--chat-h", Math.max(220, Math.round(vh - headerH - reserve)) + "px");
}

// ---------- chat history overlay (read-only browse + search) ----------
// A human day label for an archived UTC timestamp ("today" / "3 days ago" / …).
function histWhen(ts) { return humanDate(chatDayISO(ts)); }

// Escape text, then emphasize the search term with <mark> (safe — marks added
// after escaping). Term is regex-escaped.
function highlightTerm(text, q) {
  const esc = escHtml(text);
  const term = (q || "").trim();
  if (!term) return esc;
  try {
    const re = new RegExp("(" + term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig");
    return esc.replace(re, "<mark>$1</mark>");
  } catch { return esc; }
}

const HIST_CHEV = `<span class="chat-hist-chev" aria-hidden="true">›</span>`;
function histSessionRow(s) {
  return `<button class="chat-hist-item" data-session="${escAttr(s.archived_at)}">
    <span class="chat-hist-main">
      <span class="chat-hist-preview">${escHtml(s.preview || "Conversation")}</span>
      <span class="chat-hist-meta">${escHtml(histWhen(s.ended_at))} · ${s.count} message${s.count === 1 ? "" : "s"}</span>
    </span>${HIST_CHEV}</button>`;
}
function histHitRow(h, q) {
  const sess = h.archived_at || "live";
  return `<button class="chat-hist-item" data-open="${escAttr(sess)}">
    <span class="chat-hist-main">
      <span class="chat-hist-preview">${highlightTerm(h.snippet, q)}</span>
      <span class="chat-hist-meta">${h.role === "user" ? "You" : "Coach"} · ${escHtml(histWhen(h.created_at))}${h.archived_at ? "" : " · current"}</span>
    </span>${HIST_CHEV}</button>`;
}

// Open the read-only history/search overlay (reuses the .detail scaffold, so
// ✕ / Escape / backdrop / tab-switch all close it).
function openChatHistory() {
  const d = mountDetail(`
    <div class="chat-hist">
      <h2 class="detail-title">Conversations</h2>
      <div class="chat-hist-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        <input id="chatHistSearch" type="search" placeholder="Search every conversation…" autocomplete="off" autocapitalize="off">
      </div>
      <div id="chatHistBody" class="chat-hist-body"></div>
    </div>`);
  const body = d.querySelector("#chatHistBody");
  const searchInput = d.querySelector("#chatHistSearch");

  const renderSessions = async () => {
    body.innerHTML = loadingState("Gathering your conversations…");
    let sessions = [];
    try { sessions = await api("/chat/sessions"); } catch { sessions = []; }
    if (!d.isConnected || searchInput.value.trim()) return;
    if (!sessions.length) { body.innerHTML = `<div class="empty">No past conversations yet.<br>Start one, and a “fresh start” will tuck it here.</div>`; return; }
    body.innerHTML = `<div class="chat-hist-list">${sessions.map(histSessionRow).join("")}</div>`;
    body.querySelectorAll("[data-session]").forEach((el) =>
      el.addEventListener("click", () => openConversation(el.dataset.session)));
  };

  const runSearch = async (q) => {
    body.innerHTML = loadingState("Searching…");
    let hits = [];
    try { hits = await api("/chat/search?q=" + encodeURIComponent(q)); } catch { hits = []; }
    if (!d.isConnected || searchInput.value.trim() !== q) return; // stale / cleared
    if (!hits.length) { body.innerHTML = `<div class="empty">No matches for “${escHtml(q)}”.</div>`; return; }
    body.innerHTML = `<div class="chat-hist-list">${hits.map((h) => histHitRow(h, q)).join("")}</div>`;
    body.querySelectorAll("[data-open]").forEach((el) => el.addEventListener("click", () => {
      const sess = el.dataset.open;
      if (sess === "live") { closeDetail(); toast("In your current conversation"); return; }
      openConversation(sess);
    }));
  };

  const openConversation = async (archivedAt) => {
    body.innerHTML = loadingState("Opening…");
    let msgs = [];
    try { msgs = await api("/chat/sessions/" + encodeURIComponent(archivedAt)); } catch { msgs = []; }
    if (!d.isConnected) return;
    body.innerHTML = `<button class="chat-hist-back">← All conversations</button><div id="chatHistConvo" class="chatlog chat-hist-convo"></div>`;
    body.querySelector(".chat-hist-back").addEventListener("click", () => { searchInput.value = ""; renderSessions(); });
    const convo = body.querySelector("#chatHistConvo");
    let lastDay = null;
    for (const m of msgs) {
      const day = chatDayISO(m.created_at);
      if (day !== lastDay) { convo.appendChild(chatDivider(day)); lastDay = day; }
      appendMsg(m, true, convo, { readonly: true });
    }
  };

  let searchTimer = 0;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (!q) { renderSessions(); return; }
    searchTimer = setTimeout(() => runSearch(q), 250);
  });

  renderSessions();
}

