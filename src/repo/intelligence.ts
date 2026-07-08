// Day-intelligence barrel (K4). The former monolith was split into three focused
// modules; external code keeps importing everything from "./intelligence.js"
// (and, transitively, from "./repo.js") unchanged:
//   - plan-selection.ts  selectAdaptivePlanDay + the plan-day resolution helpers
//   - day-read.ts        dayRead / forwardLook / weekAheadPlan / the day-read cache
//                        / frequentFoods (the Brief's deterministic core)
//   - expenditure.ts     estimateExpenditure (adaptive nutrition / TDEE)
//
// prioritizeMarkers + the OPTIMAL_ZONES infrastructure live with the propagation
// engine (deriveDirectives consumes them); see src/repo/propagation.ts.
export * from "./day-read.js";
export * from "./expenditure.js";
export * from "./plan-selection.js";
