(() => {
// @ts-check
// Me Profile form rendering and view-state normalization helpers.
(() => {
    function profileRecord(value) {
        return value && typeof value === "object" ? value : {};
    }
    function profileNumberInputHtml(deps, id, label, val, step = 1) {
        return `<div class="field" style="margin-bottom:9px"><label>${label}</label>
     <input id="${id}" type="number" step="${step || 1}" value="${deps.escapeAttr(val ?? "")}" class="form-input"></div>`;
    }
    function profileGoalMode(profile, goal) {
        return (goal && goal.goal_mode) || profile.goal_mode
            || ((profile.goal_weight_lb != null && profile.weight_lb != null && profile.goal_weight_lb < profile.weight_lb - 0.5) ? "lose" : "maintain");
    }
    function profileEnduranceGoal(profile) {
        try {
            return profile.endurance_goal_json
                ? profileRecord(JSON.parse(profile.endurance_goal_json))
                : {};
        }
        catch {
            return {};
        }
    }
    function activeGoalTargetDisplay(goalMode) {
        return goalMode === "maintain" ? "display:none" : "";
    }
    function profileHtml(deps, profile, goal, context) {
        const { discipline, enduranceGoal, enduranceMode, goalMode } = context;
        const reqWarn = goal?.requested?.aggressive
            ? `<div class="ex-flag" style="margin-top:0"><b>Goal too aggressive for lean mass.</b> ${goal.message}</div>`
            : `<div class="sess-line">${goal?.message || ""}</div>`;
        const n = (id, label, val, step = 1) => profileNumberInputHtml(deps, id, label, val, step);
        return deps.segBar("profile", deps.segments) + `
    <div class="sess">
      <div class="sess-head"><span class="sess-date">Goal check</span><span class="sess-day">${goal?.tdee ? goal.tdee + " kcal TDEE" : ""}</span></div>
      ${reqWarn}
      ${goal?.recommended ? `<div class="sess-line" style="margin-top:6px"><b>${goal.goal_mode === "maintain" ? "Maintenance target" : goal.goal_mode === "gain" ? "Lean-gain target" : "Lean-safe target"}:</b> ${goal.recommended.target_intake_kcal} kcal · ${goal.recommended.protein_g} g protein${goal.recommended.weekly_rate_lb ? ` · ${goal.recommended.weekly_rate_lb} lb/wk` : ""}</div>` : ""}
    </div>
    <h1 class="lbl" style="margin:24px 0 8px">Profile</h1>
    <div id="profFields">
    <div class="field" style="margin-bottom:9px"><label for="name">Name <span class="ob-opt">— optional</span></label>
      <p class="aboutme-hint">Stamped on the doctor report you export from Health → Share. Leave empty to fill it in on paper instead.</p>
      <input id="name" type="text" placeholder="e.g. Alex Rivera" maxlength="120" value="${deps.escapeAttr(profile.name || "")}" class="form-input"></div>
    ${n("age", "Age", profile.age)}
    ${n("height_cm", "Height (cm)", profile.height_cm, 0.1)}
    ${n("weight_lb", "Weight (lb)", profile.weight_lb, 0.1)}
    <div class="field" style="margin-bottom:9px">
      <label>Your goal</label>
      <p class="aboutme-hint">Losing weight, holding steady, or a slow lean gain. Cairn fuels and frames everything around this — maintaining is a real goal, not "no goal". Change it anytime.</p>
      <div class="seg goalmode-seg" id="goalModeSeg" role="group" aria-label="Goal mode">
        <button type="button" class="segbtn${goalMode === "lose" ? " active" : ""}" data-goalmode="lose">Lose</button>
        <button type="button" class="segbtn${goalMode === "maintain" ? " active" : ""}" data-goalmode="maintain">Maintain</button>
        <button type="button" class="segbtn${goalMode === "gain" ? " active" : ""}" data-goalmode="gain">Gain</button>
      </div>
    </div>
    <div id="goalTargetFields" style="${activeGoalTargetDisplay(goalMode)}">
      ${n("goal_weight_lb", "Goal weight (lb)", profile.goal_weight_lb, 0.1)}
      <div class="field" style="margin-bottom:9px"><label>Goal date <span class="ob-opt">— optional</span></label>
        <input id="goal_date" type="date" value="${deps.escapeAttr(profile.goal_date || "")}" class="form-input"></div>
    </div>
    <p class="aboutme-hint" id="goalMaintainNote" style="margin:-2px 0 9px${goalMode === "maintain" ? "" : ";display:none"}">We anchor to your real expenditure — no goal weight needed. Cairn stays quiet unless your weight genuinely drifts.</p>
    ${n("activity_factor", "Activity factor (1.3-1.8)", profile.activity_factor, 0.05)}

    <div class="field" style="margin-bottom:9px">
      <label>Your sport</label>
      <p class="aboutme-hint">What you mostly train. Cairn meets you in it — the language, the day's read, and Progress reshape around it. Change it anytime.</p>
      <div class="seg disc-seg" id="discSeg" role="group" aria-label="Primary discipline">
        <button type="button" class="segbtn${discipline === "strength" ? " active" : ""}" data-disc="strength">Strength</button>
        <button type="button" class="segbtn${discipline === "endurance" ? " active" : ""}" data-disc="endurance">Endurance</button>
        <button type="button" class="segbtn${discipline === "hybrid" ? " active" : ""}" data-disc="hybrid">Hybrid</button>
      </div>
    </div>
    <div class="field" id="endSportField" style="margin-bottom:9px${discipline === "strength" ? ";display:none" : ""}">
      <label for="endurance_sport">Endurance sport <span class="ob-opt">— optional</span></label>
      <input id="endurance_sport" type="text" placeholder="e.g. running, cycling, triathlon, rowing" maxlength="120"
        value="${deps.escapeAttr(profile.endurance_sport || "")}" class="form-input">
    </div>

    <div class="field" id="endGoalField" style="margin-bottom:9px">
      <label>Running goal <span class="ob-opt">— optional</span></label>
      <p class="aboutme-hint">A race the coach builds you toward, or an ongoing "stay ready" target. Either way it prescribes your runs each week alongside lifting — separate from the sport above.</p>
      <div class="seg" id="endGoalMode" role="group" aria-label="Running goal mode">
        <button type="button" class="segbtn${enduranceMode === "none" ? " active" : ""}" data-egmode="none">None</button>
        <button type="button" class="segbtn${enduranceMode === "race" ? " active" : ""}" data-egmode="race">Race</button>
        <button type="button" class="segbtn${enduranceMode === "standing" ? " active" : ""}" data-egmode="standing">Standing</button>
      </div>
      <div id="egRace" class="eg-sub" style="${enduranceMode === "race" ? "" : "display:none"}">
        <div class="field" style="margin:9px 0 0"><label for="eg_event">Race</label>
          <input id="eg_event" type="text" maxlength="120" placeholder="e.g. Cambridge Half" value="${deps.escapeAttr(enduranceGoal.event || "")}" class="form-input"></div>
        <div class="field" style="margin:9px 0 0"><label for="eg_date">Race date</label>
          <input id="eg_date" type="date" value="${deps.escapeAttr(enduranceGoal.date || "")}" class="form-input"></div>
        <div class="field" style="margin:9px 0 0"><label for="eg_target">Target <span class="ob-opt">— optional</span></label>
          <input id="eg_target" type="text" maxlength="60" placeholder="e.g. sub-1:45, just finish" value="${deps.escapeAttr(enduranceGoal.target || "")}" class="form-input"></div>
      </div>
      <div id="egStanding" class="eg-sub" style="${enduranceMode === "standing" ? "" : "display:none"}">
        <div class="field" style="margin:9px 0 0"><label for="eg_label">Readiness</label>
          <input id="eg_label" type="text" maxlength="80" placeholder="e.g. 10k-ready, half-ready" value="${deps.escapeAttr(enduranceGoal.label || "")}" class="form-input"></div>
      </div>
      <div id="egShared" class="eg-grid" style="${enduranceMode === "none" ? "display:none" : ""}">
        <div class="field" style="margin:9px 0 0"><label for="eg_distance">Distance (km) <span class="ob-opt">— optional</span></label>
          <input id="eg_distance" type="number" step="0.1" value="${deps.escapeAttr(enduranceGoal.distance_km ?? "")}" class="form-input"></div>
        <div class="field" style="margin:9px 0 0"><label for="eg_weekly_km">Weekly km <span class="ob-opt">— optional</span></label>
          <input id="eg_weekly_km" type="number" step="1" value="${deps.escapeAttr(enduranceGoal.weekly_km ?? "")}" class="form-input"></div>
      </div>
    </div>

    <div class="field aboutme" style="margin-bottom:0">
      <label for="about_me">About you</label>
      <p class="aboutme-hint">What "better" means to you, a little of your history, the foods you love and avoid, how work and life run. Optional — the coach reads it to make the pointing yours.</p>
      <textarea id="about_me" rows="6" placeholder="e.g. lifted on and off for years; fasted mornings suit me; two young kids, so evenings are unpredictable..."
        maxlength="8000">${deps.escapeHtml(profile.about_me || "")}</textarea>
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
        Log your bodyweight, activities, and meals on <button class="linkbtn" id="profToToday">Today</button> — the quick-log, the bodyweight chip, voice, and your frequents all live there. They show up in <b>Lately</b> and your <button class="linkbtn" id="profToProgress">History</button>.
      </div>
    </div>`;
    }
    const CAIRN_ME_PROFILE_FORM = {
        record: profileRecord,
        goalMode: profileGoalMode,
        enduranceGoal: profileEnduranceGoal,
        html: profileHtml,
    };
    Object.assign(globalThis, { CairnMeProfileForm: CAIRN_ME_PROFILE_FORM });
    if (typeof window !== "undefined") {
        window.CairnMeProfileForm = CAIRN_ME_PROFILE_FORM;
    }
})();
})();
