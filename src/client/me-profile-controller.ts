// @ts-check
// Me Profile controller: profile fetch/render, form wiring, and persistence.

(() => {
  const GOAL_CACHE_KEY = "me:goal";

  function setActiveButton(root: ParentNode | null | undefined, selector: string, active: Element): void {
    root?.querySelectorAll(selector).forEach((element) => {
      element.classList.toggle("active", element === active);
    });
  }

  const LB_PER_KG = 2.2046226218;
  const round1 = (n: number): number => Math.round(n * 10) / 10;

  function wireProfileForm(
    deps: MeProfileControllerDeps,
    enduranceGoal: MeProfileEnduranceGoalDraft,
    initial: {
      discipline: string; enduranceMode: string; goalMode: string; unit: "in" | "cm";
    },
  ): void {
    let pickedDisc = String(initial.discipline || "strength");
    let pickedEgMode = String(initial.enduranceMode || "none");
    let pickedGoalMode = String(initial.goalMode || "maintain");
    // The active display unit (in ⇒ imperial, cm ⇒ metric). The toggle converts
    // the body inputs in place; storage always writes imperial (height_in / lb).
    let activeUnit: "in" | "cm" = initial.unit === "cm" ? "cm" : "in";

    const enduranceGoalPayload = (): MeProfileEnduranceGoalDraft | null | undefined => {
      const dist = deps.numberValue("#eg_distance");
      const wk = deps.numberValue("#eg_weekly_km");
      if (pickedEgMode === "race") {
        const date = deps.inputValue("#eg_date") || null;
        if (!date) {
          deps.toast("Add a race date to save your race goal");
          return undefined;
        }
        return {
          mode: "race",
          event: deps.inputValue("#eg_event").trim() || null,
          date,
          distance_km: dist,
          target: deps.inputValue("#eg_target").trim() || null,
          weekly_km: wk,
        };
      }
      if (pickedEgMode === "standing") {
        return { mode: "standing", label: deps.inputValue("#eg_label").trim() || null, distance_km: dist, weekly_km: wk };
      }
      return null;
    };

    // Read the height inputs (structure differs per unit) back to total inches.
    const readHeightIn = (): number | null => {
      if (activeUnit === "cm") {
        const cm = deps.numberValue("#height_cm_val");
        return cm == null ? null : round1(cm / 2.54);
      }
      const ftv = deps.numberValue("#height_ft");
      const inv = deps.numberValue("#height_in_part");
      if (ftv == null && inv == null) return null;
      return (ftv ?? 0) * 12 + (inv ?? 0);
    };
    // Body mass field → pounds (the schema unit) from the active display unit.
    const readMassLb = (selector: string): number | null => {
      const v = deps.numberValue(selector);
      if (v == null) return null;
      return activeUnit === "cm" ? round1(v * LB_PER_KG) : v;
    };

    const persistProfile = async () => {
      const heightIn = readHeightIn();
      // Store height_in as the source-of-truth AND a matching height_cm so the
      // TDEE / doctor-report paths (which read cm) stay in sync. In metric mode
      // the typed cm is authoritative; in imperial we derive cm from inches.
      const heightCm =
        activeUnit === "cm"
          ? (() => {
              const cm = deps.numberValue("#height_cm_val");
              return cm == null ? null : round1(cm);
            })()
          : heightIn == null
            ? null
            : round1(heightIn * 2.54);
      const body = {
        name: deps.inputValue("#name").trim(),
        age: deps.numberValue("#age"),
        height_in: heightIn,
        height_cm: heightCm,
        weight_lb: readMassLb("#weight_val"),
        goal_weight_lb: readMassLb("#goal_weight_val"),
        goal_date: deps.inputValue("#goal_date") || null,
        activity_factor: deps.numberValue("#activity_factor"),
        goal_mode: pickedGoalMode,
        primary_discipline: pickedDisc,
        endurance_sport: pickedDisc === "strength" ? "" : deps.inputValue("#endurance_sport").trim(),
        endurance_goal: enduranceGoalPayload(),
        about_me: deps.textAreaValue("#about_me").trim(),
        allergies: deps.inputValue("#allergies").trim(),
        dietary_restrictions: deps.inputValue("#dietary_restrictions").trim(),
      };
      await deps.api("/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      deps.setDiscipline(pickedDisc);
      if (body.endurance_goal !== undefined) {
        const hadGoal = !!(enduranceGoal && enduranceGoal.mode);
        deps.setEnduranceGoalSet(!!body.endurance_goal);
        if (!hadGoal && body.endurance_goal) deps.toast("Your running plan now lives in Plan → Endurance");
      }
      ["profile", GOAL_CACHE_KEY, "stats", "progress:weight", "progress:energy"].forEach(deps.swrInvalidate);
      deps.renderMe();
      return true;
    };

    const profileFields = deps.select<HTMLElement>("#profFields");
    if (!profileFields) return;
    const profileBar = deps.mountSaveBar({
      sentinel: profileFields,
      fields: profileFields,
      onSave: persistProfile,
      onDiscard: deps.renderProfile,
    });

    deps.select<HTMLElement>("#discSeg")?.querySelectorAll<HTMLElement>("[data-disc]").forEach((button) =>
      button.addEventListener("click", () => {
        pickedDisc = button.dataset.disc || pickedDisc;
        setActiveButton(deps.select("#discSeg"), ".segbtn", button);
        const sportField = deps.select<HTMLElement>("#endSportField");
        if (sportField) sportField.style.display = pickedDisc === "strength" ? "none" : "";
        profileBar.markDirty();
      })
    );

    deps.select<HTMLElement>("#endGoalMode")?.querySelectorAll<HTMLElement>("[data-egmode]").forEach((button) =>
      button.addEventListener("click", () => {
        pickedEgMode = button.dataset.egmode || pickedEgMode;
        setActiveButton(deps.select("#endGoalMode"), ".segbtn", button);
        const race = deps.select<HTMLElement>("#egRace");
        const standing = deps.select<HTMLElement>("#egStanding");
        const shared = deps.select<HTMLElement>("#egShared");
        if (race) race.style.display = pickedEgMode === "race" ? "" : "none";
        if (standing) standing.style.display = pickedEgMode === "standing" ? "" : "none";
        if (shared) shared.style.display = pickedEgMode === "none" ? "none" : "";
        profileBar.markDirty();
      })
    );

    deps.select<HTMLElement>("#goalModeSeg")?.querySelectorAll<HTMLElement>("[data-goalmode]").forEach((button) =>
      button.addEventListener("click", () => {
        pickedGoalMode = button.dataset.goalmode || pickedGoalMode;
        setActiveButton(deps.select("#goalModeSeg"), ".segbtn", button);
        const target = deps.select<HTMLElement>("#goalTargetFields");
        const note = deps.select<HTMLElement>("#goalMaintainNote");
        if (target) target.style.display = pickedGoalMode === "maintain" ? "none" : "";
        if (note) note.style.display = pickedGoalMode === "maintain" ? "" : "none";
        profileBar.markDirty();
      })
    );

    // Activity level: the pills seed the stored `activity_factor` number (kept in
    // a hidden input the save path already reads). Selecting one writes the factor,
    // updates the one-line description, and marks the form dirty.
    const ACTIVITY_DESC: Record<string, string> = {
      "1.3": "Desk job, little planned exercise.",
      "1.45": "On your feet a fair bit, or 1–3 light sessions a week.",
      "1.55": "Training 3–5 days a week.",
      "1.7": "Hard training most days, or a physically demanding job.",
      "1.8": "Twice-a-day or very high training volume.",
    };
    deps.select<HTMLElement>("#activityLevelSeg")?.querySelectorAll<HTMLElement>("[data-actlevel]").forEach((button) =>
      button.addEventListener("click", () => {
        const factor = button.dataset.actlevel || "";
        const hidden = deps.select<HTMLInputElement>("#activity_factor");
        if (hidden) hidden.value = factor;
        setActiveButton(deps.select("#activityLevelSeg"), ".segbtn", button);
        const desc = deps.select<HTMLElement>("#activityLevelDesc");
        if (desc) desc.textContent = ACTIVITY_DESC[factor] || "";
        profileBar.markDirty();
      })
    );

    // Unit toggle: convert the body inputs between imperial and metric IN PLACE
    // (so unsaved edits survive) and persist the shared preference. It changes
    // display only — the canonical values are unchanged, so it never marks dirty.
    const setInput = (selector: string, value: string): void => {
      const el = deps.select<HTMLInputElement>(selector);
      if (el) el.value = value;
    };
    const convMass = (selector: string, next: "in" | "cm"): void => {
      const raw = (deps.select<HTMLInputElement>(selector)?.value ?? "").trim();
      if (raw === "") return;
      const v = Number(raw);
      if (!Number.isFinite(v)) return;
      setInput(selector, String(next === "cm" ? round1(v / LB_PER_KG) : round1(v * LB_PER_KG)));
    };
    const applyUnit = (next: "in" | "cm"): void => {
      if (next === activeUnit) return;
      // Height: read the currently-shown unit, write the other, swap visibility.
      if (next === "cm") {
        const ftv = deps.numberValue("#height_ft");
        const inv = deps.numberValue("#height_in_part");
        const totalIn = ftv == null && inv == null ? null : (ftv ?? 0) * 12 + (inv ?? 0);
        setInput("#height_cm_val", totalIn == null ? "" : String(round1(totalIn * 2.54)));
      } else {
        const cm = deps.numberValue("#height_cm_val");
        const totalIn = cm == null ? null : cm / 2.54;
        if (totalIn == null) {
          setInput("#height_ft", "");
          setInput("#height_in_part", "");
        } else {
          const f = Math.floor(totalIn / 12);
          setInput("#height_ft", String(f));
          setInput("#height_in_part", String(Math.round(totalIn - f * 12)));
        }
      }
      const himp = deps.select<HTMLElement>("#heightImperial");
      const hmet = deps.select<HTMLElement>("#heightMetric");
      if (himp) himp.style.display = next === "cm" ? "none" : "";
      if (hmet) hmet.style.display = next === "cm" ? "" : "none";
      // Weight + goal weight (values were shown in the old unit).
      convMass("#weight_val", next);
      convMass("#goal_weight_val", next);
      const mLbl = next === "cm" ? "kg" : "lb";
      const wU = deps.select<HTMLElement>("#weightUnit");
      if (wU) wU.textContent = mLbl;
      const gU = deps.select<HTMLElement>("#goalWeightUnit");
      if (gU) gU.textContent = mLbl;
      deps.select<HTMLElement>("#profUnitToggle")?.querySelectorAll<HTMLElement>("[data-unit]").forEach((b) => {
        const on = b.dataset.unit === next;
        b.setAttribute?.("aria-pressed", String(on));
        b.classList?.toggle("on", on);
      });
      activeUnit = next;
      CairnMeProfileForm.setUnitPref(next);
    };
    deps.select<HTMLElement>("#profUnitToggle")?.querySelectorAll<HTMLElement>("[data-unit]").forEach((button) =>
      button.addEventListener("click", () => applyUnit(button.dataset.unit === "cm" ? "cm" : "in"))
    );

    deps.select("#profToToday")?.addEventListener("click", () => deps.activateTab("today"));
    deps.select("#profToProgress")?.addEventListener("click", () => { deps.state.progressSeg = "sessions"; deps.activateTab("progress"); });
  }

  // Build + wire the whole profile form from a (profile, goal) pair. Factored out
  // so the warm cached paint and the revalidated paint share one path.
  async function applyProfile(
    deps: MeProfileControllerDeps,
    profileRaw: unknown,
    goalRaw: unknown,
    opts: { animate: boolean },
  ): Promise<void> {
    const profile = CairnMeProfileForm.record(profileRaw) as MeProfileProfile;
    const goal = CairnMeProfileForm.record(goalRaw) as MeProfileGoalCheck;
    deps.setDiscipline(profile.primary_discipline);
    deps.setEnduranceGoalSet(!!profile.endurance_goal_json);

    const enduranceGoal = CairnMeProfileForm.enduranceGoal(profile);
    const enduranceMode = typeof enduranceGoal.mode === "string" && enduranceGoal.mode ? enduranceGoal.mode : "none";
    const goalMode = CairnMeProfileForm.goalMode(profile, goal);
    const discipline = deps.primaryDiscipline();
    const unit = CairnMeProfileForm.unitPref();

    const draw = () => {
      deps.root.innerHTML = CairnMeProfileForm.html(deps, profile, goal, { discipline, enduranceGoal, enduranceMode, goalMode, unit });
      deps.wireSeg(deps.handlers);
      wireProfileForm(deps, enduranceGoal, { discipline, enduranceMode, goalMode, unit });
    };
    if (opts.animate) await deps.skeletonSwap(draw);
    else draw();
  }

  async function renderProfile(deps: MeProfileControllerDeps): Promise<void> {
    deps.headerTitle.textContent = "Profile";
    deps.state.meSeg = "profile";
    deps.invalidatePoll();

    // Profile is already SWR-cached (today-data-loader writes "profile"); paint it
    // instantly and skip the skeleton, then revalidate both reads in the background.
    const peek = peekCached<MeProfileProfile>("profile");
    if (peek) await applyProfile(deps, peek.data, peekCached<MeProfileGoalCheck>(GOAL_CACHE_KEY)?.data ?? {}, { animate: false });
    else deps.root.innerHTML = deps.segSkeleton("profile", deps.segments, 2);

    let profileRaw: unknown, goalRaw: unknown;
    try {
      [profileRaw, goalRaw] = await Promise.all([deps.api("/profile"), deps.api("/goal")]);
    } catch {
      if (!peek) await applyProfile(deps, {}, {}, { animate: true });
      return;
    }
    swrSet("profile", profileRaw);
    swrSet(GOAL_CACHE_KEY, goalRaw);
    // Stale-guard: the athlete may have left Profile while the reads were in flight.
    if (deps.state.meSeg !== "profile") return;
    // A background revalidate must never stomp an in-progress edit — hold the paint
    // while the save bar is open (dirty), exactly like the Settings SWR path.
    if (peek && document.body.classList.contains("savebar-open")) return;
    await applyProfile(deps, profileRaw, goalRaw, { animate: !peek });
  }

  const CAIRN_ME_PROFILE_CONTROLLER = {
    renderProfile,
  };

  Object.assign(globalThis, { CairnMeProfileController: CAIRN_ME_PROFILE_CONTROLLER });

  if (typeof window !== "undefined") {
    window.CairnMeProfileController = CAIRN_ME_PROFILE_CONTROLLER;
  }
})();
