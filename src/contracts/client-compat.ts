import type { DayRead, ExpenditureEstimate } from "../repo/intelligence.js";
import type { ArchivedChatSession, ChatSearchHit } from "../repo/chat.js";
import type { suggestSession } from "../coachOps.js";
import type { CoachingFocus } from "../repo/coaching-focus.js";
import type { getDayIntake } from "../repo/nutrition.js";
import type { NextStep } from "../repo/next-step.js";
import type { planDayProgression } from "../repo/progression.js";
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
import type { ClientLearnedTimeline, ClientMemory, ClientOutcomeLearningsResponse, ClientSessionSuggestResponse } from "./client-api.js";

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
