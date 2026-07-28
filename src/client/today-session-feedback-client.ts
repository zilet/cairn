// @ts-check
// Today session feedback rendering and persistence helpers.

type TodaySessionFeedbackStatusApi = {
  feedbackDoneHtml(session: Record<string, unknown> | null | undefined): string;
  feedbackFormHtml(session: Record<string, unknown> | null | undefined): string;
  feedbackOpenHtml(): string;
  hasFeedback(session: Record<string, unknown> | null | undefined): boolean;
};

type TodaySessionFeedbackDeps = {
  state: { logDate: string };
  api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
  toast(message: string, options?: { action?: string; onAction?: () => void }): void;
  sessionStatus: TodaySessionFeedbackStatusApi;
};

type ClientTrainingSymptom = import("../contracts/client-api.js").ClientTrainingSymptom;
type SymptomLifecycleLoggedSet = import("../contracts/client-api.js").ClientLoggedSet;
type MovementCheckObservationResponse =
  import("../contracts/client-api.js").ClientExerciseSymptomObservationResponse;
type MovementCheckVariation = import("../contracts/client-api.js").ClientExerciseVariation;
type MovementStopMarker = {
  date: string;
  session_key: string;
  movement_key: string;
  ts: number;
};

(() => {
  function responseRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  }

  function renderFeedbackDone(slot: Element | null | undefined, session: Record<string, unknown>, deps: TodaySessionFeedbackDeps): void {
    if (!slot) return;
    const html = deps.sessionStatus.feedbackDoneHtml(session);
    if (!html) {
      slot.innerHTML = "";
      return;
    }
    slot.innerHTML = html;
    slot.querySelector("#feedbackEdit")?.addEventListener("click", () => renderFeedbackForm(slot, session, deps));
    void renderSymptomLifecycle(slot, session, deps);
  }

  // Whether this feedback slot lives inside a finished-session DONE card. There the
  // 1-tap capture folds in OPEN (it's the natural "how did that feel" moment); the
  // mid-session finish slot keeps the quiet collapsed affordance so it never nags
  // between sets. Guarded — `closest` is absent under the vm test harness.
  function inDoneCard(slot: Element): boolean {
    return typeof (slot as Element & { closest?: (s: string) => Element | null }).closest === "function"
      ? !!slot.closest(".sessiondone")
      : false;
  }

  function renderFeedback(slot: Element | null | undefined, session: Record<string, unknown>, deps: TodaySessionFeedbackDeps): void {
    if (!slot) return;
    if (deps.sessionStatus.hasFeedback(session)) {
      renderFeedbackDone(slot, session, deps);
      return;
    }
    // Fold the capture into the done moment: render the 1-tap form in place (not a
    // buried "how did that feel?" button) so the affordance is where the moment is.
    // Once answered it pre-dismisses to the compact done summary on the next render.
    if (inDoneCard(slot)) {
      renderFeedbackForm(slot, session, deps);
      return;
    }
    slot.innerHTML = deps.sessionStatus.feedbackOpenHtml();
    slot.querySelector("#feedbackOpen")?.addEventListener("click", () => renderFeedbackForm(slot, session, deps));
    void renderSymptomLifecycle(slot, session, deps);
  }

  // The calm settled line once both scales are in — a persistent confirmation that
  // the signal will bend next week, never a nag. (The reload state still shows the
  // recorded values with an edit affordance via feedbackDoneHtml.)
  function renderFeedbackNoted(slot: Element): void {
    slot.innerHTML = `<div class="checkin-done feedback-done chip-in">
      <span class="checkin-done-mark" aria-hidden="true">✓</span> Noted — it'll shape next week.
    </div><div data-symptom-lifecycle></div>`;
  }

  function sessionMovementOptions(session: Record<string, unknown>): Array<{ id: number | null; name: string }> {
    const seen = new Set<string>();
    const options: Array<{ id: number | null; name: string }> = [];
    for (const raw of Array.isArray(session.sets) ? session.sets : []) {
      const set = raw && typeof raw === "object" ? raw as Partial<SymptomLifecycleLoggedSet> : {};
      const name = String(set.exercise ?? "").trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      const id = Number(set.exercise_id);
      options.push({ id: Number.isInteger(id) && id > 0 ? id : null, name });
    }
    return options;
  }

  function movementInputHtml(symptomId: number, session: Record<string, unknown>): string {
    const options = sessionMovementOptions(session);
    if (!options.length) {
      return `<input class="feedback-joint" data-symptom-movement="${escAttr(symptomId)}" type="text"
        autocomplete="off" placeholder="movement, e.g. Back Squat">`;
    }
    return `<select class="feedback-joint" data-symptom-movement="${escAttr(symptomId)}">
      <option value="">choose movement</option>
      ${options.map((option) =>
        `<option value="${escAttr(option.name)}"${option.id == null ? "" : ` data-exercise-id="${escAttr(option.id)}"`}>${escHtml(option.name)}</option>`
      ).join("")}
    </select>`;
  }

  function movementEvidenceHtml(symptom: ClientTrainingSymptom): string {
    const rows = Array.isArray(symptom.movement_readiness) ? symptom.movement_readiness : [];
    if (!rows.length) return "";
    return rows.map((movement) => {
      const count = Math.max(0, Number(movement.pain_free_exposures) || 0);
      const note = movement.trial_ready
        ? "Two pain-free checks recorded — evidence for a careful movement recheck; the symptom stays open."
        : `${count} pain-free ${count === 1 ? "check" : "checks"} recorded.`;
      return `<div class="sess-line"><strong>${escHtml(movement.movement_name)}</strong> · ${escHtml(note)}</div>`;
    }).join("");
  }

  function symptomRowHtml(symptom: ClientTrainingSymptom, session: Record<string, unknown>): string {
    const active = symptom.status === "active";
    return `<div class="well-accent-sm" data-symptom-row="${escAttr(symptom.id)}">
      <div><strong>${escHtml(symptom.area_text)}</strong> <span class="sess-line">· ${active ? "active" : "resolved"}</span></div>
      ${movementEvidenceHtml(symptom)}
      <div class="feedback-joint-wrap">
        ${movementInputHtml(symptom.id, session)}
        ${active
          ? `<button class="linkbtn linkbtn-plain linkbtn-sm" type="button" data-tolerance="free" data-symptom-id="${escAttr(symptom.id)}">pain-free check</button>
             <button class="linkbtn linkbtn-quiet linkbtn-sm" type="button" data-tolerance="present" data-symptom-id="${escAttr(symptom.id)}">pain present</button>
             <button class="linkbtn linkbtn-quiet linkbtn-sm" type="button" data-symptom-resolve="${escAttr(symptom.id)}">mark resolved</button>`
          : `<button class="linkbtn linkbtn-plain linkbtn-sm" type="button" data-symptom-recur="${escAttr(symptom.id)}">it returned</button>`}
      </div>
    </div>`;
  }

  function responseSymptoms(value: unknown): ClientTrainingSymptom[] {
    return Array.isArray(value)
      ? value.filter((entry): entry is ClientTrainingSymptom => !!entry && typeof entry === "object")
      : [];
  }

  async function reportSymptomArea(
    areaText: string,
    session: Record<string, unknown>,
    date: string,
    deps: TodaySessionFeedbackDeps
  ): Promise<ClientTrainingSymptom | null> {
    const sourceSessionId = Number(session.id);
    const result = responseRecord(await deps.api("/training-symptoms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        area_text: areaText,
        onset_on: date,
        source_session_id: Number.isInteger(sourceSessionId) && sourceSessionId > 0 ? sourceSessionId : null,
        source_kind: "session_feedback",
      }),
    }));
    if (result.error) throw new Error(String(result.error));
    return result as unknown as ClientTrainingSymptom;
  }

  async function renderSymptomLifecycle(
    slot: Element,
    session: Record<string, unknown>,
    deps: TodaySessionFeedbackDeps
  ): Promise<void> {
    const host = slot.querySelector<HTMLElement>("[data-symptom-lifecycle]");
    if (!host) return;
    let symptoms: ClientTrainingSymptom[];
    try {
      const viewedDate = encodeURIComponent(String(session.date || deps.state.logDate));
      symptoms = responseSymptoms(await deps.api(`/training-symptoms?on=${viewedDate}&include_resolved=1`));
    } catch {
      host.innerHTML = `<div class="sess-line">Movement notes couldn't load right now.</div>`;
      return;
    }
    if (!host.isConnected && typeof (host as HTMLElement & { isConnected?: boolean }).isConnected === "boolean") return;
    host.innerHTML = `<div class="feedback-prompt lbl">movement notes</div>
      ${symptoms.map((symptom) => symptomRowHtml(symptom, session)).join("")}
      <div class="feedback-joint-wrap">
        <input class="feedback-joint" data-new-symptom type="text" autocomplete="off" placeholder="report another area">
        <button class="linkbtn linkbtn-plain linkbtn-sm" type="button" data-report-symptom>report</button>
      </div>`;

    const reload = () => renderSymptomLifecycle(slot, session, deps);
    host.querySelector("[data-report-symptom]")?.addEventListener("click", async () => {
      const input = host.querySelector<HTMLInputElement>("[data-new-symptom]");
      const area = input?.value.trim() ?? "";
      if (!area) {
        deps.toast("Name the area first.");
        return;
      }
      try {
        await reportSymptomArea(area, session, String(session.date || deps.state.logDate), deps);
        deps.toast("Symptom noted");
        await reload();
      } catch {
        deps.toast("Couldn't save that symptom — try again.");
      }
    });
    host.querySelectorAll<HTMLElement>("[data-symptom-resolve]").forEach((button) =>
      button.addEventListener("click", async () => {
        try {
          await deps.api(`/training-symptoms/${button.dataset.symptomResolve}/resolve`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ on: String(session.date || deps.state.logDate) }),
          });
          deps.toast("Marked resolved");
          await reload();
        } catch {
          deps.toast("Couldn't update that symptom — try again.");
        }
      }));
    host.querySelectorAll<HTMLElement>("[data-symptom-recur]").forEach((button) =>
      button.addEventListener("click", async () => {
        const id = String(button.dataset.symptomRecur ?? "");
        const movement = host.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-symptom-movement="${id}"]`);
        const option = movement instanceof HTMLSelectElement ? movement.selectedOptions[0] : null;
        try {
          await deps.api(`/training-symptoms/${id}/recur`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              on: String(session.date || deps.state.logDate),
              movement: movement?.value.trim() || undefined,
              exercise_id: option?.dataset.exerciseId ? Number(option.dataset.exerciseId) : undefined,
            }),
          });
          deps.toast("Recurrence noted");
          await reload();
        } catch {
          deps.toast("Couldn't update that symptom — try again.");
        }
      }));
    host.querySelectorAll<HTMLElement>("[data-tolerance]").forEach((button) =>
      button.addEventListener("click", async () => {
        const id = String(button.dataset.symptomId ?? "");
        const movement = host.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-symptom-movement="${id}"]`);
        const name = movement?.value.trim() ?? "";
        if (!name) {
          deps.toast("Choose the movement first.");
          return;
        }
        const option = movement instanceof HTMLSelectElement ? movement.selectedOptions[0] : null;
        try {
          await deps.api(`/training-symptoms/${id}/tolerance`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              movement: name,
              exercise_id: option?.dataset.exerciseId ? Number(option.dataset.exerciseId) : undefined,
              observed_on: String(session.date || deps.state.logDate),
              session_id: Number(session.id) || undefined,
              pain_free: button.dataset.tolerance === "free",
            }),
          });
          deps.toast("Movement check noted");
          await reload();
        } catch {
          deps.toast("Couldn't save that movement check — try again.");
        }
      }));
  }

  function movementCheckSymptoms(value: unknown): ClientTrainingSymptom[] {
    return responseSymptoms(value).filter((symptom) => symptom.status === "active");
  }

  function movementCheckChoicesHtml(hasSets: boolean): string {
    return `<div class="pill-group" data-movement-current-choices>
      <button class="linkbtn linkbtn-plain linkbtn-sm" type="button" data-movement-ease>Ease this</button>
      ${hasSets
        ? `<button class="linkbtn linkbtn-quiet linkbtn-sm" type="button" data-movement-stop>Stop here</button>`
        : `<button class="linkbtn linkbtn-quiet linkbtn-sm" type="button" data-movement-alternatives>Use another movement</button>
           <button class="linkbtn linkbtn-quiet linkbtn-sm" type="button" data-movement-skip>Skip today</button>`}
    </div>`;
  }

  function movementCheckLoadedHtml(symptoms: ClientTrainingSymptom[]): string {
    symptoms = symptoms.filter((symptom) => symptom.status === "active");
    if (!symptoms.length) {
      return `<div class="sess-line">If something hurts, name the exact area so this check stays specific.</div>
        <div class="feedback-joint-wrap">
          <input class="feedback-joint" data-movement-area type="text" autocomplete="off"
            placeholder="exact area, e.g. front of right knee">
          <div class="pill-group">
            <button class="linkbtn linkbtn-plain linkbtn-sm" type="button"
              data-movement-outcome="pain_present">Something hurts</button>
          </div>
        </div>`;
    }
    return symptoms.map((symptom) => `<div data-movement-symptom="${escAttr(symptom.id)}">
        <div class="sess-line"><strong>${escHtml(symptom.area_text)}</strong></div>
        <div class="pill-group">
          <button class="linkbtn linkbtn-plain linkbtn-sm" type="button"
            data-movement-outcome="pain_free" data-symptom-id="${escAttr(symptom.id)}"
            data-symptom-area="${escAttr(symptom.area_text)}">Pain-free today</button>
          <button class="linkbtn linkbtn-quiet linkbtn-sm" type="button"
            data-movement-outcome="pain_present" data-symptom-id="${escAttr(symptom.id)}"
            data-symptom-area="${escAttr(symptom.area_text)}">Pain present</button>
        </div>
      </div>`).join("");
  }

  function movementCheckPainPresentHtml(area: string, queued: boolean, hasSets: boolean): string {
    const saved = queued ? "Pain present saved — it will sync when you're back online." : "Pain present noted.";
    return `<div class="sess-line"><strong>${escHtml(area || "Pain present")}</strong> · ${escHtml(saved)}
      Choose what fits this session; this does not change your weekly plan.</div>
      ${movementCheckChoicesHtml(hasSets)}`;
  }

  function movementCheckPainFreeHtml(area: string, queued: boolean): string {
    const saved = queued
      ? "Pain-free check saved — it will sync when you're back online."
      : "Pain-free today recorded.";
    return `<div class="sess-line"><strong>${escHtml(area)}</strong> · ${escHtml(saved)}
      The symptom stays open; one pain-free check does not change its status.</div>`;
  }

  function movementCheckSessionId(
    session: Record<string, unknown>,
    deps: ClientTodaySessionControllerDeps,
    date: string,
  ): number | null {
    if (session._staged_offline === true) return null;
    const id = Number(deps.state.sessionIdsByDate?.[date] ?? session.id);
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  const MOVEMENT_STOP_STORAGE_KEY = "cairn.movement-stop.v1";
  const MOVEMENT_STOP_MAX = 32;
  const MOVEMENT_STOP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

  function movementStopKey(movement: string): string {
    return movement.trim().toLowerCase().replace(/\s+/g, " ");
  }

  function validMovementStopSessionKey(value: unknown): value is string {
    return (
      typeof value === "string" &&
      value.length <= 180 &&
      /^(?:session|daily|prepare):[A-Za-z0-9._:-]+$/.test(value)
    );
  }

  function movementStopMarkers(): MovementStopMarker[] {
    try {
      const parsed = JSON.parse(localStorage.getItem(MOVEMENT_STOP_STORAGE_KEY) || "[]");
      if (!Array.isArray(parsed)) return [];
      const cutoff = Date.now() - MOVEMENT_STOP_MAX_AGE_MS;
      return parsed
        .filter((marker): marker is MovementStopMarker =>
          !!marker &&
          typeof marker === "object" &&
          /^\d{4}-\d{2}-\d{2}$/.test(String(marker.date || "")) &&
          validMovementStopSessionKey(marker.session_key) &&
          typeof marker.movement_key === "string" &&
          marker.movement_key.length > 0 &&
          marker.movement_key.length <= 160 &&
          Number.isFinite(Number(marker.ts)) &&
          Number(marker.ts) >= cutoff &&
          Number(marker.ts) <= Date.now() + 60_000)
        .sort((left, right) => Number(right.ts) - Number(left.ts))
        .slice(0, MOVEMENT_STOP_MAX);
    } catch {
      return [];
    }
  }

  function writeMovementStopMarkers(markers: MovementStopMarker[]): boolean {
    try {
      const bounded = markers
        .sort((left, right) => Number(right.ts) - Number(left.ts))
        .slice(0, MOVEMENT_STOP_MAX);
      const serialized = JSON.stringify(bounded);
      localStorage.setItem(MOVEMENT_STOP_STORAGE_KEY, serialized);
      return localStorage.getItem(MOVEMENT_STOP_STORAGE_KEY) === serialized;
    } catch {
      return false;
    }
  }

  function movementStopSessionKey(
    session: Record<string, unknown>,
    deps: ClientTodaySessionControllerDeps,
    date: string,
    preferred?: unknown,
  ): string | null {
    if (validMovementStopSessionKey(preferred)) return preferred;
    const localPrepareId = String(session._local_prepare_id || "").trim();
    if (session._staged_offline === true && localPrepareId) return `prepare:${localPrepareId}`;
    const sessionId = movementCheckSessionId(session, deps, date);
    const dailySession =
      session.daily_session && typeof session.daily_session === "object"
        ? session.daily_session as Record<string, unknown>
        : null;
    const dailyId = Number(dailySession?.id);
    const runtime = globalThis as {
      outboxSessionGroupId?: (
        value: string,
        identity?: { sessionId?: unknown; dailySessionId?: unknown },
      ) => string;
    };
    const group = runtime.outboxSessionGroupId?.(date, {
      sessionId,
      dailySessionId: Number.isInteger(dailyId) && dailyId > 0 ? dailyId : undefined,
    });
    if (validMovementStopSessionKey(group)) return group;
    if (sessionId != null) return `session:${sessionId}`;
    if (Number.isInteger(dailyId) && dailyId > 0) return `daily:${dailyId}`;
    return localPrepareId ? `prepare:${localPrepareId}` : null;
  }

  function saveMovementStop(date: string, sessionKey: string | null, movement: string): boolean {
    if (!validMovementStopSessionKey(sessionKey)) return false;
    const movementKey = movementStopKey(movement);
    if (!movementKey || movementKey.length > 160) return false;
    const markers = movementStopMarkers().filter((marker) =>
      !(marker.date === date && marker.session_key === sessionKey && marker.movement_key === movementKey));
    markers.unshift({ date, session_key: sessionKey, movement_key: movementKey, ts: Date.now() });
    return writeMovementStopMarkers(markers);
  }

  function clearMovementStop(date: string, sessionKey: string | null, movement: string): boolean {
    if (!validMovementStopSessionKey(sessionKey)) return false;
    const movementKey = movementStopKey(movement);
    const markers = movementStopMarkers();
    const next = markers.filter((marker) =>
      !(marker.date === date && marker.session_key === sessionKey && marker.movement_key === movementKey));
    return next.length !== markers.length && writeMovementStopMarkers(next);
  }

  function hasMovementStop(
    date: string,
    sessionKey: string | null,
    movement: string,
  ): boolean {
    if (!validMovementStopSessionKey(sessionKey)) return false;
    const movementKey = movementStopKey(movement);
    return movementStopMarkers().some((marker) =>
      marker.date === date && marker.session_key === sessionKey && marker.movement_key === movementKey);
  }

  function movementStopPlaceholder(
    card: HTMLElement,
    movement: string,
    date: string,
    sessionKey: string | null,
    deps: ClientTodaySessionControllerDeps,
  ): HTMLElement | null {
    const sibling = card.nextElementSibling as HTMLElement | null;
    if (
      sibling?.dataset.movementStopPlaceholder === "1" &&
      sibling.dataset.movementStopKey === movementStopKey(movement)
    ) {
      return sibling;
    }
    const placeholder = document.createElement("div");
    placeholder.className = "skipline";
    placeholder.dataset.movementStopPlaceholder = "1";
    placeholder.dataset.movementStopKey = movementStopKey(movement);
    placeholder.innerHTML = `<span class="sess-line"><strong>${escHtml(movement)}</strong> stopped here.</span>
      <button class="linkbtn linkbtn-quiet linkbtn-sm" type="button" data-movement-show>Show movement</button>`;
    card.parentElement?.insertBefore(placeholder, card.nextElementSibling);
    placeholder.querySelector<HTMLElement>("[data-movement-show]")?.addEventListener("click", () => {
      const restored = clearMovementStop(date, sessionKey, movement);
      card.hidden = false;
      deps.expandEl(card);
      placeholder.remove();
      deps.toast(restored ? `${movement} is visible again.` : `${movement} is visible for now.`);
    });
    return placeholder;
  }

  function suppressMovementCard(
    card: HTMLElement,
    movement: string,
    date: string,
    sessionKey: string | null,
    deps: ClientTodaySessionControllerDeps,
    animate: boolean,
  ): void {
    const hide = () => {
      card.hidden = true;
      movementStopPlaceholder(card, movement, date, sessionKey, deps);
    };
    if (animate) deps.collapseEl(card, hide);
    else hide();
  }

  function movementCheckStillCurrent(
    details: HTMLDetailsElement,
    card: HTMLElement,
    deps: ClientTodaySessionControllerDeps,
    date: string,
    tab: string | undefined,
    token?: string,
  ): boolean {
    if (deps.state.logDate !== date || deps.state.tab !== tab) return false;
    if (details.isConnected === false || card.isConnected === false) return false;
    return token == null || details.dataset.movementRequest === token;
  }

  function wireMovementChoiceActions(
    body: HTMLElement,
    details: HTMLDetailsElement,
    card: HTMLElement,
    movement: string,
    deps: ClientTodaySessionControllerDeps,
    date: string,
    tab: string | undefined,
    sessionKey: string | null,
  ): void {
    body.querySelector<HTMLElement>("[data-movement-ease]")?.addEventListener("click", () => {
      if (!movementCheckStillCurrent(details, card, deps, date, tab)) return;
      details.open = false;
      const dose = card.querySelector<HTMLInputElement>(".in-w, .in-dur, .in-r");
      dose?.scrollIntoView({ behavior: "smooth", block: "center" });
      dose?.focus();
      deps.toast("Choose the lower load or shorter dose that fits today.");
    });
    body.querySelector<HTMLElement>("[data-movement-stop]")?.addEventListener("click", () => {
      if (!movementCheckStillCurrent(details, card, deps, date, tab)) return;
      card.dataset.stoppedHere = "1";
      saveMovementStop(date, sessionKey, movement);
      suppressMovementCard(card, movement, date, sessionKey, deps, true);
      deps.toast("Stopped here — your logged work stays in this session.");
    });
    body.querySelector<HTMLElement>("[data-movement-skip]")?.addEventListener("click", () => {
      if (!movementCheckStillCurrent(details, card, deps, date, tab)) return;
      card.querySelector<HTMLElement>(".ex-skip")?.click();
    });
    body.querySelector<HTMLElement>("[data-movement-alternatives]")?.addEventListener("click", async () => {
      if (!movementCheckStillCurrent(details, card, deps, date, tab)) return;
      const token = `${Date.now()}:${Math.random()}`;
      details.dataset.movementRequest = token;
      body.innerHTML = `<div class="sess-line">Finding same-pattern options…</div>`;
      let variations: MovementCheckVariation[];
      try {
        const value = await deps.api(
          `/program/variations?exercise=${encodeURIComponent(movement)}&mode=alternatives`,
        );
        variations = Array.isArray(value)
          ? value.filter((row): row is MovementCheckVariation =>
              !!row && typeof row === "object" && typeof (row as MovementCheckVariation).name === "string")
          : [];
      } catch {
        if (movementCheckStillCurrent(details, card, deps, date, tab, token)) {
          body.innerHTML = `<div class="sess-line">Movement options couldn't load right now.</div>`;
        }
        return;
      }
      if (!movementCheckStillCurrent(details, card, deps, date, tab, token)) return;
      body.innerHTML = variations.length
        ? `<div class="sess-line">Same-pattern ideas only — choose one you already know feels tolerable.</div>
           <div class="pill-group">
             ${variations.map((variation) =>
               `<button class="linkbtn linkbtn-quiet linkbtn-sm" type="button"
                 data-movement-alternative="${escAttr(variation.name)}">${escHtml(variation.name)}</button>`
             ).join("")}
           </div>`
        : `<div class="sess-line">No same-pattern options are available here. Ease this movement or skip it today.</div>`;
      body.querySelectorAll<HTMLElement>("[data-movement-alternative]").forEach((button) =>
        button.addEventListener("click", () => {
          if (!movementCheckStillCurrent(details, card, deps, date, tab, token)) return;
          const alternative = String(button.dataset.movementAlternative || "").trim();
          const addButton = deps.root.querySelector<HTMLElement>("#addExBtn");
          const input = deps.root.querySelector<HTMLInputElement>("#addExInput");
          const add = deps.root.querySelector<HTMLElement>("#addExGo");
          const skip = card.querySelector<HTMLElement>(".ex-skip");
          if (!alternative || !addButton || !input || !add || !skip) {
            deps.toast("Use + Add exercise for that option, then skip this movement.");
            return;
          }
          if (!addButton.hidden) addButton.click();
          input.value = alternative;
          add.click();
          skip.click();
          deps.toast(`${alternative} is staged for this session — log a set to make it part of today's work.`);
        }));
    });
  }

  function wireMovementObservationActions(
    body: HTMLElement,
    details: HTMLDetailsElement,
    card: HTMLElement,
    movement: string,
    session: Record<string, unknown>,
    deps: ClientTodaySessionControllerDeps,
    date: string,
    tab: string | undefined,
  ): void {
    body.querySelectorAll<HTMLElement>("[data-movement-outcome]").forEach((button) =>
      button.addEventListener("click", async () => {
        if (!movementCheckStillCurrent(details, card, deps, date, tab)) return;
        const outcome = button.dataset.movementOutcome === "pain_free" ? "pain_free" : "pain_present";
        const symptomId = Number(button.dataset.symptomId);
        const areaInput = body.querySelector<HTMLInputElement>("[data-movement-area]");
        const area = areaInput?.value.trim() || "";
        const symptomArea = String(button.dataset.symptomArea || "").trim();
        if (outcome === "pain_present" && !Number.isInteger(symptomId) && !area) {
          deps.toast("Name the exact area first.");
          areaInput?.focus();
          return;
        }
        const sessionId = movementCheckSessionId(session, deps, date);
        const requestBody = {
          date,
          movement,
          ...(sessionId ? { session_id: sessionId } : {}),
          ...(Number.isInteger(symptomId) && symptomId > 0 ? { symptom_event_id: symptomId } : {}),
          ...(area ? { area_text: area } : {}),
          outcome,
        };
        const mutation = await runSessionMutation({
          date,
          kind: "symptom_observation",
          path: "/training-symptoms/observation",
          body: requestBody,
          identity: { sessionId },
        }, (idempotencyKey) => deps.api("/training-symptoms/observation", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Idempotency-Key": idempotencyKey },
          body: JSON.stringify(requestBody),
        }));
        if (!movementCheckStillCurrent(details, card, deps, date, tab)) return;
        const hasSets = card.querySelectorAll("[data-logged] .chip").length > 0;
        if (mutation.status === "queued") {
          body.innerHTML = outcome === "pain_present"
            ? movementCheckPainPresentHtml(symptomArea || area || "Pain present", true, hasSets)
            : movementCheckPainFreeHtml(symptomArea || "Pain-free check", true);
          if (outcome === "pain_present") {
            wireMovementChoiceActions(
              body,
              details,
              card,
              movement,
              deps,
              date,
              tab,
              movementStopSessionKey(session, deps, date, mutation.groupId),
            );
          }
          return;
        }
        if (mutation.status !== "sent") {
          const message = mutation.status === "blocked"
            ? "An earlier saved change in this workout needs attention before this movement check."
            : mutation.status === "storage_error"
              ? "This movement check couldn't be saved on this device."
              : "This movement check couldn't be saved — try again.";
          body.innerHTML = `<div class="sess-line">${escHtml(message)}</div>`;
          return;
        }
        const result = responseRecord(mutation.value) as unknown as MovementCheckObservationResponse;
        if (
          result.ok !== true ||
          String(result.date) !== date ||
          (sessionId != null && Number(result.session_id) !== sessionId) ||
          String(result.exercise?.name || "").toLowerCase() !== movement.toLowerCase()
        ) return;
        const resultArea = String(result.symptom?.area_text || area || "Pain present");
        if (result.outcome === "pain_present") {
          body.innerHTML = movementCheckPainPresentHtml(resultArea, false, hasSets);
          wireMovementChoiceActions(
            body,
            details,
            card,
            movement,
            deps,
            date,
            tab,
            movementStopSessionKey(session, deps, date, mutation.groupId),
          );
        } else {
          body.innerHTML = movementCheckPainFreeHtml(resultArea, false);
        }
      }));
  }

  function wireMovementChecks(
    session: Record<string, unknown>,
    deps: ClientTodaySessionControllerDeps,
  ): void {
    const date = deps.state.logDate;
    const tab = deps.state.tab;
    const sessionKey = movementStopSessionKey(session, deps, date);
    deps.root.querySelectorAll<HTMLDetailsElement>("[data-movement-check]").forEach((details) => {
      if (details.dataset.wired) return;
      details.dataset.wired = "1";
      const card = details.closest<HTMLElement>(".ex");
      const body = details.querySelector<HTMLElement>("[data-movement-check-body]");
      const movement = String(details.dataset.movement || "").trim();
      if (!card || !body || !movement) return;
      if (hasMovementStop(date, sessionKey, movement)) {
        suppressMovementCard(card, movement, date, sessionKey, deps, false);
      }
      details.addEventListener("toggle", async () => {
        if (!details.open || !movementCheckStillCurrent(details, card, deps, date, tab)) return;
        const token = `${Date.now()}:${Math.random()}`;
        details.dataset.movementRequest = token;
        body.innerHTML = `<div class="sess-line">Loading movement notes…</div>`;
        let symptoms: ClientTrainingSymptom[];
        try {
          symptoms = movementCheckSymptoms(await deps.api(
            `/training-symptoms?on=${encodeURIComponent(date)}&movement=${encodeURIComponent(movement)}`,
          ));
        } catch {
          if (movementCheckStillCurrent(details, card, deps, date, tab, token)) {
            body.innerHTML = `<div class="sess-line">Movement notes couldn't load right now.</div>`;
          }
          return;
        }
        if (!movementCheckStillCurrent(details, card, deps, date, tab, token) || !details.open) return;
        body.innerHTML = movementCheckLoadedHtml(symptoms);
        wireMovementObservationActions(body, details, card, movement, session, deps, date, tab);
      });
    });
  }

  function renderFeedbackForm(slot: Element, session: Record<string, unknown>, deps: TodaySessionFeedbackDeps): void {
    slot.innerHTML = deps.sessionStatus.feedbackFormHtml(session);
    void renderSymptomLifecycle(slot, session, deps);
    const date = String(session.date || deps.state.logDate);
    const picked: Record<string, number | undefined> = {};
    // A save is confirmed only when the server accepts it (no {error}, no network
    // throw). Returning that truth lets the tap handler avoid a lying "Noted".
    const save = async (): Promise<boolean> => {
      const joint = slot.querySelector<HTMLInputElement>("#feedbackJoint");
      const jointVal = joint ? joint.value.trim() : "";
      try {
        const saved = await deps.api(`/sessions/${date}/feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            soreness: picked.soreness,
            performance: picked.performance,
            joint_pain: jointVal || null,
          }),
        });
        const row = responseRecord(saved);
        if (row.error) return false;
        Object.assign(session, row);
        if (jointVal) {
          try {
            await reportSymptomArea(jointVal, session, date, deps);
            void renderSymptomLifecycle(slot, session, deps);
          } catch {
            deps.toast("Feedback saved; the symptom note couldn't update.");
          }
        }
        return true;
      } catch {
        return false;
      }
    };

    // Confirm once, and only on a real save — this is optional signal, so a failed
    // write stays silent rather than nagging or (worse) faking a "Noted".
    let notified = false;
    slot.querySelectorAll<HTMLElement>(".feel-dot").forEach((button) =>
      button.addEventListener("click", async () => {
        const kind = String(button.dataset.feel || "");
        const val = Number(button.dataset.val);
        const dots = [...slot.querySelectorAll<HTMLElement>(`.feel-dot[data-feel="${kind}"]`)];
        // Optimistic apply — but snapshot the prior selection + fill so a rejected
        // write rolls back instead of silently desyncing the dots from the truth.
        const prevVal = picked[kind];
        const prevOn = dots.map((dot) => dot.classList.contains("feel-dot-on"));
        picked[kind] = val;
        dots.forEach((dot) => dot.classList.toggle("feel-dot-on", Number(dot.dataset.val) <= val));
        const ok = await save();
        if (ok) {
          if (!notified) {
            notified = true;
            deps.toast("Noted");
          }
          // Both scales in → collapse to the calm settled line (the joint note, if
          // any, was already carried on this same save). The finish moment stays two
          // taps, never a lingering form.
          if (picked.soreness != null && picked.performance != null) renderFeedbackNoted(slot);
          if (picked.soreness != null && picked.performance != null) void renderSymptomLifecycle(slot, session, deps);
          return;
        }
        // Roll back the optimistic fill to exactly what was showing before the tap.
        picked[kind] = prevVal;
        dots.forEach((dot, index) => dot.classList.toggle("feel-dot-on", prevOn[index]));
        deps.toast("Couldn't save that — try again.");
      }));

    // The joint free-text starts collapsed behind "anything ache?"; reveal it in place.
    const jointToggle = slot.querySelector<HTMLElement>("#feedbackJointToggle");
    const joint = slot.querySelector<HTMLInputElement>("#feedbackJoint");
    jointToggle?.addEventListener("click", () => {
      jointToggle.hidden = true;
      if (joint) {
        joint.hidden = false;
        joint.focus();
      }
    });
    if (joint) joint.addEventListener("change", () => {
      if (picked.soreness || picked.performance || joint.value.trim()) void save();
    });
    slot.querySelector("#feedbackDismiss")?.addEventListener("click", () => {
      slot.innerHTML = "";
    });
  }

  const CAIRN_TODAY_SESSION_FEEDBACK = {
    movementCheckLoadedHtml,
    renderFeedback,
    wireMovementChecks,
  };

  Object.assign(globalThis, { CairnTodaySessionFeedback: CAIRN_TODAY_SESSION_FEEDBACK });

  if (typeof window !== "undefined") {
    window.CairnTodaySessionFeedback = CAIRN_TODAY_SESSION_FEEDBACK;
  }
})();
