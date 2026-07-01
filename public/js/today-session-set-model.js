(() => {
// @ts-check
// Today session set model helpers: request payloads, response guards, and shared invalidation.
(() => {
    function responseRecord(value) {
        return value && typeof value === "object" ? value : {};
    }
    function sessionPathId(session) {
        return encodeURIComponent(String(session.id ?? ""));
    }
    function invalidateSessionTruth(deps) {
        deps.invalidate("today:session:" + deps.state.logDate);
        deps.invalidate("history:sessions");
    }
    function invalidateSetTruth(deps) {
        deps.state.brief = null;
        deps.invalidate("today:session:" + deps.state.logDate);
        deps.invalidate("stats");
        deps.invalidate("history:sessions");
        deps.invalidate("progress:volume");
        deps.invalidateTodayProgression();
    }
    function logPayloadFromRow(row, deps) {
        const timed = row.dataset.mode === "timed";
        const exercise = decodeURIComponent(row.dataset.ex || "");
        const dayNumber = Number(row.dataset.day);
        if (timed) {
            const durEl = row.querySelector(".in-dur");
            const sec = deps.parseDur(durEl?.value || "");
            if (sec == null || sec <= 0) {
                return { ok: false, message: "Time? e.g. 1:30 or 90", focus: () => durEl?.focus() };
            }
            if (durEl)
                durEl.value = deps.fmtDur(sec);
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
        const wEl = row.querySelector(".in-w");
        const rEl = row.querySelector(".in-r");
        const rirEl = row.querySelector(".in-rir");
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
    const CAIRN_TODAY_SESSION_SET_MODEL = {
        responseRecord,
        sessionPathId,
        invalidateSessionTruth,
        invalidateSetTruth,
        logPayloadFromRow,
    };
    Object.assign(globalThis, { CairnTodaySessionSetModel: CAIRN_TODAY_SESSION_SET_MODEL });
    if (typeof window !== "undefined") {
        window.CairnTodaySessionSetModel = CAIRN_TODAY_SESSION_SET_MODEL;
    }
})();
})();
