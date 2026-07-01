// @ts-check
// Me Profile controller: profile fetch/render, form wiring, and persistence.

(() => {
  function setActiveButton(root: ParentNode | null | undefined, selector: string, active: Element): void {
    root?.querySelectorAll(selector).forEach((element) => {
      element.classList.toggle("active", element === active);
    });
  }

  function wireProfileForm(
    deps: MeProfileControllerDeps,
    profile: MeProfileProfile,
    enduranceGoal: MeProfileEnduranceGoalDraft,
    initial: { discipline: string; enduranceMode: string; goalMode: string },
  ): void {
    let pickedDisc = String(initial.discipline || "strength");
    let pickedEgMode = String(initial.enduranceMode || "none");
    let pickedGoalMode = String(initial.goalMode || "maintain");

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

    const persistProfile = async () => {
      const body = {
        name: deps.inputValue("#name").trim(),
        age: deps.numberValue("#age"),
        height_cm: deps.numberValue("#height_cm"),
        weight_lb: deps.numberValue("#weight_lb"),
        goal_weight_lb: deps.numberValue("#goal_weight_lb"),
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
      ["profile", "stats", "progress:weight", "progress:energy"].forEach(deps.swrInvalidate);
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

    deps.select("#profToToday")?.addEventListener("click", () => deps.activateTab("today"));
    deps.select("#profToProgress")?.addEventListener("click", () => deps.activateTab("progress"));
  }

  async function renderProfile(deps: MeProfileControllerDeps): Promise<void> {
    deps.headerTitle.textContent = "Me";
    deps.state.meSeg = "profile";
    deps.invalidatePoll();
    deps.root.innerHTML = deps.segSkeleton("profile", deps.segments, 2);

    const [profileRaw, goalRaw] = await Promise.all([deps.api("/profile"), deps.api("/goal")]);
    const profile = CairnMeProfileForm.record(profileRaw) as MeProfileProfile;
    const goal = CairnMeProfileForm.record(goalRaw) as MeProfileGoalCheck;
    deps.setDiscipline(profile.primary_discipline);
    deps.setEnduranceGoalSet(!!profile.endurance_goal_json);

    const enduranceGoal = CairnMeProfileForm.enduranceGoal(profile);
    const enduranceMode = typeof enduranceGoal.mode === "string" && enduranceGoal.mode ? enduranceGoal.mode : "none";
    const goalMode = CairnMeProfileForm.goalMode(profile, goal);
    const discipline = deps.primaryDiscipline();

    await deps.skeletonSwap(() => {
      deps.root.innerHTML = CairnMeProfileForm.html(deps, profile, goal, { discipline, enduranceGoal, enduranceMode, goalMode });
    });
    deps.wireSeg(deps.handlers);
    wireProfileForm(deps, profile, enduranceGoal, { discipline, enduranceMode, goalMode });
  }

  const CAIRN_ME_PROFILE_CONTROLLER = {
    renderProfile,
  };

  Object.assign(globalThis, { CairnMeProfileController: CAIRN_ME_PROFILE_CONTROLLER });

  if (typeof window !== "undefined") {
    window.CairnMeProfileController = CAIRN_ME_PROFILE_CONTROLLER;
  }
})();
