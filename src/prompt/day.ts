// Day-driver prompts: the Brief day-read, the on-demand session, the quiet
// cross-domain insight, and the standing weekly read.
import * as repo from "../repo.js";
import type { CoachContext } from "../repo/coach-context.js";
import { promptData } from "./context-projection.js";
import { localDateISO } from "../repo/shared.js";
import {
  activeInjuryAreas,
  COACHING_STANCE,
  CONTEXT_GUARDRAILS,
  ELITE_STRENGTH_GUARDRAILS,
  renderActiveContext,
  renderCoachingFocus,
  renderBodyComp,
  renderConnectedBrain,
  renderDexaTargeting,
  renderDiscipline,
  renderEnduranceGoal,
  renderHybridSequencing,
  renderMuscleGroups,
  renderNow,
  renderPerformance,
  renderProgramState,
  renderReactionModel,
  renderRunCompliance,
  renderRunPlan,
  renderRunZones,
  renderSignalState,
  renderTodayFuel,
  renderTrainingSignals,
  renderTrajectory,
  renderStreamingContract,
  renderJsonContract,
  MECHANICS_ENCODING,
  dateScopedPromptContext,
  CAIRN_PERSONA,
} from "./shared.js";

// ---------- the day read (Phase 1A — the soul) ----------
const DAY_READ_SCHEMA = `{
  "kind": "train|easy|rest|done",
  "headline": "<2-5 word plain-language state. Prospective when train/easy/rest ('Long run today.'); past-tense acknowledgement when done ('Long run done.')>",
  "why": "<one warm, plain sentence — what you saw and why; NO numbers, NO scores>",
  "focus": "<train: the session character. For a LIFTING day this is the muscle focus ('Lower body'); for an ENDURANCE user it can be the run/ride character — 'Easy', 'Long', 'Tempo', 'Intervals', 'Recovery'. null on rest.>",
  "est_minutes": <rough minutes for the suggestion, or null>
}`;

// A compact, deterministic read of the training history so the agent grasps the
// RHYTHM (frequency, freshness, recent emphasis, sore/joint flags) without having
// to reconstruct it from the raw session blob — this is what makes the Brief feel
// like it "remembers everything you've done", not just today's signals.
function trainingRhythmLine(allSessions: any[], date?: string): string {
  const sessions = Array.isArray(allSessions) ? allSessions : [];
  if (!sessions.length) return "(no training logged yet — ease in)";
  const dayMs = 864e5;
  const ref = date ? new Date(date + "T00:00:00Z").getTime() : Date.now();
  const ageDays = (d?: string) => (d ? Math.floor((ref - new Date(d + "T00:00:00Z").getTime()) / dayMs) : null);
  const trained = sessions.filter((s) => Array.isArray(s?.sets) && s.sets.length);
  const last = trained[0] || sessions[0];
  const since = ageDays(last?.date);
  const within = (days: number) =>
    sessions.filter((s) => {
      const a = ageDays(s?.date);
      return a != null && a >= 0 && a < days;
    }).length;
  const last7 = within(7);
  const last28 = within(28);
  const recentFocus = [
    ...new Set(
      sessions
        .slice(0, 3)
        .map((s) => s?.title || s?.day_name)
        .filter(Boolean)
    ),
  ];
  const jointFlags = [
    ...new Set(
      sessions
        .slice(0, 4)
        .map((s) => s?.joint_pain)
        .filter(Boolean)
    ),
  ];
  const sore = sessions.slice(0, 3).filter((s) => s?.soreness != null && Number(s.soreness) >= 4).length;
  const bits: string[] = [];
  bits.push(
    since == null
      ? "no dated sessions"
      : since <= 0
        ? "trained today already"
        : since === 1
          ? "last trained yesterday"
          : `last trained ${since} days ago`
  );
  bits.push(`${last7} session${last7 === 1 ? "" : "s"} in the last 7 days · ${last28} in 28`);
  if (recentFocus.length) bits.push(`recent emphasis: ${recentFocus.join(" → ")}`);
  if (jointFlags.length) bits.push(`flagged joints recently: ${jointFlags.join(", ")}`);
  if (sore) bits.push(`reported sore after ${sore} of the last 3`);
  return bits.join("; ") + ".";
}

// ---------- cross-day memory ----------
// What the Brief actually SAID on the last few days, plus where today sits in the
// program. Without this the agent has no idea it has been repeating itself: a
// chronic short sleeper or a multi-week injury holds every input steady, so the same
// read is re-derived and re-worded identically, forever ("rest after rest after
// rest"). With it, the agent can say something new, acknowledge the continuity
// honestly, or admit plainly that nothing has moved. "" when there's no history.
function renderRecentReads(date: string): string {
  let prior: Array<{ date: string; kind: string; headline: string | null; why: string | null }> = [];
  try {
    prior = repo.recentDayReads(date, 3);
  } catch {
    return "";
  }
  if (!prior.length) return "";
  const lines = prior.map((r) => {
    const said = [r.headline, r.why]
      .filter((part): part is string => typeof part === "string" && !!part.trim())
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 220);
    return `- ${r.date} (${r.kind || "?"}): ${said || "(no text)"}`;
  });
  return `
WHAT YOU ALREADY TOLD THEM (the last few days' Briefs, most recent first):
${lines.join("\n")}
Do NOT reword yesterday and present it as today's read. If the picture genuinely has not
moved, SAY that plainly in your own words ("nothing's really moved since yesterday") and
keep it short — honesty reads better than a fresh-sounding sentence about the same facts.
If you are suggesting a third or fourth quiet day in a row, do not re-argue the case for
rest: acknowledge the stretch and offer the smallest thing worth doing, as an option.
`;
}

