import * as repo from "./repo.js";
import { runAgentWithFallback, setAgentRunSink } from "./agents.js";
import { buildCoachPrompt } from "./prompt.js";
import { evolveProgram, generateInsight, nutritionCheckin, synthesizeHealth } from "./coachOps.js";
import { precomputeDayRead, localToday } from "./dayread.js";
import { checkForUpdate } from "./updateCheck.js";
// Stream 2 (self-updating memory): quiet nightly memory housekeeping + outcome
// reconciliation. Lazy-imported in the tick so this module stays decoupled.

// Weekly auto-draft + quiet proactivity. Configured in Settings (persisted in
// the DB, editable from the PWA at runtime — no restart needed): coach_enabled,
// coach_day (0=Sun..6=Sat), coach_hour (local). When the slot arrives it drafts
// ONE proposal using the configured agent rotation (round-robin / random /
// priority, with fallthrough). It never auto-applies — you review and tap Apply.
//
// The weekly coach draft is MISS-TOLERANT: rather than firing only on exact
// hour equality (which silently skips the week if the process was asleep at that
// minute), it fires when the most recent scheduled slot has passed and it hasn't
// run for that slot yet — tracked via a persisted last-run stamp (app_state), so
// a missed slot still drafts once when the server comes back.
//
// Proactivity (gated behind settings.proactive_enabled, default on) is PULL,
// NEVER push: it only STORES a waiting read (a quiet nightly insight, a weekly
// read, a drifted-nutrition draft) — no notification, no nag ever fires.
//
// First-run defaults seed from COACH_AGENT/COACH_DAY/COACH_HOUR env vars so
// existing deployments keep working until you change anything in Settings.
//
// Also hosts the Garmin auto-sync (boot + ~6h cadence, only when configured).

const DAY_MS = 24 * 60 * 60 * 1000;

// The most recent past (or current) occurrence of weekday `day` at hour `hour`,
// as a local Date. Used for miss-tolerant weekly slots: if `now >= slot` and we
// haven't run for that slot's date, the slot is due.
function lastScheduledSlot(now: Date, day: number, hour: number): Date {
  const slot = new Date(now);
  slot.setHours(hour, 0, 0, 0);
  // Walk back to the target weekday (0..6). If today IS the day but the hour
  // hasn't arrived yet, this still lands today and the now>=slot guard defers it.
  let back = (now.getDay() - day + 7) % 7;
  // If it's the right weekday but before the hour, the most recent occurrence was
  // a week ago.
  if (back === 0 && now.getTime() < slot.getTime()) back = 7;
  slot.setTime(slot.getTime() - back * DAY_MS);
  return slot;
}

// True when the weekly slot's most recent occurrence has passed and the persisted
// last-run stamp doesn't already cover it. Records the stamp as a side effect
// when it returns true (so it fires once per slot, restart-tolerant).
function weeklySlotDue(now: Date, day: number, hour: number, stateKey: string): boolean {
  const slot = lastScheduledSlot(now, day, hour);
  if (now.getTime() < slot.getTime()) return false; // the slot hasn't arrived yet
  const slotStamp = localToday(slot);
  if (repo.getAppState(stateKey) === slotStamp) return false; // already ran for this slot
  repo.setAppState(stateKey, slotStamp);
  return true;
}

