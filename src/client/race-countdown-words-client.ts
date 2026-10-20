// @ts-check
// The race countdown's one wording on the client (split out of progress-run-plan-client.ts
// to keep that module under its size ratchet). Journey bundle, loaded before the run plan.

// The countdown's ONE wording is the server's (raceCountdown, src/repo/race-build.ts):
// `race.countdown.words` for the head, each rung's `countdown_words` for its row — counted
// in DAYS, so a race 12 days off reads "12 days out", never the ladder's calendar-week
// "1 wk out". `weeks_to_race` stays the rung's kind count only. Fields are read
// defensively: a read from before them falls back to the same day count.
type RaceBuildRace = NonNullable<import("../contracts/client-api.js").ClientRaceBuild["race"]>;
type RaceBuildWeek = import("../contracts/client-api.js").ClientRaceBuildWeek;

/** The server's rule, for a read that carries only the day count (`raceDate` places race week). */
function raceCountdownFallback(days: number, raceDate?: unknown): string {
  if (days <= 0) return "Race day";
  if (days === 1) return "Tomorrow";
  // Race week: the read date sits in the race's own Mon–Sun week.
  const iso = String(raceDate || "").slice(0, 10);
  const raceDow = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? ((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7) + 1 : 0;
  if (raceDow && days <= raceDow - 1) return "Race week";
  if (days <= 13) return `${days} days out`;
  return `${Math.floor(days / 7)} wks out`;
}

function raceCountdownWords(race: RaceBuildRace | null | undefined): string {
  const said = typeof race?.countdown?.words === "string" ? race.countdown.words.trim() : "";
  if (said) return said;
  const days = Number(race?.days_to_race);
  if (race?.days_to_race != null && Number.isFinite(days)) return raceCountdownFallback(Math.round(days), race.date);
  // Only the ladder's week count: say no more than it does.
  const weeks = Number(race?.weeks_to_race);
  return Number.isFinite(weeks) ? (weeks <= 0 ? "Race week" : `${Math.round(weeks)} wks out`) : "";
}

function raceWeekOutWords(week: RaceBuildWeek): string {
  const said = typeof week.countdown_words === "string" ? week.countdown_words.trim() : "";
  if (said) return said;
  return week.kind === "race" || Number(week.weeks_to_race) === 0 ? "Race week" : "";
}

// The build wraps each module; the run plan reaches these as globals.
Object.assign(globalThis, { raceCountdownFallback, raceCountdownWords, raceWeekOutWords });