// How those reads actually LANDED. renderRecentReads above tells the agent what it
// SAID; nothing told it what happened next, so it could re-argue the same rest case
// for a fortnight without ever learning the athlete had trained through every one of
// them and rated the sessions well. That disagreement is measured (`read_adherence` —
// counts only, never a rate or a grade), and this is the one prompt where it is about
// the very decision being made.
//
// Only rendered once a pattern is genuinely there (two or more divergences on a read
// kind), so an athlete who follows their reads never carries this block; and never as a
// licence to escalate — the server owns the safety call and discards an upgrade, so the
// guidance is about how to shape the day already open, not about opening a bigger one.
//
// BOTH deterministic ladders are narrated, because both can already have acted before
// this prompt runs: rest → easy (outcome_feedback) and easy → train (easy_outcome_feedback).
// Carrying only the rest one left the agent blind to a day the easy ladder had opened,
// free to quietly write it back down to easy — the exact re-argument the ladder exists
// to end. Machine register throughout: this is evidence handed to the agent, not prose
// an athlete reads.
function renderReadOutcomes(context: any, baseline: any): string {
  const byRead = Array.isArray(context?.read_adherence?.by_read) ? context.read_adherence.by_read : [];
  // A kind's counts, or null when the pattern isn't there. `days < diverged` is a
  // malformed row, not a pattern.
  const pattern = (kind: string): { days: number; diverged: number; followed: number } | null => {
    const row = byRead.find((entry: any) => entry?.read === kind);
    const diverged = Number(row?.diverged ?? 0);
    const days = Number(row?.days ?? 0);
    if (!Number.isFinite(diverged) || diverged < 2 || !Number.isFinite(days) || days < diverged) return null;
    return { days, diverged, followed: Number(row?.followed ?? 0) };
  };
  const rest = pattern("rest");
  const easy = pattern("easy");
  if (!rest && !easy) return "";
  // `applied`, never `active`. `active` says only that the pattern exists, and it is
  // just as true on a morning that reads train or one where a clinical constraint held
  // the rest in place — so keying on it told the agent the day had been eased on
  // mornings where nothing had been eased at all.
  const restSoftened = baseline?.signals?.outcome_feedback?.applied === true;
  const easyOpened = baseline?.signals?.easy_outcome_feedback?.applied === true;
  const restLine = rest
    ? `
Of the ${rest.days} rest read${rest.days === 1 ? "" : "s"} in the recent window, they trained anyway on
${rest.diverged} and took ${rest.followed} as rest.${
        restSoftened
          ? `
Today's suggestion has ALREADY been eased from rest to an easy day for exactly this reason — that
easing is the answer to the pattern, so do not spend the read re-arguing it or apologising for it.`
          : ""
      }`
    : "";
  const easyLine = easy
    ? `
Of the ${easy.days} easy read${easy.days === 1 ? "" : "s"} in the recent window, they went above easy on
${easy.diverged} and kept ${easy.followed} at or under it.${
        easyOpened
          ? `
Today's suggestion has ALREADY been opened from easy to a training day for exactly this reason. That
opening IS the answer to the pattern — write the training day, and do NOT quietly walk it back to an
easy one or hedge it into a recovery session.`
          : ""
      }`
    : "";
  return `
HOW YOUR READS HAVE ACTUALLY LANDED:${restLine}${easyLine}
\`read_adherence\` in DATA has the day by day.
- A read they keep declining is not a read that is working. Do NOT re-derive the same case in fresh
  words. Say what today actually supports and let the day be theirs.
- Where today's picture leaves room, take the MORE PERMISSIVE of the readings open to you, and give
  them a reason to move by naming the concrete next thing their own logs support — a lift that has
  been sitting at the same weight and is ready to go up, a run that is due, a group that hasn't been
  touched this week. Grounded in what is actually in the data; never hype, never a target, never a
  gate, never a number about them.
- The safety call is NOT yours to raise. You may write a CALMER day than the one suggested above,
  never a bigger one — an upgrade is discarded and they see the plain version instead. So shape the
  day inside what is open rather than promising a session that isn't.
`;
}

// Where today sits in the program, so a deload day 3 of 7 is not proposed as though
// rest were a new idea. "" when no block and no overlay are running.
function renderPeriodization(date: string): string {
  let context: ReturnType<typeof repo.dayReadPeriodizationContext>;
  try {
    context = repo.dayReadPeriodizationContext(date);
  } catch {
    return "";
  }
  const bits: string[] = [];
  const block = context.program_block;
  if (block) {
    bits.push(
      `program block "${block.goal}" (${block.focus}) — week ${block.week_index} of ${block.total_weeks}, ${block.effective_phase} phase`
    );
  }
  const overlay = context.recovery_overlay;
  if (overlay) {
    bits.push(
      `a reduced-volume recovery week is running: day ${overlay.day_index} of ${overlay.total_days} (through ${overlay.until})`
    );
  }
  if (!bits.length) return "";
  return `
WHERE TODAY SITS: ${bits.join("; ")}. This is planned, not news — speak to it as an arc
they are already inside ("day three of the lighter week"), never as a fresh discovery.
`;
}

// A QUIET standing-health line for the Brief: the elite-coach synthesis headline +
// the one change, offered as optional pull — the day-read may fold ONE calm clause
// in when it naturally fits today, but usually leaves it unsaid (the Brief is about
// today's training, not a health lecture). "" when there's no synthesis yet.
function renderHealthLead(ctx: any): string {
  const s = ctx?.health_synthesis;
  if (!s || !(s.headline || s.one_change)) return "";
  const bits = [s.headline, s.one_change ? `the one change worth holding: ${s.one_change}` : null].filter(Boolean);
  return `\nSTANDING HEALTH FOCUS (their whole-picture read — surface at most ONE quiet clause and ONLY if it fits today, in a friend's voice, never alarming; usually leave it unsaid): ${bits.join(" — ")}\n`;
}

// The single agentic judgment at the heart of the product: given the whole
// picture, what KIND of day should this be? Honors the constitution — it's a
// SUGGESTION, never a verdict; kind, never anxious; plain language, never a
// score. repo.dayRead computes deterministic signals first; this builder asks
// the agent to make the nuanced call and write the human sentence. opts let the
// caller pass an escape-hatch override ("rough night" / "short on time").
// Round a minutes-ago gap to the nearest HALF hour for natural phrasing: 90 → 1.5,
// 120 → 2 (JS renders a whole number with no trailing ".0"), 105 → 2. Coarser than
// per-minute, kinder than the old whole-hour round that read 90 min as "about 2 h".
export function roundMinutesToHalfHour(mins: number): number {
  return Math.round(mins / 30) / 2;
}

