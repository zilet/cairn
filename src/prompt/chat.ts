// Conversational chat prompts + the prose-first reply contract (sentinels,
// stripLeadingNarration, parseChatReply) and the memory/about-me distillers.
import { extractJson } from "../agents.js";
import {
  normalizeChatActions,
  renderChatActionPromptProse,
  renderChatActionSchema,
  type ChatAction,
} from "../chatActions.js";
import * as repo from "../repo.js";
import {
  CONTEXT_GUARDRAILS,
  renderActiveContext,
  renderCoachingFocus,
  renderNow,
  renderReactionModel,
  renderTodayFuel,
  renderTrainingSignals,
  CAIRN_PERSONA,
  CHAT_ACTION_SENTINEL,
  CHAT_REPLY_SENTINEL,
} from "./shared.js";
// CHAT_ACTION_SENTINEL / CHAT_REPLY_SENTINEL now live in shared.js (chat AND the
// streaming job ops share them). The prompt.js barrel re-exports them via shared.js,
// so existing `./prompt.js` imports (chatStreamFilter, tests) resolve unchanged.

// ---- prose-first chat contract ----
// The chat reply STREAMS, so its contract is prose-first: the model writes the human
// answer as plain prose (rendered live, token by token), then — only when it needs to
// log or change something — emits CHAT_ACTION_SENTINEL on its own line followed by ONE
// JSON object {"actions":[…]}. Everything before CHAT_REPLY_SENTINEL is dropped (an
// autonomous CLI's tool-step narration); everything after the reply marker is the
// reply; everything after the action sentinel is parsed for actions. A pure-prose
// answer omits the action sentinel entirely. parseChatReply tolerates a missing/garbled
// actions block (reply still stands) AND the legacy {reply, actions} JSON shape.

// Safety net for agents that ignore the reply marker: strip ONLY the leading lines
// that are unmistakable tool-step narration — an action verb AND a technical token
// (a path, a table, a db/file/command). Stops at the first line that isn't both, so
// genuine coaching prose ("I'll bump your squat to 200", "Let me explain your zones")
// is never touched. Conservative by construction: false positives require both a
// step verb and a filesystem/db token on the same leading line.
function stripLeadingNarration(s: string): string {
  const lines = s.split("\n");
  const verb = /^\s*(I will|I'll|I am going to|I'm going to|Let me|First,?\s+I|Now,?\s+I|Next,?\s+I|Then,?\s+I|I need to|I should|I'll now|Reading|Fetching|Checking|Querying|Listing|Running|Inspecting|Examining|Looking at|Pulling up|Pulling|Reviewing|Gathering|Searching|Viewing)\b/i;
  // A retrieval/plumbing token. Broadened past raw filesystem/db words to a few
  // data-plumbing NOUNS an agent narrates a lookup with ("pull up your data",
  // "get the context", "check your metrics"). Deliberately NOT "log"/"record" — those
  // double as coaching verbs ("I'll log that", "I'll record it"), which must survive.
  const tech = /(\/\w|\.json\b|\.db\b|\.js\b|\.ts\b|\bsqlite|\bnode\b|\bnpm\b|\btable\b|\bdatabase\b|\bschema\b|\bdirectory\b|\bcommand\b|\bquery\b|\bfile\b|\bfiles\b|\brepo\b|\bworkspace\b|\bdata\b|\bcontext\b|\bmetrics?\b|node_modules|package\.json|cairn\.db|chat_messages|chat_turns|\/app\b|\/home\b|\/data\b)/i;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === "") { i++; continue; }                      // blanks between narration
    if (verb.test(lines[i]) && tech.test(lines[i])) { i++; continue; }  // a tool-step line — drop it
    break;
  }
  return lines.slice(i).join("\n").trim();
}

export function parseChatReply(text: string): { reply: string; actions: ChatAction[] } {
  let raw = (text ?? "").toString();
  // Drop any tool-step preamble before the user-facing reply marker. Keep the
  // LAST marker, in case the literal token shows up earlier inside the narration.
  const rIdx = raw.lastIndexOf(CHAT_REPLY_SENTINEL);
  const hadMarker = rIdx !== -1;
  if (hadMarker) raw = raw.slice(rIdx + CHAT_REPLY_SENTINEL.length);
  // With a marker the reply is already clean; without one, fall back to the stripper.
  const clean = (s: string) => (hadMarker ? s.trim() : stripLeadingNarration(s.trim()));
  // lastIndexOf (not indexOf): the real actions block is the LAST sentinel, so a reply
  // that merely MENTIONS "===CAIRN_ACTIONS===" in its prose isn't truncated there.
  const idx = raw.lastIndexOf(CHAT_ACTION_SENTINEL);
  if (idx === -1) {
    // No actions sentinel: pure prose — UNLESS the model emitted the legacy
    // {reply,actions} JSON, which we salvage so older agents keep working.
    const obj = extractJson(raw);
    if (obj && typeof obj === "object" && (typeof obj.reply === "string" || Array.isArray(obj.actions))) {
      return {
        reply: ((obj.reply ?? "").toString().trim()) || clean(raw),
        actions: normalizeChatActions(obj.actions),
      };
    }
    return { reply: clean(raw), actions: [] };
  }
  const reply = clean(raw.slice(0, idx));
  const obj = extractJson(raw.slice(idx + CHAT_ACTION_SENTINEL.length));
  const actions = obj && Array.isArray(obj.actions) ? obj.actions : (Array.isArray(obj) ? obj : []);
  return { reply, actions: normalizeChatActions(actions) };
}

