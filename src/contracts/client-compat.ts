import type { DayRead, ExpenditureEstimate } from "../repo/intelligence.js";
import type { ArchivedChatSession, ChatSearchHit } from "../repo/chat.js";
import type { suggestSession } from "../coachOps.js";
import type { GuidelineEntry } from "../guidelines.js";
import type { CardioEffort, FeedRow, getCardioForDate } from "../repo/activities.js";
import type { CoachingFocus } from "../repo/coaching-focus.js";
import type { getInjuryImpacts } from "../repo/health.js";
import type { getDayIntake } from "../repo/nutrition.js";
import type { NextStep } from "../repo/next-step.js";
import type { DexaTargeting } from "../repo/dexa-targeting.js";
import type { MuscleGroupTrajectory, TestWeekDue } from "../repo/muscle-trajectory.js";
import type { ProgramBlock } from "../repo/program-blocks.js";
import type { getEnduranceGoal } from "../repo/profile.js";
import type { planDayProgression, ProgramAdjustment, ProgramBalance } from "../repo/progression.js";
import type { RunZones, WeeklyRunPlan } from "../repo/run-progression.js";
import type { EndurancePRs, getRunCompliance, RunCompliance } from "../repo/sessions.js";
import type { TodayAgenda } from "../repo/today-agenda.js";
import type {
  computeGoalCheck,
  getPlan,
  getProfile,
  getSettings,
  getOutcomeLearnings,
  learnedTimeline,
  listExercises,
  listHealthDocuments,
  listMemory,
} from "../repo.js";
import type {
  ClientChatSearchHit,
  ClientChatSessionSummary,
  ClientCoachingFocus,
  ClientDayIntake,
  ClientDayRead,
  ClientExpenditureEstimate,
  ClientExercise,
  ClientGoalCheck,
  ClientHealthDocument,
  ClientNextStep,
  ClientPlanDay,
  ClientPrescription,
  ClientProfile,
  ClientSettings,
  ClientTodayAgenda,
} from "./client.js";
import type {
  ClientDexaTargeting,
  ClientCardioEffort,
  ClientEnduranceGoal,
  ClientEndurancePRs,
  ClientGuidelineEntry,
  ClientInjuryImpactsResponse,
  ClientLearnedTimeline,
  ClientMemory,
  ClientMuscleGroupTrajectory,
  ClientOutcomeLearningsResponse,
  ClientProgramAdjustment,
  ClientProgramBalance,
  ClientProgramBlock,
  ClientRecentTrainingFeedRow,
  ClientRunCompliance,
  ClientRunZones,
  ClientSessionSuggestResponse,
  ClientTestWeekDue,
  ClientWeeklyRunPlan,
} from "./client-api.js";

type AssertAssignable<_Actual extends Expected, Expected> = true;

export type TodayAgendaMatchesClientContract = AssertAssignable<TodayAgenda, ClientTodayAgenda>;
export type CoachingFocusMatchesClientContract = AssertAssignable<CoachingFocus, ClientCoachingFocus>;
export type DayIntakeMatchesClientContract = AssertAssignable<ReturnType<typeof getDayIntake>, ClientDayIntake>;
export type DayReadMatchesClientContract = AssertAssignable<DayRead, ClientDayRead>;
export type NextStepMatchesClientContract = AssertAssignable<NextStep, ClientNextStep>;
export type ExpenditureMatchesClientContract = AssertAssignable<ExpenditureEstimate, ClientExpenditureEstimate>;
export type ProgramProgressionMatchesClientContract = AssertAssignable<
  ReturnType<typeof planDayProgression>,
  ClientPrescription[]
>;
export type ProgramBalanceMatchesClientContract = AssertAssignable<ProgramBalance, ClientProgramBalance>;
export type ProgramAdjustmentsMatchClientContract = AssertAssignable<ProgramAdjustment[], ClientProgramAdjustment[]>;
export type ProgramBlockMatchesClientContract = AssertAssignable<ProgramBlock, ClientProgramBlock>;
export type GuidelineEntryMatchesClientContract = AssertAssignable<GuidelineEntry, ClientGuidelineEntry>;
export type InjuryImpactsMatchClientContract = AssertAssignable<ReturnType<typeof getInjuryImpacts>, ClientInjuryImpactsResponse>;
export type RecentTrainingFeedMatchesClientContract = AssertAssignable<FeedRow, ClientRecentTrainingFeedRow>;
export type EndurancePrsMatchClientContract = AssertAssignable<EndurancePRs, ClientEndurancePRs>;
export type RunComplianceMatchesClientContract = AssertAssignable<RunCompliance, ClientRunCompliance>;
export type RunComplianceReturnMatchesClientContract = AssertAssignable<ReturnType<typeof getRunCompliance>, ClientRunCompliance>;
export type CardioEffortMatchesClientContract = AssertAssignable<CardioEffort, ClientCardioEffort>;
export type CardioEffortReturnMatchesClientContract = AssertAssignable<
  ReturnType<typeof getCardioForDate>,
  ClientCardioEffort[]
>;
export type EnduranceGoalMatchesClientContract = AssertAssignable<ReturnType<typeof getEnduranceGoal>, ClientEnduranceGoal | null>;
export type RunZonesMatchClientContract = AssertAssignable<RunZones, ClientRunZones>;
export type WeeklyRunPlanMatchesClientContract = AssertAssignable<WeeklyRunPlan, ClientWeeklyRunPlan>;
export type MuscleTrajectoryMatchesClientContract = AssertAssignable<
  MuscleGroupTrajectory,
  ClientMuscleGroupTrajectory
>;
export type TestWeekMatchesClientContract = AssertAssignable<TestWeekDue, ClientTestWeekDue>;
export type DexaTargetingMatchesClientContract = AssertAssignable<DexaTargeting, ClientDexaTargeting>;
export type SessionSuggestMatchesClientContract = AssertAssignable<
  Awaited<ReturnType<typeof suggestSession>>,
  ClientSessionSuggestResponse
>;
export type ChatSessionMatchesClientContract = AssertAssignable<ArchivedChatSession, ClientChatSessionSummary>;
export type ChatSearchHitMatchesClientContract = AssertAssignable<ChatSearchHit, ClientChatSearchHit>;
export type SettingsMatchesClientContract = AssertAssignable<ReturnType<typeof getSettings>, ClientSettings>;
export type ProfileMatchesClientContract = AssertAssignable<ReturnType<typeof getProfile>, ClientProfile>;
export type GoalCheckMatchesClientContract = AssertAssignable<ReturnType<typeof computeGoalCheck>, ClientGoalCheck>;
export type PlanMatchesClientContract = AssertAssignable<ReturnType<typeof getPlan>, ClientPlanDay[]>;
export type ExerciseMatchesClientContract = AssertAssignable<ReturnType<typeof listExercises>[number], ClientExercise>;
export type HealthDocumentMatchesClientContract = AssertAssignable<
  ReturnType<typeof listHealthDocuments>[number],
  ClientHealthDocument
>;
export type MemoryMatchesClientContract = AssertAssignable<ReturnType<typeof listMemory>[number], ClientMemory>;
export type LearnedTimelineMatchesClientContract = AssertAssignable<ReturnType<typeof learnedTimeline>, ClientLearnedTimeline>;
export type OutcomeLearningsMatchesClientContract = AssertAssignable<
  ReturnType<typeof getOutcomeLearnings>,
  ClientOutcomeLearningsResponse
>;