// The deterministic facts behind a post-session DEBRIEF (the "done" read): what was
// trained today (top set per lift), how it fits the week, what the next session leans
// toward + what's due, and where fuel sits. Plain facts only — the agent turns them
// into a warm debrief. Every read is its own try/catch so a missing surface degrades
// to fewer facts, never throws. Returns "" when there's nothing concrete to say.
function debriefFacts(date: string): string {
  const lines: string[] = [];
  // 1) Today's session — the top set per lift + the volume done.
  try {
    const sess: any = repo.getSessionByDate(date);
    const sets: any[] = Array.isArray(sess?.sets) ? sess.sets : [];
    if (sets.length) {
      const top = new Map<string, any>();
      for (const s of sets) {
        const score =
          s.mode === "timed" ? Number(s.duration_sec) || 0 : (Number(s.weight) || 0) * 1000 + (Number(s.reps) || 0);
        const cur = top.get(s.exercise);
        if (!cur || score > cur._score) top.set(s.exercise, { ...s, _score: score });
      }
      const fmtSet = (s: any): string => {
        if (s.mode === "timed" && s.duration_sec != null) return `${s.duration_sec}s`;
        if (s.weight == null && s.reps != null) return `${s.reps} reps (bodyweight)`;
        if (s.weight != null && s.reps != null) {
          const w = Number(s.weight);
          const load = w < 0 ? `bw−${-w} lb` : w === 0 ? "bodyweight" : `${w} lb`;
          const rir = s.rir != null ? ` @RIR${s.rir}` : "";
          return `${load} × ${s.reps}${rir}`;
        }
        return "logged";
      };
      const lifts = [...top.entries()].slice(0, 8).map(([name, s]) => `${name} ${fmtSet(s)}`);
      const sum: any = repo.sessionSummary?.(sess.id) ?? null;
      const vol =
        sum && sum.tonnage > 0
          ? ` (${sum.sets} sets · ${Math.round(sum.tonnage).toLocaleString()} lb)`
          : sum
            ? ` (${sum.sets} sets)`
            : "";
      lines.push(`SESSION TODAY${sess.title ? ` — ${sess.title}` : ""}${vol}: ${lifts.join("; ")}.`);
    }
  } catch {
    /* no session detail → skip */
  }
  // 1b) Today's CARDIO — a synced/logged run or ride, with the physiology that's
  // actually there (distance · moving time · avg HR · pace), so the agent debriefs the
  // REAL effort instead of guessing ("an easy run" when it was a hard one). Plain
  // numbers, never a score; skip silently when nothing endurance was logged today.
  try {
    const cardio: any[] = repo.getCardioForDate?.(date) ?? [];
    for (const c of cardio.slice(0, 2)) {
      const bits: string[] = [];
      if (c?.distance_km != null) bits.push(`${Math.round(Number(c.distance_km) * 10) / 10} km`);
      if (c?.duration_min != null) bits.push(`${Math.round(Number(c.duration_min))} min`);
      if (c?.avg_hr != null) bits.push(`avg HR ${Math.round(Number(c.avg_hr))}`);
      if (c?.pace) bits.push(String(c.pace));
      const label = c?.type && c.type !== "other" ? String(c.type) : "cardio";
      if (bits.length)
        lines.push(`CARDIO TODAY — ${label}: ${bits.join(" · ")}${c?.source === "garmin" ? " (synced)" : ""}.`);
    }
  } catch {
    /* no cardio → skip */
  }
  // 2) Forward — the day-ahead (the SAME forwardLook the Brief's forward line uses).
  try {
    const fwd: any = repo.forwardLook(date);
    if (fwd?.next_focus) lines.push(`NEXT SESSION leans toward: ${fwd.next_focus}.`);
    if (Array.isArray(fwd?.due) && fwd.due.length) {
      lines.push(`DUE THIS WEEK (under its productive range — a good forward focus): ${fwd.due.join(", ")}.`);
    }
  } catch {
    /* no forward look → skip */
  }
  // 3) Fuel — PACE-AWARE. A raw "grams remaining" reads as a gap all morning (110 g
  // "short" at 11 AM is trivially true before dinner), so grade protein against where
  // you'd EXPECT to be at this point in the eating window: only genuinely-behind earns
  // a nudge; on-pace (even with grams still to eat) and comfortably-met do not. Never
  // a score. No derivable target → no fuel line, exactly as before.
  try {
    const fuel = repo.dayFuelState(date);
    if (fuel) {
      if (fuel.bucket === "behind") {
        const recency =
          fuel.last_meal && fuel.last_meal.minutes_ago >= 90
            ? ` Last logged intake was about ${roundMinutesToHalfHour(fuel.last_meal.minutes_ago)} h ago.`
            : "";
        lines.push(
          `FUEL: protein's running behind pace — ${fuel.protein_so_far_g} g in so far vs ~${fuel.expected_by_now_g} g you'd expect by now on a ${fuel.target_g} g day.${recency} A brief refuel nudge fits.`
        );
      } else if (fuel.bucket === "on_pace") {
        lines.push(
          `FUEL: protein's on pace for this point in the day (${fuel.protein_so_far_g} of ${fuel.target_g} g) — no nudge needed, even with more to eat later.`
        );
      } else {
        lines.push(`FUEL: protein target comfortably met today — no nudge needed.`);
      }
    }
  } catch {
    /* no nutrition target → no fuel line */
  }
  return lines.length
    ? `\nDEBRIEF FACTS (deterministic — weave only what's true, drop the rest):\n${lines.map((l) => `- ${l}`).join("\n")}`
    : "";
}

