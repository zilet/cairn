import { currentLiftCapacities } from "../../repo/performance.js";
import { getStrengthJourney, suggestAnchorObjective } from "../../repo/strength-objectives.js";

// The read GET /strength-journey answers with: the athlete's one explicit anchor
// objective, plus — ONLY in the truly-empty state — a reachable anchor suggestion
// computed from the standards capacities (an existing journey pays nothing for it).
// Extracted so the Today aggregate can carry the same payload the standalone route
// returns instead of re-deriving a second, drifting version of it.
export function strengthJourneyRead(): ReturnType<typeof getStrengthJourney> {
  const journey = getStrengthJourney();
  if (!journey.available) journey.suggestion = suggestAnchorObjective({ capacities: currentLiftCapacities() });
  return journey;
}
