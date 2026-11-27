// @ts-check
// Mid-session "Ideas to add" controller: owns the CairnUiSheet lifecycle,
// fast agentic ideation runs, optional steering, and durable 1-tap session append.

type SessionAdditionsControllerDeps = {
  root: Element;
  state: { logDate: string; exModes?: Record<string, string> };
  api(path: string, opts?: RequestInit & { headers?: Record<string, string>; acceptErrorBody?: boolean }): Promise<unknown>;
  runOp(kind: string, body: Record<string, unknown>, options: Record<string, unknown>): Promise<unknown>;
  exCard(
    item: Record<string, unknown>,
    logged: Array<Record<string, unknown>>,
    prefill: Record<string, unknown>,
    revealIdx: unknown,
    rx: unknown,
    lastSet?: unknown
  ): string;
  wireGuides(card: Element): void;
  wireLogRow(row: Element | null): void;
  wireSkips(): void;
  invalidate(keyOrPrefix: string): void;
  reducedMotion(): boolean;
  toast(message: string): void;
  fmtDur?(seconds: number): string;
};

type SessionAdditionRow = Record<string, unknown> & {
  exercise?: unknown;
  mode?: unknown;
  sets?: unknown;
  rep_low?: unknown;
  rep_high?: unknown;
  target_weight?: unknown;
  target_seconds?: unknown;
  last_set?: Record<string, unknown> | null;
};

