// The Train (with Horizon's goal line and Today's Fuel) and You -> Health screen
// fan-ins: the bodies other GET routes answer,
// computed in ONE request and keyed by the exact path the PWA asks for them with —
// the same contract as the Today and Horizon-race fan-ins (routes/today-responses.ts):
//   • each entry is produced by the SAME function its individual route calls, with the
//     same arguments, so the body is byte-identical to that route's answer;
//   • every individual route still stands, answering identically — the client keeps
//     asking for its own path and the request layer (api-core apiPrime) hands it the
//     fan-in's answer instead of a round trip;
//   • degradation is per entry: a reader that throws leaves its path out, and that one
//     read falls back to its own request.
// Neither fan-in is memoized: each read is computed on every open, exactly as the
// individual routes it replaces are, so it can never be staler than they would be.
import {
  evidenceWantedRead,
  getHealthSynthesisView,
  getRecoverySummary,
  healthFocus,
  listHealthDocuments,
  nextCheckupRead,
  parseVisitQuestionList,
  publicPriorityMarkers,
  symptomMarkerLinks,
  visitQuestionsRead,
} from "../domain/health/index.js";
import { getCoachingFocus, listVisibleInsights } from "../domain/brain/index.js";
import { listSupplements } from "../domain/person/index.js";
import {
  getActiveBlock,
  getEnduranceGoal,
  getEndurancePRs,
  getProgramState,
  getRecentSessions,
  getStrengthJourneys,
  getWeeklyStats,
  muscleGroupTrajectory,
  muscleLoadPayload,
  performanceStanding,
  planLookAhead,
  programAdjustments,
  programBalance,
  raceBuild,
  runComplianceRead,
  strengthJourneyRead,
  testWeekDue,
  trainingLoadBand,
  weeklyRunPlan,
} from "../domain/training/index.js";
import { dexaTargeting } from "../domain/health/index.js";
import { todayDateParam } from "../domain/today/index.js";
import { flexibleTrainingAgenda } from "../repo.js";
import { calibrationStatus, dueCalibrations } from "../repo/calibration.js";
import { forwardTimeline } from "../repo/forward-timeline.js";
import { journeyMilestones, journeyRead } from "../repo/journey.js";
import { getBodyMetricsSummary, normalizeUnit } from "../repo/body-metrics.js";
import { todayPath } from "../repo/today-path.js";
import { intakeBand } from "../repo/intake-band.js";
import { fuelIdeas } from "../repo/fuel-ideas.js";
import { listMealPlans } from "../domain/nutrition/index.js";
import { buildClinicalReportData, clinicalReportJson, parseReportSections } from "../report.js";
import { directivesResponse } from "./connected-brain.js";
import { nutritionDayResponse } from "./nutrition.js";
import { settingsResponse } from "./operator.js";
import { weeklyStatsResponse } from "./training-log.js";

export type ScreenResponses = Record<string, unknown>;

/** Put one path's body into the map, or leave the path out if its reader failed. */
function put(out: ScreenResponses, path: string, read: () => unknown): void {
  try {
    out[path] = read();
  } catch {
    /* this one read falls back to its own request */
  }
}

const q = (value: string) => encodeURIComponent(value);

/** The `?date=` a screen keys its dated reads with (the device's local day), else today. */
function screenDate(dateQuery: unknown): string {
  return todayDateParam(dateQuery);
}

export const TRAIN_HOME_VIEWS = ["overview", "program", "endurance", "goal", "fuel"] as const;
export type TrainHomeView = (typeof TRAIN_HOME_VIEWS)[number];

function trainView(value: unknown): TrainHomeView {
  return (TRAIN_HOME_VIEWS as readonly string[]).includes(String(value)) ? (value as TrainHomeView) : "overview";
}

/** The device's local hour Fuel's ideas are asked with, or null when it sent none (or a bad one). */
function screenHour(hourQuery: unknown): number | null {
  const hour = hourQuery != null ? Number(hourQuery) : Number.NaN;
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null;
}

/**
 * Train in one request: `view=overview` (the Train home's twelve reads), `program`
 * (Program's state, anchors, performance, block, adjustments, test week, trajectory,
 * DEXA targeting) or `endurance` (the Endurance screen's week). Two screens that grew
 * out of Train's reads ride the same fan-in: `goal` (Horizon -> Goal line: the journey
 * story, its milestones, the road-ahead timeline — the cards Train's overview used to
 * fold away — and the All-goals board's today-path read) and `fuel` (Today -> Fuel's
 * first paint: the day, the intake band, the ideas for `hour`, and the meal-plan
 * journal its week-menu card reads). Dated reads key on `date` exactly as the screen
 * spells them.
 */