export function buildDayReadPrompt(
  ctx?: CoachContext,
  opts: { override?: string; date?: string; baseline?: repo.DayRead } = {}
): string {
  const context = dateScopedPromptContext(ctx ?? repo.getCoachContext(), opts.date);
  // The baseline the CALLER will clamp, persist and fingerprint — passed in so the
  // prompt describes the exact read the server-policy layer then acts on. Computing
  // a second one here is what opened the rich/thin seam: the agent was told
  // `A rules-only baseline suggested: …` and shown the signals of one state while
  // enforceDayReadSafetyPosture / enforceRecoveryWeekCadence clamped against
  // another, and the persisted row took its `signals` and `input_fingerprint` from
  // the second. The bare fallback stays for callers that only want the prose.
  const baseline = opts.baseline ?? repo.dayRead(opts.date, context.recovery, context.signal_state);
  // ===== FELT SIGNALS block (wave/felt-signals — self-contained, delimited) =====
  // What the athlete's OWN subjective signals reveal, relevant to TODAY: a recurring
  // Brief-override rhythm on this weekday (pre-acknowledge, never gate), a persistent
  // check-in read, or how a recent fuel change has felt. Calm, humble, adherence-
  // neutral; "" when there's nothing to say.
  const feltDate = opts.date || (context as any).now?.date || localDateISO();
  let feltBlock = "";
  try {
    const feltLines = repo.feltSignalDayLines(feltDate, (context as any).felt_signals?.patterns);
    if (feltLines.length) {
      feltBlock = `\nFELT SIGNALS (learned from THEIR OWN steers, check-ins and fuel reads — a suggestion to pre-acknowledge in a friend's voice when it fits, NEVER a gate or a number; usually one calm clause is plenty):\n${feltLines.map((l) => `- ${l}`).join("\n")}\n`;
    }
  } catch {
    feltBlock = "";
  }
  // ===== end FELT SIGNALS block =====
  // ===== LEARNED CROSS-DOMAIN block (wave/learned-models — self-contained) =====
  // What one domain's history quietly says about another, relevant to TODAY: whether
  // bigger run weeks have dented lower-body lifting (a standing tendency), and — only
  // when TONIGHT'S read was genuinely short — a calm short-night fueling nudge. Humble,
  // adherence-neutral, a suggestion never a gate; "" when there's nothing to say.
  let learnedBlock = "";
  try {
    const learnedLines = repo.learnedModelDayLines(feltDate, (context as any).learned_models?.patterns);
    if (learnedLines.length) {
      learnedBlock = `\nLEARNED CROSS-DOMAIN READS (from THEIR OWN history — coincidences to weave in a friend's voice when it fits, NEVER causal claims, a number, or a gate; usually one calm clause is plenty):\n${learnedLines.map((l) => `- ${l}`).join("\n")}\n`;
    }
  } catch {
    learnedBlock = "";
  }
  // ===== end LEARNED CROSS-DOMAIN block =====
  // The positive half of the signal state, named for the agent. `signal_state.action`
  // ships in DATA either way, but nothing in this prompt told the model what
  // `support: "backed"` MEANS, so the licensed-to-reach day and the ordinary train day
  // read identically on the agent path — the deterministic floor's push arm was the
  // only thing that ever noticed. One sentence, on the same terms as every other
  // learned block here: permission, never instruction, and still inside the grammar.
  let backedBlock = "";
  try {
    if ((context as any)?.signal_state?.action?.support?.level === "backed") {
      backedBlock = `\nTODAY IS BACKED (DATA.signal_state.action.support): their own recent logs say they are carrying this work well and nothing fresh is pulling the other way. You MAY shape the read as an invitation to reach a little further within the session — never longer, never a target, never a demand — or leave it as an ordinary good day if the whole picture reads better that way. Same rules as everything else: a suggestion in a friend's voice, no score, no gate.\n`;
    }
  } catch {
    backedBlock = "";
  }
  // The athlete's OWN standing choice, named on the same terms. `training_drive_push`
  // is set only when the deterministic gate has ALREADY passed (evidence green, muscle
  // groups genuinely due, inside the load ceiling, nothing clinical) on a day they have
  // explicitly set their drive to push. The safety clamp downstream only ever moves a
  // read LEFT, so without this nothing stopped one model sentence from quietly
  // reverting a setting they went and flipped — the same silence that left `backed`
  // invisible above.
  let driveBlock = "";
  try {
    const drive: any = (baseline.signals as any)?.training_drive_push;
    if (drive) {
      const due = Array.isArray(drive.due) && drive.due.length ? ` (what's due: ${drive.due.join(" and ")})` : "";
      driveBlock = `\nTHEY HAVE ASKED TO PUSH (DATA.signals.training_drive_push): this is the athlete's own standing choice, not an inference — they deliberately asked for the work that's due on a day that can carry it, and every condition for that has already been checked and met today${due}. Write the read as the targeted training day it is. You MAY still disagree, but only by naming the CONCRETE thing that changed your mind — a short night, a fresh flag, something they told you — never on taste, and never by quietly softening it into an ordinary easy day. Same rules as everything else: a suggestion in a friend's voice, no score, no gate.\n`;
    }
  } catch {
    driveBlock = "";
  }
  const overrideBlock = opts.override?.trim()
    ? `\nUSER OVERRIDE (honor this — they're steering): "${opts.override.trim()}". Reshape the read accordingly (e.g. "rough night" → lean easy/rest; "short on time" → a compressed session; "I want to train anyway" → a train read even if the baseline leaned rest, kept appropriately light).\n`
    : "";
  // A compact recent-training summary so the agent reads the rhythm without
  // digging through the raw DATA blob — last few sessions + days since each,
  // plus the whole-history rhythm line (frequency / freshness / emphasis).
  const allSessions = Array.isArray(context?.recent_sessions) ? context.recent_sessions : [];
  const sessions = allSessions.slice(0, 6);
  const sessionLine = sessions.length
    ? sessions
        .map((s: any) => {
          const nm = s?.title || s?.day_name;
          return `${s?.date ?? "?"}${nm ? ` (${nm})` : ""}`;
        })
        .join(", ")
    : "(no recent sessions logged)";
  const rhythmLine = trainingRhythmLine(allSessions, opts.date);
  // What's already on the board for today — a logged session and/or activities.
  // Surfaced explicitly so the agent reflects it ("nice, you've already moved")
  // instead of suggesting a fresh session as if the day were blank.
  const lt: any = baseline.signals && (baseline.signals as any).logged_today;
  const ltActs: any[] = Array.isArray(lt?.activities) ? lt.activities : [];
  const ltBits: string[] = [];
  if (lt && Number(lt.sets) > 0) ltBits.push(`${lt.sets} set${Number(lt.sets) === 1 ? "" : "s"} logged`);
  for (const a of ltActs) {
    const parts = [a?.type && a.type !== "other" ? String(a.type) : "activity"];
    if (a?.duration_min != null) parts.push(`${a.duration_min} min`);
    if (a?.distance_km != null) parts.push(`${a.distance_km} km`);
    ltBits.push(parts.join(" "));
  }
  const todayLine = ltBits.length
    ? `\nALREADY LOGGED TODAY: ${ltBits.join("; ")}. Acknowledge what they've already done and reflect it in the read — do NOT suggest a fresh session as if the day were blank.`
    : "";
  // Last night's sleep architecture + HRV in plain words (it's inside the signals
  // blob already, but called out so the agent actually voices it when it matters).
  const ln: any = baseline.signals && (baseline.signals as any).last_night;
  const lastNightLine =
    ln && ln.text
      ? `\nLAST NIGHT: ${ln.text}. When it's worth a mention, name last night in plain words — one calm clause in a friend's voice ("you slept well", "a bit light on deep sleep", "HRV's a touch below your norm") — never a number wall or a score, and let how they actually feel override it.`
      : `\nSLEEP/RECOVERY: no recent sleep or HRV data has synced. Do NOT claim or imply how they slept ("you slept fine", "well-rested", etc.) — you have no sleep signal for last night. Speak only to what the data actually shows (training, recovery trend, the day ahead).`;
  // The matching pair to the absent-data branch above, guarding the OPPOSITE
  // overclaim: one night narrated as a run of them. The deterministic floor no
  // longer does this, but the agent writes the prose the athlete actually reads,
  // and nothing else in the prompt tells it that `LAST NIGHT: 4h50m sleep.` is a
  // single data point while neighbouring lines legitimately read as trends.
  // `low_sleep` is the multi-night flag (the <6h AVERAGE), so it — never last
  // night's number — is what licenses a "lately" sentence. Four straight 290-min
  // nights can still sit under a 390-min average with low_sleep false, which is
  // exactly the case where a "stacking up" sentence contradicts the signals.
  const oneNightLine =
    ln && ln.text
      ? `\nONE NIGHT IS NOT A TREND: the line above is LAST NIGHT ONLY. Do NOT present it as a pattern ("short nights have been stacking up", "you've been sleeping badly lately", "you've been running short all week") unless the SIGNALS block backs one — \`low_sleep\` is the deterministic flag for a genuinely short multi-night AVERAGE, \`avg_sleep_min\` is that average, and \`fatigue.sleep_vs_norm\` is how far last night sat from their norm. When only last night is short, name it as one night ("last night was a short one") and let today's read rest on it as a single data point.`
      : "";
  const readiness: any = baseline.signals && (baseline.signals as any).fatigue?.readiness;
  const readinessLine =
    readiness?.current != null
      ? `\nREADINESS: current ${Math.round(Number(readiness.current))} (${readiness.current_date || "date unknown"}; ${readiness.freshness || "unknown freshness"})${readiness.window_average != null ? ` vs ${Math.round(Number(readiness.window_average))} window average` : ""}${readiness.sample_count != null && readiness.window_days != null ? ` from ${readiness.sample_count}/${readiness.window_days} days` : ""}. Treat only a FRESH current reading as a today-decision signal; an average or stale/sparse reading is context, never a gate.`
      : `\nREADINESS: no current readiness reading. A window average, if present in DATA, is context only and must not be described as today's state.`;
  // Does TODAY carry bigger work than an ordinary day (a long run, a quality session,
  // a heavy lower day, a strength+run double)? Forward-looking only, and only while the
  // work is still ahead: once the day is logged, a line about fueling it could only read
  // as a verdict on what they ate, which the nutrition laws forbid outright. Silent on a
  // standard or light day — most days say nothing here.
  const fuelDemandLine = (() => {
    if (baseline.kind === "done") return "";
    try {
      const demand: any = repo.dayFuelDemand(opts.date || context.now?.date || localDateISO());
      if (demand?.demand !== "big") return "";
      const drivers = Array.isArray(demand.drivers) && demand.drivers.length ? ` (${demand.drivers.join("; ")})` : "";
      return `\nTODAY'S FUEL DEMAND: today carries bigger work than an ordinary day${drivers}. If food comes up at all, ONE calm clause is enough — carbohydrate earns its place around that work. DATA.fuel_demand carries the same read for the days ahead. This is never a change to their accepted daily target, and never a judgement about what they have or haven't eaten.`;
    } catch {
      return "";
    }
  })();
  // The user has ALREADY completed a real, loading session today (a deterministic
  // fact). This becomes a post-session DEBRIEF, not a fresh suggestion: acknowledge the
  // specific work, place it in the week, give ONE forward focus, and nudge refuel only
  // if there's a real gap. The facts below are deterministic; the agent writes the prose.
  const doneBlock =
    baseline.kind === "done"
      ? `\nDEBRIEF MODE (a real, loading session is already logged today — this is a post-session debrief, NOT a fresh suggestion):
- Do NOT propose more training unless they ask. The day's work is in.
- "headline": acknowledge the WORK specifically — name what they actually did (a standout lift from SESSION TODAY, or the run/ride from CARDIO TODAY with its real effort) like a friend who watched you train, e.g. "Strong push session." / "Solid 6 km — you pushed that one.". If CARDIO TODAY shows a hard effort (high avg HR), don't call it "easy".
- "why": for a DONE day you MAY use 2-3 short sentences (the one exception to one-sentence): (1) how today fits the week's rhythm, (2) ONE forward focus — what the next session leans toward / what's DUE, (3) a brief refuel nudge ONLY if FUEL shows a real protein gap. Warm, plain, never a number-wall or a score.
- Output "kind":"done", "focus":null, "est_minutes":null. DONE is a factual temporal state, not another easy-day recommendation.${debriefFacts(opts.date || context.now?.date || localDateISO())}`
      : "";
  return `${CAIRN_PERSONA}

This is the Brief — today's day-read. Read their WHOLE picture and
judge what kind of day today should be: a real session, easy movement, or rest. This opens their
app — it is the first and often only thing they see.
${renderNow(context)}${readinessLine}
THE CONSTITUTION (binding):
- It is a SUGGESTION you offer, never a verdict you impose. The user drives; you navigate.
- Be KIND and never anxious. Rest is wisdom, not failure. A low signal is information, never a
  judgement; their felt experience overrides any number.
- CALM and plain. No 0-100 scores, no metric dump — numbers are vanity. Say the one true thing in
  a friend's voice. Three lines on a good day.
- Protect rest when it's earned (several hard days running, short sleep, run-down) — do NOT default
  to opening a lifting plan every morning. Never insist on rest either. When you suggest rest, frame
  it as the wise, earned choice ("rest is wisdom"), never as falling behind.
- ANTICIPATE fatigue, don't just react to it. When the signals carry a "fatigue" block with
  anticipate_deload=true, recovery is drifting below the user's OWN norm (HRV down / resting HR up
  / sleep short vs baseline) while training days stack up — so today can still be a GREEN-LIGHT to
  train, but add a gentle forward-looking heads-up in a friend's voice ("you're good today, but a
  couple more hard days and you'll likely want a reset"). It's a kind early warning, never a brake or
  a verdict — the user still drives.

DETERMINISTIC SIGNALS already computed (use them, but you make the final nuanced call):
${JSON.stringify(baseline.signals)}
A rules-only baseline suggested: kind="${baseline.kind}", focus=${JSON.stringify(baseline.focus)}.
You MAY disagree with the baseline when the whole picture warrants it — it is a floor, not a ceiling.
RECENT TRAINING (most recent first): ${sessionLine}.
TRAINING RHYTHM (read the whole history, not just today): ${rhythmLine}${todayLine}${renderRecentReads(feltDate)}${renderReadOutcomes(context, baseline)}${renderPeriodization(feltDate)}${doneBlock}${lastNightLine}${oneNightLine}${fuelDemandLine}
${CONTEXT_GUARDRAILS}
${renderSignalState(context)}${renderCoachingFocus(context, { brief: true })}${renderDiscipline(context, "day")}${renderEnduranceGoal(context, "day")}${renderRunCompliance(context, "day")}${renderRunZones(context)}${renderRunPlan(context)}${renderConnectedBrain(context, { domains: ["training", "watch"] })}${renderProgramState(context, { brief: true })}${renderMuscleGroups(context)}${renderPerformance(context, { brief: true })}${renderDexaTargeting(context, "training")}${renderBodyComp(context)}${renderHealthLead(context)}${renderReactionModel(context)}${renderTrajectory(context)}${renderActiveContext(context)}${renderTodayFuel(context)}${feltBlock}${learnedBlock}${backedBlock}${driveBlock}${overrideBlock}
${renderJsonContract(DAY_READ_SCHEMA)}

DATA:
${promptData(context, "day_read")}`;
}

