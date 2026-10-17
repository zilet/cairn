// @ts-check
// ==== chat-capture-chips-client.js ====
// The chips a chat reply carries for what it did: a logged or corrected food entry
// (named when one reply holds several) and the calm failed-agent chip. Extends
// CairnChatClient; loads after chat-client.js and before chat-message-client.js.

// ---- chat food-capture feedback ----------------------------------------
// A capture-lane food log links a food_notes row whose macros fill in later via
// background enrichment. The server stamps the applied log_food result with the
// note's live enrichment_status + a compact {meal,summary,kcal,protein_g}; these
// pure helpers turn that into the in-thread chip and keep it in sync as the note's
// SSE stream settles (see chat-message-client.ts).
// Row shape shared with capture-macros-client.ts (CaptureMacroRow), which draws the tags.
type CaptureFoodRow = CaptureMacroRow & { item?: unknown; amount?: unknown };
type CaptureFood = {
  meal?: unknown;
  summary?: unknown;
  kcal?: unknown;
  protein_g?: unknown;
  ingredients?: unknown;
  ingredient_count?: unknown;
  confidence?: unknown;
  basis?: unknown;
};
type CaptureFoodInfo = { id: number; status: string; food: CaptureFood; missing: boolean };

function captureFoodActive(status: unknown): boolean {
  const s = String(status || "");
  return s === "pending" || s === "in_progress";
}