export function trainHomeResponses(viewQuery: unknown, dateQuery: unknown, hourQuery?: unknown): ScreenResponses {
  const out: ScreenResponses = {};
  const date = screenDate(dateQuery);
  const view = trainView(viewQuery);
  if (view === "goal") {
    put(out, "/journey", () => journeyRead(undefined));
    put(out, "/journey/milestones", () => journeyMilestones(undefined));
    put(out, "/journey/timeline", () => forwardTimeline(undefined));
    put(out, `/today-path?date=${q(date)}`, () => todayPath(date));
    return out;
  }
  if (view === "fuel") {
    const hour = screenHour(hourQuery);
    put(out, `/nutrition/day?date=${q(date)}`, () => nutritionDayResponse(date));
    put(out, `/nutrition/intake-band?date=${q(date)}`, () => intakeBand(date));
    put(out, `/fuel/ideas?date=${q(date)}${hour == null ? "" : `&hour=${hour}`}`, () =>
      fuelIdeas(date, { hour: hour ?? undefined, exclude: [] })
    );
    put(out, "/mealplans?limit=12", () => listMealPlans(12));
    return out;
  }
  if (view !== "endurance") put(out, "/coaching-focus", () => getCoachingFocus());
  if (view === "overview") {
    put(out, "/stats", () => weeklyStatsResponse());
    put(out, "/program/balance", () => programBalance());
    put(out, "/muscle-trajectory", () => muscleGroupTrajectory(undefined));
    put(out, "/muscle-load", () => muscleLoadPayload(2));
    put(out, "/training-load", () => ({ band: trainingLoadBand() }));
    put(out, "/program/adjustments", () => programAdjustments());
    put(out, "/sessions?limit=3", () => getRecentSessions(3));
    put(out, "/journey", () => journeyRead(undefined));
    put(out, "/journey/milestones", () => journeyMilestones(undefined));
    put(out, "/journey/timeline", () => forwardTimeline(undefined));
    // No today's-lift line: Train's home no longer repeats the Brief's (one home per fact).
  } else if (view === "program") {
    put(out, "/program-state", () => getProgramState(undefined));
    put(out, "/strength-journeys", () => ({ journeys: getStrengthJourneys() }));
    put(out, "/strength-journey", () => strengthJourneyRead());
    put(out, "/performance", () => performanceStanding(undefined));
    put(out, "/program/blocks/active", () => getActiveBlock());
    put(out, "/program/adjustments", () => programAdjustments());
    put(out, "/test-week", () => testWeekDue(undefined));
    put(out, "/muscle-trajectory", () => muscleGroupTrajectory(undefined));
    put(out, "/dexa-targeting", () => dexaTargeting());
    put(out, "/plan/look-ahead", () => planLookAhead());
  } else {
    put(out, "/stats", () => weeklyStatsResponse());
    put(out, "/endurance-prs", () => getEndurancePRs(undefined));
    put(out, "/endurance-goal", () => getEnduranceGoal());
    put(out, "/run-compliance", () => runComplianceRead(undefined));
    put(out, "/settings", () => settingsResponse());
    put(out, "/run-plan", () => weeklyRunPlan(undefined));
    put(out, "/race-build", () => raceBuild(undefined, { describeRunning: true }));
    put(out, `/training-agenda?date=${q(date)}`, () => flexibleTrainingAgenda(date));
    put(out, "/program-state", () => getProgramState(undefined));
    put(out, `/calibration/status?date=${q(date)}`, () => {
      const status = calibrationStatus(date);
      return { status, due: dueCalibrations(date, { status }) };
    });
  }
  return out;
}

export const YOU_HEALTH_LEAVES = ["health", "records", "markers", "share"] as const;
export type YouHealthLeaf = (typeof YOU_HEALTH_LEAVES)[number];

function healthLeaf(value: unknown): YouHealthLeaf {
  return (YOU_HEALTH_LEAVES as readonly string[]).includes(String(value)) ? (value as YouHealthLeaf) : "health";
}

/**
 * You -> Health in one request: the nine reads behind the standing overview every
 * Health leaf warms, plus the leaf's own (`records`: the documents; `markers`: the
 * evidence-wanted line; `share`: the packet preview, symptom links, visit questions).
 * Every read here is health data, so the response is no-store (api.ts).
 */
export function youHealthResponses(leafQuery: unknown): ScreenResponses {
  const out: ScreenResponses = {};
  const leaf = healthLeaf(leafQuery);
  put(out, "/markers/priority", () => publicPriorityMarkers());
  put(out, "/coaching-focus", () => getCoachingFocus());
  put(out, "/body-metrics?unit=in", () => getBodyMetricsSummary(365, normalizeUnit("in")));
  put(out, "/health/synthesis", () => {
    const view = getHealthSynthesisView();
    return { synthesis: view.synthesis, focus: healthFocus(), stale: view.stale, stale_reason: view.stale_reason };
  });
  put(out, "/insights", () => listVisibleInsights(20));
  put(out, "/recovery", () => getRecoverySummary(14));
  put(out, "/supplements", () => listSupplements({ activeOnly: true }));
  put(out, "/directives", () => directivesResponse(false));
  put(out, "/health/next-checkup", () => nextCheckupRead({ refresh: false, asOf: undefined }));
  if (leaf === "records") put(out, "/health-docs", () => listHealthDocuments(50));
  if (leaf === "markers") put(out, "/health/evidence-wanted", () => evidenceWantedRead({ asOf: undefined }));
  if (leaf === "share") {
    put(out, "/health-report.json", () =>
      clinicalReportJson(
        buildClinicalReportData({ sections: parseReportSections(undefined), questions: parseVisitQuestionList(undefined) })
      )
    );
    put(out, "/symptom-links", () => ({ links: symptomMarkerLinks() }));
    put(out, "/health/visit-questions", () => visitQuestionsRead({ asOf: undefined, refresh: false }));
  }
  return out;
}