// ---------- on-demand session ("build me a session for today" — Phase 1D) ----------
const SESSION_SUGGEST_SCHEMA = `{
  "name": "<short session name, e.g. 'Lower body — quad focus' or 'Easy Z2 run'>",
  "focus": "<muscle/quality focus>",
  "est_minutes": <total minutes, number>,
  "why": "<one plain sentence on why this fits today>",
  "items": [
    { "exercise": "<exact name; reuse plan/exercise names where sensible>",
      "sets": <number>, "rep_low": <number|null>, "rep_high": <number|null>,
      "target_weight": <number|null>, "target_seconds": <number|null>,
      "mode": "reps|timed", "note": "<short cue / why, optional>" },
    { "kind": "cardio", "exercise": "<the activity, e.g. 'Easy run' / 'Z2 ride'>",
      "target_distance_km": <number|null>, "target_duration_min": <number|null>,
      "target_zone": "<'Z2' | 'tempo' | 'easy' | null>", "note": "<optional — interval structure / cue>" }
  ],
  "notes": "<optional — swaps, equipment, anything to flag>"
}`;

// "Ask it for a session right now." An on-demand agentic call that honors the
// user's constraints (a time budget, an injury, available equipment) and the
// day read, returning a session SUGGESTION for review (you drive — nothing is
// applied). opts carry the constraints the launchpad chips pass through.
export function buildSessionPrompt(
  ctx?: CoachContext,
  opts: { minutes?: number; equipment?: string; focus?: string; constraints?: string; date?: string } = {}
): string {
  const context = dateScopedPromptContext(ctx ?? repo.getCoachContext(), opts.date);
  const read = repo.dayRead(opts.date, context.recovery, context.signal_state);
  // Runner+lifter sequencing (hybrid interference/synergy) — deterministic, quiet when
  // there's nothing to sequence. Anchored to the same date the day-read used.
  const dateISO = opts.date || (context as any).now?.date || localDateISO();
  const hybrid = (() => {
    try {
      // Same flexible-agenda override as dayRead so KEY RUN TOMORROW matches the Brief.
      return repo.withFlexibleRunLookahead(repo.hybridDayContext(dateISO), dateISO);
    } catch {
      return null;
    }
  })();
  const wants: string[] = [];
  if (opts.minutes)
    wants.push(
      `TIME BUDGET: about ${Math.round(opts.minutes)} minutes — fit the whole session in that (drop accessories before compounds).`
    );
  if (opts.focus) wants.push(`FOCUS REQUESTED: ${opts.focus.trim()}.`);
  if (opts.equipment) wants.push(`EQUIPMENT AVAILABLE: ${opts.equipment.trim()} — only program what this allows.`);
  if (opts.constraints)
    wants.push(
      `WHAT THEY SAID (free text — read it like a coach and adapt): "${opts.constraints.trim()}". Honor the spirit: a sore/tired area → de-load or SWAP it for a different pattern / lower-impact option (see the swap menu); "easier" → lighter loads + shorter; "no <equipment>" → only what's available.`
    );
  // When the user asks for something specific (a sore area, a focus, an
  // equipment limit), hand the agent a concrete SWAP MENU from the variation
  // library so it trades a movement for a real same-pattern alternative instead of
  // inventing one. Bounded; only when there's a request to adapt to.
  let swapMenu = "";
  if (opts.constraints || opts.focus) {
    const injuryAreas = activeInjuryAreas(context);
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const day of Array.isArray(context?.plan) ? (context.plan as any[]) : []) {
      for (const it of Array.isArray(day?.items) ? day.items : []) {
        const name = it?.exercise;
        if (!name || seen.has(name)) continue;
        seen.add(name);
        // Injury-aware swaps so "easier on the legs" with a bad knee never offers a
        // knee-loading alternative.
        const alts = (repo.suggestAlternatives(name, { limit: 3, injuryAreas }) as any[]).map((v) => v.name);
        if (alts.length) lines.push(`- ${name} → ${alts.join(", ")}`);
        if (lines.length >= 12) break;
      }
      if (lines.length >= 12) break;
    }
    if (lines.length) {
      swapMenu = `\nSWAP MENU (same-pattern alternatives for the plan's movements — use these to honor the request: trade a sore-area or off-limits lift for a different pattern or a lower-impact option, keeping loads conservative; you may also program something not listed):\n${lines.join("\n")}\n`;
    }
  }
  return `${CAIRN_PERSONA}

Right now you're the strength & conditioning coach. Build ONE session for today,
on demand, honoring their real constraints and whole picture. This is a SUGGESTION for them to
review — nothing is applied automatically (they drive).
${renderNow(context)}
GUARDRAILS:
- Conservative loading; respect every exercise constraint_note (e.g. injury limits)
  and any active injury in context_events — never program loaded movement through an injured area.
${MECHANICS_ENCODING}
- Carry over sensible working weights from the plan / recent logs where they fit. Thin data → start
  light with a "NEW — start light, log actual" note.
- Honor the day read: if today reads as rest/easy (kind="${read.kind}"), keep this session light and
  short unless the user explicitly asked to train hard.

${ELITE_STRENGTH_GUARDRAILS}

${CONTEXT_GUARDRAILS}
${renderCoachingFocus(context)}${COACHING_STANCE}

${renderDiscipline(context, "training")}${renderEnduranceGoal(context, "training")}${renderRunZones(context)}${renderRunPlan(context)}${renderHybridSequencing(hybrid, dateISO)}${renderConnectedBrain(context, { domains: ["training", "watch"] })}${renderTrainingSignals(context)}${renderProgramState(context)}${renderMuscleGroups(context)}${renderPerformance(context)}${renderDexaTargeting(context, "training")}${renderBodyComp(context)}${renderReactionModel(context)}${renderActiveContext(context)}${renderTodayFuel(context)}${
  wants.length
    ? `