// Conversational coach. Sees all data; may emit actions the server applies/drafts.
// imagePath: absolute path of a photo the user attached this turn — the agent
// CLIs (Claude Code / Codex) can open local files, same trick as health docs.
export function buildChatPrompt(history: { role: string; content: string; at?: string }[], message: string, imagePath?: string): string {
  const ctx = repo.getCoachContext();
  // Prefix each turn with its relative time (when known) so the agent sees the
  // conversation's RHYTHM — what's from this morning vs minutes ago — not a flat,
  // timeless wall of text it would mistake for one continuous moment.
  const convo = (history || [])
    .map((m) => `${m.at ? `[${m.at}] ` : ""}${m.role === "user" ? "User" : "Coach"}: ${m.content}`)
    .join("\n");
  const photoBlock = imagePath ? `
ATTACHED PHOTO — the user attached a photo with this message, saved locally at this ABSOLUTE path:
${imagePath}
Open and LOOK at that image file directly before answering.
- If it shows food (a plate, meal, snack, packaged item): identify the dish, estimate portion sizes
  and macros from ordinary servings (rough is fine — never invent precision), emit ONE "log_food"
  action with the estimate, and summarize it in "reply" (dish · ~kcal · protein).
- If it is not food (gym equipment, a form-check frame, a menu, a label): just use what you see to
  answer their message; only log when they clearly want something logged.
` : "";
  return `${CAIRN_PERSONA}

You're chatting with the user inside their app. You can SEE all their data (DATA section) and can ACT by emitting actions.
${renderNow(ctx)}
GUARDRAILS:
- Conservative progression. Respect every exercise constraint_note (e.g. injury limits); never contradict them.
- A cut never changes the strength objective to mere maintenance. No avoidable muscle/strength loss is
  the floor; when recovery and performance support it, keep building strength and evolving the program.
- Fuel guidance follows the user's GOAL MODE (DATA: goal_mode) and goal.recommended: a lean-safe
  deficit when LOSING, maintenance calories when MAINTAINING (don't push a deficit), a conservative
  surplus when GAINING — never a crash deficit and never a dirty bulk.
- Treat Garmin as a context source, not the plan authority. Manual Cairn lifting logs are the source
  of truth for strength progression. Adapt recommendations to the user's stated focus: strength-first
  means Garmin runs/rides mainly influence recovery and conditioning; runner/cyclist-first means
  endurance progression is central and lifting supports it.
- Assisted lifts use NEGATIVE weight; bodyweight uses null.
- TIMED exercises (mode:'timed', e.g. plank, dead hang) log duration_sec and are prescribed via
  target_seconds — progression is in seconds (+5-15s/step), never load.
- Keep training fresh: when the user sounds bored or an accessory has stalled for weeks, suggest
  swapping in a new same-muscle exercise (within their constraints, conservative starting load)
  rather than grinding the same movement forever.
- CONVERSATION FOCUS: a meal log, plate photo, or nutrition question is a food moment. Log it,
  estimate it, and offer only directly useful food context. Do NOT pivot into a lift, future
  training change, or plan update from a food-only turn. Keep observing in the background; make
  a targeted plan_update only when the current turn contains a material training, recovery, pain,
  or life-context signal that truly changes the next session. Keep that adjustment out of the
  reply unless the user asks about the plan — its reason will be visible with the exercise when
  they start it.
- PROGRESSIVE UNDERSTANDING: if the DATA shows an obvious gap (no profile.about_me, an unknown
  training-time or food like/dislike) you MAY ask ONE brief, low-friction question when it fits the
  conversation naturally — never a questionnaire, never more than one per turn — and emit an
  add_memory action capturing any durable answer they give. If nothing fits naturally, skip it.
- SUPPLEMENTS — UNDERSTAND, DON'T INTERROGATE: when the user mentions what they take ("I take
  creatine daily, omega-3, some D, whey occasionally"), DON'T ask dose-by-dose questions. Capture it
  once with a log_supplement action, APPROXIMATING sensibly (creatine → ~5 g/day; "some D" → Vitamin
  D3; whey → counts toward protein). Acknowledge it in one calm line and move on; refine later only if
  it actually matters. Already-known supplements are in DATA.supplements — don't re-ask or re-suggest them.
- SELF-UPDATING MEMORY: each row in DATA.memory carries an "id". When the user tells you something
  that CONTRADICTS or CHANGES a remembered fact, don't pile on a new memory — keep the store coherent:
  emit update_memory{id,...} to correct a fact in place (a refined or now-different version of the same
  thing), or supersede_memory{id, reason, replacement?} when an old fact is simply no longer true (e.g.
  "I switched to evenings" supersedes "prefers morning training"). add_memory is only for genuinely NEW
  facts. Never invent ids — only use ids present in DATA.memory.

${CONTEXT_GUARDRAILS}

${renderChatActionPromptProse()}
${renderCoachingFocus(ctx, { brief: true })}${renderTrainingSignals(ctx)}${renderReactionModel(ctx)}${renderActiveContext(ctx)}${renderTodayFuel(ctx)}
Keep the reply short and human; confirm what you logged. Do not narrate a background plan_update.
When the user says a lift
"felt easy" / "felt heavy", lean on the LOGGED-PERFORMANCE SIGNALS above to decide — only emit a
bump for a lift that actually reads progression-ready; hold or ease one that's stalled or flagged.

OUTPUT CONTRACT — write your reply between markers so it streams cleanly:
1. Put this exact marker on its own line, immediately before your user-facing reply:
${CHAT_REPLY_SENTINEL}
   Anything before it — tool notes, "I will check the … table" step narration, private working
   thoughts — is ignored and never reaches the user. Always write this marker exactly once.
2. AFTER the marker, your reply to the user as plain, warm prose (markdown allowed) — no JSON, no
   code fence, no tool logs. This is shown to them live, word by word, so write it for a human.
3. THEN, ONLY IF you need to log or change something, put this exact marker on its own line:
${CHAT_ACTION_SENTINEL}
   and immediately after it ONE JSON object: {"actions": [ ... ]} drawn from the shapes below.
   If there is nothing to log or change, STOP after the prose — do NOT write the marker or any JSON.

ACTION SHAPES (each item inside the "actions" array):
${renderChatActionSchema()}
${photoBlock}
CONVERSATION SO FAR:
${convo || "(new conversation)"}

USER'S MESSAGE: ${message}

DATA:
${JSON.stringify(ctx)}`;
}

