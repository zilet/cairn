// @ts-check
// Me Profile form rendering and view-state normalization helpers.

type MeProfileControllerRecord = Record<string, unknown>;
type MeProfileProfile = import("../contracts/client-api.js").ClientProfile & {
  age?: number | string | null;
  height_cm?: number | string | null;
  height_in?: number | string | null;
  endurance_goal_json?: string | null;
  endurance_sport?: string | null;
  training_intent_json?: string | null;
  allergies?: string | null;
  dietary_restrictions?: string | null;
};
type MeProfileGoalCheck = import("../contracts/client-api.js").ClientGoalCheck & {
  tdee?: number | string | null;
  requested?: { aggressive?: boolean; [key: string]: unknown } | null;
  recommended?: {
    target_intake_kcal?: number | string | null;
    protein_g?: number | string | null;
    weekly_rate_lb?: number | string | null;
    [key: string]: unknown;
  } | null;
};
type MeProfileEnduranceGoalDraft = {
  mode?: string | null;
  event?: string | null;
  date?: string | null;
  target?: string | null;
  label?: string | null;
  distance_km?: number | string | null;
  weekly_km?: number | string | null;
};
type MeProfileTrainingPriority = "longevity" | "muscle" | "leanness" | "strength" | "endurance";
type MeProfileTrainingIntentDraft = {
  priorities: MeProfileTrainingPriority[];
  endurance_role: "none" | "supporting" | "co_primary" | "primary";
  endurance_capacity?: { sport: string; target_duration_min: number; context?: string | null };
};
type MeProfileSaveBar = {
  markDirty(): void;
};
type MeProfileControllerDeps = {
  root: HTMLElement;
  state: { meSeg?: string; [key: string]: unknown };
  segments: readonly ClientSegment[];
  handlers: Record<string, () => unknown>;
  headerTitle: HTMLElement;
  api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
  activateTab(tab: string): unknown;
  escapeAttr(value: unknown): string;
  escapeHtml(value: unknown): string;
  inputValue(selector: string, root?: ParentNode): string;
  invalidatePoll(): void;
  mountSaveBar(options: {
    sentinel: HTMLElement;
    fields: HTMLElement;
    onSave(): Promise<boolean>;
    onDiscard(): unknown;
  }): MeProfileSaveBar;
  numberValue(selector: string, root?: ParentNode): number | null;
  primaryDiscipline(): string;
  renderMe(): unknown;
  renderProfile(): unknown;
  segBar(active: string, items: readonly ClientSegment[]): string;
  segSkeleton(active: string, seg: readonly ClientSegment[], cards?: number): string;
  setDiscipline(discipline: unknown): string;
  setEnduranceGoalSet(value: boolean): void;
  skeletonSwap(update: () => unknown): Promise<unknown> | unknown;
  swrInvalidate(key: string): void;
  textAreaValue(selector: string, root?: ParentNode): string;
  toast(message: string): void;
  wireSeg(handlers: Record<string, () => unknown>): void;
  select<T extends HTMLElement = HTMLElement>(selector: string): T | null;
};
type MeProfileFormContext = {
  discipline: string;
  enduranceGoal: MeProfileEnduranceGoalDraft;
  enduranceMode: string;
  goalMode: string;
  unit: "in" | "cm";
  trainingIntent: MeProfileTrainingIntentDraft;
};