WHAT THE USER ASKED FOR:
${wants.join("\n")}
`
    : ""
}${swapMenu}
${renderStreamingContract(
  'write ONE or two plain sentences on why this session fits them today (the same thought that goes in the JSON\'s "why")',
  SESSION_SUGGEST_SCHEMA
)}

DATA:
${promptData(context, "session")}`;
}

// ---------- Stage 3: bounded agent composition (docs §5) ----------
// Compose ONE session strictly INSIDE the deterministic Stage 2 decision
// envelope. The server has already decided the KIND, the muscle allow/exclude
// lists, the caps, and the candidate movements with reason codes; the agent's
// only job is to turn that envelope into ordered, well-cued items. Everything the
// agent returns is re-verified and clamped server-side (exclusions, load caps,
// safe novel-exercise rules), so this prompt is guidance, not the safety layer.
export function buildDailyCompositionPrompt(envelope: any, ctx?: CoachContext): string {
  const context = dateScopedPromptContext(ctx ?? repo.getCoachContext(), envelope?.date);
  const muscles = envelope?.muscles ?? {};
  const caps = envelope?.caps ?? {};
  const candidates = Array.isArray(envelope?.candidates) ? envelope.candidates : [];
  const candidateLines = candidates
    .filter((c: any) => c?.action !== "exclude")
    .slice(0, 16)
    .map((c: any) => {
      // A peak day is TWO tiers. Naming the heavy single here keeps the agent from
      // writing a session around the back-off block alone, or from inventing a
      // second one of its own — the server inserts the actual top-set line after
      // composition (normalizeComposedSession), so this is context, not a request.
      const tiers =
        c.top_set && c.top_set.weight != null && c.top_set.reps != null
          ? ` — peak day: one heavy top set of ${c.top_set.reps} at ${c.top_set.weight}, THEN the back-off block below (the server writes the top set in for you; compose the back-off work)`
          : "";
      return `- ${c.exercise}${c.muscle_group ? ` (${c.muscle_group})` : ""}: ${c.action}${tiers}${c.note ? ` — ${c.note}` : ""}`;
    })
    .join("\n");
  const excludedList = Array.isArray(muscles.excluded) ? muscles.excluded : [];
  const reducedList = Array.isArray(muscles.reduced) ? muscles.reduced : [];
  const requiredList = Array.isArray(muscles.required) ? muscles.required : [];
  return `${CAIRN_PERSONA}

Right now you're the strength & conditioning coach composing ONE session for today.
A deterministic policy has ALREADY decided what kind of day this is and the safe
envelope to work inside. Your job is to compose the best session WITHIN that
envelope — you do not override its safety bounds. This is a SUGGESTION for review;
nothing is applied automatically.
${renderNow(context)}
THE ENVELOPE (decided for you — compose inside it):
- Day kind: ${envelope?.kind ?? "train"}.
- Focus: ${envelope?.template?.focus ?? "general"}.
- Required muscle areas to hit: ${requiredList.length ? requiredList.join(", ") : "coach's discretion within allowed"}.
- Allowed areas: ${(Array.isArray(muscles.allowed) ? muscles.allowed : []).join(", ") || "any not excluded"}.
- REDUCE (recently loaded — keep light, do NOT overload): ${reducedList.length ? reducedList.join(", ") : "none"}. The server clamps these areas down (fewer sets, an easier target) whatever you write, so compose them light on purpose rather than having it done to you.
- EXCLUDED (do NOT program any loaded work here): ${excludedList.length ? excludedList.join(", ") : "none"}.
- Caps: volume=${caps.volume ?? "normal"}, intensity=${caps.intensity ?? "normal"}${caps.duration_min ? `, about ${caps.duration_min} minutes total` : ""}.

CANDIDATE MOVEMENTS (prefer these; the action is the progression the policy chose):
${candidateLines || "- (no template candidates — compose from the allowed areas)"}

HARD RULES (the server enforces these; violating them just gets your item dropped):
- Never program loaded movement through an EXCLUDED area or an injured joint.
- Honor the caps: an "easy"/"deload" intensity means submaximal loads; a "reduced"/"minimal"
  volume means fewer sets and movements.
${MECHANICS_ENCODING}
- SAFE EXERCISE INTRODUCTION: prefer movements the athlete already trains or a
  canonical same-pattern substitution. You may introduce AT MOST ONE genuinely new
  movement, only if equipment + injuries allow it; for a new movement give conservative
  technique volume, NO precise working load (target_weight null), and label it as
  establishing a baseline. Never add a movement just to add variety.${
    excludedList.length
      ? `\n- NO NEW MOVEMENTS TODAY: because ${excludedList.join(", ")} ${excludedList.length === 1 ? "is" : "are"} excluded, novel movements are unavailable (the server cannot verify an unknown movement avoids the excluded area). Compose only from movements already in the athlete's history.`
      : ""
  }