export function startScheduler() {
  // Wire agent-run telemetry: agents.ts can't import repo.ts (circular), so it
  // emits through a registered sink. recordAgentRun is itself failure-safe.
  setAgentRunSink((r) => repo.recordAgentRun(r));

  // The small-hours hour the nightly Brief precompute + quiet insight run at.
  // Declared up front so both the proactive tick and the precompute tick share it.
  const PRECOMPUTE_HOUR = (() => {
    const h = Number(process.env.DAYREAD_PRECOMPUTE_HOUR);
    return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 4; // default 4am local
  })();

  // ---- Weekly coach draft (miss-tolerant) ----
  let coachBusy = false;
  const tick = async () => {
    if (coachBusy) return;
    const s = repo.getSettings();
    if (!s.coach_enabled) return;
    const now = new Date();
    if (!weeklySlotDue(now, s.coach_day, s.coach_hour, "coach_last_slot")) return;
    coachBusy = true;
    try {
      const prompt = buildCoachPrompt("Weekly automatic review.");
      const { agent, result } = await runAgentWithFallback(repo.pickAgentOrder(), prompt, { op: "coach_draft" });
      repo.createProposal(agent, "auto: weekly review", result.raw, result.parsed);
      console.log(`Auto-coach drafted a proposal via ${agent} (parsed=${!!result.parsed}).`);
    } catch (e: any) {
      console.error(`Auto-coach failed: ${e.message}`);
    } finally {
      coachBusy = false;
    }
  };

  // ---- Quiet proactivity (pull-never-push): nightly insight, weekly read,
  //      weekly nutrition check-in. Each only STORES a waiting read/draft. ----
  let proactiveBusy = false;
  const proactiveTick = async () => {
    if (proactiveBusy) return;
    const s = repo.getSettings();
    if (!s.proactive_enabled) return;
    const now = new Date();

    // (a) Nightly quiet insight — once per day, in the small hours alongside the
    //     Brief precompute. generateInsight emits ONE genuine connection or
    //     ok:false (dedup-guarded); a near-repeat / nothing-real is a calm no-op.
    const insightDue =
      now.getHours() === PRECOMPUTE_HOUR && repo.getAppState("insight_last_date") !== localToday(now);
    // (b) Weekly read — on the configured coach day/hour (miss-tolerant). A
    //     standing "how the week went + the one change", stored as a weekly_read
    //     insight. Reuses the coach slot so it lands on the same cadence.
    const weeklyDue = weeklySlotDue(now, s.coach_day, s.coach_hour, "weekly_read_last_slot");
    // (c) Weekly nutrition check-in — on the coach day/hour too (miss-tolerant).
    //     Drafts a nutrition_target proposal ONLY on meaningful drift; the calm,
    //     common answer is change:false (no draft).
    const nutritionDue = weeklySlotDue(now, s.coach_day, s.coach_hour, "nutrition_checkin_last_slot");
    // (d) Weekly plan EVOLUTION — the continuous-coach cadence (miss-tolerant). Drafts
    //     a plan-evolution proposal (progress what's working, deload/rotate what's
    //     stalled, ground targets in logged reality, rebalance toward weak points) and
    //     leaves it WAITING for review — pull, never push. Only when there's a plan to
    //     evolve; a fresh weekly draft retires the prior unreviewed auto one (no pile-up).
    const evolutionDue = weeklySlotDue(now, s.coach_day, s.coach_hour, "program_evolution_last_slot");

    if (!insightDue && !weeklyDue && !nutritionDue && !evolutionDue) return;
    proactiveBusy = true;
    try {
      if (insightDue) {
        repo.setAppState("insight_last_date", localToday(now));
        try {
          // Warm the ai_cache with a 12h freshness so the morning open is a
          // guaranteed instant hit (no agent wait on the request path), like the
          // nightly Brief precompute → saveDayRead.
          const r = await generateInsight("auto", "connection", undefined, { freshForMs: 12 * 60 * 60 * 1000 });
          console.log(r.ok ? `[proactive] stored a quiet insight.` : `[proactive] no genuine insight tonight (calm no-op).`);
        } catch (e: any) {
          console.error(`[proactive] insight pass failed: ${e?.message ?? e}`);
        }
      }
      if (weeklyDue) {
        try {
          const r = await generateInsight("auto", "weekly_read", undefined, { freshForMs: 12 * 60 * 60 * 1000 });
          console.log(r.ok ? `[proactive] stored the weekly read.` : `[proactive] no weekly read this week (calm no-op).`);
        } catch (e: any) {
          console.error(`[proactive] weekly read failed: ${e?.message ?? e}`);
        }
        // Refresh the whole-picture health synthesis weekly too, so it absorbs
        // training/recovery drift (new labs already refresh it immediately via the
        // enrich review pass). Pull artifact — cached, never pushed.
        try {
          const r = await synthesizeHealth("auto");
          console.log(r.ok ? `[proactive] refreshed the health synthesis.` : `[proactive] health synthesis steady (calm no-op).`);
        } catch (e: any) {
          console.error(`[proactive] health synthesis failed: ${e?.message ?? e}`);
        }
      }
      if (nutritionDue) {
        try {
          const r: any = await nutritionCheckin("auto");
          console.log(
            r.ok && r.change ? `[proactive] drafted an adaptive nutrition change (waiting for review).`
              : r.ok ? `[proactive] nutrition steady — no change (calm no-op).`
              : `[proactive] nutrition check-in unavailable (calm no-op).`
          );
        } catch (e: any) {
          console.error(`[proactive] nutrition check-in failed: ${e?.message ?? e}`);
        }
      }
      if (evolutionDue) {
        try {
          // Nothing to evolve for a brand-new user with no plan — skip the agent call.
          const hasPlan = (repo.getPlan() as any[]).some((d) => Array.isArray(d.items) && d.items.length);
          if (!hasPlan) {
            console.log(`[proactive] no plan to evolve yet (calm no-op).`);
          } else {
            const r: any = await evolveProgram("auto", repo.AUTO_EVOLUTION_INSTRUCTION);
            // A successful fresh draft retires the prior unreviewed auto one (no pile-up).
            if (r.ok && r.proposal?.id) repo.supersedeAutoEvolutionDrafts(r.proposal.id);
            console.log(r.ok ? `[proactive] drafted a plan evolution (waiting for review).` : `[proactive] plan evolution unavailable (calm no-op).`);
          }
        } catch (e: any) {
          console.error(`[proactive] plan evolution failed: ${e?.message ?? e}`);
        }
      }
    } finally {
      proactiveBusy = false;
    }
  };

  // Garmin auto-sync: first attempt ~45s after boot, then roughly every 6 hours.
  // Configuration (saved/env credentials or exported token files) is re-checked
  // on every pass — same live-settings pattern as the coach tick — so saving
  // Garmin credentials in Settings starts syncing within a minute, no restart.
  // The 6h clock only advances when a sync actually runs; unconfigured passes
  // are a cheap settings read + two fs.existsSync calls.
  const GARMIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
  let garminDueAt = Date.now() + 44_000; // gate opens just before the 45s boot pass fires
  let garminBusy = false;
  const garminTick = async () => {
    if (garminBusy || Date.now() < garminDueAt) return;
    try {
      const { isGarminConfigured, syncGarmin } = await import("./garmin.js");
      if (!isGarminConfigured()) return;
      garminBusy = true;
      garminDueAt = Date.now() + GARMIN_INTERVAL_MS;
      const r = await syncGarmin(); // records garmin_last_sync_at/status itself
      if (r.ok) console.log(`[garmin] auto-sync ok: ${r.activities} activities, ${r.daily_metrics} daily metric days.`);
      else console.error(`[garmin] auto-sync failed: ${r.error}`);
    } catch (e: any) {
      console.error(`[garmin] auto-sync error: ${e?.message ?? e}`);
    } finally {
      garminBusy = false;
    }
  };

  // Nightly Brief precompute: once per day in the small hours, compute & cache
  // today's canonical day-read so the morning open is instant (no agent wait on
  // the request path). Runs against the configured rotation; a failed compute
  // still caches the deterministic floor. PRECOMPUTE_HOUR is declared up top.
  let lastPrecomputeDate = "";
  let precomputeBusy = false;
  const precomputeTick = async () => {
    if (precomputeBusy) return;
    const now = new Date();
    if (now.getHours() !== PRECOMPUTE_HOUR) return;
    const stamp = localToday(now);
    if (stamp === lastPrecomputeDate) return; // already ran this day
    lastPrecomputeDate = stamp;
    precomputeBusy = true;
    try {
      await precomputeDayRead(stamp);
      console.log(`[brief] precomputed today's day-read for ${stamp}.`);
    } catch (e: any) {
      console.error(`[brief] nightly precompute failed: ${e?.message ?? e}`);
    } finally {
      precomputeBusy = false;
    }
  };

  // Stream 2 — quiet nightly memory housekeeping (runs once per day at MEMORY_HOUR,
  // default 3am local, an hour before the Brief precompute so the agent isn't
  // double-booked). Each pass: reconcile passed suggestions → durable learnings
  // (deterministic, always), then consolidate the memory store and grow about_me
  // (agentic, best-effort — a failed agent is a calm no-op). NEVER notifies; this
  // is pure background curation the user never has to think about.
  const MEMORY_HOUR = (() => {
    const h = Number(process.env.MEMORY_MAINT_HOUR);
    return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 3; // default 3am local
  })();
  let lastMemoryDate = "";
  let memoryBusy = false;
  const memoryTick = async () => {
    if (memoryBusy) return;
    const now = new Date();
    if (now.getHours() !== MEMORY_HOUR) return;
    const stamp = localToday(now);
    if (stamp === lastMemoryDate) return; // already ran today
    lastMemoryDate = stamp;
    memoryBusy = true;
    try {
      // 1. Deterministic outcome reconciliation — no agent, never fails the pass.
      try {
        const rec = repo.reconcileSuggestions();
        if (rec.learnings > 0) console.log(`[memory] reconciled ${rec.reconciled} suggestions → ${rec.learnings} learnings.`);
      } catch (e: any) { console.error(`[memory] reconcile failed: ${e?.message ?? e}`); }
      // 1b. Rebuild the PERSONAL-RESPONSE model (deterministic) from the freshly
      //     reconciled history + latest logs — cache it + promote the load-bearing
      //     patterns into memory so the coach voice personalizes. Pull, never push.
      try {
        repo.saveReactionModel();
      } catch (e: any) { console.error(`[memory] reaction-model rebuild failed: ${e?.message ?? e}`); }
      // 2. Agentic consolidation + about-me growth — best-effort, lazy-imported.
      try {
        const { consolidateMemory, growAboutMe } = await import("./coachOps.js");
        const c = await consolidateMemory("auto");
        if (c.ok && (c.merged || c.superseded || c.promoted)) console.log(`[memory] consolidated: ${c.merged} merged, ${c.superseded} superseded, ${c.promoted} promoted.`);
        const g = await growAboutMe("auto");
        if (g.ok && (g as any).changed) console.log(`[memory] grew about_me from memory.`);
      } catch (e: any) { console.error(`[memory] nightly consolidation failed: ${e?.message ?? e}`); }
      // 3. Agentic exercise-name tidy — best-effort, pull-never-push. Messy /
      //    duplicate movement titles self-align over time so the volume +
      //    progression read stays clean (never touches logged numbers).
      try {
        const { reconcileExercises } = await import("./coachOps.js");
        const x: any = await reconcileExercises("auto");
        if (x.ok && x.applied) console.log(`[memory] tidied exercise names: ${x.applied} alias(es) across ${x.aligned} movement(s).`);
      } catch (e: any) { console.error(`[memory] nightly exercise tidy failed: ${e?.message ?? e}`); }
    } finally {
      memoryBusy = false;
    }
  };

  // ---- Self-hosted update check (pull-never-push). Once per day at most, gated
  //      on settings.update_check_enabled. Reaches the GitHub Releases API and
  //      STORES the result in app_state; nothing notifies — the Settings → Data
  //      card reads it. Stamp-first so a persistent-offline box checks at most
  //      once/day instead of hammering every minute; a transient failure just
  //      waits for tomorrow (the manual "Check now" button covers an immediate
  //      retry, and getUpdateStatus still serves the last good cache). ----
  let updateCheckBusy = false;
  const updateCheckTick = async () => {
    if (updateCheckBusy) return;
    if (!repo.getSettings().update_check_enabled) return;
    const today = localToday();
    if (repo.getAppState("update_check_last_date") === today) return; // already checked today
    updateCheckBusy = true;
    repo.setAppState("update_check_last_date", today); // stamp first → at most one check/day
    try {
      const r = await checkForUpdate();
      if (r.error) console.log(`[update] check unavailable (calm no-op): ${r.error}`);
      else if (r.update_available) console.log(`[update] a newer Cairn is available: ${r.latest} (running ${r.current}) — see Settings → Data.`);
      else console.log(`[update] up to date (${r.current}).`);
    } catch (e: any) {
      console.error(`[update] check error: ${e?.message ?? e}`);
    } finally {
      updateCheckBusy = false;
    }
  };

  const s = repo.getSettings(); // also lazily creates the row (seeding env defaults)
  console.log(
    s.coach_enabled
      ? `Auto-coach enabled: day=${s.coach_day}, hour=${s.coach_hour}, strategy=${s.agent_strategy}.`
      : "Auto-coach disabled (enable it in Settings)."
  );
  console.log(s.proactive_enabled ? "Quiet proactivity enabled (insights wait in-app; never pushed)." : "Quiet proactivity disabled (enable it in Settings).");
  setInterval(tick, 60_000); // check every minute
  setInterval(proactiveTick, 60_000);
  setInterval(garminTick, 60_000);
  setInterval(precomputeTick, 60_000);
  setInterval(memoryTick, 60_000); // Stream 2: nightly memory maintenance
  setInterval(updateCheckTick, 60_000); // self-hosted update check (≤ once/day)
  setTimeout(garminTick, 45_000); // the boot-time pass; later passes ride the minute tick
  setTimeout(updateCheckTick, 30_000); // first update check shortly after boot (then daily)

  // Boot warm: if today's read isn't cached yet (e.g. a mid-day restart), compute
  // it in the background so the very next open is instant too. Safe no-op when an
  // agent is unreachable — it caches the deterministic floor.
  setTimeout(() => {
    const today = localToday();
    if (!repo.getCachedDayRead(today)) {
      precomputeDayRead(today)
        .then(() => console.log(`[brief] warmed today's day-read for ${today}.`))
        .catch(() => {});
    }
  }, 15_000);
}