(() => {
  function profileRecord(value: unknown): MeProfileControllerRecord {
    return value && typeof value === "object" ? value as MeProfileControllerRecord : {};
  }

  // --- units ---------------------------------------------------------------
  // ONE unit system shared with Body Metrics (same localStorage key): "in" ⇒
  // imperial (feet+inches / lb), "cm" ⇒ metric (cm / kg). Storage stays imperial
  // server-side — this only changes what's shown and how entries are read. Mirrors
  // body-metrics-client.ts's bmUnitPref()/bmSetUnitPref() so a switch in either
  // surface follows the athlete to the other.
  const PROF_UNIT_KEY = "cairn-bm-unit";
  const LB_PER_KG = 2.2046226218;
  const round1 = (n: number): number => Math.round(n * 10) / 10;

  function profUnitPref(): "in" | "cm" {
    try {
      const saved = localStorage.getItem(PROF_UNIT_KEY);
      if (saved === "in" || saved === "cm") return saved;
    } catch {
      /* private mode */
    }
    try {
      // Only the US, Liberia and Myanmar default to imperial; everyone else metric.
      const region = ((navigator.language || "").split("-")[1] || "").toUpperCase();
      return region && !["US", "LR", "MM"].includes(region) ? "cm" : "in";
    } catch {
      return "in";
    }
  }

  function profSetUnitPref(unit: "in" | "cm"): void {
    try {
      localStorage.setItem(PROF_UNIT_KEY, unit);
    } catch {
      /* private mode */
    }
  }

  function massLabel(unit: "in" | "cm"): string {
    return unit === "cm" ? "kg" : "lb";
  }

  // Stored pounds → the display unit (kg when metric), rounded to 0.1.
  function displayMass(lb: unknown, unit: "in" | "cm"): number | null {
    const n = lb == null || lb === "" ? null : Number(lb);
    if (n == null || !Number.isFinite(n)) return null;
    return unit === "cm" ? round1(n / LB_PER_KG) : round1(n);
  }

  // The athlete's height in total inches (schema source-of-truth is height_in;
  // legacy rows that only ever stored height_cm still light up via the fallback).
  function profileHeightIn(profile: MeProfileProfile): number | null {
    const num = (v: unknown): number | null => {
      const n = v == null || v === "" ? NaN : Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const hin = num(profile.height_in);
    if (hin != null) return hin;
    const cm = num(profile.height_cm);
    return cm == null ? null : round1(cm / 2.54);
  }

  function profileNumberInputHtml(deps: MeProfileControllerDeps, id: string, label: string, val: unknown, step: number | string = 1): string {
    return `<div class="field" style="margin-bottom:9px"><label>${label}</label>
     <input id="${id}" type="number" step="${step || 1}" value="${deps.escapeAttr(val ?? "")}" class="form-input"></div>`;
  }

  function profileGoalMode(profile: MeProfileProfile, goal: MeProfileGoalCheck): string {
    return (goal && goal.goal_mode) || profile.goal_mode
      || ((profile.goal_weight_lb != null && profile.weight_lb != null && profile.goal_weight_lb < profile.weight_lb - 0.5) ? "lose" : "maintain");
  }

  function profileEnduranceGoal(profile: MeProfileProfile): MeProfileEnduranceGoalDraft {
    try {
      return profile.endurance_goal_json
        ? profileRecord(JSON.parse(profile.endurance_goal_json)) as MeProfileEnduranceGoalDraft
        : {};
    } catch {
      return {};
    }
  }

  const TRAINING_PRIORITIES: readonly MeProfileTrainingPriority[] = ["longevity", "muscle", "leanness", "strength", "endurance"];

  function profileTrainingIntent(profile: MeProfileProfile, goalMode: string): MeProfileTrainingIntentDraft {
    try {
      const parsed = profile.training_intent_json ? profileRecord(JSON.parse(profile.training_intent_json)) : {};
      const priorities = Array.isArray(parsed.priorities)
        ? parsed.priorities.filter((priority): priority is MeProfileTrainingPriority => typeof priority === "string" && TRAINING_PRIORITIES.includes(priority as MeProfileTrainingPriority))
        : [];
      const role = parsed.endurance_role;
      if (priorities.length && (role === "none" || role === "supporting" || role === "co_primary" || role === "primary")) {
        const capacity = profileRecord(parsed.endurance_capacity);
        const duration = Number(capacity.target_duration_min);
        return {
          priorities,
          endurance_role: role,
          ...(typeof capacity.sport === "string" && Number.isFinite(duration) && duration > 0
            ? { endurance_capacity: { sport: capacity.sport, target_duration_min: duration, context: typeof capacity.context === "string" ? capacity.context : null } }
            : {}),
        };
      }
    } catch {
      // A malformed legacy value should never prevent Profile from opening.
    }
    const bodyPriority: MeProfileTrainingPriority = goalMode === "lose" ? "leanness" : goalMode === "gain" ? "muscle" : "strength";
    const discipline = profile.primary_discipline;
    const priorities: MeProfileTrainingPriority[] = discipline === "endurance"
      ? ["endurance", "longevity", bodyPriority]
      : discipline === "hybrid"
        ? ["strength", "endurance", "longevity", bodyPriority]
        : ["strength", "longevity", bodyPriority];
    return {
      priorities: [...new Set(priorities)],
      endurance_role: discipline === "endurance" ? "primary" : discipline === "hybrid" ? "co_primary" : "none",
    };
  }

  function trainingPriorityOptions(current: MeProfileTrainingPriority | undefined): string {
    const labels: Record<MeProfileTrainingPriority, string> = {
      longevity: "Longevity", muscle: "Build muscle", leanness: "Stay lean", strength: "Strength", endurance: "Endurance",
    };
    return `<option value="">—</option>${TRAINING_PRIORITIES.map((priority) => `<option value="${priority}"${priority === current ? " selected" : ""}>${labels[priority]}</option>`).join("")}`;
  }

  function activeGoalTargetDisplay(goalMode: string): string {
    return goalMode === "maintain" ? "display:none" : "";
  }

  // Human-readable activity levels → the stored `activity_factor` multiplier.
  // The number stays the source of truth (goal-check math is unchanged); the
  // pills are just a friendlier way to seed it. It's only a COLD-START estimate —
  // Cairn refines real expenditure from logging via `estimateExpenditure`.
  const ACTIVITY_LEVELS: ReadonlyArray<{ factor: number; label: string; desc: string }> = [
    { factor: 1.3, label: "Sedentary", desc: "Desk job, little planned exercise." },
    { factor: 1.45, label: "Lightly active", desc: "On your feet a fair bit, or 1–3 light sessions a week." },
    { factor: 1.55, label: "Moderately active", desc: "Training 3–5 days a week." },
    { factor: 1.7, label: "Very active", desc: "Hard training most days, or a physically demanding job." },
    { factor: 1.8, label: "Athlete", desc: "Twice-a-day or very high training volume." },
  ];

  // Snap a stored factor to the nearest level; ties bias to the more-active side.
  // An unset/invalid factor defaults to Moderately active (1.55), a sensible seed.
  function nearestActivityFactor(value: unknown): number {
    const f = value == null || value === "" ? NaN : Number(value);
    if (!Number.isFinite(f)) return 1.55;
    let best = ACTIVITY_LEVELS[0];
    for (const lv of ACTIVITY_LEVELS) {
      if (Math.abs(lv.factor - f) <= Math.abs(best.factor - f)) best = lv;
    }
    return best.factor;
  }

  function activityLevelHtml(deps: MeProfileControllerDeps, currentFactor: unknown): string {
    const selected = nearestActivityFactor(currentFactor);
    const pills = ACTIVITY_LEVELS.map(
      (lv) =>
        `<button type="button" class="segbtn${lv.factor === selected ? " active" : ""}" data-actlevel="${lv.factor}">${deps.escapeHtml(lv.label)}</button>`
    ).join("");
    const desc = ACTIVITY_LEVELS.find((lv) => lv.factor === selected)?.desc ?? "";
    return `<div class="field" style="margin-bottom:0">
      <label>Activity level</label>
      <p class="aboutme-hint">A starting estimate of how active you are day to day. Cairn refines your real energy expenditure from your logging over time.</p>
      <div class="pill-group actlevel-seg" id="activityLevelSeg" role="group" aria-label="Activity level">${pills}</div>
      <p class="aboutme-hint actlevel-desc" id="activityLevelDesc" style="margin:6px 0 0">${deps.escapeHtml(desc)}</p>
      <input type="hidden" id="activity_factor" value="${deps.escapeAttr(selected)}">
    </div>`;
  }

  // The in·lb / cm·kg switch. Active fill is --ink (Atelier segmented rule); the
  // whole toggle is one preference so length and mass never disagree.
  function unitToggleHtml(unit: "in" | "cm"): string {
    const btn = (u: "in" | "cm") =>
      `<button type="button" class="prof-unit-btn${u === unit ? " on" : ""}" data-unit="${u}" aria-pressed="${u === unit}">${u} · ${massLabel(u)}</button>`;
    return `<div class="prof-unit-toggle" id="profUnitToggle" role="group" aria-label="Measurement units">${btn("in")}${btn("cm")}</div>`;
  }

  // A calm grouped section: an uppercase eyebrow (with an optional right-aligned
  // control) over its fields, hairline-divided from the section above.
  function sectionHtml(deps: MeProfileControllerDeps, eyebrow: string, body: string, right = ""): string {
    return `<section class="prof-section">
      <div class="prof-section-head"><span class="lbl">${deps.escapeHtml(eyebrow)}</span>${right}</div>
      ${body}
    </section>`;
  }

  function profileHtml(
    deps: MeProfileControllerDeps,
    profile: MeProfileProfile,
    goal: MeProfileGoalCheck,
    context: MeProfileFormContext,
  ): string {
    const { discipline, enduranceGoal, enduranceMode, goalMode, unit, trainingIntent } = context;
    const reqWarn = goal?.requested?.aggressive
      ? `<div class="ex-flag" style="margin-top:0"><b>Goal too aggressive for lean mass.</b> ${goal.message}</div>`
      : `<div class="sess-line">${goal?.message || ""}</div>`;
    const n = (id: string, label: string, val: unknown, step: number | string = 1) => profileNumberInputHtml(deps, id, label, val, step);

    // Body figures shown in the athlete's chosen unit; server storage stays imperial.
    const hin = profileHeightIn(profile);
    const ft = hin == null ? "" : Math.floor(hin / 12);
    const inPart = hin == null ? "" : Math.round(hin - Math.floor(hin / 12) * 12);
    const cmDisp = hin == null ? "" : Math.round(hin * 2.54);
    const mLbl = massLabel(unit);
    const wDisp = displayMass(profile.weight_lb, unit);
    const gDisp = displayMass(profile.goal_weight_lb, unit);

    const heightField = `<div class="field" style="margin-bottom:9px">
      <label>Height</label>
      <div id="heightImperial" class="prof-unit-row" style="${unit === "cm" ? "display:none" : ""}">
        <div class="prof-unit-in"><input id="height_ft" type="number" step="1" min="0" inputmode="numeric" value="${deps.escapeAttr(ft)}" class="form-input"><span class="prof-unit-suf">ft</span></div>
        <div class="prof-unit-in"><input id="height_in_part" type="number" step="1" min="0" inputmode="numeric" value="${deps.escapeAttr(inPart)}" class="form-input"><span class="prof-unit-suf">in</span></div>
      </div>
      <div id="heightMetric" class="prof-unit-in" style="${unit === "cm" ? "" : "display:none"}">
        <input id="height_cm_val" type="number" step="0.1" min="0" inputmode="decimal" value="${deps.escapeAttr(cmDisp)}" class="form-input"><span class="prof-unit-suf">cm</span>
      </div>
    </div>`;

    const weightField = `<div class="field" style="margin-bottom:9px">
      <label>Weight</label>
      <div class="prof-unit-in"><input id="weight_val" type="number" step="0.1" min="0" inputmode="decimal" value="${deps.escapeAttr(wDisp ?? "")}" class="form-input"><span class="prof-unit-suf" id="weightUnit">${mLbl}</span></div>
    </div>`;

    const youSection = sectionHtml(deps, "You", `
      <div class="field" style="margin-bottom:9px"><label for="name">Name <span class="ob-opt">— optional</span></label>
        <p class="aboutme-hint">Stamped on the doctor report you export from Stand → Share with your doctor. Leave empty to fill it in on paper instead.</p>
        <input id="name" type="text" placeholder="e.g. Alex Rivera" maxlength="120" value="${deps.escapeAttr(profile.name || "")}" class="form-input"></div>
      <div class="field" style="margin-bottom:9px"><label for="home_location">Home location <span class="ob-opt">— optional</span></label>
        <p class="aboutme-hint">Your usual home base gives the coach local and seasonal context. An active trip can temporarily override it for coaching without changing what you save here.</p>
        <input id="home_location" type="text" placeholder="e.g. Denver, CO" maxlength="160"
          value="${deps.escapeAttr(profile.home_location || "")}" class="form-input"></div>
      <div class="field aboutme" style="margin-bottom:0">
        <label for="about_me">About you</label>
        <p class="aboutme-hint">What "better" means to you, a little of your history, the foods you love and avoid, how work and life run. Optional — the coach reads it to make the pointing yours.</p>
        <textarea id="about_me" rows="6" placeholder="e.g. lifted on and off for years; fasted mornings suit me; two young kids, so evenings are unpredictable..."
          maxlength="8000">${deps.escapeHtml(profile.about_me || "")}</textarea>
      </div>`);

    const bodySection = sectionHtml(deps, "Body & goal", `
      ${n("age", "Age", profile.age)}
      <div class="field" style="margin-bottom:9px">
        <label>Sex</label>
        <p class="aboutme-hint">Sets the baselines the math runs on — strength standards, tape-measure reads, body-fat and heart-risk equations — and the body figure. The clinical equations expect sex at birth.</p>
        <div class="seg sex-seg" id="sexSeg" role="group" aria-label="Sex">
          <button type="button" class="segbtn${String(profile.sex || "") === "female" ? " active" : ""}" data-sex="female">Female</button>
          <button type="button" class="segbtn${String(profile.sex || "") === "female" ? "" : " active"}" data-sex="male">Male</button>
        </div>
      </div>
      ${heightField}
      ${weightField}
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
        <div class="field" style="margin-bottom:9px"><label>Goal weight</label>
          <div class="prof-unit-in"><input id="goal_weight_val" type="number" step="0.1" min="0" inputmode="decimal" value="${deps.escapeAttr(gDisp ?? "")}" class="form-input"><span class="prof-unit-suf" id="goalWeightUnit">${mLbl}</span></div>
        </div>
        <div class="field" style="margin-bottom:9px"><label>Goal date <span class="ob-opt">— optional</span></label>
          <input id="goal_date" type="date" value="${deps.escapeAttr(profile.goal_date || "")}" class="form-input"></div>
      </div>
      <p class="aboutme-hint" id="goalMaintainNote" style="margin:-2px 0 9px${goalMode === "maintain" ? "" : ";display:none"}">We anchor to your real expenditure — no goal weight needed. Cairn stays quiet unless your weight genuinely drifts.</p>
      ${activityLevelHtml(deps, profile.activity_factor)}`,
      unitToggleHtml(unit));

    const trainingSection = sectionHtml(deps, "Training", `
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
      <div class="field" style="margin-bottom:9px">
        <label>What matters most</label>
        <p class="aboutme-hint">Put your goals in order. When training goals compete, this is the hierarchy Cairn follows.</p>
        ${[0, 1, 2, 3, 4].map((index) => `<div class="field" style="margin:6px 0 0"><label for="training_priority_${index}">${index === 0 ? "First priority" : `Then ${index + 1}`}</label><select id="training_priority_${index}" class="form-input"${index === 0 ? " required" : ""}>${trainingPriorityOptions(trainingIntent.priorities[index])}</select></div>`).join("")}
      </div>
      <div class="field" style="margin-bottom:9px">
        <label>Endurance’s role</label>
        <p class="aboutme-hint">This decides what wins when training goals compete.</p>
        <div class="seg" id="enduranceRoleSeg" role="group" aria-label="Endurance role">
          ${[["none", "None"], ["supporting", "Supports"], ["co_primary", "Co-primary"], ["primary", "Primary"]].map(([value, label]) => `<button type="button" class="segbtn${trainingIntent.endurance_role === value ? " active" : ""}" data-endurance-role="${value}">${label}</button>`).join("")}
        </div>
      </div>
      <div id="enduranceCapacityFields" style="margin-bottom:9px${trainingIntent.endurance_role === "none" ? ";display:none" : ""}">
        <p class="aboutme-hint">A durable capability, not a temporary race. Keep the dated running goal below for an event you are building toward.</p>
        <div class="field" style="margin:9px 0 0"><label for="endurance_capacity_sport">Sport or activity</label>
          <input id="endurance_capacity_sport" type="text" maxlength="120" placeholder="e.g. mountain biking" value="${deps.escapeAttr(trainingIntent.endurance_capacity?.sport || profile.endurance_sport || "")}" class="form-input"></div>
        <div class="field" style="margin:9px 0 0"><label for="endurance_capacity_duration">Target duration (minutes)</label>
          <input id="endurance_capacity_duration" type="number" min="1" step="1" value="${deps.escapeAttr(trainingIntent.endurance_capacity?.target_duration_min ?? "")}" class="form-input"></div>
        <div class="field" style="margin:9px 0 0"><label for="endurance_capacity_context">Context <span class="ob-opt">— optional</span></label>
          <input id="endurance_capacity_context" type="text" maxlength="240" placeholder="e.g. rolling technical trails" value="${deps.escapeAttr(trainingIntent.endurance_capacity?.context || "")}" class="form-input"></div>
      </div>
      <div class="field" id="endGoalField" style="margin-bottom:0">
        <label>Running goal <span class="ob-opt">— optional</span></label>
        <p class="aboutme-hint">A race the coach builds you toward, or an ongoing "stay ready" target. Either way it prescribes your runs each week alongside lifting — separate from the sport above.</p>
        <div class="seg" id="endGoalMode" role="group" aria-label="Running goal mode">
          <button type="button" class="segbtn${enduranceMode === "none" ? " active" : ""}" data-egmode="none">None</button>
          <button type="button" class="segbtn${enduranceMode === "race" ? " active" : ""}" data-egmode="race">Race</button>
          <button type="button" class="segbtn${enduranceMode === "standing" ? " active" : ""}" data-egmode="standing">Standing</button>
        </div>
        <div id="egRace" class="eg-sub" style="${enduranceMode === "race" ? "" : "display:none"}">
          <div class="field" style="margin:9px 0 0"><label for="eg_event">Race</label>
            <input id="eg_event" type="text" maxlength="120" placeholder="e.g. Spring Half Marathon" value="${deps.escapeAttr(enduranceGoal.event || "")}" class="form-input"></div>
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
      </div>`);

    const dietSection = sectionHtml(deps, "Diet", `
      <div class="field" style="margin-bottom:9px">
        <label for="allergies">Food allergies</label>
        <p class="aboutme-hint">A hard exclusion — the coach never puts these in a meal, recipe, or swap. Leave empty if none.</p>
        <input id="allergies" type="text" placeholder="e.g. peanuts, shellfish" maxlength="1000" value="${deps.escapeAttr(profile.allergies || "")}" class="form-input">
      </div>
      <div class="field" style="margin-bottom:0">
        <label for="dietary_restrictions">Diet &amp; restrictions</label>
        <p class="aboutme-hint">Treated as hard constraints in your meal plans — the coach builds every meal within them.</p>
        <input id="dietary_restrictions" type="text" placeholder="e.g. vegan, vegetarian, pescatarian, no pork" maxlength="1000" value="${deps.escapeAttr(profile.dietary_restrictions || "")}" class="form-input">
      </div>`);

    return deps.segBar("profile", deps.segments) + `
    <div class="sess">
      <div class="sess-head"><span class="sess-date">Goal check</span><span class="sess-day">${goal?.tdee ? goal.tdee + " kcal TDEE" : ""}</span></div>
      ${reqWarn}
      ${goal?.recommended ? `<div class="sess-line" style="margin-top:6px"><b>${goal.goal_mode === "maintain" ? "Maintenance target" : goal.goal_mode === "gain" ? "Lean-gain target" : "Lean-safe target"}:</b> ${goal.recommended.target_intake_kcal} kcal · ${goal.recommended.protein_g} g protein${goal.recommended.weekly_rate_lb ? ` · ${goal.recommended.weekly_rate_lb} lb/wk` : ""}</div>` : ""}
    </div>
    <div id="profFields" class="prof-form">
      ${youSection}
      ${bodySection}
      ${trainingSection}
      ${dietSection}
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
    trainingIntent: profileTrainingIntent,
    html: profileHtml,
    unitPref: profUnitPref,
    setUnitPref: profSetUnitPref,
  };

  Object.assign(globalThis, { CairnMeProfileForm: CAIRN_ME_PROFILE_FORM });

  if (typeof window !== "undefined") {
    window.CairnMeProfileForm = CAIRN_ME_PROFILE_FORM;
  }
})();
