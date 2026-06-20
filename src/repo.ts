// Barrel: repo.ts was split into cohesive domain modules under src/repo/.
// External code imports from "./repo.js" by name; every public symbol is
// re-exported here so those imports keep working unchanged. The split is a pure,
// behavior-preserving relocation — see the individual modules for the logic.
export * from "./repo/exercises.js";
export * from "./repo/plan.js";
export * from "./repo/training-read.js";
export * from "./repo/sessions.js";
export * from "./repo/profile.js";
export * from "./repo/activities.js";
export * from "./repo/memory.js";
export * from "./repo/nutrition.js";
export * from "./repo/chat.js";
export * from "./repo/settings.js";
export * from "./repo/art-ledger.js";
export * from "./repo/agent-telemetry.js";
export * from "./repo/app-state.js";
export * from "./repo/lab-units.js";
export * from "./repo/health.js";
export * from "./repo/coach.js";
export * from "./repo/propagation.js";
export * from "./repo/evidence.js";
export * from "./repo/intelligence.js";
export * from "./repo/program-state.js";
export * from "./repo/program-blocks.js";
export * from "./repo/exercise-variations.js";
