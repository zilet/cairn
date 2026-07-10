// Stable scheduler-facing facade for the deterministic maturity loop. Keeping
// this leaf small avoids pulling domain implementation details into scheduler.ts.
export {
  evaluateExpectation,
  evaluateMatureExpectations,
  type EvaluationRunSummary,
} from "./domain/brain/evaluation-service.js";