function capMealLabel(value: unknown): string {
  const s = String(value ?? "").trim();
  if (!s) return "Meal";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Pull the linked-note descriptor out of an applied log_food action, or null when
// this isn't a capture we can track (wrong type, no note id, or note deleted).
function captureFoodInfo(action: unknown): CaptureFoodInfo | null {
  const a = action && typeof action === "object" ? (action as Record<string, unknown>) : null;
  if (!a || String(a.type || "") !== "log_food") return null;
  const result = a.result && typeof a.result === "object" ? (a.result as Record<string, unknown>) : null;
  if (!result) return null;
  const id = Number(result.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const food: CaptureFood = result.food && typeof result.food === "object" ? { ...(result.food as CaptureFood) } : {};
  if (food.meal == null && result.meal != null) food.meal = result.meal;
  return { id, status: String(result.enrichment_status || ""), food, missing: result.food_note_missing === true };
}

// Map a fetched food-note row (SSE update / poll) back to {status, food} so the chip
// updates in place from the same rendering path as the initial server-stamped state.
function captureFoodFromRow(row: unknown): { status: string; food: CaptureFood } {
  const r = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
  let parsed: unknown = r.parsed;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { parsed = null; }
  }
  if ((parsed == null || typeof parsed !== "object") && r.parsed_json) {
    try { parsed = JSON.parse(String(r.parsed_json)); } catch { parsed = null; }
  }
  const p = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const source = Array.isArray(p.ingredients) ? p.ingredients : Array.isArray(p.items) ? p.items : [];
  const rows = source.map(captureFoodRow).filter((row): row is CaptureFoodRow => !!row);
  return {
    status: String(r.enrichment_status || ""),
    food: {
      meal: r.meal,
      summary: p.summary,
      kcal: p.kcal,
      protein_g: p.protein_g,
      ingredients: rows.slice(0, CAPTURE_REVIEW_MAX_ROWS),
      ingredient_count: rows.length,
      confidence: p.confidence,
      basis: p.basis,
    },
  };
}

// ---- the settled review ------------------------------------------------
// Under the chip, ONE quiet read-only line per component: item, portion in words, a
// muted "~150 kcal". Approximate logging is corrected by the next message ("oh and
// 40 g of avocado"), which amends the same meal and reprints this in place. Rows are
// capped (the full breakdown lives in Fuel); the meal's total is the chip above.
const CAPTURE_REVIEW_MAX_ROWS = 6;

// The same normalization the server runs in stampCaptureFood, for the SSE/poll path
// that hands us a raw food-note row instead of an already-stamped result.
function captureFoodRow(raw: unknown): CaptureFoodRow | null {
  if (typeof raw === "string") return raw.trim() ? { item: raw.trim() } : null;
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const item = String(row.item ?? row.name ?? row.food ?? "").trim();
  if (!item) return null;
  const amount = String(row.amount ?? row.qty ?? row.quantity ?? row.portion ?? "").trim();
  const { kcal, protein_g, carbs_g, fat_g, fiber_g } = row;
  return { item, amount, kcal, protein_g, carbs_g, fat_g, fiber_g };
}

// "1 handful (~30 g)" reads "1 handful": the bracketed weight is the estimator's
// working, not a weighing; "40 g" alone stays. Twin of meal-card-model's portionWords.
function capturePortionWords(amount: unknown): string {
  const text = String(amount ?? "").trim();
  return text.replace(/\s*\(\s*(?:~|about|approx\.?|≈)?\s*\d+(?:[.,]\d+)?\s*(?:g|ml|oz)\s*\)\s*$/i, "") || text;
}

// The review's inner HTML, or "" when there is nothing honest to show yet (still
// enriching, failed, or an estimate that came back with no components).
function captureFoodReviewInner(status: unknown, food: unknown): string {
  const s = String(status || "");
  if (captureFoodActive(s) || s === "failed" || s === "skipped") return "";
  const f = food && typeof food === "object" ? (food as CaptureFood) : {};
  const rows = (Array.isArray(f.ingredients) ? f.ingredients : [])
    .map(captureFoodRow)
    .filter((row): row is CaptureFoodRow => !!row)
    .slice(0, CAPTURE_REVIEW_MAX_ROWS);
  if (!rows.length) return "";
  const total = Number(f.ingredient_count);
  const hidden = Number.isFinite(total) ? Math.max(0, total - rows.length) : 0;
  const body = rows
    .map((row) => {
      const portion = capturePortionWords(row.amount);
      const kcal = Number(row.kcal);
      return `<li class="capture-item"><span class="capture-item-name">${escHtml(row.item)}</span>${
        portion ? `<span class="capture-item-portion">${escHtml(portion)}</span>` : ""
      }${captureFoodMacrosHtml(row)}${kcal > 0 ? `<span class="capture-item-kcal">~${Math.round(kcal)} kcal</span>` : ""}</li>`;
    })
    .join("");
  const more = hidden ? `<li class="capture-item capture-item-more">and ${hidden} more</li>` : "";
  return `<ul class="capture-items">${body}${more}</ul>`;
}

// An applied update_food_note that landed: the updated row, for repainting that
// meal's chip and review in place. Null for anything else.
function amendedFoodRow(action: unknown): { id: number; row: Record<string, unknown> } | null {
  const a = action && typeof action === "object" ? (action as Record<string, unknown>) : null;
  const result = a?.result && typeof a.result === "object" ? (a.result as Record<string, unknown>) : null;
  if (String(a?.type || "") !== "update_food_note" || !result || result.error) return null;
  const id = Number(result.id);
  if (!Number.isSafeInteger(id) || id <= 0 || (result.parsed == null && result.parsed_json == null)) return null;
  return { id, row: result };
}

/** "711 kcal · 61g protein" bits of a meal; empty when neither is known. */
function captureMacroBits(f: CaptureFood): string[] {
  const kcal = Number(f.kcal);
  const protein = Number(f.protein_g);
  return [kcal > 0 ? `${Math.round(kcal)} kcal` : "", protein > 0 ? `${Math.round(protein)}g protein` : ""].filter(Boolean);
}

type FoodTagOpts = { among?: boolean; preferThing?: boolean };

const FOOD_MEAL_WORD = /^(breakfast|lunch|dinner|snack|meal)$/i;

function asCaptureFood(food: unknown): CaptureFood {
  return food && typeof food === "object" ? (food as CaptureFood) : {};
}

/** A short item name already on the reply: the summary, else the one ingredient. */
function foodThing(food: CaptureFood): string {
  const summary = String(food.summary ?? "").replace(/\s+/g, " ").trim();
  if (summary && summary.length <= 40 && !FOOD_MEAL_WORD.test(summary)) return capMealLabel(summary);
  const rows = (Array.isArray(food.ingredients) ? food.ingredients : [])
    .map(captureFoodRow)
    .filter((row): row is CaptureFoodRow => !!row);
  if (rows.length === 1) {
    const item = String(rows[0].item ?? "").replace(/\s+/g, " ").trim();
    if (item && item.length <= 40) return capMealLabel(item);
  }
  return "";
}

/**
 * Lead for a new log when the reply has more than one food chip: "Breakfast logged",
 * or the item when two logs would otherwise say the same meal.
 */
function captureFoodAmongLead(food: unknown, opts: { preferThing?: boolean } = {}): string {
  const f = asCaptureFood(food);
  const meal = capMealLabel(f.meal);
  const thing = foodThing(f);
  if (opts.preferThing && thing && thing.toLowerCase() !== meal.toLowerCase()) return `${thing} logged`;
  return `${meal} logged`;
}

// The chip over an amendment, where the correction was made: "✓ Lunch updated · 780 kcal · 65g protein".
// Among other food chips in the same reply it names the entry: "✓ Chocolate corrected · 57 kcal".
function amendedFoodTag(action: unknown, opts: FoodTagOpts = {}): string | null {
  const amended = amendedFoodRow(action);
  if (!amended) return null;
  const { food } = captureFoodFromRow(amended.row);
  const meal = capMealLabel(food.meal);
  const thing = foodThing(food);
  const lead = opts.among ? `${thing || meal} corrected` : `${meal} updated`;
  return `✓ ${[lead, ...captureMacroBits(food)].join(" · ")}`;
}

// The chip's inner HTML for a given status. Active -> a calm "filling in details…"
// with the spinner dot; done -> "✓ Dinner · 640 kcal · 40g protein" (or "✓ Dinner
// logged" when no macros came back); failed/skipped -> a calm "logged — details
// unavailable" (the log itself is never in doubt). escHtml is the ambient global.
function captureFoodTagInner(status: unknown, food: unknown, opts: FoodTagOpts = {}): string {
  const s = String(status || "");
  const f = asCaptureFood(food);
  if (captureFoodActive(s)) return `<span class="enr-dot" aria-hidden="true"></span>filling in details…`;
  const meal = capMealLabel(f.meal);
  if (s === "failed" || s === "skipped") return `✓ ${escHtml(meal)} logged — details unavailable`;
  const bits = captureMacroBits(f);
  if (opts.among) {
    const lead = captureFoodAmongLead(f, opts);
    return bits.length ? `✓ ${escHtml(`${lead} · ${bits.join(" · ")}`)}` : `✓ ${escHtml(lead)}`;
  }
  if (!bits.length) return `✓ ${escHtml(meal)} logged`;
  return `✓ ${escHtml(`${meal} · ${bits.join(" · ")}`)}`;
}

// One reply with several food chips has to say which entry each chip is. A lone
// chip keeps the meal-only words. Two new logs that would both say "Breakfast
// logged" take the item name instead.
function chatFoodTagOpts(applied: ChatScreenAppliedAction[]): FoodTagOpts[] {
  const rows = applied.map((a) => {
    const info = CairnChatClient.captureFoodInfo(a);
    if (info && !info.missing) return { kind: "log" as const, food: info.food };
    const amended = CairnChatClient.amendedFoodRow(a);
    if (amended) return { kind: "amend" as const, food: CairnChatClient.captureFoodFromRow(amended.row).food };
    return null;
  });
  const among = rows.filter(Boolean).length > 1;
  const counts = new Map<string, number>();
  if (among) {
    for (const row of rows) {
      if (!row || row.kind !== "log") continue;
      const lead = CairnChatClient.captureFoodAmongLead(row.food);
      counts.set(lead, (counts.get(lead) || 0) + 1);
    }
  }
  return rows.map((row) => {
    if (!row || !among) return {};
    if (row.kind !== "log") return { among: true };
    const lead = CairnChatClient.captureFoodAmongLead(row.food);
    return { among: true, preferThing: (counts.get(lead) || 0) > 1 };
  });
}

function agentWord(value: unknown): string {
  return value == null ? "" : String(value);
}

function chatAgentCheckHtml(attemptsValue: unknown): string {
  const failed = (Array.isArray(attemptsValue) ? attemptsValue : []).filter((row): row is Record<string, unknown> => !!row && typeof row === "object" && row.ok === false);
  if (!failed.length) return "";
  const first = failed[0];
  const agent = agentWord(first.agent) || "agent";
  const status = agentWord(first.status || first.error_class).replace(/_/g, " ") || "needs attention";
  const raw = agentWord(first.status || first.error_class);
  // Calm words by what happened; the visible text hints at the way in (the title is
  // invisible on a phone) without naming a provider or the engineering word.
  const words =
    raw === "timeout"
      ? "Took a little longer than usual"
      : raw === "auth_required" || raw === "permission_denied"
        ? "One agent needs signing in again · Agents ›"
        : "One agent couldn't answer · Agents ›";
  const more = failed.length > 1 ? ` +${failed.length - 1}` : "";
  // The visible words stay calm. Which backend and what failed live on the title,
  // beside the way into Settings → Agents. No aria-label: the button's text is its name.
  const title = `${agent} ${status}${more}. Open Settings → Agents`;
  return `<button class="agentcheck" type="button" data-agent-check="1" title="${escAttr(title)}">
    <span class="agentcheck-dot" aria-hidden="true"></span>
    <span>${escHtml(words)}</span>
  </button>`;
}

const CAIRN_CHAT_CAPTURE_CHIPS = {
  captureFoodActive,
  captureFoodInfo,
  captureFoodFromRow,
  captureFoodTagInner,
  captureFoodAmongLead,
  captureFoodReviewInner,
  amendedFoodRow,
  amendedFoodTag,
  foodTagOpts: chatFoodTagOpts,
  agentCheckHtml: chatAgentCheckHtml,
};

Object.assign(CairnChatClient, CAIRN_CHAT_CAPTURE_CHIPS);