const DISTILL_SCHEMA = `{
  "memories": [
    { "content": "<one short, self-contained durable fact>", "kind": "preference|constraint|decision|injury|milestone|observation" }
  ],
  "farewell": "<optional single warm sentence closing the conversation out>"
}`;

// "Fresh start" distillation: one call that reads the conversation about to be
// archived and extracts only the durable facts worth carrying into the memory
// table. The reset never blocks on this — an agent failure still archives.
export function buildChatDistillPrompt(history: { role: string; content: string }[]): string {
  const known = (repo.listMemory(60) as any[]).map((m) => `- ${m.content}`).join("\n");
  const convo = (history || [])
    .slice(-80)
    .map((m) => `${m.role === "user" ? "User" : "Coach"}: ${String(m.content ?? "").slice(0, 600)}`)
    .join("\n");
  return `${CAIRN_PERSONA}

Right now you are acting as Cairn's coaching memory. The user is archiving this chat conversation and starting fresh.
Distill ONLY the durable facts from it that you should still know weeks from now:
- preferences (training style, schedule, food likes/dislikes), constraints (equipment, time, pain/injury rules),
  decisions made together (plan changes agreed to, goals set), milestones, and genuinely notable observations.
- NOT trivia, NOT one-off logs (sets, meals and weigh-ins are already stored), NOT anything recomputable
  from the data, NOT advice the coach gave unless the user clearly adopted it.
- Each memory is one short, self-contained sentence. An empty list is a perfectly good answer.

ALREADY REMEMBERED (do not repeat or restate any of these):
${known || "(nothing yet)"}

OUTPUT CONTRACT: respond with ONE JSON object, no prose, no fences:
${DISTILL_SCHEMA}

CONVERSATION BEING ARCHIVED:
${convo || "(empty)"}`;
}

const CONSOLIDATION_SCHEMA = `{
  "merges":      [ { "ids": [<id>, <id>, ...], "content": "<the single combined fact>", "kind": "preference|constraint|decision|injury|milestone|goal|observation" } ],
  "supersedes":  [ { "id": <stale id>, "reason": "<why it's no longer true>", "replacement": "<optional newer fact, or omit>" } ],
  "promotions":  [ { "id": <observation id>, "kind": "preference|constraint|decision|goal", "content": "<optional sharper wording, or omit to keep as-is>" } ]
}`;

