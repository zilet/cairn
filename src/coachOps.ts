// Shared coaching orchestration: the "run agent → validate parsed JSON shape →
// persist as draft/insight/review → return ok/ok:false" logic that src/api.ts
// (REST) and src/mcp.ts (MCP) both adapt. Per the project's architecture rule,
// this business logic lives in ONE place; the two protocol surfaces are thin
// wrappers that only translate the returned OBJECT into an HTTP response or an
// MCP asText payload. Each function here returns the plain result object — the
// designed { ok:true, ... } / { ok:false, error, tried } shape — never an HTTP
// response and never an MCP wrapper.
//
// The ops themselves live under src/coachOps/, grouped by domain. This file is a
// pure re-export barrel so every existing `from "./coachOps.js"` import — routes,
// MCP tools, the scheduler, the tests — keeps working unchanged.
export * from "./coachOps/shared.js";
export * from "./coachOps/training.js";
export * from "./coachOps/nutrition.js";
export * from "./coachOps/health.js";
export * from "./coachOps/memory.js";