(() => {
  let openSheet: { sheet: HTMLElement; close(options?: { instant?: boolean }): void } | null = null;
  let activeRunToken = 0;

  function insertPrescribedCard(
    item: Record<string, unknown>,
    lastSet: Record<string, unknown> | null,
    deps: SessionAdditionsControllerDeps
  ): HTMLElement | null {
    const name = String(item.exercise || "").trim();
    const key = CairnSessionAdditionsModel.exerciseKey(name);
    if (!key) return null;
    const existing = [...deps.root.querySelectorAll<HTMLElement>(".ex[data-card]")].find(
      (el) => CairnSessionAdditionsModel.exerciseKey(el.dataset.card) === key
    );
    if (existing) return existing;

    const prefill = CairnSessionAdditionsModel.prefillFromSuggestion({ ...item, last_set: lastSet });
    const tpl = document.createElement("template");
    tpl.innerHTML = deps
      .exCard({ ...item, fromPlan: false, fromSession: true }, [], prefill, null, null, lastSet)
      .trim();
    const cardEl = tpl.content.firstElementChild as HTMLElement | null;
    if (!cardEl) return null;

    const addBlock = deps.root.querySelector(".addex");
    if (addBlock) addBlock.before(cardEl);
    else (deps.root.querySelector(".plansurface") || deps.root).appendChild(cardEl);

    deps.wireGuides(cardEl);
    const logRow = cardEl.querySelector(".logrow");
    deps.wireLogRow(logRow);
    if (typeof CairnTodaySessionSetModel !== "undefined") {
      CairnTodaySessionSetModel.wireLastSetLine(logRow, lastSet, deps as never);
    }
    deps.wireSkips();
    if (item.mode && name) {
      (deps.state.exModes ??= {})[name] = String(item.mode);
    }
    return cardEl;
  }

  function invalidateSessionCaches(date: string, deps: SessionAdditionsControllerDeps): void {
    const inv = (globalThis as {
      CairnWriteInvalidation?: { invalidateWrite(name: string, opts?: { keep?: readonly string[] }): string[] };
    }).CairnWriteInvalidation;
    if (inv && typeof inv.invalidateWrite === "function") {
      inv.invalidateWrite("session_add_items");
    }
    for (const prefix of ["today:session:", "today:daily-session:", "today:aggregate:", "today:open:"]) {
      deps.invalidate(prefix + date);
    }
  }

  function openIdeateSheet(deps: SessionAdditionsControllerDeps): void {
    const sheets = (globalThis as {
      CairnUiSheet?: { open(options: Record<string, unknown>): { sheet: HTMLElement; close(options?: { instant?: boolean }): void } };
    }).CairnUiSheet;
    if (!sheets || openSheet) return;

    const subtitle = CairnSessionAdditionsModel.sessionContextSummary(deps.root);
    const addedKeys = CairnSessionAdditionsModel.collectCurrentExerciseKeys(deps.root);
    const seenNames = new Set<string>();
    let currentSteer = "";
    let lastJobId: number | null = null;
    let currentSuggestions: SessionAdditionRow[] = [];
    let firstAddedCard: HTMLElement | null = null;

    const handle = sheets.open({
      html: CairnSessionAdditionsClient.sheetHtml({ subtitle }),
      labelledBy: "ideateSheetTitle",
      sheetClass: "ui-sheet ideate-sheet",
      sheetTag: "section",
      onClose: () => {
        activeRunToken += 1;
        openSheet = null;
        if (firstAddedCard?.isConnected) {
          const field =
            firstAddedCard.querySelector<HTMLElement>(".in-r") ||
            firstAddedCard.querySelector<HTMLElement>(".in-dur") ||
            firstAddedCard.querySelector<HTMLElement>(".in-w");
          if (typeof CairnFocusReveal !== "undefined") CairnFocusReveal.focus(field, { box: firstAddedCard });
          else {
            firstAddedCard.scrollIntoView({ behavior: deps.reducedMotion() ? "auto" : "smooth", block: "nearest" });
            field?.focus();
          }
        }
      },
    });
    openSheet = handle;

    const slot = handle.sheet.querySelector<HTMLElement>(".ideate-slot");
    const steerInput = handle.sheet.querySelector<HTMLInputElement>(".ideate-steer-input");
    const goBtn = handle.sheet.querySelector<HTMLElement>("[data-ideate-go]");
    const vibeBtns = [...handle.sheet.querySelectorAll<HTMLElement>("[data-ideate-vibe]")];

    const syncVibeSelection = (steer: string) => {
      const folded = steer.trim().toLowerCase();
      for (const btn of vibeBtns) {
        btn.classList.toggle("is-active", (btn.dataset.ideateVibe || "").toLowerCase() === folded && !!folded);
      }
    };

    const appendSuggestion = async (idx: number, button: HTMLButtonElement) => {
      const suggestion = currentSuggestions[idx];
      if (!suggestion || button.disabled || button.dataset.busy === "1") return;
      const exercise = String(suggestion.exercise || "").trim();
      if (!exercise) return;
      const key = CairnSessionAdditionsModel.exerciseKey(exercise);
      if (addedKeys.has(key)) return;

      const restoreLabel = button.textContent || "+ Add";
      button.dataset.busy = "1";
      button.disabled = true;
      button.textContent = "Adding…";

      try {
        const res = (await deps.api("/daily-session/items", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            date: deps.state.logDate,
            origin: "ideation_add",
            source_job_id: lastJobId,
            items: [
              {
                exercise,
                mode: suggestion.mode ?? "reps",
                sets: suggestion.sets ?? 3,
                rep_low: suggestion.rep_low ?? null,
                rep_high: suggestion.rep_high ?? null,
                target_weight: suggestion.target_weight ?? null,
                target_seconds: suggestion.target_seconds ?? null,
                note: suggestion.note ?? null,
              },
            ],
          }),
          acceptErrorBody: true,
        })) as Record<string, unknown> | null;

        if (!res || res.ok !== true) {
          throw new Error(String(res?.error || "Could not add that exercise."));
        }

        const addedList = Array.isArray(res.added) ? (res.added as Array<Record<string, unknown>>) : [];
        const cardItem = addedList[0] ?? suggestion;
        const lastSet =
          suggestion.last_set && typeof suggestion.last_set === "object"
            ? suggestion.last_set
            : null;
        const cardEl = insertPrescribedCard(cardItem, lastSet, deps);
        if (cardEl && !firstAddedCard) firstAddedCard = cardEl;

        invalidateSessionCaches(deps.state.logDate, deps);
        if (typeof CairnTodayOpenSession !== "undefined" && res.daily_session && res.session) {
          CairnTodayOpenSession.remember(deps.state.logDate, res.daily_session, res.session);
        }

        addedKeys.add(key);
        button.dataset.busy = "";
        button.classList.add("is-added");
        button.textContent = "Added ✓";
        deps.toast(`Added ${String(cardItem.exercise || exercise)} to today's session`);
      } catch (err) {
        button.dataset.busy = "";
        button.disabled = false;
        button.textContent = restoreLabel;
        deps.toast(err instanceof Error && err.message ? err.message : "Couldn't add that exercise — try again.");
      }
    };

    const wireResults = () => {
      if (!slot) return;
      slot.querySelectorAll<HTMLButtonElement>("[data-ideate-add]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const idx = Number(btn.dataset.ideateAdd);
          if (Number.isInteger(idx) && idx >= 0) void appendSuggestion(idx, btn);
        });
      });
      slot.querySelector("[data-ideate-more]")?.addEventListener("click", () => {
        void runIdeation(steerInput?.value ?? currentSteer, true);
      });
      slot.querySelector("[data-ideate-retry]")?.addEventListener("click", () => {
        void runIdeation(steerInput?.value ?? currentSteer, false);
      });
    };

    const runIdeation = async (steerText: string, excludeSeen = false): Promise<void> => {
      if (!slot || openSheet !== handle) return;
      const token = ++activeRunToken;
      currentSteer = steerText.trim();
      syncVibeSelection(currentSteer);
      slot.innerHTML = CairnSessionAdditionsClient.loadingHtml();

      const exclude = excludeSeen ? [...seenNames] : [];
      const body: Record<string, unknown> = { date: deps.state.logDate };
      if (currentSteer) body.constraints = currentSteer;
      if (exclude.length) body.exclude = exclude;

      await deps.runOp("session_additions", body, {
        path: "/session-additions",
        anchor: ".ideate-slot",
        caption: "session_additions",
        stream: true,
        guard: () => token !== activeRunToken || openSheet !== handle || !slot.isConnected,
        isFail: (result: unknown) => {
          const row = result && typeof result === "object" ? (result as Record<string, unknown>) : null;
          return !row || row.ok !== true || !Array.isArray(row.suggestions);
        },
        render: (result: unknown, job?: unknown) => {
          if (token !== activeRunToken || openSheet !== handle || !slot.isConnected) return;
          const row = result as { why?: string; suggestions?: SessionAdditionRow[] };
          const jobObj = job && typeof job === "object" ? (job as { id?: unknown }) : null;
          lastJobId = jobObj?.id != null && Number.isInteger(Number(jobObj.id)) ? Number(jobObj.id) : null;
          currentSuggestions = Array.isArray(row.suggestions) ? row.suggestions : [];
          for (const item of currentSuggestions) {
            if (item.exercise) seenNames.add(String(item.exercise));
          }
          slot.innerHTML = CairnSessionAdditionsClient.resultsHtml({
            why: row.why,
            suggestions: currentSuggestions,
            addedKeys,
            formatDur: deps.fmtDur,
          });
          wireResults();
        },
        onFail: () => {
          if (token !== activeRunToken || openSheet !== handle || !slot.isConnected) return;
          slot.innerHTML = CairnSessionAdditionsClient.failureHtml();
          wireResults();
        },
      });
    };

    for (const btn of vibeBtns) {
      btn.addEventListener("click", () => {
        const vibe = btn.dataset.ideateVibe || "";
        const next = currentSteer.toLowerCase() === vibe.toLowerCase() ? "" : vibe;
        if (steerInput) steerInput.value = next;
        void runIdeation(next, false);
      });
    }
    goBtn?.addEventListener("click", () => {
      void runIdeation(steerInput?.value || "", false);
    });
    steerInput?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void runIdeation(steerInput.value || "", false);
      }
    });

    void runIdeation("", false);
  }

  const CAIRN_SESSION_ADDITIONS_CONTROLLER = {
    open: openIdeateSheet,
  };

  Object.assign(globalThis, { CairnSessionAdditionsController: CAIRN_SESSION_ADDITIONS_CONTROLLER });
  if (typeof window !== "undefined") {
    Object.assign(window, { CairnSessionAdditionsController: CAIRN_SESSION_ADDITIONS_CONTROLLER });
  }
})();
