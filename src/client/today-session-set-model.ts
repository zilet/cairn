// @ts-check
// Today session set model helpers: request payloads, response guards, and shared invalidation.

type TodaySessionSetPayloadResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; message: string; focus?: () => void };

type TodaySessionSetModelApi = {
  responseRecord(value: unknown): Record<string, unknown>;
  sessionPathId(session: Record<string, unknown>): string;
  cacheSessionTruth(deps: ClientTodaySessionControllerDeps, value: unknown): void;
  invalidateSessionTruth(deps: ClientTodaySessionControllerDeps): void;
  invalidateSetTruth(deps: ClientTodaySessionControllerDeps): void;
  logPayloadFromRow(row: HTMLElement, deps: ClientTodaySessionControllerDeps): TodaySessionSetPayloadResult;
};

(() => {
  function responseRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  }

  function sessionPathId(session: Record<string, unknown>): string {
    return encodeURIComponent(String(session.id ?? ""));
  }

  function sessionCacheKey(deps: ClientTodaySessionControllerDeps): string {
    return "today:session:" + deps.state.logDate;
  }

  function cacheSessionTruth(deps: ClientTodaySessionControllerDeps, value: unknown): void {
    const session = responseRecord(value);
    if (session.id == null) return;
    const cacheable = { ...session };
    delete cacheable.summary;
    deps.storeCached(sessionCacheKey(deps), cacheable);
  }

  function invalidateSessionTruth(deps: ClientTodaySessionControllerDeps): void {
    deps.invalidate(sessionCacheKey(deps));
    deps.invalidate("history:sessions");
  }

  function invalidateSetTruth(deps: ClientTodaySessionControllerDeps): void {
    deps.state.brief = null;
    deps.invalidate(sessionCacheKey(deps));
    deps.invalidate("stats");
    deps.invalidate("history:sessions");
    deps.invalidate("progress:volume");
    deps.invalidateTodayProgression();
  }

  function logPayloadFromRow(row: HTMLElement, deps: ClientTodaySessionControllerDeps): TodaySessionSetPayloadResult {
    const timed = row.dataset.mode === "timed";
    const exercise = decodeURIComponent(row.dataset.ex || "");
    const dayNumber = Number(row.dataset.day);
    if (timed) {
      const durEl = row.querySelector<HTMLInputElement>(".in-dur");
      const sec = deps.parseDur(durEl?.value || "");
      if (sec == null || sec <= 0) {
        return { ok: false, message: "Time? e.g. 1:30 or 90", focus: () => durEl?.focus() };
      }
      if (durEl) durEl.value = deps.fmtDur(sec);
      return {
        ok: true,
        body: {
          exercise,
          weight: null,
          reps: null,
          rir: null,
          duration_sec: sec,
          exercise_mode: "timed",
          day_number: dayNumber,
          date: deps.state.logDate,
        },
      };
    }

    const wEl = row.querySelector<HTMLInputElement>(".in-w");
    const rEl = row.querySelector<HTMLInputElement>(".in-r");
    const rirEl = row.querySelector<HTMLInputElement>(".in-rir");
    const weight = wEl?.value || "";
    const reps = rEl?.value || "";
    const rir = rirEl?.value || "";
    if (reps === "") {
      return { ok: false, message: "Reps?", focus: () => rEl?.focus() };
    }
    return {
      ok: true,
      body: {
        exercise,
        weight: weight === "" ? null : Number(weight),
        reps: Number(reps),
        rir: rir === "" ? null : Number(rir),
        day_number: dayNumber,
        date: deps.state.logDate,
      },
    };
  }

  const CAIRN_TODAY_SESSION_SET_MODEL: TodaySessionSetModelApi = {
    responseRecord,
    sessionPathId,
    cacheSessionTruth,
    invalidateSessionTruth,
    invalidateSetTruth,
    logPayloadFromRow,
  };

  Object.assign(globalThis, { CairnTodaySessionSetModel: CAIRN_TODAY_SESSION_SET_MODEL });

  if (typeof window !== "undefined") {
    window.CairnTodaySessionSetModel = CAIRN_TODAY_SESSION_SET_MODEL;
  }
})();