// Quiet, periodic memory consolidation: reads the live memory store and proposes
// (a) merges of near-duplicate facts into one, (b) supersessions where a newer
// fact contradicts an older one, and (c) promotions of a recurring OBSERVATION
// into a durable PREFERENCE/CONSTRAINT/DECISION/GOAL. It changes nothing on its
// own — coachOps.consolidateMemory applies the result via the repo functions
// (which MARK, never hard-delete). Empty arrays are the calm, common answer.
export function buildMemoryConsolidationPrompt(): string {
  const rows = (repo.listMemory(120) as any[]).map(
    (m) => `- [id ${m.id}] (${m.kind ?? "observation"}${Number(m.confidence) > 1 ? `, seen×${Math.round(Number(m.confidence) * 2) / 2}` : ""}) ${String(m.content ?? "").slice(0, 240)}`
  ).join("\n");
  return `${CAIRN_PERSONA}

Right now you are acting as Cairn's coaching-memory librarian. Tidy the user's memory store so it stays a
coherent, non-redundant model of who they are — WITHOUT losing anything real. This is housekeeping,
not coaching: be conservative, only act when you're confident.

WHAT TO DO (each is optional; empty arrays are a perfectly good answer):
- MERGE near-duplicate facts that say essentially the same thing into ONE clear sentence (list every
  id involved; the rest are folded into the first).
- SUPERSEDE a fact that a LATER fact contradicts (e.g. an old "trains mornings" when a newer note says
  "switched to evenings"). Give the stale id + the reason; add a "replacement" only if a single clean
  combined fact is clearer than what's already there.
- PROMOTE a recurring OBSERVATION that has clearly become a stable trait into a preference/constraint/
  decision/goal (e.g. three notes about skipping breakfast → a "prefers fasted mornings" preference).
- Do NOT merge facts that are merely on the same topic but say different things. Do NOT invent facts.
  Do NOT touch ids you don't see below. Never surface a numeric score.

CURRENT MEMORY (most recent first):
${rows || "(empty)"}

OUTPUT CONTRACT: respond with ONE JSON object, no prose, no fences:
${CONSOLIDATION_SCHEMA}`;
}

const ABOUT_ME_SCHEMA = `{
  "about_me": "<the rewritten person-model, a few short paragraphs of plain prose>",
  "changed": <true|false>
}`;

// Grow profile.about_me into a coherent person-model from typed memory + family +
// recent check-ins. AUGMENTS, never overwrites blindly: the existing about_me
// (which the user curates) is preserved and only extended/sharpened with what the
// data clearly supports. The user still edits it freely afterward.
export function buildAboutMeGrowthPrompt(): string {
  const ctx = repo.getCoachContext();
  const profile = ctx.profile || {};
  const mem = ctx.memory.map((m) => `- (${m.kind ?? "observation"}) ${String(m.content ?? "").slice(0, 240)}`).join("\n");
  const family = (ctx.family as any[] || []).map((f: any) => `- ${f.name ?? "member"}${f.relation ? ` (${f.relation})` : ""}${f.notes ? `: ${String(f.notes).slice(0, 120)}` : ""}`).join("\n");
  const checkins = (ctx.checkins as any[] || []).slice(0, 7).map((c: any) => `- ${c.date}: mood ${c.mood ?? "—"}, energy ${c.energy ?? "—"}, sleep ${c.sleep_feel ?? "—"}${c.note ? ` · ${String(c.note).slice(0, 80)}` : ""}`).join("\n");
  return `${CAIRN_PERSONA}

Right now you are acting as Cairn's coaching memory, maintaining the user's "about me" — a short, warm,
person-model you read to personalize tone and plans. Update it from the data below.

RULES:
- AUGMENT, never replace wholesale. The EXISTING about-me is partly user-authored; preserve its
  meaning and any personal voice. Only add or sharpen what the memory/family/check-in data clearly
  supports. If the data adds nothing, set "changed": false and return the existing text unchanged.
- A few short paragraphs of plain prose — training style & schedule, food preferences/constraints,
  what they're working toward, the people they plan around, how they tend to feel/recover. No lists,
  no headers, no numeric scores, no medical claims. Write it TO the coach, ABOUT the user.
- Never invent. Only what's in the data.

EXISTING ABOUT-ME (preserve & extend; may be empty):
${profile.about_me ? String(profile.about_me).slice(0, 4000) : "(empty)"}

TYPED MEMORY:
${mem || "(none)"}

FAMILY THE COACH PLANS AROUND:
${family || "(none)"}

RECENT CHECK-INS:
${checkins || "(none)"}

OUTPUT CONTRACT: respond with ONE JSON object, no prose, no fences:
${ABOUT_ME_SCHEMA}`;
}
