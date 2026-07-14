// @ts-check
// Today session set model helpers: request payloads, response guards, and shared invalidation.

type TodaySessionSetPayloadResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; message: string; focus?: () => void };
type TodaySessionIdState = ClientTodaySessionControllerDeps["state"] & {
  sessionIdsByDate?: Record<string, string>;
};

// The last logged set for an exercise, as returned by GET /last-set — used for the
// prefill AND for the "beat this" quiet target line.
type TodayLastSetData = {
  weight?: unknown;
  reps?: unknown;
  duration_sec?: unknown;
  date?: unknown;
} | null | undefined;

type TodaySessionSetModelApi = {
  responseRecord(value: unknown): Record<string, unknown>;
  rememberMutationSessionId(
    deps: Pick<ClientTodaySessionControllerDeps, "state">,
    date: string,
    value: unknown,
  ): string | null;
  rememberFullSessionId(
    deps: Pick<ClientTodaySessionControllerDeps, "state">,
    date: string,
    value: unknown,
  ): string | null;
  sessionPathId(
    session: Record<string, unknown>,
    deps: Pick<ClientTodaySessionControllerDeps, "state">,
    date: string,
  ): string | null;
  cacheSessionTruth(deps: ClientTodaySessionControllerDeps, date: string, value: unknown): boolean;
  invalidateSessionTruth(deps: ClientTodaySessionControllerDeps): void;
  invalidateSetTruth(deps: ClientTodaySessionControllerDeps): void;
  logPayloadFromRow(row: HTMLElement, deps: ClientTodaySessionControllerDeps): TodaySessionSetPayloadResult;
  lastSetScore(weight: unknown, reps: unknown, durationSec: unknown): number;
  lastSetLineText(lastSet: TodayLastSetData, deps: ClientTodaySessionControllerDeps): string;
  currentSetScoreFromRow(row: HTMLElement, deps: ClientTodaySessionControllerDeps): number | null;
  wireLastSetLine(row: Element | null | undefined, lastSet: TodayLastSetData, deps: ClientTodaySessionControllerDeps): void;
};

