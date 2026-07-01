// @ts-check
// Progress History session data/model helpers.

function progressHistoryRows<T extends ProgressHistoryRecord = ProgressHistoryRecord>(value: unknown): T[] {
  return Array.isArray(value) ? value.filter((row): row is T => !!row && typeof row === "object") : [];
}

function progressHistoryString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function progressHistoryNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function progressHistoryNumOrNull(value: unknown): number | null {
  if (value === "" || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function progressHistorySessionSetScore(set: ProgressHistorySet): number {
  if (set.duration_sec != null) return Number(set.duration_sec) || 0;
  const weight = Number(set.weight);
  const reps = Number(set.reps);
  return weight > 0 && reps ? weight * (1 + reps / 30) : reps || 0;
}

function progressHistoryWeekday(date: unknown): string {
  const [year, month, day] = String(date || "").split("-").map(Number);
  return year ? new Date(year, month - 1, day).toLocaleDateString(undefined, { weekday: "long" }) : "";
}

function progressHistoryExerciseGroups(sets: ProgressHistorySet[] | null | undefined): ProgressHistoryExerciseGroup[] {
  const byExercise: Record<string, ProgressHistorySet[]> = {};
  for (const set of sets || []) {
    const exercise = String(set.exercise ?? "");
    (byExercise[exercise] ??= []).push(set);
  }
  return Object.entries(byExercise).map(([exercise, groupedSets]) => {
    let bestIndex = 0;
    groupedSets.forEach((set, setIndex) => {
      if (progressHistorySessionSetScore(set) > progressHistorySessionSetScore(groupedSets[bestIndex] ?? {})) {
        bestIndex = setIndex;
      }
    });
    return { exercise, sets: groupedSets, bestIndex };
  });
}

function progressHistorySessionCardModel(session: unknown): ProgressHistorySessionCardModel {
  const row = (session ?? {}) as HistorySession;
  return {
    row,
    weekday: progressHistoryWeekday(row.date),
    groups: progressHistoryExerciseGroups(row.sets),
    tonnage: setsTonnage(row.sets),
    setCount: (row.sets || []).length,
  };
}

function progressHistoryEditGroups(session: HistorySession): ProgressHistoryEditGroup[] {
  const sets = (session.sets || []).slice().sort((a, b) => progressHistoryNumber(a.id) - progressHistoryNumber(b.id));
  const byExercise: Record<string, ProgressHistorySet[]> = {};
  for (const set of sets) {
    const key = progressHistoryString(set.exercise) || "Exercise";
    (byExercise[key] ??= []).push(set);
  }
  return Object.entries(byExercise).map(([exercise, groupedSets]) => ({ exercise, sets: groupedSets }));
}

function progressHistorySummary(sessions: HistorySession[], now: Date = new Date()): ProgressHistorySummary {
  const ym = localISO(now).slice(0, 7);
  const iso30 = localISO(new Date(now.getTime() - 30 * 864e5));
  const monthSessions = sessions.filter((session) => progressHistoryString(session.date).slice(0, 7) === ym).length;
  const last30 = sessions.filter((session) => progressHistoryString(session.date) >= iso30);
  const tonnage30 = last30.reduce((total, session) => total + setsTonnage(session.sets), 0);
  const sets30 = last30.reduce((total, session) => total + (session.sets || []).length, 0);
  return {
    monthSessions,
    tonnage30,
    sets30,
    stats: [
      ["sessions this month", monthSessions],
      ["lb moved · 30d", Math.round(tonnage30), { k: true }],
      ["sets · 30d", sets30],
    ],
  };
}

const CAIRN_PROGRESS_HISTORY_MODEL = {
  rows: progressHistoryRows,
  string: progressHistoryString,
  number: progressHistoryNumber,
  numOrNull: progressHistoryNumOrNull,
  sessionSetScore: progressHistorySessionSetScore,
  weekday: progressHistoryWeekday,
  exerciseGroups: progressHistoryExerciseGroups,
  sessionCardModel: progressHistorySessionCardModel,
  editGroups: progressHistoryEditGroups,
  summary: progressHistorySummary,
};

Object.assign(globalThis, {
  CairnProgressHistoryModel: CAIRN_PROGRESS_HISTORY_MODEL,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnProgressHistoryModel: CAIRN_PROGRESS_HISTORY_MODEL,
  });
}