${ELITE_STRENGTH_GUARDRAILS}

${CONTEXT_GUARDRAILS}${COACHING_STANCE}

${renderStreamingContract(
  'write ONE or two plain sentences on why this session fits them today (the same thought that goes in the JSON\'s "why")',
  SESSION_SUGGEST_SCHEMA
)}

DATA:
${promptData(context, "daily_composition")}`;
}

// ---------- quiet cross-domain insight (Phase 6A — pull, never push) ----------
// TRAP, if anyone later wires JSON-schema structured output for the insight op:
// `connection` MUST be named in that schema. Constrained decoding drops fields the
// schema does not name, and `additionalProperties: true` does NOT prevent it (see
// docs/ARCHITECTURE.md on agent structured output) — the model would emit prose with
// no connection object, every insight would fall back to text-only derivation, and
// the dedup regression would be silent.
const INSIGHT_SCHEMA = `{
  "kind": "connection",
  "found": true,
  "connection": {
    "a": {"facet": "<one facet from the list above>", "direction": "up|down"},
    "b": {"facet": "<a facet from a DIFFERENT domain>", "direction": "up|down"}
  },
  "text": "<the ONE connection, one or two plain sentences in a friend's voice — NO numbers as scores, NO alarm>",
  "rationale": "<ONE short sentence (≤240 chars) of plain-language reasoning that backs the connection — speak TO the user ('your recent labs show…'), never narrate the data structures you were given>",
  "next_step": "<OPTIONAL: one concrete, low-friction next step (a food swap, a retest to consider) in ≤140 chars, or null — calm, never a directive>"
}`;

// The quiet-intelligence pass. Hunts the user's WHOLE picture for ONE genuine
// cross-domain connection they couldn't easily make themselves — the kind a
// friend who knew their labs, training, food and life would notice ("ferritin
// ran low in spring and your volume's been down since — could be iron-limited").
// It runs on demand / periodically and the result waits in-app; NOTHING is
// pushed. Honors the constitution: at most one real thing, plainly, kindly, or
// nothing at all. recent[] are insights already surfaced — do NOT repeat them.

export function buildInsightPrompt(
  ctx?: CoachContext,
  recent: string[] = [],
  liked: string[] = [],
  priorKeys: string[] = []
): string {
  const context = ctx ?? repo.getCoachContext();
  // What's already been covered is stated as TERRITORY, not as sentences. Listing the
  // prose invited a rewrite of it (the model reads "don't say this" and writes the
  // same claim in new words, which the text guard then waves through); naming the
  // facet pair says the connection itself is spent. `recent` is the residue: rows
  // whose territory could not be derived, still listed verbatim so a literal repeat
  // stays blocked.
  // Both lists are capped HERE — the one place every caller passes through — because
  // the corpus they come from is deliberately whole (the dedupe guards and the cache
  // key need all of it) and can run to a couple hundred rows over 90 days. Newest
  // first: the corpus is built id-DESC.
  const coveredLines = priorKeys
    .map((k) => repo.describeInsightIntentKey(k))
    .filter((d): d is string => !!d)
    .slice(0, repo.INSIGHT_PROMPT_COVERED_LIMIT)
    .map((d) => `  - ${d}`);
  const recentTexts = recent.slice(0, repo.INSIGHT_PROMPT_UNKEYED_LIMIT);
  const coveredBlock = coveredLines.length
    ? `\nALREADY COVERED (these connections are spent — do NOT make the same link again in different words; find genuinely new territory, or return found:false):\n${coveredLines.join("\n")}\n`
    : "";
  const recentBlock = recentTexts.length
    ? `\nALREADY SAID (do NOT repeat or reword any of these — find something genuinely new, or return found:false):\n${recentTexts.map((r) => `  - ${r}`).join("\n")}\n`
    : "";
  // The positive half of the same one-tap. Deliberately weaker than the block above:
  // "already said" is a prohibition, this is a direction, and it must never become a
  // reason to manufacture a connection the data doesn't carry (the constitution's
  // silence-is-usually-right rule outranks it, which is why that is said here too).
  const likedBlock = liked.length
    ? `\nTHEY LIKED THESE (a direction, not a template — the kind of connection that landed for this person; aim near it when the data genuinely offers one, and still return found:false when it doesn't):\n${liked.map((r) => `  - ${r}`).join("\n")}\n`
    : "";
  return `${CAIRN_PERSONA}

Look across their WHOLE picture
and find the ONE genuine cross-domain connection they likely couldn't make themselves — a thread that
links two domains (a lab marker and their training, their sleep/recovery and their nutrition, a life
event and a dip in volume). The kind of thing a sharp friend who quietly knew everything about them
would mention — once, when they happen to open the app.

THE CONSTITUTION (binding):
- PULL, never push. This waits in-app; it is never a notification, never a nag, never urgent.
- Exactly ONE connection, or NOTHING. If there isn't a real, data-grounded thread worth saying,
  return {"found": false} — silence is the right answer far more often than not. Do not manufacture
  an insight to fill the space.
- GROUNDED in their ACTUAL data only (recovery, markers/directives, training, nutrition, life/family
  context below). Never generic wellness advice; never a connection the data doesn't support.
- CALM and KIND. Plain language, a friend's voice. NO 0-100 scores, no metric dump, no alarm, no
  "you should" — offer a thought and an optional next step, never a verdict or a gate. Health findings
  are informational, NOT medical advice; defer anything clinical to a clinician.
- BRIEF and HUMAN. The headline carries the point; the rationale is ONE short sentence, not a
  paragraph. Speak TO the user in everyday words — NEVER narrate the data you were handed or name
  its internal fields (no "the health_review confirms…", "recent_sessions show…", "the goal object").
  No grocery-list of evidence; one plain reason is enough.
- It is a suggestion, never pressure. Rest and a quiet week are healthy, not problems to solve.
${coveredBlock}${recentBlock}${likedBlock}
NAME WHAT YOU CONNECTED. Alongside the prose, tag the two sides of the connection with facets from
this closed list, and say which way each one moved ("up" / "down" — bigger/smaller, better/worse):
${repo.renderInsightFacetVocabulary()}
The two facets MUST come from different domains — a link inside one domain is not a cross-domain
connection. Pick the closest facet; if nothing on the list fits either side, the connection isn't one
this can carry, so return {"found": false}.

${renderTodayFuel(context)}
${renderJsonContract(INSIGHT_SCHEMA, {
    lead: `When there's nothing real to say: {"found": false}
When there is exactly one genuine connection:`,
  })}

DATA:
${promptData(context, "insight")}`;
}

