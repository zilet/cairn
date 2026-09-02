// THE REST TRADE — "train today, rest tomorrow", as a thing the calendar actually
// records (owner ruling, 2026-09-02).
//
// The ceiling-easy read (`accumulated_load_rest`) re-fires every morning the athlete
// trains through it, and the ring's rest day, once skipped, simply advances with the
// anchor. So an athlete who wanted TODAY and was happy to sit out TOMORROW had no way
// to say it: the Brief re-offered the same quiet day, and nothing anywhere held the
// day they had actually promised themselves.
//
// The machinery to claim a day already existed and is deterministic: a context event
// carrying `meta.claims_day` holds tomorrow (todayHolds / tomorrowHolds in
// signal-state.ts), the look-ahead re-times today's discretionary rest onto today, and
// on the day itself the read comes back as rest. All this adds is the WRITE, plus the
// flag that lets tomorrow's read say whose idea it was (REST_TRADE_META_KEY).
//
// Three rules hold it honest:
//   • It is only offered on a quiet day that is about RHYTHM — the ceiling-easy read,
//     any easy read, or the week's own rest day. A rest grounded in the athlete (a
//     symptom, a clinical hold, a rest-grade readiness reading) is a floor, and a floor
//     is not a trade: those refuse.
//   • ONE open trade, and it is idempotent per date — asking twice returns the same
//     claim rather than stacking two rest days onto the calendar.
//   • The RING IS NOT TOUCHED. The calendar carries the trade; plan rotation, anchors
//     and the week's shape are exactly as they were.
//
// Both surfaces (POST /api/today-read/trade-rest and the trade_rest_day MCP tool) are
// thin wrappers over `tradeRestDay` — the whole decision lives here.
import { addContextEvent, listContextEvents } from "../../repo/health.js";
import { REST_TRADE_META_KEY, dayRead, invalidateDayRead, getCachedDayRead } from "../../repo/intelligence.js";
import { readsRestGradeReadiness } from "../../repo/readiness-bands.js";
import { sensorIsCurrent } from "../../repo/sensor-freshness.js";
import { addDaysISO, localDateISO } from "../../repo/shared.js";
import { listTrainingSymptoms } from "../../repo/training-symptoms.js";
import { db } from "../../db.js";

/** The title the traded day carries on the calendar. Athlete-facing. */
export const REST_TRADE_TITLE = "Rest day — traded";

export type RestTradeRefusal =
  | "not_a_quiet_day"
  | "rest_grade_readiness"
  | "active_symptom"
  | "clinical_hold"
  | "trade_already_open"
  | "bad_date";

export interface RestTradeResult {
  ok: boolean;
  /** Machine-readable refusal code beside the athlete-facing `error`. */
  reason?: RestTradeRefusal;
  error?: string;
  /** The day that stays a training day. */
  date?: string;
  /** The day the rest moved to (date + 1). */
  rest_date?: string;
  event_id?: number | null;
  /** True when this exact trade was already on the calendar — the idempotent answer. */
  already_traded?: boolean;
  /** The athlete has chosen to train today; the client reveals the plan on this. */
  train_anyway?: boolean;
  /** Today's read, re-derived after the claim landed. */
  read?: ReturnType<typeof dayRead>;
}

/** The rule codes whose quiet day is about RHYTHM rather than about the athlete. */
const TRADEABLE_REST_RULES = new Set(["accumulated_load_rest", "template_rest_day"]);

// ---------- WHY THESE SENTENCES ARE LITERALS, NOT VARIANT SETS ----------
//
// Every athlete-facing string the BRIEF speaks rotates through pickDayVariant, because
// a stable input fires a stable rule every morning and one sentence printed verbatim
// for weeks stops reading as coaching. That reasoning does not reach here.
//
// A refusal is the answer to a TAP. The athlete asked one question, once, and gets one
// answer back in the same second. It is not a daily reading they wake up to, they will
// see any given one a handful of times at most, and each refusal already names its own
// concrete reason, so there is nothing to grow tired of. Rotating them would actively
// hurt: two taps a minute apart, refused for the SAME reason in two different
// sentences, reads as the system changing its mind rather than repeating itself. A
// stable answer to a stable question is the honest shape.
//
// So tap-triggered refusals are EXEMPT from the variant law, deliberately. They are
// still held to everything else — a friend's voice, no score, no gate — and
// `violatesReadingGrammar` is asserted against them in dayReadTodayHold.test.js.
function refuse(reason: RestTradeRefusal, error: string): RestTradeResult {
  return { ok: false, reason, error };
}

/** A fresh, rest-grade training-readiness reading for `date`, if there is one. */
function restGradeReadinessToday(date: string): boolean {
  try {
    const row = db
      .prepare(
        `SELECT date, training_readiness FROM garmin_daily_metrics
          WHERE date <= ? AND training_readiness IS NOT NULL
          ORDER BY date DESC, id DESC LIMIT 1`
      )
      .get(date) as { date?: string; training_readiness?: number } | undefined;
    if (!row) return false;
    if (!sensorIsCurrent("training_readiness", row.date == null ? null : String(row.date), date)) return false;
    return readsRestGradeReadiness(row.training_readiness);
  } catch {
    // An unreadable table is not evidence of a floor — but it is not evidence of
    // safety either, so the caller's other floors still stand.
    return false;
  }
}

