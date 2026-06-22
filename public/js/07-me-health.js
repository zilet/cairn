// ==== 07-me-health.js ====
// ---------- Me (segmented: Profile / Memory / Health / Life) ----------
const ME_SEG = [["profile", "Profile"], ["memory", "Memory"], ["health", "Health"], ["life", "Life"], ["family", "Family"]];
// Lazy handler refs (arrow-wrapped like PROGRESS_HANDLERS/PLAN_HANDLERS): renderLife and
// renderFamily live in a later-loaded module, so bare references would resolve at parse
// time — before that script runs — and throw. Arrows defer resolution to call time, by
// which point every module is loaded. wireSeg/renderMe call handlers with no args.
const ME_HANDLERS = { profile: () => renderMeProfile(), memory: () => renderMemory(), health: () => renderHealth(), life: () => renderLife(), family: () => renderFamily() };
function renderMe() {
  headerTitle.textContent = "Me";
  pollToken++; // invalidate in-flight enrichment polls
  if (!state.meSeg) state.meSeg = "profile";
  return (ME_HANDLERS[state.meSeg] || renderMeProfile)();
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
  const [profile, goal] = await Promise.all([api("/profile"), api("/goal")]);
  const p = profile || {};
  setDiscipline(p.primary_discipline); // keep the emphasis global in sync with what's on file
  setEnduranceGoalSet(!!p.endurance_goal_json);
  const disc = primaryDiscipline;
  // The endurance OBJECTIVE (v37) — race | standing | none. Parsed from the profile
  // row's JSON; the editor below lets the athlete set a race to build toward or a
  // standing "stay ready" target, orthogonal to the sport/discipline above.
  let egCur = {};
  try { egCur = p.endurance_goal_json ? JSON.parse(p.endurance_goal_json) : {}; } catch { egCur = {}; }
  const egMode = egCur && egCur.mode ? egCur.mode : "none";
  const num = (id, label, val, step) =>
    `<div class="field" style="margin-bottom:9px"><label>${label}</label>
     <input id="${id}" type="number" step="${step||1}" value="${val ?? ""}" class="form-input"></div>`;

  const reqWarn = goal?.requested?.aggressive
    ? `<div class="ex-flag" style="margin-top:0"><b>Goal too aggressive for lean mass.</b> ${goal.message}</div>`
    : `<div class="sess-line">${goal?.message || ""}</div>`;

  await skelSwap(() => { view.innerHTML = segBar("profile", ME_SEG) + `
    <div class="sess">
      <div class="sess-head"><span class="sess-date">Goal check</span><span class="sess-day">${goal?.tdee ? goal.tdee + " kcal TDEE" : ""}</span></div>
      ${reqWarn}
      ${goal?.recommended ? `<div class="sess-line" style="margin-top:6px"><b>Lean-safe target:</b> ${goal.recommended.target_intake_kcal} kcal \u00b7 ${goal.recommended.protein_g} g protein \u00b7 ${goal.recommended.weekly_rate_lb} lb/wk</div>` : ""}
    </div>
    <h1 class="lbl" style="margin:24px 0 8px">Profile</h1>
    <div id="profFields">
    <div class="field" style="margin-bottom:9px"><label for="name">Name <span class="ob-opt">— optional</span></label>
      <p class="aboutme-hint">Stamped on the doctor report you export from Health → Markers. Leave empty to fill it in on paper instead.</p>
      <input id="name" type="text" placeholder="e.g. Alex Rivera" maxlength="120" value="${escAttr(p.name || "")}" class="form-input"></div>
    ${num("age","Age",p.age)}
    ${num("height_cm","Height (cm)",p.height_cm,0.1)}
    ${num("weight_lb","Weight (lb)",p.weight_lb,0.1)}
    ${num("goal_weight_lb","Goal weight (lb)",p.goal_weight_lb,0.1)}
    <div class="field" style="margin-bottom:9px"><label>Goal date</label>
      <input id="goal_date" type="date" value="${p.goal_date || ""}" class="form-input"></div>
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
  let pickedDisc = disc;
  let pickedEgMode = egMode;
  // Assemble the endurance goal from the active mode's fields (none → null clears it).
  const egPayload = () => {
    const dist = +$("#eg_distance")?.value || null;
    const wk = +$("#eg_weekly_km")?.value || null;
    if (pickedEgMode === "race") {
      const date = $("#eg_date")?.value || null;
      // A race needs a date to be periodized — the server would reject a dateless
      // race to null (a silent clear). Don't clobber an existing goal mid-entry:
      // return undefined (JSON omits it → leaves the saved goal intact) + a calm hint.
      if (!date) { toast("Add a race date to save your race goal"); return undefined; }
      return { mode: "race", event: ($("#eg_event")?.value ?? "").trim() || null,
        date, distance_km: dist, target: ($("#eg_target")?.value ?? "").trim() || null, weekly_km: wk };
    }
    if (pickedEgMode === "standing") {
      return { mode: "standing", label: ($("#eg_label")?.value ?? "").trim() || null, distance_km: dist, weekly_km: wk };
    }
    return null; // none
  };
  const persistProfile = async () => {
    const body = {
      name: ($("#name")?.value ?? "").trim(),
      age: +$("#age").value || null, height_cm: +$("#height_cm").value || null,
      weight_lb: +$("#weight_lb").value || null, goal_weight_lb: +$("#goal_weight_lb").value || null,
      goal_date: $("#goal_date").value || null, activity_factor: +$("#activity_factor").value || null,
      primary_discipline: pickedDisc,
      endurance_sport: pickedDisc === "strength" ? "" : (($("#endurance_sport")?.value ?? "").trim()),
      endurance_goal: egPayload(),
      about_me: ($("#about_me")?.value ?? "").trim(),
      allergies: ($("#allergies")?.value ?? "").trim(),
      dietary_restrictions: ($("#dietary_restrictions")?.value ?? "").trim(),
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
  const profBar = mountSaveBar({
    sentinel: $("#profFields"),
    fields: $("#profFields"),
    onSave: persistProfile,
    onDiscard: () => renderMeProfile(),
  });
  // Discipline segmented control: pick one (background-swap active state, like
  // onboarding's days/week), reveal the optional sport field for endurance/hybrid,
  // and mark the screen dirty so Save surfaces.
  $("#discSeg")?.querySelectorAll("[data-disc]").forEach((b) =>
    b.addEventListener("click", () => {
      pickedDisc = b.dataset.disc;
      $("#discSeg").querySelectorAll(".segbtn").forEach((x) => x.classList.toggle("active", x === b));
      const sportField = $("#endSportField");
      if (sportField) sportField.style.display = pickedDisc === "strength" ? "none" : "";
      profBar.markDirty();
    })
  );
  // Running-goal mode: None / Race / Standing — toggle the relevant fields, mark dirty.
  $("#endGoalMode")?.querySelectorAll("[data-egmode]").forEach((b) =>
    b.addEventListener("click", () => {
      pickedEgMode = b.dataset.egmode;
      $("#endGoalMode").querySelectorAll(".segbtn").forEach((x) => x.classList.toggle("active", x === b));
      const race = $("#egRace"), standing = $("#egStanding"), shared = $("#egShared");
      if (race) race.style.display = pickedEgMode === "race" ? "" : "none";
      if (standing) standing.style.display = pickedEgMode === "standing" ? "" : "none";
      if (shared) shared.style.display = pickedEgMode === "none" ? "none" : "";
      profBar.markDirty();
    })
  );
  // Capture is consolidated on Today + Chat — these just route there.
  $("#profToToday")?.addEventListener("click", () => activateTab("today"));
  $("#profToProgress")?.addEventListener("click", () => activateTab("progress"));
}

function foodNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function formatFoodNum(v) {
  const n = foodNum(v);
  if (n === null) return "";
  return Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1);
}
function foodIngredients(pj) {
  if (!pj || typeof pj !== "object") return [];
  if (Array.isArray(pj.ingredients)) {
    return pj.ingredients.map((x) => {
      if (typeof x === "string") return { item: x };
      if (!x || typeof x !== "object") return null;
      const item = String(x.item || x.name || "").trim();
      if (!item) return null;
      return {
        item,
        amount: x.amount || x.qty || x.quantity || "",
        kcal: foodNum(x.kcal),
        protein_g: foodNum(x.protein_g),
        carbs_g: foodNum(x.carbs_g),
        fat_g: foodNum(x.fat_g),
      };
    }).filter(Boolean);
  }
  if (Array.isArray(pj.items)) {
    return pj.items.map((x) => {
      if (typeof x === "string") return { item: x };
      if (!x || typeof x !== "object") return null;
      const item = String(x.item || x.name || "").trim();
      return item ? { item, amount: x.amount || x.qty || x.quantity || "" } : null;
    }).filter(Boolean);
  }
  return [];
}
function ingredientLabel(ing) {
  const amount = String(ing?.amount || "").trim();
  const item = String(ing?.item || "").trim();
  if (!amount) return item;
  if (item.toLowerCase().startsWith(amount.toLowerCase())) return item;
  return `${amount} ${item}`;
}
function foodItemsText(pj) {
  if (!pj || typeof pj !== "object") return "";
  if (Array.isArray(pj.items)) return pj.items.map((x) => typeof x === "string" ? x : (x?.item || x?.name || "")).filter(Boolean).join(", ");
  return pj.items || "";
}
function foodTitleFromIngredients(pj) {
  const items = foodIngredients(pj).map((x) => x.item).filter(Boolean);
  if (!items.length) return "";
  return items.slice(0, 3).join(", ") + (items.length > 3 ? "..." : "");
}
function foodMacroText(pj, opts = {}) {
  if (!pj || typeof pj !== "object") return "";
  const parts = [];
  if (opts.kcal !== false && foodNum(pj.kcal) !== null) parts.push(`${formatFoodNum(pj.kcal)} kcal`);
  const labels = opts.short
    ? [["P", "protein_g"], ["C", "carbs_g"], ["F", "fat_g"], ["Fiber", "fiber_g"]]
    : [["protein", "protein_g"], ["carbs", "carbs_g"], ["fat", "fat_g"], ["fiber", "fiber_g"]];
  for (const [label, key] of labels) {
    if (foodNum(pj[key]) !== null) parts.push(`${formatFoodNum(pj[key])}g ${label}`);
  }
  return parts.join(" · ");
}

// food-note parsed_json may arrive as a JSON string or an object
function parsedNote(n) {
  let pj = n?.parsed && typeof n.parsed === "object" ? n.parsed : n?.parsed_json;
  if (typeof pj === "string") { try { pj = JSON.parse(pj); } catch { pj = null; } }
  return pj || null;
}
function noteEntryInner(n) {
  const pj = parsedNote(n);
  const date = (n.created_at || "").slice(0, 10);
  let detail;
  const text = n.raw || n.raw_output || "";
  if (pj) {
    const macros = foodMacroText(pj, { kcal: true, short: true });
    const ingredients = foodIngredients(pj);
    const items = ingredients.length ? ingredients.map(ingredientLabel).join(", ") : foodItemsText(pj);
    const title = pj.summary || foodTitleFromIngredients(pj) || text;
    detail = `<div class="meal-name">${escHtml(title)}</div>` +
      (items ? `<div class="meal-items">${escHtml(items)}</div>` : "") +
      (macros ? `<span class="fn-macros">${escHtml(macros)}</span>` : "") +
      (pj.notes ? `<div class="sess-line" style="color:var(--muted)">${escHtml(pj.notes)}</div>` : "");
  } else {
    detail = `<div class="meal-name">${escHtml(text)}</div>`;
  }
  const q = n.raw_text || n.raw || n.raw_output || (pj && (pj.summary || pj.items)) || "";
  const tile = artImg("food", q, "artile-sm meal-art", art("food", q));
  const body = tile
    ? `<div class="meal-row">${tile}<div class="meal-main">${detail}</div></div>`
    : detail;
  return `<div class="sess-head"><span class="sess-date" style="font-size:.9rem">${escHtml(n.meal || "")} · ${escHtml(date)}</span><span class="fnent-badge">${enrichBadge(n.enrichment_status)}</span></div>${body}`;
}
function noteEntryHtml(n, i) {
  const rev = typeof i === "number";
  return `<div class="sess fnent tappable${rev ? " reveal" : ""}" data-noteid="${n.id}"${rev ? ` style="${stagger(i)}"` : ""}>${noteEntryInner(n)}</div>`;
}

// tap a note card → full-screen food detail (zooming from its art tile)
function wireNoteCard(el) {
  if (!el || el._wired) return; el._wired = true;
  el.addEventListener("click", (e) => {
    if (e.target.closest("button, a, input")) return;
    const n = (state._notesById || {})[el.dataset.noteid];
    if (n) openFoodDetail(n, el.querySelector(".artile"));
  });
}

function renderNotes(notes) {
  const wrap = $("#notelist");
  if (!notes || !notes.length) { wrap.innerHTML = `<div class="empty">Nothing logged yet. Snap a plate or jot a meal in Chat and it shows up here.</div>`; return; }
  state._notesById = Object.fromEntries(notes.map((n) => [String(n.id), n]));
  wrap.innerHTML = notes.map((n, i) => noteEntryHtml(n, i)).join("");
  wrap.querySelectorAll(".fnent").forEach(wireNoteCard);
}

function renderActs(acts) {
  const wrap = $("#actlist");
  if (!acts.length) { wrap.innerHTML = `<div class="empty">Nothing logged yet. Log a ride, run, or walk on Today and it lands here.</div>`; return; }
  wrap.innerHTML = acts.map((a) => actEntryHtml(a)).join("");
}

// ---------- Me: Memory (what the coach remembers) ----------
const MEM_KINDS = ["note", "preference", "constraint", "goal", "fact"];
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
      <select id="memKind">${MEM_KINDS.map((k) => `<option value="${k}">${k}</option>`).join("")}</select>
      <input id="memInput" type="text" placeholder="Add something to remember…">
      <button id="memAdd" class="logbtn">+</button>
    </div>
    <div id="memlist" style="margin-top:12px"></div>`;
  wireSeg(ME_HANDLERS);

  const addBtn = $("#memAdd"), input = $("#memInput");
  const add = async () => {
    const content = input.value.trim();
    if (!content) { input.focus(); return; }
    const kind = $("#memKind").value;
    input.value = "";
    try { await api("/memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content, kind }) }); }
    catch { toast("Couldn't save that — try again."); return; }
    toast("Remembered");
    loadMemory();
  };
  addBtn.addEventListener("click", add);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
  loadMemory();
}

async function loadMemory() {
  const wrap = $("#memlist");
  if (!wrap) return;
  let items = [];
  try { items = await api("/memory"); } catch { items = []; }
  if (state.tab !== "me" || state.meSeg !== "memory" || !wrap.isConnected) return;
  if (!items || !items.length) { wrap.innerHTML = `<div class="empty">Nothing remembered yet. As you chat and log, the coach keeps the facts and preferences that matter — they'll gather here.</div>`; return; }
  wrap.innerHTML = items.map((m, i) => {
    const date = (m.created_at || "").slice(0, 10);
    const src = m.source && m.source !== "user" ? ` · ${escHtml(m.source)}` : "";
    return `<div class="memrow reveal" style="${stagger(i)}" data-mem="${m.id}">
      <div class="memrow-main">
        <div class="memrow-top"><span class="memtag">${escHtml(m.kind || "note")}</span><span class="memdate">${escHtml(date)}${src}</span></div>
        <div class="memcontent" data-memcontent>${escHtml(m.content || "")}</div>
      </div>
      <div class="memctl">
        <button class="iconbtn" data-memedit title="edit">✎</button>
        <button class="iconbtn memdel" data-memdel title="delete">×</button>
      </div>
    </div>`;
  }).join("");

  wrap.querySelectorAll("[data-memedit]").forEach((b) => b.addEventListener("click", () => startMemEdit(b.closest(".memrow"))));
  wrap.querySelectorAll("[data-memdel]").forEach((b) => b.addEventListener("click", () => startMemDelete(b)));
}

// inline edit: swap the content line for an input + save/cancel
function startMemEdit(row) {
  if (!row || row.querySelector(".memedit-box")) return;
  const id = row.dataset.mem;
  const contentEl = row.querySelector("[data-memcontent]");
  const current = contentEl.textContent;
  contentEl.hidden = true;
  const box = document.createElement("div");
  box.className = "memedit-box";
  box.innerHTML = `<input class="memedit-in" type="text" value="${escAttr(current)}">
    <button class="iconbtn memok" title="save">✓</button>
    <button class="iconbtn" data-memcancel title="cancel">×</button>`;
  contentEl.after(box);
  const inp = box.querySelector(".memedit-in");
  inp.focus(); inp.setSelectionRange(current.length, current.length);
  const cancel = () => { box.remove(); contentEl.hidden = false; };
  const save = async () => {
    const content = inp.value.trim();
    if (!content) { inp.focus(); return; }
    try { await api(`/memory/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) }); }
    catch { toast("Couldn't save that — try again."); return; }
    toast("Updated"); loadMemory();
  };
  box.querySelector(".memok").addEventListener("click", save);
  box.querySelector("[data-memcancel]").addEventListener("click", cancel);
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); else if (e.key === "Escape") cancel(); });
}

// two-tap armed × — the one destructive-confirm pattern (see armDelete in 02-ui.js)
function startMemDelete(btn) {
  const id = btn.closest(".memrow").dataset.mem;
  armDelete(btn, () => {
    api(`/memory/${id}`, { method: "DELETE" }).then(() => { toast("Removed"); loadMemory(); }).catch(() => toast("Couldn't remove that — try again."));
  });
}

// ---------- Me: Health (uploaded docs + agentic analysis) ----------
const HEALTH_KINDS = [["bloodwork", "Bloodwork"], ["dexa", "DEXA"], ["other", "Other"]];
const MAX_DOC_BYTES = 15 * 1024 * 1024; // ~15MB client cap
const MAX_DOC_TEXT = 400000;

function healthKindLabel(k) {
  const m = HEALTH_KINDS.find((x) => x[0] === k);
  return m ? m[1] : (k || "Doc");
}

// parsed_json may arrive as a JSON string or an object
function parsedDoc(d) {
  let pj = d.parsed_json;
  if (typeof pj === "string") { try { pj = JSON.parse(pj); } catch { pj = null; } }
  return pj || null;
}

// flag -> color class. "low"/"high"/"abnormal" -> warn accent; "normal"/"ok" -> muted.
function markerFlagClass(flag) {
  const f = String(flag || "").toLowerCase();
  if (f === "low" || f === "high" || f === "abnormal" || f === "critical") return "hm-flag warn";
  if (f) return "hm-flag ok";
  return "";
}

function markersTable(pj) {
  const markers = pj && Array.isArray(pj.markers) ? pj.markers : [];
  if (!markers.length) return "";
  const rows = markers.map((mk) => {
    const flag = mk.flag ? `<span class="${markerFlagClass(mk.flag)}">${escHtml(mk.flag)}</span>` : "";
    const val = [mk.value, mk.unit].filter((x) => x != null && x !== "").join(" ");
    return `<tr>
      <td class="hm-name">${escHtml(mk.name || "")}</td>
      <td class="hm-val">${escHtml(val)}</td>
      <td class="hm-fl">${flag}</td>
    </tr>`;
  }).join("");
  return `<table class="hmarkers"><tbody>${rows}</tbody></table>`;
}

// True when a card holds enough analyzed substance to be worth collapsing behind
// a one-line teaser (a done analysis with markers or a summary). Shared by the
// card renderer and the initial collapsed-state decision so they never drift.
function docCollapsible(d) {
  const pj = parsedDoc(d);
  const markers = pj && Array.isArray(pj.markers) ? pj.markers : [];
  return d.enrichment_status === "done" && (markers.length > 0 || !!d.summary);
}

// Inner content of one health-doc card (re-rendered in place while enriching).
function healthDocInner(d) {
  const pj = parsedDoc(d);
  const status = d.enrichment_status;
  const derived = !!d.source_doc_id; // a dated panel split out of a multi-record import
  let analysisBadge = "";
  if (enrichmentActive(status)) analysisBadge = `<span class="enr enr-pending">analyzing...</span>`;
  else if (status === "failed") analysisBadge = `<span class="enr" style="color:var(--warn)">analysis failed</span>`;
  else if (status === "skipped") analysisBadge = `<span class="enr enr-done">not analyzed</span>`;
  else if (status === "done") analysisBadge = `<span class="enr enr-done" title="analyzed">✦ analyzed</span>`;

  let detail = "";
  if (status === "done") {
    if (d.summary) detail += `<div class="sess-line" style="margin-top:7px">${escHtml(d.summary)}</div>`;
    detail += markersTable(pj);
    if (pj && pj.type && !d.summary) detail += `<div class="sess-line" style="color:var(--muted)">${escHtml(pj.type)}</div>`;
  } else if (enrichmentActive(status)) {
    detail = `<div class="sess-line" style="color:var(--muted)">Reading the document and splitting it by date...</div>`;
  } else if (status === "failed") {
    detail = `<div class="sess-line" style="color:var(--muted)">Couldn't extract markers automatically. The original file is still saved — try Re-analyze.</div>`;
  }

  // "view file" resolves to this row's binary, or the source upload's for a panel.
  const fileId = d.has_file ? d.id : (d.source_doc_id || null);
  const busy = enrichmentActive(status);

  // Collapsible cards stand in a one-line teaser for the detail when collapsed, so
  // a growing record history stays scannable: marker + flagged counts at a glance,
  // tap the header (or teaser) to open the full table. Newest opens by default.
  const collapsible = docCollapsible(d);
  const markers = pj && Array.isArray(pj.markers) ? pj.markers : [];
  const flagged = markers.filter((mk) => {
    const f = String(mk.flag || "").toLowerCase();
    return f && f !== "normal" && f !== "optimal" && f !== "in range" && f !== "in-range";
  }).length;
  const teaser = markers.length
    ? `${markers.length} marker${markers.length === 1 ? "" : "s"}${flagged ? ` · ${flagged} flagged` : " · all in range"}`
    : "Analyzed";

  const head = `<div class="sess-head${collapsible ? " hdoc-head" : ""}"${collapsible ? ` data-hdoc-toggle role="button" tabindex="0" aria-label="Toggle record detail"` : ""}>
      <span class="sess-date">${escHtml(healthKindLabel(d.kind))}${d.doc_date ? ` · ${escHtml(d.doc_date)}` : ""}${derived ? `<span class="hdoc-tag">from import</span>` : ""}</span>
      <span class="hdoc-headright">
        <span class="hdoc-badge">${analysisBadge}</span>
        ${collapsible ? `<span class="hdoc-chev" aria-hidden="true">▾</span>` : ""}
      </span>
    </div>`;

  const teaserHtml = collapsible
    ? `<button class="hdoc-teaser" type="button" data-hdoc-toggle><span class="hdoc-teaser-txt">${escHtml(teaser)}</span><span class="hdoc-teaser-more">view</span></button>`
    : "";

  return `${head}
    ${teaserHtml}
    <div class="hdoc-detail">
      ${d.original_name && !derived ? `<div class="sess-line" style="color:var(--muted);font-size:.78rem">${escHtml(d.original_name)}</div>` : ""}
      ${detail}
    </div>
    <div class="hdoc-foot">
      <div class="hdoc-date-wrap">
        <button class="hdoc-datebtn" data-hdate-edit="${d.id}" title="Change the result date">
          <span class="hdoc-date-ico" aria-hidden="true">✎</span>
          <span class="hdoc-date-val">${d.doc_date ? escHtml(d.doc_date) : "Set date"}</span>
        </button>
        <span class="hdoc-date-edit" data-hdate-editor="${d.id}" hidden>
          <input class="hdoc-date" data-hdate="${d.id}" type="date" value="${escAttr(d.doc_date || "")}" max="${localISO()}" aria-label="Result date">
          <button class="hdoc-date-save" data-hdate-save="${d.id}">Save</button>
          <button class="hdoc-date-cancel" data-hdate-cancel="${d.id}">Cancel</button>
        </span>
        <span class="hdoc-date-flash" data-hdate-flash="${d.id}" hidden>✓ updated</span>
      </div>
      <div class="hdoc-actions">
        ${d.has_file ? `<button class="hdoc-link hdoc-rescan" data-hrescan="${d.id}"${busy ? " disabled" : ""} title="Re-run the scan over the original file">↻ re-analyze</button>` : ""}
        ${fileId ? `<a class="hdoc-link" href="${withToken(`/api/health-docs/${fileId}/file`)}" target="_blank" rel="noopener">view file</a>` : ""}
        <button class="iconbtn hdoc-del" data-hdel="${d.id}" title="delete">×</button>
      </div>
    </div>`;
}

function healthDocHtml(d, i) {
  const rev = typeof i === "number";
  const collapsed = docCollapsible(d) && rev && i > 0; // newest opens; older collapse
  return `<div class="sess hdoc${rev ? " reveal" : ""}${collapsed ? " hdoc-collapsed" : ""}" data-hdoc="${d.id}"${rev ? ` style="${stagger(i)}"` : ""}>${healthDocInner(d)}</div>`;
}

// ---------- Me: Health — the whole picture (review · markers · records) ----------
// _hPic caches what the picture panel needs across in-place repaints; the in-flight
// review run lives at module level so it survives sub-view re-renders (the POST can
// take minutes — an agent CLI run) and quietly lands wherever the user is.
let _hPic = null;        // { review, docCount, newestDocAt }
let _hReviewRun = null;  // in-flight POST /health/review promise
let _hReviewErr = null;  // gentle inline message after a failed run

const H_FILE_PROMPT = "Drop a lab PDF, MyChart export (.zip), HTML, XML, a photo, or text…";

// Browsers leave file.type empty for many .zip/.xml picks — infer from the name
// so the server's MIME allowlist accepts it. Unknown → octet-stream (rejected).
function guessUploadMime(f) {
  const t = (f.type || "").toLowerCase();
  if (t) return t;
  const name = (f.name || "").toLowerCase();
  if (name.endsWith(".zip")) return "application/zip";
  if (name.endsWith(".html") || name.endsWith(".htm")) return "text/html";
  if (name.endsWith(".xml")) return "application/xml";
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}

// review.parsed may arrive as a JSON string or an object
function parsedReview(r) {
  if (!r || r.error) return null;
  let p = r.parsed;
  if (typeof p === "string") { try { p = JSON.parse(p); } catch { p = null; } }
  return p && typeof p === "object" ? p : null;
}

// flag/status → dot modifier. Colors mirror the marker flag pills:
// low/high → warn, "watch" → gold, normal → sage, none → neutral hairline.
function healthDotClass(flag) {
  const f = String(flag || "").toLowerCase();
  if (f === "low" || f === "high" || f === "abnormal" || f === "critical") return "hdot-warn";
  if (f === "normal" || f === "ok") return "hdot-ok";
  return f ? "hdot-watch" : "hdot-mute";
}

// Static studio plate for the no-docs hero (trusted SVG, no caller text — same
// rules as art.js: cream circle, ink line, one terracotta accent).
const HEALTH_HERO_ART = `<svg viewBox="0 0 96 96" aria-hidden="true">
  <circle cx="48" cy="48" r="44" fill="#efe8db"/>
  <ellipse cx="48" cy="78" rx="24" ry="5" fill="rgba(72,58,35,.10)"/>
  <polyline points="18,54 32,54 38,40 47,66 54,44 59,54 70,54" fill="none" stroke="#211d17" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="74" cy="54" r="4" fill="#b4552d"/>
</svg>`;

function reviewBusyHtml() {
  return `<div class="hpic hpic-busy">
    <div class="hpic-top"><span class="lbl">Your picture</span><span class="hpic-when">reviewing…</span></div>
    <div class="hshimmer hshimmer-lg"></div>
    <div class="hshimmer"></div>
    <div class="hshimmer hshimmer-sm"></div>
    <div class="hpic-busynote">Reading every record and trend — this can take a few minutes. You can keep using Cairn.</div>
  </div>`;
}

function healthHeroHtml(err) {
  return `<div class="hpic hpic-hero reveal" style="${stagger(0)}">
    <div class="artile artile-lg hpic-hero-art">${HEALTH_HERO_ART}</div>
    <div class="hpic-hero-title">Build your whole picture</div>
    <div class="hpic-hero-sub">Share your bloodwork or a DEXA scan and Cairn reads it — markers, trends, and a coach's-eye view of what to do next.</div>
    ${err}
    <button id="hHeroShare" class="logbtn hpic-cta-btn">SHARE A DOCUMENT</button>
  </div>`;
}

function buildPictureHtml(err, docCount) {
  const n = Number(docCount) || 0;
  return `<div class="hpic hpic-build reveal" style="${stagger(0)}">
    <span class="lbl">Your picture</span>
    <div class="hpic-headline">Your records are in.</div>
    <div class="hpic-hero-sub">One review across ${n === 1 ? "your document" : `all ${n} documents`} — what's strong, what to watch, and what to do this week.</div>
    ${err}
    <button id="hRevBtn" class="logbtn hpic-cta-btn">BUILD MY PICTURE</button>
  </div>`;
}

function reviewHtml(review, stale, err) {
  const p = parsedReview(review) || {};
  const latestISO = latestReviewDate(p);
  const hz = (t) => escHtml(humanizeReviewText(t, latestISO)); // humanize, then escape
  const focus = (Array.isArray(p.focus) ? p.focus : []).filter((f) => f && (f.title || f.action)).map((f) => `
    <div class="hfocus">
      ${f.title ? `<div class="hfocus-title">${hz(f.title)}</div>` : ""}
      ${f.why ? `<div class="hfocus-why">${hz(f.why)}</div>` : ""}
      ${f.action ? `<div class="hfocus-act">→ ${hz(f.action)}</div>` : ""}
    </div>`).join("");
  const watch = (Array.isArray(p.watchlist) ? p.watchlist : []).filter((w) => w && (w.marker || w.why)).map((w) => `
    <div class="hwatch">
      <span class="hdot ${healthDotClass(w.status)}"></span>
      <div class="hwatch-main">
        <div class="hwatch-line"><span class="hwatch-name">${escHtml(w.marker || "")}</span>${w.status ? `<span class="hwatch-st">${escHtml(w.status)}</span>` : ""}</div>
        ${w.why ? `<div class="hwatch-why">${hz(w.why)}</div>` : ""}
        ${w.action ? `<div class="hwatch-act">${hz(w.action)}</div>` : ""}
      </div>
    </div>`).join("");
  const wins = (Array.isArray(p.wins) ? p.wins : []).filter(Boolean).map((w) => `<li>${hz(w)}</li>`).join("");
  const fu = (Array.isArray(p.followups) ? p.followups : []).filter((f) => f && f.what).map((f) => `
    <div class="hfu"><span class="hfu-what">${hz(f.what)}</span>${f.when ? `<span class="hfu-when">${escHtml(f.when)}</span>` : ""}</div>`).join("");
  const impacts = [["Training", p.training_impact], ["Nutrition", p.nutrition_impact]]
    .filter(([, v]) => v)
    .map(([l, v]) => `<div class="himpact"><span class="lbl">${l}</span><span class="himpact-t">${hz(v)}</span></div>`).join("");
  const when = review.created_at ? `Reviewed ${relTime(review.created_at)}` : "Reviewed";
  const asOf = latestISO ? `<span class="hpic-asof lbl">As of ${escHtml(humanDate(latestISO))}</span>` : "";
  const refresh = stale
    ? `<button id="hRevBtn" class="hpic-refresh hpic-refresh-stale" title="New results since this review"><span class="hdot hdot-warn"></span>New results — refresh</button>`
    : `<button id="hRevBtn" class="hpic-refresh">↻ refresh</button>`;
  return `<div class="hpic reveal" style="${stagger(0)}">
    <span class="lbl">Your picture</span>
    ${p.headline ? `<div class="hpic-headline">${hz(p.headline)}</div>` : ""}
    ${asOf}
    ${focus ? `<span class="hpic-sub lbl">This week's focus</span><div class="hfocus-list">${focus}</div>` : ""}
    ${watch ? `<span class="hpic-sub lbl">Watchlist</span><div class="hwatch-list">${watch}</div>` : ""}
    ${wins ? `<span class="hpic-sub lbl">Going well</span><ul class="hwins">${wins}</ul>` : ""}
    ${fu ? `<span class="hpic-sub lbl">Follow-ups</span><div class="hfu-list">${fu}</div>` : ""}
    ${impacts ? `<div class="himpacts">${impacts}</div>` : ""}
    ${err}
    <div class="hpic-foot">
      <span class="hpic-when">${escHtml(when)}${review.agent ? ` · ${escHtml(review.agent)}` : ""}</span>
      ${refresh}
    </div>
  </div>`;
}

// Paint #hPicture from _hPic + the in-flight run state. Safe to call anytime —
// bails unless the Health sub-view is live.
function paintHealthPicture() {
  const wrap = $("#hPicture");
  if (!wrap || state.tab !== "me" || state.meSeg !== "health" || state.healthSeg !== "read" || !wrap.isConnected) return;
  if (_hReviewRun) { wrap.innerHTML = reviewBusyHtml(); return; }
  const pic = _hPic || {};
  const err = _hReviewErr ? `<div class="hpic-err">${escHtml(_hReviewErr)}</div>` : "";
  const p = parsedReview(pic.review);
  if (!p && !(pic.docCount > 0)) {
    // nothing shared yet → inviting hero; CTA jumps to the Records tab + file picker
    wrap.innerHTML = healthHeroHtml(err);
    const b = $("#hHeroShare");
    if (b) b.addEventListener("click", () => switchHealthSeg("records", { openPicker: true }));
    return;
  }
  if (!p) {
    // records exist but no review yet → primary "build" action
    wrap.innerHTML = buildPictureHtml(err, pic.docCount);
    const b = $("#hRevBtn"); if (b) b.addEventListener("click", runHealthReview);
    return;
  }
  const rT = Date.parse(pic.review.created_at || "") || 0;
  const dT = Date.parse(pic.newestDocAt || "") || 0;
  wrap.innerHTML = reviewHtml(pic.review, rT > 0 && dT > rT, err);
  const b = $("#hRevBtn"); if (b) b.addEventListener("click", runHealthReview);
}

// POST /api/health/review — an agent run that can take minutes. One in-flight run
// max; the shimmer card holds the slot, and ok:false lands as a gentle inline note.
async function runHealthReview() {
  if (_hReviewRun) return;
  _hReviewErr = null;
  _hReviewRun = api("/health/review", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
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

async function loadHealthPicture(token, docsP) {
  let review = null, docs = [];
  try { review = await api("/health/review"); } catch { review = null; }
  try { docs = (await docsP) || []; } catch { docs = []; }
  if (review && review.error) review = null;
  if (review) state.healthReview = review;
  if (token !== pollToken) return; // navigated away / re-rendered
  const newest = docs.reduce((m, d) => (d.created_at && (!m || d.created_at > m) ? d.created_at : m), null);
  _hPic = { review, docCount: docs.length, newestDocAt: newest };
  paintHealthPicture();
}

// ---- markers (trends) ----
function fmtMkNum(v) {
  const n = Number(v);
  if (!isFinite(n)) return String(v ?? "");
  const a = Math.abs(n);
  const r = a >= 100 ? Math.round(n) : a >= 10 ? Math.round(n * 10) / 10 : Math.round(n * 100) / 100;
  return String(r);
}

function sparkDateLabel(d) {
  if (!d) return "";
  const s = String(d);
  const t = new Date(s.length === 10 ? s + "T00:00:00" : s);
  if (isNaN(t)) return s;
  return t.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" });
}

// Plain-language trend phrase from the server's `trend` (no numeric grade — the
// constitution bans scores). Falls back to deriving direction from the points span.
function markerTrendWord(m) {
  const t = m.trend || {};
  const dir = t.dir;
  if (!dir || dir === "stable") {
    // an explicit stable read, or not enough movement to call
    const pts = (m.points || []).filter((p) => p && isFinite(Number(p.value)));
    if (dir === "stable" || pts.length >= 2) return "holding steady";
    return "";
  }
  const span = markerSpanWord(t.span_days);
  return `${dir}${span ? ` over ${span}` : ""}`;
}

// "~14 mo" / "~3 wk" / "~9 days" — a soft span for the trend phrase.
function markerSpanWord(days) {
  const d = Number(days);
  if (!isFinite(d) || d <= 0) return "";
  if (d < 21) return `~${Math.round(d)} days`;
  if (d < 75) return `~${Math.round(d / 7)} wk`;
  return `~${Math.max(1, Math.round(d / 30))} mo`;
}

// Richer inline progress chart — hand-built SVG, no library. Shades the optimal-zone
// band (when present, folded into the y-domain so it's always visible), draws a
// Catmull-Rom curve through the readings (the house line), plots every numeric point
// as a flag-tinted dot, and labels the date axis at the ends. Numbers go in as
// attributes; the only text (endpoint dates) is escHtml'd — same rules as the old sparkline.
function markerChartSvg(m) {
  const raw = (m.points || []).filter((p) => p && isFinite(Number(p.value)));
  if (raw.length < 2) return "";
  const W = 300, H = 108, L = 14, R = 14, T = 14, B = 26;
  const vals = raw.map((p) => Number(p.value));
  let min = Math.min(...vals), max = Math.max(...vals);
  const opt = m.optimal && isFinite(Number(m.optimal.low)) && isFinite(Number(m.optimal.high)) ? m.optimal : null;
  // fold the optimal band into the y-domain so the shaded zone is always on-screen
  if (opt) { min = Math.min(min, Number(opt.low)); max = Math.max(max, Number(opt.high)); }
  if (max === min) { max += 1; min -= 1; }
  // a touch of headroom so dots & the band edge don't kiss the frame
  const pad = (max - min) * 0.08; min -= pad; max += pad;
  const x = (i) => L + (i * (W - L - R)) / (raw.length - 1);
  const y = (v) => T + (1 - (v - min) / (max - min)) * (H - T - B);
  const P = raw.map((p, i) => [x(i), y(Number(p.value))]);
  // optimal band rectangle (clamped to the plot)
  let band = "";
  if (opt) {
    const yHi = Math.max(T, y(Number(opt.high))), yLo = Math.min(H - B, y(Number(opt.low)));
    band = `<rect class="hchart-band" x="${L}" y="${yHi.toFixed(1)}" width="${(W - L - R).toFixed(1)}" height="${Math.max(1, yLo - yHi).toFixed(1)}" rx="3"/>`;
  }
  // gentle Catmull-Rom curve through the points
  let d = `M${P[0][0].toFixed(1)} ${P[0][1].toFixed(1)}`;
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  const dots = P.map(([px, py], i) => {
    const f = String(raw[i].flag || "").toLowerCase();
    const flagged = f === "low" || f === "high" || f === "abnormal" || f === "critical";
    return `<circle class="hchart-dot" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${i === P.length - 1 ? 4 : 2.8}" fill="${flagged ? "#b3402e" : "#6e7f5c"}"/>`;
  }).join("");
  return `<svg class="hchart" viewBox="0 0 ${W} ${H}" aria-hidden="true">
      ${band}
      <path class="hchart-line" d="${d}" fill="none" stroke="#211d17" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      ${dots}
      <text class="hchart-txt" x="${L}" y="${H - 7}" text-anchor="start">${escHtml(sparkDateLabel(raw[0].date))}</text>
      <text class="hchart-txt" x="${W - R}" y="${H - 7}" text-anchor="end">${escHtml(sparkDateLabel(raw[raw.length - 1].date))}</text>
    </svg>`;
}

// The full expanded panel: the chart, an optimal-band caption + trend words, and the
// latest reading with its relative recency. No numeric grade anywhere.
function markerPanelHtml(m) {
  const latest = m.latest || {};
  const chart = markerChartSvg(m);
  if (!chart) return "";
  const band = m.optimal && isFinite(Number(m.optimal.low)) && isFinite(Number(m.optimal.high))
    ? `optimal ${escHtml(fmtMkNum(m.optimal.low))}–${escHtml(fmtMkNum(m.optimal.high))}${m.unit ? " " + escHtml(m.unit) : ""}`
    : "";
  const trend = markerTrendWord(m);
  const caption = [band, trend].filter(Boolean).join(" · ");
  const lv = latest.value != null && latest.value !== "" ? fmtMkNum(latest.value) : "";
  const age = latest.date ? relAge(latest.date) : "";
  const latestLine = lv
    ? `<div class="hchart-latest">
        <span class="hchart-latest-v">${escHtml(lv)}${m.unit ? `<span class="hmk-unit">${escHtml(m.unit)}</span>` : ""}</span>
        ${age ? `<span class="hchart-latest-when" title="${escAttr(absDate(latest.date))}">latest · ${escHtml(age)}</span>` : ""}
      </div>`
    : "";
  return `${latestLine}${chart}${caption ? `<div class="hchart-cap">${caption}</div>` : ""}`;
}

function hmkRowHtml(m, i) {
  const latest = m.latest || {};
  const exp = (m.points || []).filter((p) => p && isFinite(Number(p.value))).length >= 2;
  const lv = Number(latest.value), pv = m.prev ? Number(m.prev.value) : NaN;
  let delta = "";
  if (isFinite(lv) && isFinite(pv) && lv !== pv) {
    const df = lv - pv;
    delta = `<span class="hmk-delta">${df > 0 ? "▲" : "▼"} ${escHtml(fmtMkNum(Math.abs(df)))}</span>`;
  }
  const age = latest.date ? relAge(latest.date) : "";
  const when = age ? `<span class="hmk-when" title="${escAttr(absDate(latest.date))}">${escHtml(age)}</span>` : "";
  const rowInner = `<span class="hdot ${healthDotClass(latest.flag)}"></span>
      <span class="hmk-id">
        <span class="hmk-name">${escHtml(m.name || m.key || "")}</span>
        ${when}
      </span>
      <span class="hmk-right">
        ${delta}
        <span class="hmk-val">${escHtml(fmtMkNum(latest.value))}${m.unit ? `<span class="hmk-unit">${escHtml(m.unit)}</span>` : ""}</span>
        <span class="hmk-chev${exp ? "" : " hmk-chev-ghost"}" aria-hidden="true">${exp ? "▾" : ""}</span>
      </span>`;
  return `<div class="hmk reveal${exp ? " hmk-x" : ""}" style="${stagger(i)}" data-mkey="${escAttr(m.key || "")}">
    ${exp
      ? `<button class="hmk-row" aria-expanded="false">${rowInner}</button>
        <div class="hmk-panel"><div class="hmk-panel-in">${markerPanelHtml(m)}</div></div>`
      : `<div class="hmk-row">${rowInner}</div>`}
  </div>`;
}

// SWR over /markers/priority (key shared with the Brain tab's priority view): a
// warm re-entry paints the grouped marker list instantly, then revalidates and
// re-paints only if the payload changed. The render is unchanged — SWR only
// changes WHEN the data arrives.
function loadHealthMarkers(token) {
  const wrap = $("#hMarkers");
  if (!wrap || !wrap.isConnected) return;
  // /markers/priority is the superset: it carries the optimal bands (for the chart) plus
  // group + trend on top of the flat marker shape /health/markers returns.
  const paint = (res) => {
    if (token !== pollToken || !wrap.isConnected) return;
    const markers = res && Array.isArray(res.markers) ? res.markers : [];
    // The export affordance only makes sense once there's at least one marker.
    const exportWrap = $("#hExport");
    if (exportWrap) exportWrap.hidden = !markers.length;
    if (!markers.length) {
      wrap.innerHTML = healthMarkersEmptyHtml();
      const b = wrap.querySelector("#hMkToRecords");
      if (b) b.addEventListener("click", () => switchHealthSeg("records", { openPicker: true }));
      return;
    }
    // Server `groups` is the canonical ordered list of groups that hold ≥1 marker; render
    // headers in that order, preserving each group's server order (flagged/impact-first).
    // Degrade gracefully if the backend hasn't shipped grouping yet: derive an ordered list
    // from the markers themselves, falling everything ungrouped into a single "Markers" bucket.
    let groups = res && Array.isArray(res.groups) ? res.groups.filter((g) => g && g.key) : [];
    if (!groups.length) {
      const seen = new Set(), derived = [];
      for (const m of markers) {
        const key = m.group || "other";
        if (!seen.has(key)) { seen.add(key); derived.push({ key, label: m.group_label || (m.group ? m.group : "Markers") }); }
      }
      groups = derived;
    }
    const byGroup = new Map(groups.map((g) => [g.key, []]));
    for (const m of markers) {
      const key = byGroup.has(m.group) ? m.group : (groups[0] && groups[0].key);
      if (byGroup.has(key)) byGroup.get(key).push(m);
    }
    let i = 0;
    const sections = groups.map((g) => {
      const list = byGroup.get(g.key) || [];
      if (!list.length) return "";
      const rows = list.map((m) => hmkRowHtml(m, i++)).join("");
      // single-group view (e.g. ungrouped fallback) skips the header — no value labelling one bucket
      const head = groups.length > 1
        ? `<div class="hmk-grouphead lbl reveal" style="${stagger(i)}">${escHtml(g.label || g.key)}</div>`
        : "";
      return `${head}<div class="hmk-card">${rows}</div>`;
    }).join("");
    wrap.innerHTML = `<div class="hmk-groups">${sections}</div>`;
    wrap.querySelectorAll(".hmk-x .hmk-row").forEach((b) =>
      b.addEventListener("click", () => {
        const item = b.closest(".hmk");
        const open = item.classList.toggle("open");
        b.setAttribute("aria-expanded", open ? "true" : "false");
      }));
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

// Health's inner views, flattened to three clear concepts (no more four-way
// double-seg, no marker/recovery surface rendered in two places):
//   • read    — "Read": the whole-picture narrative review (the crown jewel) PLUS
//               the connected brain reachable in one step — recovery (its ONE home),
//               "this week's focus" directives, what-matters-now priority, supplements.
//   • markers — "Markers": the rich trends catalog (the ONE detailed markers home).
//   • records — "Records": upload + the document list.
const HEALTH_SEG = [["read", "Read"], ["markers", "Markers"], ["records", "Records"]];

// Back-compat: an older persisted state.healthSeg ("analysis"/"brain") maps onto
// the new "read" home so a returning client never lands on a dead inner tab.
function normalizeHealthSeg(seg) {
  if (seg === "analysis" || seg === "brain") return "read";
  return HEALTH_SEG.some(([k]) => k === seg) ? seg : "read";
}

// Health is a one-level inner view: the Me seg picks "Health", then a single inner
// seg picks Read / Markers / Records. Splitting these bounds each view's scroll and
// keeps it focused — and the connected brain now lives on the default Read view, so
// it's reachable in one nav step (Me → Health) instead of buried behind a second seg.
async function renderHealth() {
  headerTitle.textContent = "Me";
  state.meSeg = "health";
  state.healthSeg = normalizeHealthSeg(state.healthSeg);
  pollToken++; // invalidate in-flight enrichment polls from a sibling sub-view
  const idx = Math.max(0, HEALTH_SEG.findIndex(([k]) => k === state.healthSeg));
  view.innerHTML = segBar("health", ME_SEG)
    + `<div class="segwrap hsegwrap"><div class="seg seg-sliding hseg" style="--segn:${HEALTH_SEG.length};--segi:${idx}">`
    +   `<span class="seg-thumb"></span>`
    +   HEALTH_SEG.map(([k, l]) => `<button class="segbtn${k === state.healthSeg ? " active" : ""}" data-hseg="${k}">${l}</button>`).join("")
    + `</div></div>`
    + `<div id="hContent"></div>`;
  wireSeg(ME_HANDLERS);
  const hseg = view.querySelector(".hseg");
  hseg.querySelectorAll(".segbtn").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.hseg === state.healthSeg) return;
    setHealthSegActive(b.dataset.hseg);
    withViewTransition(() => paintHealthTab());
  }));
  paintHealthTab();
}

// Slide the inner seg thumb + flip the active button to `seg` (no repaint).
function setHealthSegActive(seg) {
  state.healthSeg = seg;
  const hseg = view.querySelector(".hseg");
  if (!hseg) return;
  const btns = [...hseg.querySelectorAll(".segbtn")];
  const target = btns.find((b) => b.dataset.hseg === seg);
  if (!target) return;
  hseg.style.setProperty("--segi", btns.indexOf(target));
  btns.forEach((x) => x.classList.toggle("active", x === target));
  fitSeg(hseg); // keep the active pill centered when the bar is in scroll mode
}

// Programmatic inner-tab switch from a CTA. openPicker keeps the .click() in the
// same user gesture (so the file dialog isn't blocked) — hence no view transition.
function switchHealthSeg(seg, opts = {}) {
  if (state.tab !== "me" || state.meSeg !== "health") return;
  setHealthSegActive(seg);
  if (opts.openPicker) {
    paintHealthTab();
    const f = $("#hFile"); if (f) f.click();
  } else {
    withViewTransition(() => paintHealthTab());
  }
}

// Repaint #hContent for the active inner tab. Bumps pollToken so any enrichment
// poll from the tab we're leaving stops cleanly (Records resumes on return).
function paintHealthTab() {
  pollToken++;
  if (state.healthSeg === "markers") return paintHealthMarkersTab();
  if (state.healthSeg === "records") return paintHealthRecordsTab();
  return paintHealthReadTab();
}

// ---- Read tab: the whole-picture agentic review + the connected brain ----
// The crown-jewel narrative review leads, with the connected brain reachable in
// the same step (recovery — its ONE home — then "this week's focus" directives,
// what-matters-now priority, and what-you're-taking supplements). The desktop
// two-column layout splits this: the narrative review + recovery as the primary
// column, the brain (directives / priority / supplements) as the right rail.
function paintHealthReadTab() {
  const c = $("#hContent");
  if (!c) return;
  c.innerHTML = `<div class="hread-cols">
      <div class="hread-main">
        <div id="hSynthesis"></div>
        <div id="hRecovery"></div>
        <div id="hPicture">
          <div class="hpic hpic-busy"><div class="hshimmer hshimmer-lg"></div><div class="hshimmer"></div><div class="hshimmer hshimmer-sm"></div></div>
        </div>
      </div>
      <aside class="hread-rail">
        <div class="hbrain-intro sess"><div class="sess-line" style="color:var(--muted)">
          One brain across your whole picture. A finding in your labs can quietly shape your meals, your training, and what to keep an eye on. It's here to inform — never medical advice — and nothing changes your plan on its own.
        </div></div>
        <div id="hbDirectives"><div class="hb-load">Gathering directives…</div></div>
        <div id="hbMarkers"><div class="hb-load">Reading what matters most…</div></div>
        <div id="hbSupplements"></div>
      </aside>
    </div>`;
  loadHealthSynthesis(pollToken);
  loadRecoverySummary(pollToken, "#hRecovery");
  loadPriorityMarkers(pollToken);
  loadDirectives(pollToken);
  loadSupplements(pollToken);
  if (_hReviewRun) { paintHealthPicture(); return; } // a run is still cooking
  loadHealthPicture(pollToken, api("/health-docs"));
}

// ---- the elite-coach synthesis: the whole picture, read as ONE prioritized story ----
// Leads the Read tab. The agentic narrative (headline + connected story + the 2-3
// priorities + the one change) sits above the deterministic TIERED focus (act-now /
// track groups, deduped from the directive flood). Pull: it waits here; a refresh
// regenerates it as a streamed job. No scores; informational, never a verdict.
function focusTierHtml(focus) {
  const prios = (focus && Array.isArray(focus.priorities) ? focus.priorities : []);
  if (!prios.length) return "";
  const row = (p) => {
    const move = p.moves && (p.moves.nutrition || p.moves.training || p.moves.watch);
    return `<div class="hsyn-fp${p.tier === "act_now" ? " hsyn-fp-now" : ""}">
        <div class="hsyn-fp-head"><span class="hsyn-fp-dot" aria-hidden="true"></span><span class="hsyn-fp-group">${escHtml(p.group)}</span>${p.uncertain ? `<span class="hsyn-fp-soft lbl">worth confirming</span>` : ""}</div>
        <div class="hsyn-fp-why lbl">${escHtml(p.why)}</div>
        ${move ? `<div class="hsyn-fp-move">${escHtml(move)}</div>` : ""}
      </div>`;
  };
  const actNow = prios.filter((p) => p.tier === "act_now");
  const track = prios.filter((p) => p.tier !== "act_now");
  let h = "";
  if (actNow.length) h += `<div class="hsyn-tier-lbl lbl">Act on now</div>${actNow.map(row).join("")}`;
  if (track.length) h += `<div class="hsyn-tier-lbl lbl">Worth tracking</div>${track.map(row).join("")}`;
  return `<div class="hsyn-focus">${h}</div>`;
}

function renderHealthSynthesis(data, token) {
  const wrap = $("#hSynthesis");
  if (!wrap || !wrap.isConnected || (token != null && token !== pollToken)) return;
  const s = data && data.synthesis;
  const focus = (data && data.focus) || { priorities: [] };
  const hasFocus = Array.isArray(focus.priorities) && focus.priorities.length;
  if (!s && !hasFocus) { wrap.innerHTML = ""; return; } // nothing to synthesize yet — stay quiet
  // Newer labs landed since this read was written? Warn calmly, the same way the
  // review card does — so the narrative never silently contradicts the fresh focus
  // tiers below it. Read defensively for both response shapes (spread or nested).
  const stale = (data && data.stale) ?? (s && s.stale) ?? false;

  const prios = s && Array.isArray(s.priorities) ? s.priorities.filter((p) => p && (p.label || p.the_move)) : [];
  let body;
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
      ${focusTierHtml(focus)}
      <div class="hsyn-foot"><span class="lbl">${s.generated_at ? `read ${escHtml(relTime(s.generated_at))}` : ""}</span>${stale
        ? `<button id="hsynRefresh" class="hpic-refresh hpic-refresh-stale" type="button" title="New results since this read"><span class="hdot hdot-warn"></span>New results — refresh</button>`
        : `<button class="linkbtn" id="hsynRefresh" type="button">refresh</button>`}</div>`;
  } else {
    body = `
      <p class="hsyn-invite">Your labs, training, recovery and nutrition — read as one connected, prioritized picture.</p>
      ${focusTierHtml(focus)}
      <button class="draftbtn hsyn-gen" id="hsynGen" type="button">Read my whole picture</button>`;
  }
  wrap.innerHTML = `<div class="hsyn reveal"><div class="hsyn-kicker lbl">Your health — one picture</div>${body}</div>`;
  $("#hsynRefresh")?.addEventListener("click", triggerHealthSynthesis);
  $("#hsynGen")?.addEventListener("click", triggerHealthSynthesis);
}

function loadHealthSynthesis(token) {
  const wrap = $("#hSynthesis");
  if (!wrap || !wrap.isConnected) return;
  api("/health/synthesis")
    .then((data) => renderHealthSynthesis(data || {}, token))
    .catch(() => { /* leave quiet */ });
}

// Regenerate the synthesis — a streamed background job (reads the whole picture;
// can take ~30-90s), reconnects across reloads via runOp.
function triggerHealthSynthesis() {
  const wrap = $("#hSynthesis");
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
      if (result && result.synthesis) renderHealthSynthesis(result, pollToken);
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
function loadSupplements(token) {
  const wrap = $("#hbSupplements");
  if (!wrap || !wrap.isConnected) return;
  const peek = peekCached("supplements");
  if (peek) renderSupplements(peek.data, token);
  cachedApi("/supplements", {
    key: "supplements",
    onUpgrade: (data, { changed }) => { if (changed || !peek) renderSupplements(data, token); },
  }).catch(() => { if (!peek) renderSupplements([], token); });
}

function renderSupplements(list, token) {
  const wrap = $("#hbSupplements");
  if (!wrap || !wrap.isConnected || (token != null && token !== pollToken)) return;
  const items = Array.isArray(list) ? list : [];
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
  const input = $("#suppText");
  const submit = () => understandSupplementsFromInput();
  $("#suppAdd")?.addEventListener("click", submit);
  input?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
  wrap.querySelectorAll("[data-suppx]").forEach((b) =>
    b.addEventListener("click", () => removeSupplement(Number(b.dataset.suppx)))
  );
}

async function understandSupplementsFromInput() {
  const input = $("#suppText");
  const text = (input?.value || "").trim();
  if (!text) return;
  const btn = $("#suppAdd");
  if (btn) { btn.disabled = true; btn.textContent = "Reading…"; }
  try {
    await api("/supplements/understand", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
    });
    swrInvalidate("supplements");
    loadSupplements(pollToken);
  } catch { if (btn) { btn.disabled = false; btn.textContent = "Add"; } }
}

async function removeSupplement(id) {
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
function loadRecoverySummary(token, sel) {
  const wrap = $(sel);
  if (!wrap || !wrap.isConnected) return;
  const paint = (r) => {
    const w = $(sel);
    if (token !== pollToken || !w || !w.isConnected) return;
    if (!r || !r.has_data) {
      // quiet hint, not a nag — capture is offered, never demanded
      w.innerHTML = `<div class="hb-recovery hb-recovery-empty reveal" style="${stagger(0)}">
        <span class="lbl">Recovery</span>
        <p class="hb-recovery-hint">No sleep or recovery signal yet. Connect a wearable, or jot how you're feeling, and the buddy will fold it into your day.</p>
      </div>`;
      return;
    }
    w.innerHTML = recoveryHtml(r);
  };
  const peek = peekCached("recovery:14");
  if (peek) { paint(peek.data); if (!peek.fresh) markRefreshing(true); }
  cachedApi("/recovery?days=14", {
    key: "recovery:14",
    onUpgrade: (data, { changed }) => { if (peek && !peek.fresh) markRefreshing(false); if (changed || !peek) paint(data); },
  }).catch(() => { if (peek && !peek.fresh) markRefreshing(false); });
}

// Plain-language recovery summary. Each chip is a phrase, not a number you must
// interpret; we lean on rough bands (sleeping well / a little short, resting HR
// steady) so it reads like a friend's note. Numbers are kept to quiet captions.
function recoveryHtml(r) {
  const rc = r.recovery || {};
  const lines = [];
  const cap = (txt, sub) => `<div class="hb-rline"><span class="hb-rphrase">${escHtml(txt)}</span>${sub ? `<span class="hb-rsub">${escHtml(sub)}</span>` : ""}</div>`;

  const sm = Number(rc.avg_sleep_min);
  if (isFinite(sm) && sm > 0) {
    const h = Math.floor(sm / 60), m = Math.round(sm % 60);
    const hrs = sm / 60;
    const phrase = hrs >= 7.5 ? "Sleeping well" : hrs >= 6.5 ? "Sleep's about right" : hrs >= 5.5 ? "Sleep's run a little short" : "Sleep's been short";
    // Fold deep/REM architecture into the caption when the wearable reports it.
    const deep = Number(rc.avg_deep_sleep_min), rem = Number(rc.avg_rem_sleep_min);
    const arch = [
      isFinite(deep) && deep > 0 ? `${Math.round(deep)}m deep` : null,
      isFinite(rem) && rem > 0 ? `${Math.round(rem)}m REM` : null,
    ].filter(Boolean).join(" · ");
    lines.push(cap(phrase, `${h}h${m ? " " + m + "m" : ""} a night${arch ? " · " + arch : ""}`));
  }
  const rhr = Number(rc.avg_resting_hr);
  if (isFinite(rhr) && rhr > 0) lines.push(cap("Resting heart rate steady", `~${Math.round(rhr)} bpm`));
  const hrv = Number(rc.avg_hrv_ms);
  if (isFinite(hrv) && hrv > 0) {
    const st = String(rc.hrv_status || "").toLowerCase();
    const phrase = st === "balanced" ? "Heart-rate variability balanced"
      : st === "unbalanced" ? "Heart-rate variability a touch off"
      : (st === "low" || st === "poor") ? "Heart-rate variability running low"
      : "Heart-rate variability holding";
    lines.push(cap(phrase, `~${Math.round(hrv)} ms`));
  }
  const stress = Number(rc.avg_stress);
  if (isFinite(stress) && stress > 0) {
    const phrase = stress < 26 ? "Stress load's low" : stress < 51 ? "Stress load's moderate" : "Stress load's run high";
    lines.push(cap(phrase, ""));
  }
  const bb = Number(rc.avg_body_battery);
  if (isFinite(bb) && bb > 0) {
    const phrase = bb >= 60 ? "Energy reserves look good" : bb >= 40 ? "Energy reserves middling" : "Running a bit low on reserves";
    lines.push(cap(phrase, ""));
  }
  // Breathing + blood-oxygen — a quiet illness/altitude tell when it drifts.
  const resp = Number(rc.avg_respiration), spo2 = Number(rc.avg_spo2);
  if ((isFinite(resp) && resp > 0) || (isFinite(spo2) && spo2 > 0)) {
    const sub = [
      isFinite(resp) && resp > 0 ? `~${Math.round(resp)}/min` : null,
      isFinite(spo2) && spo2 > 0 ? `SpO₂ ${Math.round(spo2)}%` : null,
    ].filter(Boolean).join(" · ");
    const phrase = isFinite(spo2) && spo2 > 0 && spo2 < 93 ? "Blood oxygen ran low overnight" : "Breathing steady overnight";
    lines.push(cap(phrase, sub));
  }
  // Skin-temperature deviation — surface only when it meaningfully drifts (a soft
  // strain/illness signal on supported devices).
  const skin = Number(rc.skin_temp_dev_c);
  if (isFinite(skin) && Math.abs(skin) >= 0.3) {
    lines.push(cap(skin > 0 ? "Skin temp ran warm overnight" : "Skin temp ran cool overnight", `${skin > 0 ? "+" : ""}${skin}°C vs baseline`));
  }
  const tr = Number(rc.avg_training_readiness);
  if (isFinite(tr) && tr > 0) {
    const phrase = tr >= 75 ? "Primed to train" : tr >= 50 ? "Ready for a normal day" : tr >= 25 ? "Ease in — recovery's partial" : "Body's asking for a lighter day";
    lines.push(cap(phrase, ""));
  }
  // VO2max + training status read as objective fitness, not a verdict.
  const vo2 = Number(rc.vo2max);
  if (isFinite(vo2) && vo2 > 0) {
    const status = String(rc.training_status || "").replace(/_/g, " ").toLowerCase();
    lines.push(cap("Aerobic fitness", `VO₂max ~${Math.round(vo2)}${status ? " · " + status : ""}`));
  }
  const steps = Number(rc.avg_steps);
  if (isFinite(steps) && steps > 0) {
    const phrase = steps >= 8000 ? "Moving plenty day to day" : steps >= 4000 ? "Moving a fair bit" : "Fairly sedentary lately";
    lines.push(cap(phrase, `~${fmtK(steps)} steps`));
  }
  // Body composition (latest weigh-in from a connected scale).
  const wt = Number(rc.weight_kg), bf = Number(rc.body_fat_pct), mm = Number(rc.muscle_mass_kg);
  if ((isFinite(wt) && wt > 0) || (isFinite(bf) && bf > 0)) {
    const sub = [
      isFinite(wt) && wt > 0 ? `${Math.round(wt * 10) / 10} kg` : null,
      isFinite(bf) && bf > 0 ? `${Math.round(bf * 10) / 10}% fat` : null,
      isFinite(mm) && mm > 0 ? `${Math.round(mm * 10) / 10} kg muscle` : null,
    ].filter(Boolean).join(" · ");
    lines.push(cap("Body composition", sub));
  }
  if (!lines.length) {
    return `<div class="hb-recovery hb-recovery-empty reveal" style="${stagger(0)}">
      <span class="lbl">Recovery</span>
      <p class="hb-recovery-hint">Recovery data's coming in but nothing to call out yet.</p>
    </div>`;
  }
  const srcLabel = (r.sources || []).map((s) => s === "garmin" ? "Garmin" : s === "apple" ? "Apple Health" : s).filter(Boolean).join(" · ");
  return `<div class="hb-recovery reveal" style="${stagger(0)}">
    <div class="hb-rtop"><span class="lbl">Recovery · last 2 weeks</span>${srcLabel ? `<span class="hb-rsrc">${escHtml(srcLabel)}</span>` : ""}</div>
    <div class="hb-rlist">${lines.join("")}</div>
  </div>`;
}

// ---- Priority markers (optimal-zone framing, never a score) ----
// Phrase each marker in plain language against its optimal zone: "ApoB — above
// optimal", "HbA1c — in your optimal range", "Ferritin — below optimal". Order
// comes from the server (impact_score); we NEVER render that number.
function optimalPhrase(m) {
  const opt = m.optimal;
  const latest = m.latest || {};
  const flag = String(latest.flag || "").toLowerCase();
  // No optimal band: lean on the lab's own flag, still plain language.
  if (!opt) {
    if (flag === "high") return { word: "running high", tone: "warn" };
    if (flag === "low") return { word: "running low", tone: "warn" };
    if (flag === "normal" || flag === "ok") return { word: "in range", tone: "ok" };
    return { word: "worth a look", tone: "watch" };
  }
  if (m.in_optimal === true) return { word: "in your optimal range", tone: "ok" };
  if (m.in_optimal === false) {
    const v = Number(latest.value);
    // which side of the band — "above" / "below" optimal, in plain words
    if (isFinite(v)) {
      if (v > opt.high) return { word: "above optimal", tone: "warn" };
      if (v < opt.low) return { word: "below optimal", tone: "warn" };
    }
    if (opt.dir === "low") return { word: "below optimal", tone: "warn" };
    if (opt.dir === "high") return { word: "above optimal", tone: "warn" };
    return { word: "outside your optimal range", tone: "warn" };
  }
  // optimal exists but no numeric latest → soft
  return { word: "worth a look", tone: "watch" };
}

function priorityMarkerHtml(m, i) {
  const latest = m.latest || {};
  const phrase = optimalPhrase(m);
  const dotClass = phrase.tone === "ok" ? "hdot-ok" : phrase.tone === "warn" ? "hdot-warn" : "hdot-watch";
  const val = latest.value != null && latest.value !== "" ? fmtMkNum(latest.value) : "";
  const valLine = val ? `<span class="hb-mkval">${escHtml(val)}${m.unit ? `<span class="hmk-unit">${escHtml(m.unit)}</span>` : ""}</span>` : "";
  const points = (m.points || []).filter((p) => p && isFinite(Number(p.value)));
  const trend = points.length >= 2 ? `<div class="hb-mktrend">${sparklineSvg(points.map((p) => Number(p.value)))}</div>` : "";
  // a calm word on the optimal band itself (where it sits), no numbers-as-grade
  const bandNote = m.optimal
    ? `<span class="hb-mkband">optimal ${escHtml(fmtMkNum(m.optimal.low))}–${escHtml(fmtMkNum(m.optimal.high))}${m.unit ? " " + escHtml(m.unit) : ""}</span>`
    : "";
  const when = latest.date ? `<span class="hb-mkwhen" title="${escAttr(absDate(latest.date))}">${escHtml(relAge(latest.date))}</span>` : "";
  return `<div class="hb-mk reveal" style="${stagger(i)}">
    <div class="hb-mktop">
      <span class="hdot ${dotClass}"></span>
      <span class="hb-mkname">${escHtml(m.name || m.key || "")}</span>
      <span class="hb-mkphrase hb-mkphrase-${phrase.tone}">${escHtml(phrase.word)}</span>
      <span class="hb-mkright">${valLine}</span>
    </div>
    ${bandNote || when ? `<div class="hb-mkmeta">${bandNote}${bandNote && when ? `<span class="hb-mkdot">·</span>` : ""}${when}</div>` : ""}
    ${trend}
  </div>`;
}

// SWR over /markers/priority (key shared with the Markers tab): a warm re-entry
// into the Brain tab paints "what matters now" instantly, then revalidates.
function loadPriorityMarkers(token) {
  const wrap = $("#hbMarkers");
  if (!wrap || !wrap.isConnected) return;
  const paint = (res) => {
    if (token !== pollToken || !wrap.isConnected) return;
    const markers = res && Array.isArray(res.markers) ? res.markers : [];
    if (!markers.length) {
      wrap.innerHTML = `<div class="hb-section">
        <div class="hb-sechead"><span class="lbl">What matters now</span></div>
        <div class="empty">No markers yet. Add a lab report on the Records tab and Cairn pulls out what matters most.</div>
      </div>`;
      return;
    }
    // Lead with the few that genuinely matter (flagged or out-of-optimal); keep the
    // good ones quietly behind a fold so already-optimal markers stay silent.
    const matters = markers.filter((m) => {
      const ph = optimalPhrase(m);
      return ph.tone !== "ok";
    });
    const good = markers.filter((m) => optimalPhrase(m).tone === "ok");
    const lead = (matters.length ? matters : markers).slice(0, 4);
    const rest = (matters.length ? matters.slice(4).concat(good) : markers.slice(4));
    wrap.innerHTML = `<div class="hb-section">
      <div class="hb-sechead"><span class="lbl">What matters now</span>${matters.length ? `<span class="hb-secnote">${matters.length} to keep an eye on</span>` : `<span class="hb-secnote">all looking good</span>`}</div>
      <div class="hb-mklist">${lead.map((m, i) => priorityMarkerHtml(m, i)).join("")}</div>
      ${rest.length ? `<details class="hb-more"><summary>Everything else (${rest.length})</summary><div class="hb-mklist hb-mklist-quiet">${rest.map((m, i) => priorityMarkerHtml(m, i)).join("")}</div></details>` : ""}
      <button class="hb-mk-allbtn" id="hbToMarkers" type="button">See every trend →</button>
    </div>`;
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
const DIRECTIVE_DOMAINS = [
  ["nutrition", "Nutrition", "❧"],
  ["training", "Training", "◇"],
  ["watch", "Watch", "◉"],
];

function directiveHtml(d, i = 0, evMap = null) {
  const soft = d.uncertain && !d.citation;
  const marker = d.marker ? `<span class="hb-dmarker">${escHtml(d.marker)}</span>` : "";
  // uncertain (no citation) reads tentative — a lead, not gospel
  const lead = soft ? `<span class="hb-dsoft">Worth looking into · </span>` : "";
  const cite = d.citation ? `<div class="hb-dcite">${escHtml(d.citation)}</div>` : "";
  // "See the evidence" — turn an asserted claim into a verifiable one. Lazy-fetches
  // GET /api/evidence?marker= on first open. F1: the affordance now shows when the
  // marker has a citation OR has cached evidence rows on file (so researched
  // sources are discoverable even on a directive that carries no citation string),
  // and the count is surfaced — "see the evidence (3)". Keyed by the directive's marker.
  const evCount = d.marker && evMap ? (evMap.get(String(d.marker).toLowerCase()) || 0) : 0;
  const ev = d.marker && (d.citation || evCount > 0)
    ? `<button class="hb-devidence" type="button" data-evidence="${escAttr(String(d.marker))}" aria-expanded="false">see the evidence${evCount > 0 ? ` <span class="hb-evcount">(${evCount})</span>` : ""}</button>
       <div class="hb-evbox" hidden></div>`
    : "";
  return `<div class="hb-directive reveal${soft ? " hb-directive-soft" : ""}" style="${stagger(i + 1)}" data-dir="${d.id}">
    <div class="hb-dmain">
      ${marker}
      <p class="hb-dtext">${lead}${escHtml(d.directive || "")}</p>
      ${d.rationale ? `<p class="hb-drat">${escHtml(d.rationale)}</p>` : ""}
      ${cite}
      ${ev}
    </div>
    <div class="hb-dctl">
      <button class="hb-dbtn hb-ddone" data-ddone="${d.id}" title="Mark handled; the coach will stop carrying this unless new results change">Done</button>
      <button class="hb-dbtn hb-ddismiss" data-ddismiss="${d.id}" title="Dismiss; the coach will avoid repeating this unless the marker materially changes">Dismiss</button>
    </div>
  </div>`;
}

