// @ts-check
// The write -> cache-invalidation TABLES (data only; the engine that applies them is
// write-invalidation-client.ts, which documents the target grammar). Split out so the
// engine stays small: a new chat action type adds a row HERE, and
// test/clientWriteInvalidation.test.js holds this table complete against the server's
// own CHAT_ACTION_TYPES.

type WriteInvalidationTargetsApi = {
  CHAT_ACTION_TARGETS: Readonly<Record<string, readonly string[]>>;
  WRITE_TARGETS: Readonly<Record<string, readonly string[]>>;
};

{
  // Surfaces that read the whole day: the Today aggregate, the stones, Horizon's
  // last-known race reads (offline-state-client.ts), the Brief.
  const DAY = ["today:aggregate:", "today:stones:", "horizon:", "@brief"] as const;
  // Everything a logged training session feeds.
  const TRAINING = [
    "stats",
    "history:sessions",
    "progress:volume",
    "progress:calendar",
    "progress:exercises",
    "progress:program",
    "program:progression:",
    "last-set:",
    "@train",
  ] as const;
  // Everything a plan change feeds.
  const PLAN = [
    "plan",
    "plan:",
    "exercises",
    "exercises:names",
    "program:progression:",
    "progress:program",
    "today:daily-session:",
    "brain:changes",
    "health:asks",
    "@plan",
    "@train",
    "@endurance",
  ] as const;
  const FOOD = ["food:day:", "fuel:band:", "fuel:ideas:", "progress:intake", "progress:energy", "stats"] as const;
  const BODY = ["progress:weight", "progress:energy", "stats", "profile", "me:goal", "fuel:band:"] as const;
  const GOAL = ["profile", "me:goal", "settings:screen", "settings:drive", "@endurance", "@train"] as const;
  const HEALTH = ["health:", "markers:", "recovery:"] as const;
  const LIFE = ["me:life", "me:life:"] as const;

  const t = (...groups: ReadonlyArray<readonly string[]>): readonly string[] =>
    Object.freeze([...new Set(groups.flat())]);

  // Every chat action type the server can apply (src/chatActions.ts
  // CHAT_ACTION_TYPES). A new action type without a row here fails the test.
  const CHAT_ACTION_TARGETS: Readonly<Record<string, readonly string[]>> = Object.freeze({
    log_activity: t(DAY, TRAINING, ["today:session:", "@endurance", "progress:energy", "fuel:band:"]),
    log_set: t(DAY, TRAINING, ["today:session:", "exercises", "exercises:names"]),
    set_profile: t(DAY, GOAL, BODY),
    set_training_intent: t(DAY, GOAL, PLAN),
    set_endurance_goal: t(DAY, GOAL, ["@endurance"]),
    set_endurance_schedule: t(DAY, GOAL, ["@endurance", "today:daily-session:"]),
    set_strength_schedule: t(DAY, GOAL, PLAN),
    set_movement_considerations: t(DAY, GOAL, ["plan:"]),
    set_strength_objective: t(DAY, GOAL, ["progress:program"]),
    add_memory: t(["me:memory", "health:learned"]),
    update_memory: t(["me:memory", "health:learned"]),
    supersede_memory: t(["me:memory", "health:learned"]),
    log_food: t(DAY, FOOD),
    update_food_note: t(DAY, FOOD),
    log_weight: t(DAY, BODY),
    log_blood_pressure: t(DAY, HEALTH),
    plan_update: t(DAY, PLAN),
    plan_restructure: t(DAY, PLAN),
    set_run: t(DAY, PLAN, ["@endurance"]),
    log_health: t(DAY, HEALTH, ["supplements"]),
    add_context_event: t(DAY, LIFE),
    resolve_context_event: t(DAY, LIFE),
    log_context_tag: t(DAY, LIFE),
    log_supplement: t(DAY, HEALTH, ["supplements"]),
    log_measurement: t(DAY, BODY, HEALTH),
    report_training_symptom: t(DAY, PLAN, ["today:session:"]),
    resolve_training_symptom: t(DAY, PLAN, ["today:session:"]),
    log_checkin: t(DAY, ["recovery:"]),
    set_training_drive: t(DAY, GOAL, PLAN),
    // The fuel line, the Intake target card and the goal pace all read the active target.
    set_nutrition_target: t(DAY, FOOD, GOAL),
    set_activity_effort: t(DAY, TRAINING, ["@endurance", "recovery:"]),
    flag_training_structure: t(DAY, PLAN),
    // A revert puts back whatever the decision changed: it can be any of the above.
    revert_decision: t(DAY, PLAN, TRAINING, FOOD, BODY, GOAL, LIFE, ["meals:plans"]),
    // A remark lands on the session notes the Today card and history both read.
    add_session_note: t(["today:session:", "history:sessions"]),
    // Today's own session, built or opened from chat: the card Today serves and its log.
    today_session: t(DAY, TRAINING, ["today:daily-session:", "today:session:"]),
    start_session: t(DAY, TRAINING, ["today:daily-session:", "today:session:"]),
  });

  // Writes the PWA makes itself, from surfaces that are not chat.
  const WRITE_TARGETS: Readonly<Record<string, readonly string[]>> = Object.freeze({
    // Undo / Hold on a brain decision (Changes, the rail, a toast).
    decision_revert: CHAT_ACTION_TARGETS.revert_decision,
    // POST /sessions/:id/finish.
    // The caller keeps the session key it just primed from the finish response.
    session_finish: t(DAY, TRAINING, ["today:daily-session:"]),
    // Applying a drafted proposal (Coach list, a chat draft card).
    proposal_apply: t(DAY, PLAN),
    // A meal plan edit / swap / status change.
    meal_edit: t(["meals:plans", "fuel:ideas:", "@brief"]),
    // POST /training-drive/offer/accept: the same push stance a stated push sets
    // (set_training_drive), so the same reach: the day, the drive's goal side, the plan.
    push_offer_accept: CHAT_ACTION_TARGETS.set_training_drive,
    // POST /training-drive/offer/dismiss: the offer rides the Brief and the conductor.
    push_offer_dismiss: t(DAY, ["settings:screen"]),
    // A Garmin sync finished (POST /garmin/sync's background job): new activities, a
    // watch strength session merged into its day, last night's sleep and readiness,
    // the wearable findings, the energy the watch measured, and the sync status line.
    garmin_sync: t(DAY, TRAINING, [
      "today:session:",
      "@endurance",
      "recovery:",
      "health:",
      "progress:energy",
      "fuel:band:",
      "settings:screen",
    ]),
  });

  const CAIRN_WRITE_INVALIDATION_TARGETS: WriteInvalidationTargetsApi = { CHAT_ACTION_TARGETS, WRITE_TARGETS };
  Object.assign(globalThis, { CairnWriteInvalidationTargets: CAIRN_WRITE_INVALIDATION_TARGETS });
}
