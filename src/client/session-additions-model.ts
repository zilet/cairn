// @ts-check
// Pure mid-session ideation model helpers: vibe presets, live session summary,
// card deduplication keys, prescription formatting, and prefill derivation.

type SessionAdditionSuggestion = {
  exercise?: unknown;
  mode?: unknown;
  sets?: unknown;
  rep_low?: unknown;
  rep_high?: unknown;
  target_weight?: unknown;
  target_seconds?: unknown;
  load_basis?: unknown;
  muscle_group?: unknown;
  fit?: unknown;
  note?: unknown;
  input?: unknown;
  last_set?: Record<string, unknown> | null;
};

(() => {
  const IDEATE_VIBES: readonly string[] = [
    "feeling strong",
    "10 min finisher",
    "arms",
    "core",
    "light on joints",
    "dumbbells only",
  ];

  function exerciseKey(raw: unknown): string {
    return String(raw ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function collectCurrentExerciseKeys(root: ParentNode | null | undefined): Set<string> {
    const keys = new Set<string>();
    if (!root || typeof root.querySelectorAll !== "function") return keys;
    root.querySelectorAll<HTMLElement>(".ex[data-card]").forEach((el) => {
      const key = exerciseKey(el.dataset.card);
      if (key) keys.add(key);
    });
    return keys;
  }

  function sessionContextSummary(root: ParentNode | null | undefined): string {
    if (!root || typeof root.querySelectorAll !== "function") {
      return "Pick something that fits where your session is right now.";
    }
    const cards = [...root.querySelectorAll<HTMLElement>(".ex[data-card]")];
    const loggedSets = root.querySelectorAll(".ex .logged .chip").length;
    const titleRaw = root.querySelector(".session-title")?.textContent?.trim() || "";
    const title = titleRaw.split("·")[0]?.trim() || "";
    if (!loggedSets && !cards.length) {
      return "Opens a few complementary lifts you can add in one tap.";
    }
    const setWord = loggedSets === 1 ? "1 set logged" : `${loggedSets} sets logged`;
    if (loggedSets > 0 && title) {
      return `${setWord} on ${title} — steer if you want, or pick what fits.`;
    }
    if (loggedSets > 0) {
      return `${setWord} so far — steer if you want, or pick what fits.`;
    }
    return `${cards.length} exercise${cards.length === 1 ? "" : "s"} on deck — steer if you want, or pick what fits.`;
  }

  function loadSuffix(item: SessionAdditionSuggestion): string {
    const n = item.target_weight == null || item.target_weight === "" ? null : Number(item.target_weight);
    if (n != null && Number.isFinite(n)) {
      if (n < 0) return ` · ${Math.abs(n)} assist`;
      if (n > 0) return ` · ${n} lb`;
    }
    if (item.load_basis === "bodyweight") return " · BW";
    return "";
  }

  function rxSummary(item: SessionAdditionSuggestion, formatDur?: (seconds: number) => string): string {
    const timed = item.mode === "timed" || item.target_seconds != null;
    const sets = item.sets ?? 3;
    if (timed) {
      const sec = Number(item.target_seconds);
      const dur = Number.isFinite(sec) && sec > 0
        ? (typeof formatDur === "function" ? formatDur(sec) : typeof fmtDur === "function" ? fmtDur(sec) : `${Math.round(sec)}s`)
        : "time";
      const load = item.target_weight == null ? 0 : Number(item.target_weight);
      return `${sets} × ${dur}${Number.isFinite(load) && load !== 0 ? loadSuffix(item) : ""}`;
    }
    const lo = item.rep_low;
    const hi = item.rep_high;
    const reps = lo != null && hi != null ? (lo === hi ? `${lo}` : `${lo}–${hi}`) : (lo ?? hi ?? "");
    return `${sets}${reps ? ` × ${reps}` : ""}${loadSuffix(item)}`;
  }

  function prefillFromSuggestion(item: SessionAdditionSuggestion): Record<string, unknown> {
    const last = item.last_set && typeof item.last_set === "object" ? item.last_set : null;
    const timed = item.mode === "timed" || item.target_seconds != null;
    return {
      weight: item.target_weight ?? last?.weight ?? null,
      reps: timed ? null : (item.rep_low ?? last?.reps ?? null),
      rir: null,
      duration_sec: timed ? (item.target_seconds ?? last?.duration_sec ?? null) : null,
    };
  }

  const CAIRN_SESSION_ADDITIONS_MODEL = {
    IDEATE_VIBES,
    exerciseKey,
    collectCurrentExerciseKeys,
    sessionContextSummary,
    rxSummary,
    prefillFromSuggestion,
  };

  Object.assign(globalThis, { CairnSessionAdditionsModel: CAIRN_SESSION_ADDITIONS_MODEL });
  if (typeof window !== "undefined") {
    Object.assign(window, { CairnSessionAdditionsModel: CAIRN_SESSION_ADDITIONS_MODEL });
  }
})();