function activeSymptomToday(date: string): boolean {
  try {
    // `seed_legacy: false`: this is a read on a user action, and it must not write.
    return listTrainingSymptoms({ on: date, seed_legacy: false }).some(
      (event: any) => event?.status === "active" && event?.legacy_unconfirmed !== true
    );
  } catch {
    return false;
  }
}

/**
 * Anything clinical holding the day — an injury row, an illness window, or a
 * health constraint the read is already working around. Deliberately probed off the
 * read's own signals rather than re-derived, so this cannot come to disagree with
 * the rule that produced the rest.
 */
function clinicalHoldToday(read: ReturnType<typeof dayRead>): boolean {
  const signals = (read?.signals ?? {}) as Record<string, any>;
  const state = signals.signal_state;
  const health = state?.dimensions?.health_constraints;
  if (health?.status === "constrained" || health?.status === "watch") return true;
  if (Array.isArray(state?.action?.source_dimensions) && state.action.source_dimensions.includes("health_constraints"))
    return true;
  return !!signals.health_workaround;
}

/** Every open rest trade on or after `date`, oldest first. */
function openRestTrades(date: string): any[] {
  try {
    return (listContextEvents({}) as any[]).filter((event) => {
      if (!event || event.archived) return false;
      if (event.meta?.[REST_TRADE_META_KEY] !== true) return false;
      const start = String(event.start_date ?? "").slice(0, 10);
      return !!start && start >= date;
    });
  } catch {
    return [];
  }
}

export function tradeRestDay(input: { date?: string } = {}): RestTradeResult {
  const date = input.date ? String(input.date).slice(0, 10) : localDateISO();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return refuse("bad_date", "That date isn't a day I can read.");
  const restDate = addDaysISO(date, 1);
  if (!restDate) return refuse("bad_date", "That date isn't a day I can read.");

  // Already traded — the idempotent answer, not an error. Asking twice from two tabs
  // must not put two rest days on the calendar.
  const open = openRestTrades(date);
  const existing = open.find((event) => String(event.start_date ?? "").slice(0, 10) === restDate);
  if (existing) {
    return {
      ok: true,
      date,
      rest_date: restDate,
      event_id: existing.id != null ? Number(existing.id) : null,
      already_traded: true,
      train_anyway: true,
      read: dayRead(date),
    };
  }
  if (open.length) {
    return refuse(
      "trade_already_open",
      "You've already got a rest day traded forward — take that one before moving another."
    );
  }

  // What is today, really? The cached row is what the athlete is looking at; the live
  // deterministic read is the authority on the floors. Both are consulted.
  const live = dayRead(date);
  const cached = (() => {
    try {
      return getCachedDayRead(date);
    } catch {
      return null;
    }
  })();
  const kind = String(cached?.kind ?? live?.kind ?? "");
  const ruleCode = String((cached as any)?.decision?.rule_code ?? live?.decision?.rule_code ?? "");
  // The FLOORS come first, so a refusal names the real reason rather than the shape it
  // happens to produce: a rest-grade morning also fails the eligibility test below, and
  // "there's no quiet day to trade" would be a confusing thing to tell someone whose
  // reading is exactly why the day went quiet.
  if (restGradeReadinessToday(date)) {
    return refuse(
      "rest_grade_readiness",
      "This morning's reading is the reason for the quiet day — that one isn't a trade."
    );
  }
  if (activeSymptomToday(date)) {
    return refuse(
      "active_symptom",
      "Something you've reported is holding today, so this isn't a day to trade forward."
    );
  }
  if (clinicalHoldToday(live)) {
    return refuse("clinical_hold", "There's a health finding shaping today, so the quiet day stays where it is.");
  }

  const quietEnough =
    kind === "easy" ||
    TRADEABLE_REST_RULES.has(ruleCode) ||
    TRADEABLE_REST_RULES.has(String(live?.decision?.rule_code ?? ""));
  if (!quietEnough) {
    return refuse("not_a_quiet_day", "There's no quiet day to trade today — today is already yours to train.");
  }

  const event = addContextEvent({
    kind: "life_event",
    title: REST_TRADE_TITLE,
    detail: "You kept today as a training day and moved the rest here.",
    start_date: restDate,
    end_date: restDate,
    meta: { claims_day: true, [REST_TRADE_META_KEY]: true, traded_from: date },
  }) as any;

  // addContextEvent already busts today's cached Brief; be explicit about the date
  // being traded so the next open re-reads it rather than serving the pre-trade row.
  try {
    invalidateDayRead(date);
  } catch {
    /* the response is still truthful */
  }

  return {
    ok: true,
    date,
    rest_date: restDate,
    event_id: event?.id != null ? Number(event.id) : null,
    already_traded: false,
    train_anyway: true,
    read: dayRead(date),
  };
}
