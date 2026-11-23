// The ideas for a day with the day's carbohydrate room read in. fuel-guides.ts imports
// fuel-ideas.ts (the health leans), so fuel-ideas cannot import the guides back: this thin
// module reads the carbs guide's room and hands it over. Routes and MCP call this one.

import type { ClientFuelIdeas } from "../contracts/fuel.js";
import { dayFuelGuides } from "./fuel-guides.js";
import type { FuelGuides } from "./fuel-guides.js";
import { fuelIdeas } from "./fuel-ideas.js";
import type { FuelIdeasOptions } from "./fuel-ideas.js";
import { localDateISO } from "./shared.js";

/** Grams of carbs the day's guide still has room for; null when unknown or none left to place. */
export function dayCarbsRoomG(date: string): number | null {
  try {
    return carbsRoomFromGuides(date, dayFuelGuides(date, { today: localDateISO(), gramsOnly: true }));
  } catch {
    return null;
  }
}

/**
 * The carbs room off `date`'s guides as already read — the day route's own (its carbs row
 * is the grams-only row with its explanation added), so a screen that reads the day and
 * the ideas together derives the guides once.
 */
export function carbsRoomFromGuides(date: string, guides: Pick<FuelGuides, "guides" | "day_state">): number | null {
  try {
    const carbs = guides.guides.find((g) => g.key === "carbs");
    let high = carbs?.room?.high_g;
    // Before the first log of the day a guide has no `room` yet (nothing eaten to subtract):
    // the whole day's carbs are still open. Carbs unknown on a day with logs stays null.
    if (high == null && carbs?.eaten_g == null && guides.day_state === "nothing_logged" && date >= localDateISO())
      high = carbs?.high_g;
    return high != null && Number.isFinite(high) ? Math.max(0, Math.round(high)) : null;
  } catch {
    return null;
  }
}

export function fuelIdeasForDay(date: string = localDateISO(), opts: FuelIdeasOptions = {}): ClientFuelIdeas {
  return fuelIdeas(date, { ...opts, carbsRoomG: opts.carbsRoomG !== undefined ? opts.carbsRoomG : dayCarbsRoomG(date) });
}

/**
 * The ideas' carbs room from a day read a fan-in already holds (`nutritionDayRead`'s body),
 * as a `fuelIdeasForDay` option; empty — the ideas read the guides themselves — when the
 * day read failed or carried no guides.
 */
export function dayCarbsRoom(
  date: string,
  day: { guides?: FuelGuides | null } | null
): Pick<FuelIdeasOptions, "carbsRoomG"> {
  return day?.guides ? { carbsRoomG: carbsRoomFromGuides(date, day.guides) } : {};
}
