// The week read's small shared words: the pages a thread, a mark or a stone opens, and a
// lead lift's short name inside a sentence. Split out so the road's ground
// (journey-ground.ts) and the week read share them without importing each other.

/** The pages a thread or a milestone opens (src/contracts/client-routes.ts canonical URLs). */
export const WEEK_HREFS = {
  race: "/app/horizon/race",
  goal: "/app/horizon/goal",
  program: "/app/train/program",
  checkup: "/app/you/checkup",
  markers: "/app/you/markers",
  body: "/app/you/body",
  behind: (id: number) => `/app/horizon/behind?id=${id}`,
  day: (date: string) => `/app/day/${date}`,
} as const;

/** "the bench", "the press": a lead lift inside a sentence. */
export function liftShortName(exercise: string): string {
  const n = String(exercise ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (/overhead|military|\bohp\b|shoulder press/.test(n)) return "the press";
  if (/bench/.test(n)) return "the bench";
  if (/deadlift/.test(n) && !/romanian|\brdl\b|stiff/.test(n)) return "the deadlift";
  if (/squat/.test(n)) return "the squat";
  if (/\brow\b/.test(n)) return "the row";
  if (/pull-?up|chin-?up/.test(n)) return "the pull-up";
  return `the ${n.replace(/^(barbell|dumbbell|db|bb)\s+/, "")}`;
}