(() => {
  function responseRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  }

  function validSessionId(value: unknown): string | null {
    const candidate = String(value ?? "").trim();
    return /^[1-9]\d*$/.test(candidate) ? candidate : null;
  }

  function responseMatchesDate(value: Record<string, unknown>, date: string): boolean {
    return value.date == null || String(value.date) === date;
  }

  function rememberId(
    deps: Pick<ClientTodaySessionControllerDeps, "state">,
    date: string,
    idValue: unknown,
  ): string | null {
    const id = validSessionId(idValue);
    if (!id) return null;
    const state = deps.state as TodaySessionIdState;
    (state.sessionIdsByDate ??= {})[date] = id;
    return id;
  }

  // Mutation responses use `session_id`; their `id` is another entity (for a
  // set-log response it is the logged-set ID). Never infer one from the other.
  function rememberMutationSessionId(
    deps: Pick<ClientTodaySessionControllerDeps, "state">,
    date: string,
    value: unknown,
  ): string | null {
    const result = responseRecord(value);
    if (!responseMatchesDate(result, date)) return null;
    return rememberId(deps, date, result.session_id);
  }

  // Full GET/finish/reopen session rows use `id`. Validate their date when the
  // server includes one before the ID can become date-scoped client truth.
  function rememberFullSessionId(
    deps: Pick<ClientTodaySessionControllerDeps, "state">,
    date: string,
    value: unknown,
  ): string | null {
    const session = responseRecord(value);
    if (!responseMatchesDate(session, date)) return null;
    return rememberId(deps, date, session.id);
  }

  function sessionPathId(
    session: Record<string, unknown>,
    deps: Pick<ClientTodaySessionControllerDeps, "state">,
    date: string,
  ): string | null {
    const direct = responseMatchesDate(session, date) ? validSessionId(session.id) : null;
    const state = deps.state as TodaySessionIdState;
    const remembered = validSessionId(state.sessionIdsByDate?.[date]);
    const id = direct ?? remembered;
    return id ? encodeURIComponent(id) : null;
  }

  function sessionCacheKey(date: string): string {
    return "today:session:" + date;
  }

  function cacheSessionTruth(deps: ClientTodaySessionControllerDeps, date: string, value: unknown): boolean {
    const session = responseRecord(value);
    if (!rememberFullSessionId(deps, date, session)) return false;
    const cacheable = { ...session };
    delete cacheable.summary;
    deps.storeCached(sessionCacheKey(date), cacheable);
    return true;
  }

  function invalidateSessionTruth(deps: ClientTodaySessionControllerDeps): void {
    deps.invalidate(sessionCacheKey(deps.state.logDate));
    deps.invalidate("history:sessions");
  }

  function invalidateSetTruth(deps: ClientTodaySessionControllerDeps): void {
    deps.state.brief = null;
    deps.invalidate(sessionCacheKey(deps.state.logDate));
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

  // Score used to compare "this set" against "last time" for the quiet beat-this nudge.
  // Timed: raw duration. Loaded (weight>0): Epley est-1RM. Bodyweight/assisted (weight
  // null or negative): reps alone — a signed assist weight can't be folded into Epley
  // without inverting its sign, so this mirrors progressHistorySessionSetScore's
  // established convention for the same weight-encoding edge case.
  function lastSetScore(weight: unknown, reps: unknown, durationSec: unknown): number {
    if (durationSec != null) return Number(durationSec) || 0;
    const w = Number(weight);
    const r = Number(reps);
    return w > 0 && r ? w * (1 + r / 30) : r || 0;
  }

  function lastSetLineText(lastSet: TodayLastSetData, deps: ClientTodaySessionControllerDeps): string {
    const data = responseRecord(lastSet);
    let base = "";
    if (data.duration_sec != null) {
      base = `Last time: ${deps.fmtDur(Number(data.duration_sec))}`;
    } else if (data.reps != null) {
      const reps = Number(data.reps);
      if (!Number.isFinite(reps)) return "";
      if (data.weight == null) {
        base = `Last time: ${reps} reps`;
      } else {
        const weight = Number(data.weight);
        if (!Number.isFinite(weight)) return "";
        base = weight < 0 ? `Last time: ${weight} lb assist × ${reps}` : `Last time: ${weight} × ${reps}`;
      }
    } else {
      return "";
    }
    const dateIso = typeof data.date === "string" ? data.date : "";
    return dateIso ? `${base} · ${humanDate(dateIso)}` : base;
  }

  function currentSetScoreFromRow(row: HTMLElement, deps: ClientTodaySessionControllerDeps): number | null {
    if (row.dataset.mode === "timed") {
      const durEl = row.querySelector<HTMLInputElement>(".in-dur");
      const sec = deps.parseDur(durEl?.value || "");
      return sec != null && sec > 0 ? lastSetScore(null, null, sec) : null;
    }
    const rEl = row.querySelector<HTMLInputElement>(".in-r");
    const repsRaw = rEl?.value ?? "";
    if (repsRaw === "") return null;
    const reps = Number(repsRaw);
    if (!Number.isFinite(reps) || reps <= 0) return null;
    const wEl = row.querySelector<HTMLInputElement>(".in-w");
    const weightRaw = wEl?.value ?? "";
    const weight = weightRaw === "" ? null : Number(weightRaw);
    return lastSetScore(weight, reps, null);
  }

  // Live "beat this" affirmation: wires an input listener on the row's value fields
  // (mirrors wireLogRow's per-row idempotent wiring in today-session-set-actions.ts) that
  // swaps the quiet last-time line for a sage affirmation once the athlete's typed set
  // out-scores it, and swaps back the moment it no longer does. Looks up the line via the
  // shared .ex card ancestor (not DOM order) so it works regardless of where the caller
  // places the .ex-lastset element relative to .logrow.
  function wireLastSetLine(
    row: Element | null | undefined,
    lastSet: TodayLastSetData,
    deps: ClientTodaySessionControllerDeps,
  ): void {
    if (!(row instanceof HTMLElement) || !lastSet) return;
    const lineEl = row.closest(".ex")?.querySelector<HTMLElement>(".ex-lastset");
    if (!lineEl || lineEl.dataset.wired) return;
    lineEl.dataset.wired = "1";
    const data = responseRecord(lastSet);
    const baseline = lastSetScore(data.weight, data.reps, data.duration_sec);
    const baseText = lineEl.textContent || "";
    const timed = row.dataset.mode === "timed";
    const inputs = timed
      ? [row.querySelector<HTMLInputElement>(".in-dur")]
      : [row.querySelector<HTMLInputElement>(".in-w"), row.querySelector<HTMLInputElement>(".in-r")];
    const update = () => {
      const current = currentSetScoreFromRow(row, deps);
      const beats = current != null && current > baseline;
      lineEl.textContent = beats ? "That beats last time" : baseText;
      lineEl.classList.toggle("ex-lastset-beat", beats);
    };
    for (const el of inputs) {
      if (el) el.addEventListener("input", update);
    }
  }

  const CAIRN_TODAY_SESSION_SET_MODEL: TodaySessionSetModelApi = {
    responseRecord,
    rememberMutationSessionId,
    rememberFullSessionId,
    sessionPathId,
    cacheSessionTruth,
    invalidateSessionTruth,
    invalidateSetTruth,
    logPayloadFromRow,
    lastSetScore,
    lastSetLineText,
    currentSetScoreFromRow,
    wireLastSetLine,
  };

  Object.assign(globalThis, { CairnTodaySessionSetModel: CAIRN_TODAY_SESSION_SET_MODEL });

  if (typeof window !== "undefined") {
    window.CairnTodaySessionSetModel = CAIRN_TODAY_SESSION_SET_MODEL;
  }
})();
