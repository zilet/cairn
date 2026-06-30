// ==== 07-me-health.js ====
type HealthPictureCache = { review?: Record<string, unknown> | null; docCount?: number; newestDocAt?: string | null };
// _hPic is intentionally a true global var: the Records screen mutates it while
// this screen owns rendering the health picture cache.
var _hPic: HealthPictureCache | null = null;        // { review, docCount, newestDocAt }
{
type HealthScreenRecord = Record<string, unknown>;
type HealthMemory = import("../contracts/client-api.js").ClientMemory;
type HealthProfile = import("../contracts/client-api.js").ClientProfile & {
  age?: number | string | null;
  height_cm?: number | string | null;
  endurance_goal_json?: string | null;
  endurance_sport?: string | null;
  allergies?: string | null;
  dietary_restrictions?: string | null;
};
type HealthGoalCheck = import("../contracts/client-api.js").ClientGoalCheck & {
  tdee?: number | string | null;
  requested?: { aggressive?: boolean; [key: string]: unknown } | null;
  recommended?: {
    target_intake_kcal?: number | string | null;
    protein_g?: number | string | null;
    weekly_rate_lb?: number | string | null;
    [key: string]: unknown;
  } | null;
};
type HealthReviewRunResult = { ok?: boolean; review?: HealthScreenRecord; error?: string } | null;
type HealthReviewRecord = HealthScreenRecord & { created_at?: string; error?: unknown };
type HealthDocumentRow = HealthScreenRecord & { created_at?: string };
type MarkerPriorityResponse = { markers?: HealthMarkerRow[]; groups?: HealthMarkerGroup[] };
type HealthSynthesisPriority = HealthScreenRecord & {
  label?: string;
  the_move?: string;
  recheck?: string;
};
type HealthSynthesisPayload = HealthScreenRecord & {
  synthesis?: (HealthScreenRecord & {
    headline?: string;
    story?: string;
    priorities?: HealthSynthesisPriority[];
    one_change?: string;
    generated_at?: string;
    stale?: unknown;
  }) | null;
  focus?: HealthScreenRecord & { priorities?: unknown[] };
  stale?: unknown;
};
type SymptomMarker = HealthScreenRecord & { name?: string; value?: unknown; unit?: string };
type SymptomLink = HealthScreenRecord & { note?: string; markers?: SymptomMarker[] };
type RecoverySummary = HealthScreenRecord & { has_data?: unknown };
type EnduranceGoalDraft = {
  mode?: string | null;
  event?: string | null;
  date?: string | null;
  target?: string | null;
  label?: string | null;
  distance_km?: number | string | null;
  weekly_km?: number | string | null;
};
type HealthMarkerGroup = { key: string; label?: string };
type HealthMarkerRow = HealthScreenRecord & {
  name?: string;
  key?: string;
  group?: string;
  group_label?: string;
};
type HealthSupplement = HealthScreenRecord & {
  id?: number | string;
  name?: string;
  dose?: string | null;
  frequency?: string | null;
  note?: string | null;
};
type WiredHealthElement<T extends HTMLElement = HTMLElement> = T & { _wired?: boolean };

function healthScreenRecord(value: unknown): HealthScreenRecord {
  return value && typeof value === "object" ? (value as HealthScreenRecord) : {};
}

function healthScreenRows<T extends HealthScreenRecord = HealthScreenRecord>(value: unknown): T[] {
  return Array.isArray(value) ? (value.filter((row) => !!row && typeof row === "object") as T[]) : [];
}

function healthInput(selector: string, root: ParentNode = document): HTMLInputElement | null {
  return root.querySelector<HTMLInputElement>(selector);
}

function healthTextArea(selector: string, root: ParentNode = document): HTMLTextAreaElement | null {
  return root.querySelector<HTMLTextAreaElement>(selector);
}

function healthInputValue(selector: string, root: ParentNode = document): string {
  return healthInput(selector, root)?.value ?? "";
}

function healthNumberValue(selector: string, root: ParentNode = document): number | null {
  const n = Number(healthInputValue(selector, root));
  return Number.isFinite(n) && healthInputValue(selector, root) !== "" ? n : null;
}

// ---------- Me (segmented: Profile / Memory / Health / Life) ----------
// Standing leads — Me opens to the REVIEW (where you stand + where to focus), not a
// data-entry form. The lab DATA (Health), identity (Profile), life, family and the
// curated Memory follow it: review first, entering/updating second.
const ME_SEG: readonly ClientSegment[] = [["standing", "Standing"], ["profile", "Profile"], ["health", "Health"], ["life", "Life"], ["family", "Family"], ["memory", "Memory"]];
// Lazy handler refs (arrow-wrapped like PROGRESS_HANDLERS/PLAN_HANDLERS): renderLife and
// renderFamily live in a later-loaded module, so bare references would resolve at parse
// time — before that script runs — and throw. Arrows defer resolution to call time, by
// which point every module is loaded. wireSeg/renderMe call handlers with no args.
const ME_HANDLERS: Record<ClientMeSection, () => unknown> = { standing: () => renderMeStanding(), profile: () => renderMeProfile(), memory: () => renderMemory(), health: () => renderHealth(), life: () => renderLife(), family: () => renderFamily() };
function renderMe() {
  headerTitle.textContent = "Me";
  pollToken++; // invalidate in-flight enrichment polls
  if (!state.meSeg) state.meSeg = "standing";
  return (ME_HANDLERS[state.meSeg] || renderMeStanding)();
}

// True when the Health → Read depth view is live — the whole-picture loaders
// (picture/synthesis/recovery/directives/markers/supplements) gate on this so a
// late async response never paints into a sibling tab.
function onHealthReadView() {
  return state.tab === "me" && state.meSeg === "health" && state.healthSeg === "read";
}

// The Standing review — the FIRST thing Me opens to. It leads with the conductor's
// whole-athlete "Where to focus" card (the cross-domain lead, tapping through to the
// plan), then the detailed where-you-stand health read below.
async function renderMeStanding() {
  headerTitle.textContent = "Me";
  state.meSeg = "standing";
  pollToken++; // invalidate in-flight enrichment polls from a sibling sub-view
  view.innerHTML = segBar("standing", ME_SEG)
    + `<div class="cfocus-slot cfocus-standing-slot" id="cfocusStandingSlot"></div>`
    + `<div id="hContent"></div>`;
  wireSeg(ME_HANDLERS);
  loadCoachingFocus("#cfocusStandingSlot", view); // the whole-athlete lead → planning
  paintStandingReview(); // the detailed where-you-stand health read
}

async function renderMeProfile() {
  headerTitle.textContent = "Me";
  state.meSeg = "profile";
  pollToken++; // invalidate in-flight enrichment polls from a sibling sub-view
  view.innerHTML = segSkeleton("profile", ME_SEG, 2); // skeleton-first: seg paints now, fields hydrate
  // Profile is identity + goals + allergies/diet ONLY. Capture lives on Today
  // (quick-log + frequents + voice + the bodyweight chip) and in Chat — never
  // duplicated here. The activity/nutrition HISTORY lives in Today's "Lately"
  // and Progress → History, not on Profile.
  const [profileRaw, goalRaw] = await Promise.all([api("/profile"), api("/goal")]);
  const p = healthScreenRecord(profileRaw) as HealthProfile;
  const goal = healthScreenRecord(goalRaw) as HealthGoalCheck;
  setDiscipline(p.primary_discipline); // keep the emphasis global in sync with what's on file
  setEnduranceGoalSet(!!p.endurance_goal_json);
  const disc = primaryDiscipline;
  // The endurance OBJECTIVE (v37) — race | standing | none. Parsed from the profile
  // row's JSON; the editor below lets the athlete set a race to build toward or a
  // standing "stay ready" target, orthogonal to the sport/discipline above.
  let egCur: EnduranceGoalDraft = {};
  try { egCur = p.endurance_goal_json ? (healthScreenRecord(JSON.parse(p.endurance_goal_json)) as EnduranceGoalDraft) : {}; } catch { egCur = {}; }
  const egMode = typeof egCur.mode === "string" && egCur.mode ? egCur.mode : "none";
  // The journey's SHAPE (v41) — lose | maintain | gain. Prefer the server's effective
  // mode (goal.goal_mode); fall back to the stored column, then derive for back-compat.
  const goalMode = (goal && goal.goal_mode) || p.goal_mode
    || ((p.goal_weight_lb != null && p.weight_lb != null && p.goal_weight_lb < p.weight_lb - 0.5) ? "lose" : "maintain");
  const num = (id: string, label: string, val: unknown, step: number | string = 1): string =>
    `<div class="field" style="margin-bottom:9px"><label>${label}</label>
     <input id="${id}" type="number" step="${step||1}" value="${val ?? ""}" class="form-input"></div>`;

  const reqWarn = goal?.requested?.aggressive
    ? `<div class="ex-flag" style="margin-top:0"><b>Goal too aggressive for lean mass.</b> ${goal.message}</div>`
    : `<div class="sess-line">${goal?.message || ""}</div>`;

  await skelSwap(() => { view.innerHTML = segBar("profile", ME_SEG) + `
    <div class="sess">
      <div class="sess-head"><span class="sess-date">Goal check</span><span class="sess-day">${goal?.tdee ? goal.tdee + " kcal TDEE" : ""}</span></div>
      ${reqWarn}
      ${goal?.recommended ? `<div class="sess-line" style="margin-top:6px"><b>${goal.goal_mode === "maintain" ? "Maintenance target" : goal.goal_mode === "gain" ? "Lean-gain target" : "Lean-safe target"}:</b> ${goal.recommended.target_intake_kcal} kcal \u00b7 ${goal.recommended.protein_g} g protein${goal.recommended.weekly_rate_lb ? ` \u00b7 ${goal.recommended.weekly_rate_lb} lb/wk` : ""}</div>` : ""}
    </div>
    <h1 class="lbl" style="margin:24px 0 8px">Profile</h1>
    <div id="profFields">
    <div class="field" style="margin-bottom:9px"><label for="name">Name <span class="ob-opt">— optional</span></label>
      <p class="aboutme-hint">Stamped on the doctor report you export from Health → Share. Leave empty to fill it in on paper instead.</p>
      <input id="name" type="text" placeholder="e.g. Alex Rivera" maxlength="120" value="${escAttr(p.name || "")}" class="form-input"></div>
    ${num("age","Age",p.age)}
    ${num("height_cm","Height (cm)",p.height_cm,0.1)}
    ${num("weight_lb","Weight (lb)",p.weight_lb,0.1)}
    <div class="field" style="margin-bottom:9px">
      <label>Your goal</label>
      <p class="aboutme-hint">Losing weight, holding steady, or a slow lean gain. Cairn fuels and frames everything around this \u2014 maintaining is a real goal, not "no goal". Change it anytime.</p>
      <div class="seg goalmode-seg" id="goalModeSeg" role="group" aria-label="Goal mode">
        <button type="button" class="segbtn${goalMode === "lose" ? " active" : ""}" data-goalmode="lose">Lose</button>
        <button type="button" class="segbtn${goalMode === "maintain" ? " active" : ""}" data-goalmode="maintain">Maintain</button>
        <button type="button" class="segbtn${goalMode === "gain" ? " active" : ""}" data-goalmode="gain">Gain</button>
      </div>
    </div>
    <div id="goalTargetFields" style="${goalMode === "maintain" ? "display:none" : ""}">
      ${num("goal_weight_lb","Goal weight (lb)",p.goal_weight_lb,0.1)}
      <div class="field" style="margin-bottom:9px"><label>Goal date <span class="ob-opt">\u2014 optional</span></label>
        <input id="goal_date" type="date" value="${p.goal_date || ""}" class="form-input"></div>
    </div>
    <p class="aboutme-hint" id="goalMaintainNote" style="margin:-2px 0 9px${goalMode === "maintain" ? "" : ";display:none"}">We anchor to your real expenditure \u2014 no goal weight needed. Cairn stays quiet unless your weight genuinely drifts.</p>
    ${num("activity_factor","Activity factor (1.3\u20131.8)",p.activity_factor,0.05)}

    <div class="field" style="margin-bottom:9px">
      <label>Your sport</label>
      <p class="aboutme-hint">What you mostly train. Cairn meets you in it \u2014 the language, the day's read, and Progress reshape around it. Change it anytime.</p>
      <div class="seg disc-seg" id="discSeg" role="group" aria-label="Primary discipline">
        <button type="button" class="segbtn${disc === "strength" ? " active" : ""}" data-disc="strength">Strength</button>
        <button type="button" class="segbtn${disc === "endurance" ? " active" : ""}" data-disc="endurance">Endurance</button>
        <button type="button" class="segbtn${disc === "hybrid" ? " active" : ""}" data-disc="hybrid">Hybrid</button>
      </div>
    </div>
    <div class="field" id="endSportField" style="margin-bottom:9px${disc === "strength" ? ";display:none" : ""}">
      <label for="endurance_sport">Endurance sport <span class="ob-opt">\u2014 optional</span></label>
      <input id="endurance_sport" type="text" placeholder="e.g. running, cycling, triathlon, rowing" maxlength="120"
        value="${escAttr(p.endurance_sport || "")}" class="form-input">
    </div>

    <div class="field" id="endGoalField" style="margin-bottom:9px">
      <label>Running goal <span class="ob-opt">— optional</span></label>
      <p class="aboutme-hint">A race the coach builds you toward, or an ongoing "stay ready" target. Either way it prescribes your runs each week alongside lifting — separate from the sport above.</p>
      <div class="seg" id="endGoalMode" role="group" aria-label="Running goal mode">
        <button type="button" class="segbtn${egMode === "none" ? " active" : ""}" data-egmode="none">None</button>
        <button type="button" class="segbtn${egMode === "race" ? " active" : ""}" data-egmode="race">Race</button>
        <button type="button" class="segbtn${egMode === "standing" ? " active" : ""}" data-egmode="standing">Standing</button>
      </div>
      <div id="egRace" class="eg-sub" style="${egMode === "race" ? "" : "display:none"}">
        <div class="field" style="margin:9px 0 0"><label for="eg_event">Race</label>
          <input id="eg_event" type="text" maxlength="120" placeholder="e.g. Cambridge Half" value="${escAttr(egCur.event || "")}" class="form-input"></div>
        <div class="field" style="margin:9px 0 0"><label for="eg_date">Race date</label>
          <input id="eg_date" type="date" value="${escAttr(egCur.date || "")}" class="form-input"></div>
        <div class="field" style="margin:9px 0 0"><label for="eg_target">Target <span class="ob-opt">— optional</span></label>
          <input id="eg_target" type="text" maxlength="60" placeholder="e.g. sub-1:45, just finish" value="${escAttr(egCur.target || "")}" class="form-input"></div>
      </div>
      <div id="egStanding" class="eg-sub" style="${egMode === "standing" ? "" : "display:none"}">
        <div class="field" style="margin:9px 0 0"><label for="eg_label">Readiness</label>
          <input id="eg_label" type="text" maxlength="80" placeholder="e.g. 10k-ready, half-ready" value="${escAttr(egCur.label || "")}" class="form-input"></div>
      </div>
      <div id="egShared" class="eg-grid" style="${egMode === "none" ? "display:none" : ""}">
        <div class="field" style="margin:9px 0 0"><label for="eg_distance">Distance (km) <span class="ob-opt">— optional</span></label>
          <input id="eg_distance" type="number" step="0.1" value="${egCur.distance_km ?? ""}" class="form-input"></div>
        <div class="field" style="margin:9px 0 0"><label for="eg_weekly_km">Weekly km <span class="ob-opt">— optional</span></label>
          <input id="eg_weekly_km" type="number" step="1" value="${egCur.weekly_km ?? ""}" class="form-input"></div>
      </div>
    </div>

    <div class="field aboutme" style="margin-bottom:0">
      <label for="about_me">About you</label>
      <p class="aboutme-hint">What "better" means to you, a little of your history, the foods you love and avoid, how work and life run. Optional \u2014 the coach reads it to make the pointing yours.</p>
      <textarea id="about_me" rows="6" placeholder="e.g. lifted on and off for years; fasted mornings suit me; two young kids, so evenings are unpredictable…"
        maxlength="8000">${escHtml(p.about_me || "")}</textarea>
    </div>
    <div class="field" style="margin-top:9px;margin-bottom:9px">
      <label for="allergies">Food allergies</label>
      <p class="aboutme-hint">A hard exclusion — the coach never puts these in a meal, recipe, or swap. Leave empty if none.</p>
      <input id="allergies" type="text" placeholder="e.g. peanuts, shellfish" maxlength="1000" class="form-input">
    </div>
    <div class="field" style="margin-bottom:0">
      <label for="dietary_restrictions">Dietary preferences</label>
      <p class="aboutme-hint">Respected strongly in your meal plans (e.g. vegetarian, pescatarian, no pork).</p>
      <input id="dietary_restrictions" type="text" placeholder="e.g. pescatarian, no pork" maxlength="1000" class="form-input">
    </div>
    </div>

    <div class="prof-capture-note sess">
      <div class="sess-line" style="color:var(--muted)">
        Log your bodyweight, activities, and meals on <button class="linkbtn" id="profToToday">Today</button> — the quick-log, the bodyweight chip, voice, and your frequents all live there. They show up in <b>Lately</b> and <button class="linkbtn" id="profToProgress">Progress</button>.
      </div>
    </div>`; });

  wireSeg(ME_HANDLERS);

  // Track the chosen discipline locally (a seg tap isn't an input/change event the
  // save bar listens for, so we mark dirty + persist it explicitly).
  let pickedDisc = String(disc || "strength");
  let pickedEgMode = String(egMode || "none");
  let pickedGoalMode = String(goalMode || "maintain");
  // Assemble the endurance goal from the active mode's fields (none → null clears it).
  const egPayload = (): EnduranceGoalDraft | null | undefined => {
    const dist = healthNumberValue("#eg_distance");
    const wk = healthNumberValue("#eg_weekly_km");
    if (pickedEgMode === "race") {
      const date = healthInputValue("#eg_date") || null;
      // A race needs a date to be periodized — the server would reject a dateless
      // race to null (a silent clear). Don't clobber an existing goal mid-entry:
      // return undefined (JSON omits it → leaves the saved goal intact) + a calm hint.
      if (!date) { toast("Add a race date to save your race goal"); return undefined; }
      return { mode: "race", event: healthInputValue("#eg_event").trim() || null,
        date, distance_km: dist, target: healthInputValue("#eg_target").trim() || null, weekly_km: wk };
    }
    if (pickedEgMode === "standing") {
      return { mode: "standing", label: healthInputValue("#eg_label").trim() || null, distance_km: dist, weekly_km: wk };
    }
    return null; // none
  };
  const persistProfile = async () => {
    const body = {
      name: healthInputValue("#name").trim(),
      age: healthNumberValue("#age"), height_cm: healthNumberValue("#height_cm"),
      weight_lb: healthNumberValue("#weight_lb"), goal_weight_lb: healthNumberValue("#goal_weight_lb"),
      goal_date: healthInputValue("#goal_date") || null, activity_factor: healthNumberValue("#activity_factor"),
      goal_mode: pickedGoalMode,
      primary_discipline: pickedDisc,
      endurance_sport: pickedDisc === "strength" ? "" : healthInputValue("#endurance_sport").trim(),
      endurance_goal: egPayload(),
      about_me: (healthTextArea("#about_me")?.value ?? "").trim(),
      allergies: healthInputValue("#allergies").trim(),
      dietary_restrictions: healthInputValue("#dietary_restrictions").trim(),
    };
    await api("/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setDiscipline(pickedDisc); // the emphasis global follows what was just saved
    // Only re-derive the goal flag when the payload actually CARRIED a goal decision.
    // egPayload() returns undefined for a rejected race-with-no-date (the server then
    // leaves the existing goal intact), so we must NOT flip the tab off in that case.
    if (body.endurance_goal !== undefined) {
      const hadGoal = !!(egCur && egCur.mode);
      setEnduranceGoalSet(!!body.endurance_goal);
      // First time a running goal lands → point the athlete at its planning home.
      if (!hadGoal && body.endurance_goal) toast("Your running plan now lives in Plan → Endurance");
    }
    // new goal weight/date/factor moves the pace + goal lines across surfaces; a
    // discipline change reshapes Today's compass + the default Progress view.
    ["profile", "stats", "progress:weight", "progress:energy"].forEach(swrInvalidate);
    renderMe(); // refresh the goal check with the new numbers; flash continues on top
    return true;
  };
  // floating save bar: scoped to the profile fields only.
  const profFields = $<HTMLElement>("#profFields");
  if (!profFields) return;
  const profBar = mountSaveBar({
    sentinel: profFields,
    fields: profFields,
    onSave: persistProfile,
    onDiscard: () => renderMeProfile(),
  });
  // Discipline segmented control: pick one (background-swap active state, like
  // onboarding's days/week), reveal the optional sport field for endurance/hybrid,
  // and mark the screen dirty so Save surfaces.
  $<HTMLElement>("#discSeg")?.querySelectorAll<HTMLElement>("[data-disc]").forEach((b) =>
    b.addEventListener("click", () => {
      pickedDisc = b.dataset.disc || pickedDisc;
      $<HTMLElement>("#discSeg")?.querySelectorAll(".segbtn").forEach((x) => x.classList.toggle("active", x === b));
      const sportField = $<HTMLElement>("#endSportField");
      if (sportField) sportField.style.display = pickedDisc === "strength" ? "none" : "";
      profBar.markDirty();
    })
  );
  // Running-goal mode: None / Race / Standing — toggle the relevant fields, mark dirty.
  $<HTMLElement>("#endGoalMode")?.querySelectorAll<HTMLElement>("[data-egmode]").forEach((b) =>
    b.addEventListener("click", () => {
      pickedEgMode = b.dataset.egmode || pickedEgMode;
      $<HTMLElement>("#endGoalMode")?.querySelectorAll(".segbtn").forEach((x) => x.classList.toggle("active", x === b));
      const race = $<HTMLElement>("#egRace"), standing = $<HTMLElement>("#egStanding"), shared = $<HTMLElement>("#egShared");
      if (race) race.style.display = pickedEgMode === "race" ? "" : "none";
      if (standing) standing.style.display = pickedEgMode === "standing" ? "" : "none";
      if (shared) shared.style.display = pickedEgMode === "none" ? "none" : "";
      profBar.markDirty();
    })
  );
  // Goal mode: Lose / Maintain / Gain — swap active state, show/hide the goal-weight
  // target (maintenance anchors to real expenditure, no target needed), mark dirty.
  $<HTMLElement>("#goalModeSeg")?.querySelectorAll<HTMLElement>("[data-goalmode]").forEach((b) =>
    b.addEventListener("click", () => {
      pickedGoalMode = b.dataset.goalmode || pickedGoalMode;
      $<HTMLElement>("#goalModeSeg")?.querySelectorAll(".segbtn").forEach((x) => x.classList.toggle("active", x === b));
      const tgt = $<HTMLElement>("#goalTargetFields"), note = $<HTMLElement>("#goalMaintainNote");
      if (tgt) tgt.style.display = pickedGoalMode === "maintain" ? "none" : "";
      if (note) note.style.display = pickedGoalMode === "maintain" ? "" : "none";
      profBar.markDirty();
    })
  );
  // Capture is consolidated on Today + Chat — these just route there.
  $("#profToToday")?.addEventListener("click", () => activateTab("today"));
  $("#profToProgress")?.addEventListener("click", () => activateTab("progress"));
}

// Pure food-note parsing/rendering lives in food-note-client.js; direct globals
// are preserved there for the food detail sheet in 02-ui.js.

// tap a note card → full-screen food detail (zooming from its art tile)
function wireNoteCard(el: Element): void {
  const card = el as WiredHealthElement;
  if (!card || card._wired) return; card._wired = true;
  card.addEventListener("click", (e: MouseEvent) => {
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest("button, a, input")) return;
    const n = (state._notesById || {})[card.dataset.noteid || ""];
    if (n) openFoodDetail(n, card.querySelector(".artile"));
  });
}

function renderNotes(notes: unknown): void {
  const wrap = $<HTMLElement>("#notelist");
  if (!wrap) return;
  const rows = healthScreenRows(notes);
  if (!rows.length) { wrap.innerHTML = `<div class="empty">Nothing logged yet. Snap a plate or jot a meal in Chat and it shows up here.</div>`; return; }
  state._notesById = Object.fromEntries(rows.map((n) => [String(n.id), n]));
  wrap.innerHTML = rows.map((n, i) => CairnFoodNote.noteEntryHtml(n, i)).join("");
  wrap.querySelectorAll(".fnent").forEach(wireNoteCard);
}

function renderActs(acts: unknown): void {
  const wrap = $<HTMLElement>("#actlist");
  if (!wrap) return;
  const rows = healthScreenRows(acts) as Array<import("../contracts/client.js").ClientActivity & HealthScreenRecord>;
  if (!rows.length) { wrap.innerHTML = `<div class="empty">Nothing logged yet. Log a ride, run, or walk on Today and it lands here.</div>`; return; }
  wrap.innerHTML = rows.map((a) => actEntryHtml(a)).join("");
}

// ---------- Me: Memory (what the coach remembers) ----------
// Pure Memory option and row renderers live in memory-client.js.
async function renderMemory() {
  headerTitle.textContent = "Me";
  state.meSeg = "memory";
  pollToken++; // invalidate in-flight enrichment polls from a sibling sub-view
  view.innerHTML = segBar("memory", ME_SEG) + `
    <div class="sess"><div class="sess-line" style="color:var(--muted)">
      Facts and preferences the coach carries between sessions. Edit or remove anything that's stale.
    </div></div>
    <h1 class="lbl" style="margin:20px 0 8px">What the coach remembers</h1>
    <div class="memadd">
      <select id="memKind">${CairnMemory.memoryKindOptionsHtml()}</select>
      <input id="memInput" type="text" placeholder="Add something to remember…">
      <button id="memAdd" class="logbtn">+</button>
    </div>
    <div id="memlist" style="margin-top:12px"></div>`;
  wireSeg(ME_HANDLERS);

  const addBtn = $<HTMLButtonElement>("#memAdd"), input = $<HTMLInputElement>("#memInput");
  const kindSelect = $<HTMLSelectElement>("#memKind");
  if (!addBtn || !input || !kindSelect) return;
  const add = async () => {
    const content = input.value.trim();
    if (!content) { input.focus(); return; }
    const kind = kindSelect.value;
    input.value = "";
    try { await api("/memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content, kind }) }); }
    catch { toast("Couldn't save that — try again."); return; }
    toast("Remembered");
    loadMemory();
  };
  addBtn.addEventListener("click", add);
  input.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter") add(); });
  loadMemory();
}

async function loadMemory() {
  const wrap = $<HTMLElement>("#memlist");
  if (!wrap) return;
  let items: HealthMemory[] = [];
  try {
    const data = await api("/memory");
    items = Array.isArray(data) ? data : [data];
  } catch { items = []; }
  if (state.tab !== "me" || state.meSeg !== "memory" || !wrap.isConnected) return;
  if (!items || !items.length) { wrap.innerHTML = `<div class="empty">Nothing remembered yet. As you chat and log, the coach keeps the facts and preferences that matter — they'll gather here.</div>`; return; }
  wrap.innerHTML = items.map((m, i) => CairnMemory.memoryRowHtml(m, i)).join("");

  wrap.querySelectorAll<HTMLElement>("[data-memedit]").forEach((b) => b.addEventListener("click", () => startMemEdit(b.closest<HTMLElement>(".memrow"))));
  wrap.querySelectorAll<HTMLElement>("[data-memdel]").forEach((b) => b.addEventListener("click", () => startMemDelete(b)));
}

// inline edit: swap the content line for an input + save/cancel
function startMemEdit(row: HTMLElement | null): void {
  if (!row || row.querySelector(".memedit-box")) return;
  const id = row.dataset.mem;
  const contentEl = row.querySelector<HTMLElement>("[data-memcontent]");
  if (!id || !contentEl) return;
  const current = contentEl.textContent;
  contentEl.hidden = true;
  const box = document.createElement("div");
  box.className = "memedit-box";
  box.innerHTML = `<input class="memedit-in" type="text" value="${escAttr(current)}">
    <button class="iconbtn memok" title="save">✓</button>
    <button class="iconbtn" data-memcancel title="cancel">×</button>`;
  contentEl.after(box);
  const inp = box.querySelector<HTMLInputElement>(".memedit-in");
  if (!inp) return;
  inp.focus(); inp.setSelectionRange(current.length, current.length);
  const cancel = () => { box.remove(); contentEl.hidden = false; };
  const save = async () => {
    const content = inp.value.trim();
    if (!content) { inp.focus(); return; }
    try { await api(`/memory/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) }); }
    catch { toast("Couldn't save that — try again."); return; }
    toast("Updated"); loadMemory();
  };
  box.querySelector<HTMLButtonElement>(".memok")?.addEventListener("click", save);
  box.querySelector<HTMLButtonElement>("[data-memcancel]")?.addEventListener("click", cancel);
  inp.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter") save(); else if (e.key === "Escape") cancel(); });
}

// two-tap armed × — the one destructive-confirm pattern (see armDelete in 02-ui.js)
function startMemDelete(btn: Element): void {
  const row = btn.closest<HTMLElement>(".memrow");
  const id = row?.dataset.mem;
  if (!id) return;
  armDelete(btn, () => {
    api(`/memory/${id}`, { method: "DELETE" }).then(() => { toast("Removed"); loadMemory(); }).catch(() => toast("Couldn't remove that — try again."));
  });
}

// ---------- Me: Health — the whole picture (review · markers · records) ----------
// _hPic caches what the picture panel needs across in-place repaints; the in-flight
// review run lives at module level so it survives sub-view re-renders (the POST can
// take minutes — an agent CLI run) and quietly lands wherever the user is.
let _hReviewRun: Promise<HealthReviewRunResult> | null = null;  // in-flight POST /health/review promise
let _hReviewErr: string | null = null;  // gentle inline message after a failed run
let _hReadSpy: IntersectionObserver | null = null;    // scroll-spy IntersectionObserver for the Read tab's sticky nav

function parsedReview(r: { parsed?: unknown; error?: unknown } | null | undefined): Record<string, unknown> | null {
  return CairnHealthPicture.parsedReview(r);
}

function healthDotClass(flag: unknown): string {
  return CairnHealthPicture.healthDotClass(flag);
}

function reviewBusyHtml(): string {
  return CairnHealthPicture.reviewBusyHtml();
}

function healthHeroHtml(err: unknown): string {
  return CairnHealthPicture.healthHeroHtml(err);
}

function buildPictureHtml(err: unknown, docCount: unknown): string {
  return CairnHealthPicture.buildPictureHtml(err, docCount);
}

function reviewHtml(review: HealthReviewRecord, stale: unknown, err: unknown): string {
  return CairnHealthPicture.reviewHtml(review, stale, err);
}

// Paint #hPicture from _hPic + the in-flight run state. Safe to call anytime —
// bails unless the Health sub-view is live.
function paintHealthPicture(): void {
  const wrap = $<HTMLElement>("#hPicture");
  if (!wrap || !onHealthReadView() || !wrap.isConnected) return;
  if (_hReviewRun) { wrap.innerHTML = reviewBusyHtml(); return; }
  const pic = _hPic || {};
  const err = _hReviewErr ? `<div class="hpic-err">${escHtml(_hReviewErr)}</div>` : "";
  const p = parsedReview(pic.review);
  if (!p && !((pic.docCount ?? 0) > 0)) {
    // nothing shared yet → inviting hero; CTA jumps to the Records tab + file picker
    wrap.innerHTML = healthHeroHtml(err);
    const b = $("#hHeroShare");
    if (b) b.addEventListener("click", () => switchHealthSeg("records", { openPicker: true }));
    return;
  }
  if (!p) {
    // records exist but no review yet → primary "build" action
    wrap.innerHTML = buildPictureHtml(err, pic.docCount ?? 0);
    const b = $("#hRevBtn"); if (b) b.addEventListener("click", runHealthReview);
    return;
  }
  const review = (pic.review || {}) as HealthReviewRecord;
  const rT = Date.parse(String(review.created_at || "")) || 0;
  const dT = Date.parse(pic.newestDocAt || "") || 0;
  wrap.innerHTML = reviewHtml(review, rT > 0 && dT > rT, err);
  const b = $("#hRevBtn"); if (b) b.addEventListener("click", runHealthReview);
}

// POST /api/health/review — an agent run that can take minutes. One in-flight run
// max; the shimmer card holds the slot, and ok:false lands as a gentle inline note.
async function runHealthReview(): Promise<void> {
  if (_hReviewRun) return;
  _hReviewErr = null;
  _hReviewRun = api("/health/review", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
    .then((res) => (res && typeof res === "object" ? (res as HealthReviewRunResult) : null))
    .catch(() => null);
  paintHealthPicture();
  const res = await _hReviewRun;
  _hReviewRun = null;
  if (res && res.ok && res.review) {
    state.healthReview = res.review;
    _hPic = { ...(_hPic || {}), review: res.review };
    toast("Your picture is ready");
  } else {
    _hReviewErr = res && res.error
      ? `The review didn't finish: ${res.error}`
      : "The review didn't come back — give it another try in a bit.";
  }
  paintHealthPicture();
}

async function loadHealthPicture(token: number, docsP: Promise<unknown>): Promise<void> {
  let review: HealthReviewRecord | null = null, docs: HealthDocumentRow[] = [], docsOk = false;
  try {
    const rawReview = await api("/health/review");
    review = rawReview && typeof rawReview === "object" ? (rawReview as HealthReviewRecord) : null;
  } catch { review = null; }
  try { docs = healthScreenRows<HealthDocumentRow>(await docsP); docsOk = true; } catch { docs = []; }
  if (review && review.error) review = null;
  if (review) state.healthReview = review;
  if (token !== pollToken) return; // navigated away / re-rendered
  const newest = docs.reduce<string | null>((m, d) => (d.created_at && (!m || d.created_at > m) ? d.created_at : m), null);
  _hPic = { review, docCount: docs.length, newestDocAt: newest };
  // Persist the count so a returning new-user (a fresh page load resets _hPic) still
  // opens Health on Records until they've added a document — see healthDocsKnownEmpty.
  // Only on a real fetch: a transient offline [] must never cache a false zero.
  if (docsOk) { try { localStorage.setItem("cairn:healthDocCount", String(docs.length)); } catch {} }
  paintHealthPicture();
}

// ---- markers (trends) ----
function fmtMkNum(v: unknown): string {
  return CairnHealthMarkers.formatMarkerNumber(v);
}

function sparkDateLabel(d: unknown): string {
  return CairnHealthMarkers.sparkDateLabel(d);
}

function markerTrendWord(m: { trend?: { dir?: unknown; span_days?: unknown } | null; points?: Array<{ value?: unknown; date?: unknown }> | null } | null | undefined): string {
  return CairnHealthMarkers.markerTrendWord(m);
}

function markerSpanWord(days: unknown): string {
  return CairnHealthMarkers.markerSpanWord(days);
}

function markerChartSvg(m: HealthScreenRecord | null | undefined): string {
  return CairnHealthMarkers.markerChartSvg(m);
}

function wireMarkerChart(svg: Element): void {
  if (!(svg instanceof SVGElement)) return;
  CairnHealthMarkers.wireMarkerChart(svg);
}

function markerPanelHtml(m: HealthScreenRecord | null | undefined): string {
  return CairnHealthMarkers.markerPanelHtml(m);
}

function hmkRowHtml(m: HealthScreenRecord | null | undefined, i?: number): string {
  return CairnHealthMarkers.hmkRowHtml(m, i);
}

function orderHealthMarkersForDisplay(groupKey: unknown, list: HealthMarkerRow[] | null | undefined): HealthMarkerRow[] {
  return CairnHealthClient.orderMarkersForDisplay(groupKey, list);
}
function healthMarkerSubgroup(groupKey: unknown, name: unknown): string | null {
  return CairnHealthClient.markerSubgroup(groupKey, name);
}
function lipidGroupNoteHtml(list: HealthMarkerRow[] | null | undefined): string {
  return CairnHealthClient.lipidGroupNoteHtml(list, { relAge });
}

// SWR over /markers/priority (key shared with the Health → Read priority view): a
// warm re-entry paints the grouped marker list instantly, then revalidates and
// re-paints only if the payload changed. The render is unchanged — SWR only
// changes WHEN the data arrives.
function loadHealthMarkers(token: number): void {
  const wrap = $<HTMLElement>("#hMarkers");
  if (!wrap || !wrap.isConnected) return;
  // /markers/priority is the superset: it carries the optimal bands (for the chart) plus
  // group + trend on top of the flat marker shape /health/markers returns.
  const paint = (res: unknown) => {
    if (token !== pollToken || !wrap.isConnected) return;
    const data = healthScreenRecord(res) as MarkerPriorityResponse;
    const markers = healthScreenRows<HealthMarkerRow>(data.markers);
    if (!markers.length) {
      wrap.innerHTML = CairnHealthClient.markersEmptyHtml(CairnHealthClient.HEALTH_HERO_ART);
      const b = wrap.querySelector("#hMkToRecords");
      if (b) b.addEventListener("click", () => switchHealthSeg("records", { openPicker: true }));
      return;
    }
    // Server `groups` is the canonical ordered list of groups that hold ≥1 marker; render
    // headers in that order. Most groups preserve server priority order; lipids get a
    // clinician-style scan order so LDL variants and particle markers don't read as one pile.
    // Degrade gracefully if the backend hasn't shipped grouping yet: derive an ordered list
    // from the markers themselves, falling everything ungrouped into a single "Markers" bucket.
    let groups = healthScreenRows<HealthMarkerGroup>(data.groups).filter((g) => !!g.key);
    if (!groups.length) {
      const seen = new Set<string>(), derived: HealthMarkerGroup[] = [];
      for (const m of markers) {
        const key = typeof m.group === "string" && m.group ? m.group : "other";
        if (!seen.has(key)) { seen.add(key); derived.push({ key, label: m.group_label || (m.group ? m.group : "Markers") }); }
      }
      groups = derived;
    }
    const byGroup = new Map<string, HealthMarkerRow[]>(groups.map((g) => [g.key, []]));
    for (const m of markers) {
      const groupKey = typeof m.group === "string" ? m.group : "";
      const key = byGroup.has(groupKey) ? groupKey : (groups[0] && groups[0].key);
      if (key && byGroup.has(key)) byGroup.get(key)?.push(m);
    }
    let i = 0;
    const sections = groups.map((g, gi) => {
      const list: HealthMarkerRow[] = (typeof orderHealthMarkersForDisplay === "function")
        ? orderHealthMarkersForDisplay(g.key, byGroup.get(g.key) || [])
        : (byGroup.get(g.key) || []);
      if (!list.length) return "";
      let lastSub = "";
      const rows = list.map((m) => {
        const subgroup = typeof healthMarkerSubgroup === "function"
          ? healthMarkerSubgroup(g.key, m.name || m.key || "")
          : "";
        const subhead = subgroup && subgroup !== lastSub
          ? `<div class="hmk-subhead">${escHtml(subgroup)}</div>`
          : "";
        if (subgroup) lastSub = subgroup;
        return subhead + hmkRowHtml(m, i++);
      }).join("");
      const head = `<div class="hmk-grouphead lbl reveal" style="${stagger(gi)}">${escHtml(g.label || g.key)}</div>`;
      const note = g.key === "lipids" && typeof lipidGroupNoteHtml === "function"
        ? lipidGroupNoteHtml(list)
        : "";
      return `<section class="hmk-section">${head}${note}<div class="hmk-card">${rows}</div></section>`;
    }).join("");
    // The clinical report + portable export live on their own Share sub-tab, so the
    // catalog doesn't repeat a "share with your doctor" footer here.
    wrap.innerHTML = `<div class="hmk-groups">${sections}</div>`;
    wrap.querySelectorAll<HTMLElement>(".hmk-x .hmk-row").forEach((b) =>
      b.addEventListener("click", () => {
        const item = b.closest<HTMLElement>(".hmk");
        if (!item) return;
        const open = item.classList.toggle("open");
        b.setAttribute("aria-expanded", open ? "true" : "false");
      }));
    wrap.querySelectorAll("svg.hchart").forEach(wireMarkerChart);
  };
  const peek = peekCached("markers:priority");
  if (peek) { paint(peek.data); if (!peek.fresh) markRefreshing(true); }
  cachedApi("/markers/priority", {
    key: "markers:priority",
    onUpgrade: (data, { changed }) => { if (peek && !peek.fresh) markRefreshing(false); if (changed || !peek) paint(data); },
    // No cached read + a thrown fetch (offline / parse failure): clear the
    // "Loading markers…" placeholder to the calm empty state, never a stuck loader.
  }).catch(() => { if (peek && !peek.fresh) markRefreshing(false); if (!peek) paint(null); });
}

// Health's inner views. The whole-picture DEPTH (synthesis + connected brain) used to
// be inlined under the top-level Standing review, ballooning it to ~8 screens. It now
// lives here as its own "Read" sub-tab, one tap from the review, with an in-page jump
// nav so you can land on what you want instead of scrolling the whole story:
//   • read    — "Read": the whole-picture synthesis + the connected-brain directives,
//               recovery, what-matters-now markers, symptom links and supplements,
//               with a jump-chip nav across them.
//   • markers — "Markers": the rich trends catalog (the ONE detailed markers home).
//   • records — "Records": upload + the document list.
//   • share   — "Share": doctor report, structured export, and data-alignment actions.
//   • learned — "Learned": the quiet record of what Cairn has come to understand.
const HEALTH_SEG: readonly (readonly [ClientHealthSection, string])[] = [["read", "Read"], ["markers", "Markers"], ["records", "Records"], ["share", "Share"], ["learned", "Learned"]];

// Health is the lab-DATA + whole-picture-read home. Fold every legacy analysis/brain/
// standing key onto Read (where that content now lives) so a returning client never
// lands on a dead inner tab.
function normalizeHealthSeg(seg: unknown): ClientHealthSection {
  if (seg === "analysis" || seg === "brain" || seg === "standing") return "read";
  return typeof seg === "string" && HEALTH_SEG.some(([k]) => k === seg) ? (seg as ClientHealthSection) : "read";
}

// True when we positively know there are zero health documents — from this session's
// last load (_hPic.docCount) or this device's last visit (persisted). Used to open a
// brand-new user on Records (where they upload) instead of an empty Standing read.
// Returns false when the count is unknown, so we only override on a confident zero.
function healthDocsKnownEmpty(): boolean {
  if (_hPic && Number.isFinite(_hPic.docCount)) return _hPic.docCount === 0;
  try {
    const cached = localStorage.getItem("cairn:healthDocCount");
    if (cached != null) return Number(cached) === 0;
  } catch {}
  return false;
}

// Health is a one-level inner view: the Me seg picks "Health", then a single inner
// seg picks Read / Markers / Records / Share. Splitting these bounds each view's scroll and
// keeps it focused — and the connected brain now lives on the default Read view, so
// it's reachable in one nav step (Me → Health) instead of buried behind a second seg.
async function renderHealth(): Promise<void> {
  headerTitle.textContent = "Me";
  state.meSeg = "health";
  state.healthSeg = normalizeHealthSeg(state.healthSeg);
  // New user with nothing uploaded yet → open on Records (where you add a document),
  // not the Read view that can only say "this will sharpen". Respect any explicit
  // tab choice made this session, and only override on a confident zero doc count.
  if (!state.healthSegPicked && state.healthSeg === "read" && healthDocsKnownEmpty()) {
    state.healthSeg = "records";
  }
  pollToken++; // invalidate in-flight enrichment polls from a sibling sub-view
  const idx = Math.max(0, HEALTH_SEG.findIndex(([k]) => k === state.healthSeg));
  view.innerHTML = segBar("health", ME_SEG)
    + `<div class="segwrap hsegwrap"><div class="seg seg-sliding hseg" style="--segn:${HEALTH_SEG.length};--segi:${idx}">`
    +   `<span class="seg-thumb"></span>`
    +   HEALTH_SEG.map(([k, l]) => `<button class="segbtn${k === state.healthSeg ? " active" : ""}" data-hseg="${k}">${l}</button>`).join("")
    + `</div></div>`
    + `<div id="hContent"></div>`;
  wireSeg(ME_HANDLERS);
  const hseg = view.querySelector<HTMLElement>(".hseg");
  if (!hseg) return;
  hseg.querySelectorAll<HTMLButtonElement>(".segbtn").forEach((b) => b.addEventListener("click", () => {
    const next = normalizeHealthSeg(b.dataset.hseg);
    if (next === state.healthSeg) return;
    setHealthSegActive(next);
    if (typeof syncRouteFromState === "function") syncRouteFromState();
    withViewTransition(() => paintHealthTab());
  }));
  paintHealthTab();
}

// Slide the inner seg thumb + flip the active button to `seg` (no repaint).
function setHealthSegActive(seg: ClientHealthSection): void {
  state.healthSeg = seg;
  state.healthSegPicked = true; // a deliberate tab choice — don't auto-default to Records again
  const hseg = view.querySelector<HTMLElement>(".hseg");
  if (!hseg) return;
  const btns = [...hseg.querySelectorAll<HTMLButtonElement>(".segbtn")];
  const target = btns.find((b) => b.dataset.hseg === seg);
  if (!target) return;
  hseg.style.setProperty("--segi", String(btns.indexOf(target)));
  btns.forEach((x) => x.classList.toggle("active", x === target));
  fitSeg(hseg); // keep the active pill centered when the bar is in scroll mode
}

// Programmatic inner-tab switch from a CTA. openPicker keeps the .click() in the
// same user gesture (so the file dialog isn't blocked) — hence no view transition.
function switchHealthSeg(seg: ClientHealthSection, opts: { openPicker?: boolean } = {}): void {
  if (state.tab !== "me" || state.meSeg !== "health") return;
  setHealthSegActive(seg);
  if (typeof syncRouteFromState === "function") syncRouteFromState();
  if (opts.openPicker) {
    paintHealthTab();
    const f = $<HTMLInputElement>("#hFile"); if (f) f.click();
  } else {
    withViewTransition(() => paintHealthTab());
  }
}

// Repaint #hContent for the active inner tab. Bumps pollToken so any enrichment
// poll from the tab we're leaving stops cleanly (Records resumes on return).
function paintHealthTab(): void {
  pollToken++;
  if (state.healthSeg === "records") {
    paintHealthRecordsTab();
    return;
  }
  if (state.healthSeg === "share") {
    paintHealthShareTab();
    return;
  }
  if (state.healthSeg === "learned") {
    paintHealthLearnedTab();
    return;
  }
  if (state.healthSeg === "markers") {
    paintHealthMarkersTab();
    return;
  }
  paintHealthReadTab();
}

// ME → Health → Read: the whole-picture depth that used to balloon the Standing tab.
// A STICKY jump-chip nav heads it (pinned under the Health seg) so you can land on the
// connections, recovery, markers or supplements from anywhere in the long read; below
// it the same id-keyed slots the loaders fill. Single editorial column (no broken
// two-column gutter), capped width on desktop. The targets carry scroll-margin-top so a
// jump lands below the sticky chrome, and a scroll-spy highlights the section you're in.
function paintHealthReadTab(): void {
  const c = $<HTMLElement>("#hContent");
  if (!c) return;
  if (_hReadSpy) { _hReadSpy.disconnect(); _hReadSpy = null; } // drop a prior tab's observer
  c.innerHTML = `<div class="hread">
      <nav class="hread-nav" aria-label="Jump to a section">
        <button type="button" class="hread-chip" data-jump="hSynthesis">The read</button>
        <button type="button" class="hread-chip" data-jump="hbDirectives">Connections</button>
        <button type="button" class="hread-chip" data-jump="hRecovery">Recovery</button>
        <button type="button" class="hread-chip" data-jump="hbMarkers">Markers</button>
        <button type="button" class="hread-chip" data-jump="hbSupplements">Supplements</button>
      </nav>
      <div class="hbrain-intro sess"><div class="sess-line" style="color:var(--muted)">
        One brain across your whole picture. A finding in your labs can quietly shape your meals, your training, and what to keep an eye on. It's here to inform — never medical advice — and nothing changes your plan on its own.
      </div></div>
      <div id="hSynthesis"></div>
      <div id="hPicture">
        <div class="hpic hpic-busy"><div class="hshimmer hshimmer-lg"></div><div class="hshimmer"></div><div class="hshimmer hshimmer-sm"></div></div>
      </div>
      <div id="hbDirectives"><div class="hb-load">Gathering connections…</div></div>
      <div id="hbSymptomLinks"></div>
      <div id="hRecovery"></div>
      <div id="hbMarkers"><div class="hb-load">Reading what matters most…</div></div>
      <div id="hbSupplements"></div>
    </div>`;
  const chips = [...c.querySelectorAll<HTMLButtonElement>(".hread-chip")];
  const setActiveChip = (id: string | undefined) => chips.forEach((ch) => ch.classList.toggle("active", ch.dataset.jump === id));
  // Jump chips: scroll the target slot into view; scroll-margin-top (CSS) keeps it clear
  // of the sticky seg + nav. Mark it active immediately so the tap reads as a selection.
  chips.forEach((b) => b.addEventListener("click", () => {
    const el = b.dataset.jump ? view.querySelector<HTMLElement>("#" + b.dataset.jump) : null;
    if (el) el.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
    setActiveChip(b.dataset.jump);
  }));
  // Scroll-spy: highlight the chip for whichever section sits under the sticky nav. The
  // band (rootMargin) starts below the pinned chrome; the topmost section in it wins.
  // Sections WITHOUT their own chip (the picture reads under "The read", symptom links
  // under "Connections") map to the owning chip so no scroll position is left unlit.
  if ("IntersectionObserver" in window) {
    const spy: Array<readonly [string, string]> = [["hSynthesis", "hSynthesis"], ["hPicture", "hSynthesis"], ["hbDirectives", "hbDirectives"], ["hbSymptomLinks", "hbDirectives"], ["hRecovery", "hRecovery"], ["hbMarkers", "hbMarkers"], ["hbSupplements", "hbSupplements"]];
    const owner = new Map(spy);
    const order = spy.map(([id]) => id);
    const visible = new Set<string>();
    _hReadSpy = new IntersectionObserver((entries) => {
      for (const e of entries) { if (e.isIntersecting) visible.add(e.target.id); else visible.delete(e.target.id); }
      const top = order.find((id) => visible.has(id));
      if (top) setActiveChip(owner.get(top));
    }, { rootMargin: "-104px 0px -55% 0px", threshold: 0 });
    const spyObserver = _hReadSpy;
    order.forEach((id) => { const el = document.getElementById(id); if (el && spyObserver) spyObserver.observe(el); });
  }
  loadHealthSynthesis(pollToken);
  loadRecoverySummary(pollToken, "#hRecovery");
  loadPriorityMarkers(pollToken);
  const directivesLoaded = CairnHealthDirectiveLoader.load(pollToken);
  loadSymptomLinks(pollToken);
  loadSupplements(pollToken);
  // A provenance "why" deep-link can ask to land on the referenced directive rather
  // than the top. The directives rail hydrates async, so wait for it to render, then
  // scroll it into view. Consumed once; a normal entry never scrolls.
  if (state.pendingHealthScroll === "hbDirectives") {
    const token = pollToken;
    state.pendingHealthScroll = null;
    void directivesLoaded.then(() => { if (token === pollToken) scrollHealthRailIntoView("#hbDirectives"); });
  }
  if (_hReviewRun) { paintHealthPicture(); return; } // a run is still cooking
  loadHealthPicture(pollToken, api("/health-docs"));
}

// ---- Standing tab: percentiles, signal age, and point-in-time BP ----
function renderHealthStanding(data: unknown): void {
  const wrap = $<HTMLElement>("#hStanding");
  if (!wrap) return;
  wrap.innerHTML = CairnHealthStanding.renderHealthStandingHtml(healthScreenRecord(data), { referenceAge: state.healthStandingRef });

  // Don't stack two competing "single most important thing" surfaces: if the conductor's
  // "Where to focus" card already led above, drop this health "one lever" section (the
  // Program view de-dupes the same way via suppressLever). Order-independent — the
  // conductor loader does the mirror removal if it lands after this paint.
  if (view.querySelector("#cfocusStandingSlot .cfocus")) wrap.querySelector(".hstand-lever")?.remove();

  wrap.querySelectorAll<HTMLElement>("[data-refage]").forEach((b) => b.addEventListener("click", () => {
    state.healthStandingRef = Number(b.dataset.refage || 20);
    loadHealthStanding(pollToken, state.healthStandingRef);
  }));
  // This lever lives on the top-level Standing tab (meSeg="standing"), so switchHealthSeg
  // would bail (it guards meSeg==="health"). Route into Health → Markers directly.
  wrap.querySelector("[data-lever-go]")?.addEventListener("click", () => {
    state.meSeg = "health"; state.healthSeg = "markers"; state.healthSegPicked = true; activateTab("me");
  });
  $("#bpLogOpen")?.addEventListener("click", () => openBpSheet());
  // "From your DEXA — what to focus on next", co-located with the regional read.
  // Shared renderer defined in 05-progress.js (loaded earlier); null-safe + quiet.
  if (typeof loadDexaTargeting === "function") loadDexaTargeting("hDexaSlot");
}

// The relocated BP capture: a compact sheet behind a tap, so the Standing read stays a
// reading surface (the user's "why am I entering BP in the analysis view?"). Reuses the
// same POST /blood-pressure wiring as before.
function openBpSheet(): void {
  if (document.getElementById("bpSheetOv")) return;
  const ov = document.createElement("div");
  ov.id = "bpSheetOv";
  ov.className = "bpsheet-ov";
  ov.innerHTML = `<div class="bpsheet" role="dialog" aria-modal="true" aria-label="Log blood pressure">
      <div class="bpsheet-hd"><h3>Log a reading</h3><button class="bpsheet-x" type="button" aria-label="Close">✕</button></div>
      <form id="bpSheetForm" class="bpsheet-form">
        <div class="bpsheet-row">
          <label>Systolic<input id="bpSys" class="form-input" type="number" inputmode="numeric" min="60" max="260" placeholder="120" required></label>
          <label>Diastolic<input id="bpDia" class="form-input" type="number" inputmode="numeric" min="35" max="160" placeholder="80" required></label>
          <label>Pulse<input id="bpPulse" class="form-input" type="number" inputmode="numeric" min="25" max="240" placeholder="60"></label>
        </div>
        <label class="bpsheet-when">When<input id="bpAt" class="form-input" type="datetime-local" value="${escAttr(CairnHealthStanding.localDateTimeInputValue())}"></label>
        <div class="bpsheet-row">
          <label>Position<input id="bpPosition" class="form-input" type="text" maxlength="40" placeholder="Seated"></label>
          <label>Note<input id="bpNote" class="form-input" type="text" maxlength="240" placeholder="Optional"></label>
        </div>
        <div class="bpsheet-ft"><button class="ghostbtn" type="button" data-close>Cancel</button><button class="logbtn" type="submit">Save</button></div>
      </form>
    </div>`;
  document.body.appendChild(ov);
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") teardown(); };
  const teardown = () => { document.removeEventListener("keydown", onKey); ov.remove(); };
  document.addEventListener("keydown", onKey);
  ov.querySelector(".bpsheet-x")?.addEventListener("click", teardown);
  ov.querySelector("[data-close]")?.addEventListener("click", teardown);
  ov.addEventListener("click", (e) => { if (e.target === ov) teardown(); });
  $<HTMLFormElement>("#bpSheetForm")?.addEventListener("submit", async (e: SubmitEvent) => {
    e.preventDefault();
    const form = e.currentTarget instanceof HTMLFormElement ? e.currentTarget : null;
    const submit = form?.querySelector<HTMLButtonElement>("button[type='submit']") || null;
    if (submit) submit.disabled = true;
    const payload = {
      systolic: healthInputValue("#bpSys"), diastolic: healthInputValue("#bpDia"), pulse: healthInputValue("#bpPulse"),
      measured_at: healthInputValue("#bpAt"), position: healthInputValue("#bpPosition"), note: healthInputValue("#bpNote"), source: "manual",
    };
    try {
      const res = await api("/blood-pressure", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }) as unknown as { error?: string } | null;
      if (!res || res.error) { toast(res?.error || "Couldn't log BP"); if (submit) submit.disabled = false; return; }
      toast("BP logged");
      swrInvalidate("markers:");
      teardown();
      loadHealthStanding(pollToken, state.healthStandingRef || 20);
    } catch {
      toast("Couldn't log BP");
      if (submit) submit.disabled = false;
    }
  });
  setTimeout(() => $<HTMLInputElement>("#bpSys")?.focus(), 30);
}

function loadHealthStanding(token: number, refAge: unknown): void {
  const ref = Number(refAge || state.healthStandingRef || 20);
  state.healthStandingRef = ref;
  api(`/health/standing?reference_age=${encodeURIComponent(String(ref))}`)
    .then((data) => { if (token === pollToken) renderHealthStanding(data || {}); })
    .catch(() => {
      if (token !== pollToken) return;
      const wrap = $<HTMLElement>("#hStanding");
      if (wrap) wrap.innerHTML = `<div class="hstand hstand-panel"><div class="empty">Couldn't load health standing right now.</div></div>`;
    });
}

// The Standing tab is the calm REVIEW — where you stand + where to focus. It stays
// short and scannable: the conductor "Where to focus" (rendered above #hContent), then
// the momentum-led structured read (#hStanding — hero, momentum, the one lever, and the
// collapsed Full standing: live body comp, BP, percentiles). The whole-picture depth
// (synthesis, recovery, picture, the connected-brain directives/markers/supplements)
// now lives one tap away in Health → Read, reachable from the jump-off below — so this
// page no longer stacks ~8 screens of analysis on top of the review.
function paintStandingReview(): void {
  const c = $<HTMLElement>("#hContent");
  if (!c) return;
  c.innerHTML = `<div id="hStanding"><div class="hstand hstand-busy"><div class="hshimmer hshimmer-lg"></div><div class="hshimmer"></div><div class="hshimmer hshimmer-sm"></div></div></div>
    <button type="button" class="hread-jump" id="hStandingToRead">
      <span class="hread-jump-main">
        <span class="lbl">Your whole picture</span>
        <span class="hread-jump-title">The full health read</span>
        <span class="hread-jump-sub">Synthesis, the connected-brain list, recovery, markers and supplements — read as one story.</span>
      </span>
      <span class="hread-jump-arrow" aria-hidden="true">→</span>
    </button>`;
  loadHealthStanding(pollToken, state.healthStandingRef || 20);
  $("#hStandingToRead")?.addEventListener("click", () => openHealthRead());
}

// Jump from the Standing review into the relocated depth (Health → Read). Switches the
// Me seg to Health and the inner seg to Read in one step, then paints.
function openHealthRead(opts: { scroll?: string } = {}): void {
  state.meSeg = "health";
  state.healthSeg = "read";
  state.healthSegPicked = true;
  if (opts.scroll) state.pendingHealthScroll = opts.scroll;
  activateTab("me");
}

// Bring a Standing-tab connected-brain rail target into view once it has real content
// (the rail loads async, so wait for its "Gathering…" placeholder to be replaced
// before scrolling). pollToken-guarded so switching sub-views cancels it cleanly.
function scrollHealthRailIntoView(sel: string): void {
  const token = pollToken;
  let tries = 0;
  const onRead = () => state.tab === "me" && state.meSeg === "health" && state.healthSeg === "read";
  const tick = () => {
    if (token !== pollToken || !onRead()) return;
    const el = view.querySelector<HTMLElement>(sel);
    const ready = el && !el.querySelector(".hb-load"); // directives rendered (placeholder gone)
    if (ready || tries > 20) {
      if (el) el.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
      return;
    }
    tries++;
    setTimeout(tick, 80);
  };
  setTimeout(tick, 80);
}

// ---- the elite-coach synthesis: the whole picture, read as ONE prioritized story ----
// Leads the Read tab as a tight narrative: headline + connected story + the 2-3
// priorities + the one change. The deterministic act-now / worth-tracking TIERS it
// used to repeat are now carried by the actionable connected-brain list (#hbDirectives)
// rendered directly below, so we no longer duplicate them here. Pull: it waits here; a
// refresh regenerates it as a streamed job. No scores; informational, never a verdict.
function renderHealthSynthesis(data: unknown, token?: number | null): void {
  const wrap = $<HTMLElement>("#hSynthesis");
  if (!wrap || !wrap.isConnected || (token != null && token !== pollToken)) return;
  const payload = healthScreenRecord(data) as HealthSynthesisPayload;
  const s = payload.synthesis && typeof payload.synthesis === "object" ? payload.synthesis : null;
  const focus = healthScreenRecord(payload.focus);
  const hasFocus = Array.isArray(focus.priorities) && focus.priorities.length;
  if (!s && !hasFocus) { wrap.innerHTML = ""; return; } // nothing to synthesize yet — stay quiet
  // Newer labs landed since this read was written? Warn calmly, the same way the
  // review card does — so the narrative never silently contradicts the fresh
  // connected-brain list below it. Read defensively for both response shapes.
  const stale = payload.stale ?? (s && s.stale) ?? false;

  const prios = s && Array.isArray(s.priorities) ? healthScreenRows<HealthSynthesisPriority>(s.priorities).filter((p) => p.label || p.the_move) : [];
  let body: string;
  if (s && s.headline) {
    body = `
      <h3 class="hsyn-headline">${escHtml(s.headline)}</h3>
      ${s.story ? `<p class="hsyn-story">${escHtml(s.story)}</p>` : ""}
      ${prios.length ? `<div class="hsyn-prios">${prios.map((p) => `
        <div class="hsyn-prio">
          <span class="hsyn-plabel">${escHtml(p.label || "")}</span>
          ${p.the_move ? `<span class="hsyn-pmove">${escHtml(p.the_move)}</span>` : ""}
          ${p.recheck ? `<span class="hsyn-precheck lbl">${escHtml(p.recheck)}</span>` : ""}
        </div>`).join("")}</div>` : ""}
      ${s.one_change ? `<div class="hsyn-onechange"><span class="lbl">If you change one thing</span><span>${escHtml(s.one_change)}</span></div>` : ""}
      <div class="hsyn-foot"><span class="lbl">${s.generated_at ? `read ${escHtml(relTime(s.generated_at))}` : ""}</span>${stale
        ? `<button id="hsynRefresh" class="hpic-refresh hpic-refresh-stale" type="button" title="New results since this read"><span class="hdot hdot-warn"></span>New results — refresh</button>`
        : `<button class="linkbtn" id="hsynRefresh" type="button">refresh</button>`}</div>`;
  } else {
    body = `
      <p class="hsyn-invite">Your labs, training, recovery and nutrition — read as one connected, prioritized picture.</p>
      <button class="draftbtn hsyn-gen" id="hsynGen" type="button">Read my whole picture</button>`;
  }
  wrap.innerHTML = `<div class="hsyn reveal"><div class="hsyn-kicker lbl">Your health — one picture</div>${body}</div>`;
  $("#hsynRefresh")?.addEventListener("click", triggerHealthSynthesis);
  $("#hsynGen")?.addEventListener("click", triggerHealthSynthesis);
}

function loadHealthSynthesis(token: number): void {
  const wrap = $<HTMLElement>("#hSynthesis");
  if (!wrap || !wrap.isConnected) return;
  api("/health/synthesis")
    .then((data) => renderHealthSynthesis(data || {}, token))
    .catch(() => { /* leave quiet */ });
}

// Regenerate the synthesis — a streamed background job (reads the whole picture;
// can take ~30-90s), reconnects across reloads via runOp.
function triggerHealthSynthesis(): void {
  const wrap = $<HTMLElement>("#hSynthesis");
  if (!wrap) return;
  const card = wrap.querySelector(".hsyn");
  if (card && !card.querySelector(".job-cap")) {
    const cap = document.createElement("div");
    cap.className = "job-cap lbl hsyn-cap";
    card.appendChild(cap);
  }
  runOp("health_synthesis", {}, {
    path: "/health/synthesis",
    anchor: "#hSynthesis .hsyn",
    caption: ["reading your labs", "connecting it to your training & recovery", "finding what matters most", "writing your picture"],
    guard: () => !$("#hSynthesis")?.isConnected,
    render: (result) => {
      const payload = healthScreenRecord(result) as HealthSynthesisPayload;
      if (payload.synthesis) renderHealthSynthesis(payload, pollToken);
      else loadHealthSynthesis(pollToken);
      swrInvalidate("plan:coach");
    },
    onFail: () => { toast("Couldn't read the picture right now — try again in a bit."); loadHealthSynthesis(pollToken); },
  });
}

// ---- Supplements: UNDERSTANDING, not a daily log ----
// Say it once in plain words ("creatine daily, omega-3, some D, whey occasionally")
// → the system approximates each into name · dose · cadence and folds it into the
// connected brain. No rows-per-day, no check-offs — just what you're taking.
// Symptom ↔ marker connections — a quiet "worth mentioning to your doctor" read when
// something the athlete logged (a life event, a check-in note) lines up with an
// out-of-range marker. Pull-only, informational, never diagnostic. Renders nothing
// when there's no genuine co-occurrence (the common, calm case).
async function loadSymptomLinks(token: number): Promise<void> {
  const wrap = $<HTMLElement>("#hbSymptomLinks");
  if (!wrap || !wrap.isConnected) return;
  let r: { links?: unknown[] } | null = null;
  try { r = await api("/symptom-links"); } catch { r = null; }
  if ((token != null && token !== pollToken) || !wrap.isConnected) return;
  const links = healthScreenRows<SymptomLink>(r?.links);
  if (!links.length) { wrap.innerHTML = ""; return; }
  const cards = links.slice(0, 3).map((l) => {
    const mk = Array.isArray(l.markers)
      ? healthScreenRows<SymptomMarker>(l.markers).map((m) => `${escHtml(m.name)}${m.value != null ? ` ${escHtml(String(m.value))}` : ""}${m.unit ? ` ${escHtml(m.unit)}` : ""}`).join(", ")
      : "";
    return `<div class="symlink">
        <div class="symlink-note">${escHtml(l.note || "")}</div>
        ${mk ? `<div class="symlink-mk lbl">${mk}</div>` : ""}
      </div>`;
  }).join("");
  wrap.innerHTML = `<div class="hb-section symlink-card reveal">
      <span class="lbl">Worth mentioning to your doctor</span>
      <p class="symlink-sub">Something you noted lines up with one of your lab markers. Informational only — a question for your clinician, never a diagnosis.</p>
      ${cards}
    </div>`;
}

function loadSupplements(token: number): void {
  const wrap = $<HTMLElement>("#hbSupplements");
  if (!wrap || !wrap.isConnected) return;
  const peek = peekCached("supplements");
  if (peek) renderSupplements(peek.data, token);
  cachedApi("/supplements", {
    key: "supplements",
    onUpgrade: (data, { changed }) => { if (changed || !peek) renderSupplements(data, token); },
  }).catch(() => { if (!peek) renderSupplements([], token); });
}

function renderSupplements(list: unknown, token?: number | null): void {
  const wrap = $<HTMLElement>("#hbSupplements");
  if (!wrap || !wrap.isConnected || (token != null && token !== pollToken)) return;
  const items = healthScreenRows<HealthSupplement>(list);
  const chips = items.map((s) => {
    const bits = [s.dose, s.frequency].filter(Boolean).map(escHtml).join(" · ");
    return `<div class="supp-chip" title="${escAttr(s.note || s.name)}">
        <span class="supp-name">${escHtml(s.name)}</span>${bits ? `<span class="supp-meta">${bits}</span>` : ""}
        <button class="supp-x" data-suppx="${s.id}" aria-label="Remove ${escAttr(s.name)}">×</button>
      </div>`;
  }).join("");
  wrap.innerHTML = `<div class="hb-section supp-card reveal" style="${stagger(3)}">
      <span class="lbl">What you're taking</span>
      <p class="supp-sub">Say it once in plain words — I'll approximate the rest and fold it into your picture.</p>
      ${items.length ? `<div class="supp-chips">${chips}</div>` : `<p class="supp-empty">Nothing yet. Tell me below, or just mention it in chat.</p>`}
      <div class="supp-input">
        <input id="suppText" type="text" placeholder="e.g. creatine daily, omega-3…" autocomplete="off" />
        <button id="suppAdd" class="ghostbtn">Add</button>
      </div>
    </div>`;
  const input = $<HTMLInputElement>("#suppText");
  const submit = () => understandSupplementsFromInput();
  $("#suppAdd")?.addEventListener("click", submit);
  input?.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
  wrap.querySelectorAll<HTMLElement>("[data-suppx]").forEach((b) =>
    b.addEventListener("click", () => removeSupplement(Number(b.dataset.suppx)))
  );
}

async function understandSupplementsFromInput(): Promise<void> {
  const input = $<HTMLInputElement>("#suppText");
  const text = (input?.value || "").trim();
  if (!text) return;
  const btn = $<HTMLButtonElement>("#suppAdd");
  if (btn) { btn.disabled = true; btn.textContent = "Reading…"; }
  try {
    await api("/supplements/understand", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
    });
    swrInvalidate("supplements");
    loadSupplements(pollToken);
  } catch { if (btn) { btn.disabled = false; btn.textContent = "Add"; } }
}

async function removeSupplement(id: number): Promise<void> {
  try {
    await api(`/supplements/${id}`, { method: "DELETE" });
    swrInvalidate("supplements");
    loadSupplements(pollToken);
  } catch {}
}

// ---- Recovery (calm, plain-language; never a score) ----
// Render a quiet line about how recovery's been over the window. ONE home now: the
// top of the Read view (#hRecovery). Bails to nothing / a quiet hint when there's
// no wearable or check-in data.
// SWR over /recovery?days=14 (key recovery:14): a warm re-entry paints the recovery
// read instantly, then revalidates. `sel` targets which slot this call paints.
function loadRecoverySummary(token: number, sel: string): void {
  const wrap = $<HTMLElement>(sel);
  if (!wrap || !wrap.isConnected) return;
  const paint = (r: unknown) => {
    const summary = healthScreenRecord(r) as RecoverySummary;
    const w = $<HTMLElement>(sel);
    if (token !== pollToken || !w || !w.isConnected) return;
    if (!summary.has_data) {
      // quiet hint, not a nag — capture is offered, never demanded
      w.innerHTML = CairnHealthRead.recoveryNoDataHtml();
      return;
    }
    w.innerHTML = CairnHealthRead.recoveryHtml(summary);
  };
  const peek = peekCached("recovery:14");
  if (peek) { paint(peek.data); if (!peek.fresh) markRefreshing(true); }
  cachedApi("/recovery?days=14", {
    key: "recovery:14",
    onUpgrade: (data, { changed }) => { if (peek && !peek.fresh) markRefreshing(false); if (changed || !peek) paint(data); },
  }).catch(() => { if (peek && !peek.fresh) markRefreshing(false); });
}

// ---- Priority markers (optimal-zone framing, never a score) ----
// Phrase each marker in plain language against its optimal zone: "ApoB — above
// optimal", "HbA1c — in your optimal range", "Ferritin — below optimal". Order
// comes from the server (impact_score); we NEVER render that number.
// SWR over /markers/priority (key shared with the Markers tab): a warm re-entry
// into the Health → Read view paints "what matters now" instantly, then revalidates.
function loadPriorityMarkers(token: number): void {
  const wrap = $<HTMLElement>("#hbMarkers");
  if (!wrap || !wrap.isConnected) return;
  const paint = (res: unknown) => {
    if (token !== pollToken || !wrap.isConnected) return;
    const markers = healthScreenRows<HealthMarkerRow>((healthScreenRecord(res) as MarkerPriorityResponse).markers);
    wrap.innerHTML = CairnHealthRead.priorityMarkersSectionHtml(markers);
    $("#hbToMarkers")?.addEventListener("click", () => switchHealthSeg("markers"));
  };
  const peek = peekCached("markers:priority");
  if (peek) { paint(peek.data); if (!peek.fresh) markRefreshing(true); }
  cachedApi("/markers/priority", {
    key: "markers:priority",
    onUpgrade: (data, { changed }) => { if (peek && !peek.fresh) markRefreshing(false); if (changed || !peek) paint(data); },
    // No cached read + a thrown fetch (offline / parse failure): clear the
    // "Reading what matters most…" placeholder to the calm empty state instead
    // of leaving the loader stuck forever.
  }).catch(() => { if (peek && !peek.fresh) markRefreshing(false); if (!peek) paint(null); });
}

// ---- Cross-domain directives, grouped by domain (the review side) ----
// Pure directive grouping and card rendering live in health-client.js.
Object.assign(globalThis, {
  HEALTH_SEG,
  ME_HANDLERS,
  ME_SEG,
  _hPic,
  buildPictureHtml,
  fmtMkNum,
  healthDotClass,
  healthDocsKnownEmpty,
  healthHeroHtml,
  healthMarkerSubgroup,
  hmkRowHtml,
  lipidGroupNoteHtml,
  loadHealthMarkers,
  loadHealthPicture,
  loadHealthStanding,
  loadHealthSynthesis,
  loadPriorityMarkers,
  loadRecoverySummary,
  loadSupplements,
  loadSymptomLinks,
  markerChartSvg,
  markerPanelHtml,
  markerSpanWord,
  markerTrendWord,
  normalizeHealthSeg,
  onHealthReadView,
  openBpSheet,
  openHealthRead,
  orderHealthMarkersForDisplay,
  paintHealthPicture,
  paintHealthReadTab,
  paintHealthTab,
  paintStandingReview,
  parsedReview,
  renderActs,
  renderHealth,
  renderHealthStanding,
  renderHealthSynthesis,
  renderMe,
  renderMeProfile,
  renderMeStanding,
  renderMemory,
  renderNotes,
  renderSupplements,
  reviewBusyHtml,
  reviewHtml,
  runHealthReview,
  scrollHealthRailIntoView,
  setHealthSegActive,
  sparkDateLabel,
  startMemDelete,
  startMemEdit,
  switchHealthSeg,
  triggerHealthSynthesis,
  understandSupplementsFromInput,
  wireNoteCard,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    renderMe,
    renderMemory,
    switchHealthSeg,
    loadHealthMarkers,
    paintHealthPicture,
  });
}
}
