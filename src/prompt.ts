// Barrel: prompt.ts was split into per-domain modules under src/prompt/.
// External code imports from "./prompt.js" by name; every public symbol is
// re-exported here so those imports keep working unchanged. Pure structural
// relocation — see the individual modules for the prompt builders.
export * from "./prompt/shared.js";
export * from "./prompt/coach.js";
export * from "./prompt/chat.js";
export * from "./prompt/enrich.js";
export * from "./prompt/health.js";
export * from "./prompt/imaging.js";
export * from "./prompt/nutrition.js";
export * from "./prompt/day.js";
export * from "./prompt/program.js";
export * from "./prompt/verify.js";
