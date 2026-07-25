import type { DayRead } from "../intelligence.js";

type UnfinalizedDayRead = Omit<DayRead, "decision" | "input_fingerprint" | "computed_at">;

// Why a rule fired, in the two registers the system needs at once: a stable
// machine `code` for the accountability ledger, and the plain-language `reason`
// the athlete may actually read on a rest/easy Brief.
//
// Both live on the rule that produces them ON PURPOSE. Before this round a
// DayReadRule was just `{name, resolve}`, and resolve() built and returned the
// WHOLE DayRead itself — one hardcoded `why` literal baked straight into the
// rule's body, printed byte-for-byte every time that rule fired. `name` was
// documentation only; resolveDayReadRule never read it, so no rule had any
// identity that survived past resolution and there was nothing an
// accountability ledger could key on. Carrying a stable `code` on the outcome
// gives the ledger (and cross-day continuity's repeat_of_yesterday check)
// something durable to compare, and `reasons` — a rotating SET, not the old
// single literal — is what actually varies the words day to day. With the
// reason carried by the outcome there is no separate map to drift from, and a
// rule that reaches the athlete without words for them is a compile error.
export interface DayReadRuleOutcome {
  code: string;
  // Athlete-facing, second person, plain language — VISION.md Amendment 2. Never
  // engineering prose, never a score. Empty is not a legal value here: a rule that
  // genuinely has nothing to add beyond the read's own `why` should not be a rule.
  //
  // SEVERAL phrasings of the same read, because a stable input yields a stable
  // rule: a chronic short sleeper, a lingering injury or a low readiness baseline
  // fires the SAME branch every morning, and a single literal then prints the same
  // sentence verbatim for weeks — which reads as a broken app, not a calm coach.
  // pickDayVariant rotates them by calendar day, so consecutive days always differ
  // while the same day always reads the same. Index 0 is the canonical phrasing.
  reasons: readonly [string, ...string[]];
}

// Stable per-day variant selection: same day + same key ⇒ the same text, and
// CONSECUTIVE days always differ (the index advances by exactly one per day).
// Deterministic and offline — never Math.random(), never wall-clock "now".
function variantKeyOffset(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash % 9973);
}

export function pickDayVariant<T>(variants: readonly T[], date: string, key = ""): T {
  if (variants.length <= 1) return variants[0];
  const ms = Date.parse(`${String(date).slice(0, 10)}T00:00:00Z`);
  const dayIndex = Number.isFinite(ms) ? Math.floor(ms / 864e5) : 0;
  const span = variants.length;
  return variants[(((dayIndex + variantKeyOffset(key)) % span) + span) % span];
}

export interface DayReadRuleResult {
  outcome: DayReadRuleOutcome;
  read: UnfinalizedDayRead;
}

export interface DayReadRule {
  // A rule reports its own outcome, so a branch that reads differently (earned
  // rest from a dose overrun vs from stacked load) reports the words that match
  // the branch instead of collapsing into one approximate sentence.
  resolve: () => DayReadRuleResult | null;
}

// The floor when no rule fires: nothing is programmed, so nothing is due.
export const UNPROGRAMMED_EASY_DAY: DayReadRuleOutcome = {
  code: "unprogrammed_easy_day",
  reasons: [
    "Nothing is programmed today, so easy movement is plenty.",
    "There's nothing due on the plan today — move however you feel like moving.",
    "No session is waiting for you today, so anything easy counts.",
    "Today's open on the plan, so easy movement is the whole ask.",
  ],
};

export function resolveDayReadRule(rules: DayReadRule[]): DayReadRuleResult | null {
  for (const rule of rules) {
    const resolved = rule.resolve();
    if (resolved) return resolved;
  }
  return null;
}