// ---------- standing weekly read (Phase 6B — a read that waits, not a nag) ----------
const WEEKLY_READ_SCHEMA = `{
  "kind": "weekly_read",
  "found": true,
  "text": "<how the week actually went, one or two warm plain sentences — a rest week reads as a rest week, not a failure; NO scores>",
  "rationale": "<OPTIONAL: ONE short sentence (≤240 chars) of plain reasoning for the suggestion below, in a friend's voice — never narrate internal data fields. Empty when the week needs no change>",
  "next_step": "<OPTIONAL: the ONE change worth considering next week, ≤140 chars, or null — a suggestion to consider, never a directive>"
}`;

// A standing "here's how your week went + the one change I'd suggest" that WAITS
// in-app for the user to read whenever they like — pull, never push. Stored
// as an insight with kind:'weekly_read' so the Brief can surface it like any
// other quiet line. Same calm voice as the cross-domain pass; honest continuity
// (six steady weeks is "nice", a light week is fine), never streak pressure.
export function buildWeeklyReadPrompt(ctx?: CoachContext): string {
  const base = ctx ?? repo.getCoachContext();
  // "At most ONE calm accountability verdict" is enforced here, not just asked of
  // the model: the weekly read's data carries only the single most recently
  // evaluated decisive outcome, so a second verdict cannot be mentioned. Other
  // surfaces (chat) keep the full per-decision outcomes.
  const decisions = Array.isArray((base as any).recent_decisions) ? (base as any).recent_decisions : [];
  const decisiveAt = (row: any) =>
    row?.latest_outcome && ["aligned", "not_aligned"].includes(row.latest_outcome.verdict)
      ? String(row.latest_outcome.evaluated_at ?? "")
      : null;
  const keep = decisions.reduce(
    (best: any, row: any) => (String(decisiveAt(row) ?? "") > String(decisiveAt(best) ?? "") ? row : best),
    null
  );
  const context = {
    ...base,
    recent_decisions: decisions.map((row: any) =>
      row === keep || !decisiveAt(row) ? row : { ...row, latest_outcome: null }
    ),
  };
  return `${CAIRN_PERSONA}

Prepare a short standing read of
how THIS WEEK actually went and the ONE change — if any — worth considering next week. It waits in the
app for them to read when they like; it is NEVER pushed at them.

THE CONSTITUTION (binding):
- CALM, KIND, plain language, a friend's voice. NO 0-100 scores, no metric wall, no judgement.
- Honest continuity, NOT streaks. A week with two rest days and a trip is a HEALTHY week — say so.
  Rest is wisdom, not a gap. Never imply a chain to keep or a failure to fix.
- At most ONE suggested change, plainly justified from what the data shows actually happened — and it
  is a suggestion to consider, never a directive. If the week went well and nothing needs changing,
  say that warmly and leave rationale and next_step empty. If there's genuinely nothing to report,
  return {"found": false}.
- If DATA.recent_decisions contains a mature latest_outcome worth mentioning, include AT MOST ONE calm
  accountability verdict: "that moved as expected", "that did not match what I expected", or "we cannot
  tell yet". Never claim causation, never list every check, and never turn it into a grade.
- BRIEF and HUMAN. The headline carries the read; rationale is ONE short sentence, never a paragraph.
  Speak TO the user in everyday words — NEVER narrate the data you were handed or name its internal
  fields. The one change, if any, goes in next_step.
- Grounded in their ACTUAL recent data only (training, recovery, nutrition, life context below).
${renderRunCompliance(context, "weekly")}
${renderTodayFuel(context)}
${renderStreamingContract(
  'write how their week actually went in ONE or two warm plain sentences (the same reading that goes in the JSON\'s "text")',
  WEEKLY_READ_SCHEMA,
  { emptyAnswer: '{"found": false}' }
)}

DATA:
${promptData(context, "weekly_read")}`;
}
