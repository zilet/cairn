import type { DayRead, ExpenditureEstimate } from "../repo/intelligence.js";
import type { ArchivedChatSession, ChatSearchHit } from "../repo/chat.js";
import type { getDayIntake } from "../repo/nutrition.js";
import type { NextStep } from "../repo/next-step.js";
import type { TodayAgenda } from "../repo/today-agenda.js";
import type {
  ClientChatSearchHit,
  ClientChatSessionSummary,
  ClientDayIntake,
  ClientDayRead,
  ClientExpenditureEstimate,
  ClientNextStep,
  ClientTodayAgenda,
} from "./client.js";

type AssertAssignable<_Actual extends Expected, Expected> = true;

export type TodayAgendaMatchesClientContract = AssertAssignable<TodayAgenda, ClientTodayAgenda>;
export type DayIntakeMatchesClientContract = AssertAssignable<ReturnType<typeof getDayIntake>, ClientDayIntake>;
export type DayReadMatchesClientContract = AssertAssignable<DayRead, ClientDayRead>;
export type NextStepMatchesClientContract = AssertAssignable<NextStep, ClientNextStep>;
export type ExpenditureMatchesClientContract = AssertAssignable<ExpenditureEstimate, ClientExpenditureEstimate>;
export type ChatSessionMatchesClientContract = AssertAssignable<ArchivedChatSession, ClientChatSessionSummary>;
export type ChatSearchHitMatchesClientContract = AssertAssignable<ChatSearchHit, ClientChatSearchHit>;
