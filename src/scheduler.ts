import * as repo from "./repo.js";
import { runAgentWithFallback } from "./agents.js";
import { buildCoachPrompt } from "./prompt.js";
import { precomputeDayRead, localToday } from "./dayread.js";
// Stream 2 (self-updating memory): quiet nightly memory housekeeping + outcome
// reconciliation. Lazy-imported in the tick so this module stays decoupled.

// Weekly auto-draft. Configured in Settings (persisted in the DB, editable from
// the PWA at runtime — no restart needed): coach_enabled, coach_day (0=Sun..6=Sat),
// coach_hour (local). When the slot arrives it drafts ONE proposal using the
// configured agent rotation (round-robin / random / priority, with fallthrough).
// It never auto-applies — you review and tap Apply.
//
// First-run defaults seed from COACH_AGENT/COACH_DAY/COACH_HOUR env vars so
// existing deployments keep working until you change anything in Settings.
//
// Also hosts the Garmin auto-sync (boot + ~6h cadence, only when configured).
export function startScheduler() {
  let lastRunDate = "";
  const tick = async () => {
    const s = repo.getSettings();
    if (!s.coach_enabled) return;
    const now = new Date();
    if (now.getDay() !== s.coach_day || now.getHours() !== s.coach_hour) return;
    const stamp = now.toISOString().slice(0, 10);
    if (stamp === lastRunDate) return; // already ran this day
    lastRunDate = stamp;
    try {
      const prompt = buildCoachPrompt("Weekly automatic review.");
      const { agent, result } = await runAgentWithFallback(repo.pickAgentOrder(), prompt);
      repo.createProposal(agent, "auto: weekly review", result.raw, result.parsed);
      console.log(`Auto-coach drafted a proposal via ${agent} (parsed=${!!result.parsed}).`);
    } catch (e: any) {
      console.error(`Auto-coach failed: ${e.message}`);
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
  // still caches the deterministic floor. The hour is overridable for testing.
  const PRECOMPUTE_HOUR = (() => {
    const h = Number(process.env.DAYREAD_PRECOMPUTE_HOUR);
    return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 4; // default 4am local
  })();
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
      // 2. Agentic consolidation + about-me growth — best-effort, lazy-imported.
      try {
        const { consolidateMemory, growAboutMe } = await import("./coachOps.js");
        const c = await consolidateMemory("auto");
        if (c.ok && (c.merged || c.superseded || c.promoted)) console.log(`[memory] consolidated: ${c.merged} merged, ${c.superseded} superseded, ${c.promoted} promoted.`);
        const g = await growAboutMe("auto");
        if (g.ok && (g as any).changed) console.log(`[memory] grew about_me from memory.`);
      } catch (e: any) { console.error(`[memory] nightly consolidation failed: ${e?.message ?? e}`); }
    } finally {
      memoryBusy = false;
    }
  };

  const s = repo.getSettings(); // also lazily creates the row (seeding env defaults)
  console.log(
    s.coach_enabled
      ? `Auto-coach enabled: day=${s.coach_day}, hour=${s.coach_hour}, strategy=${s.agent_strategy}.`
      : "Auto-coach disabled (enable it in Settings)."
  );
  setInterval(tick, 60_000); // check every minute
  setInterval(garminTick, 60_000);
  setInterval(precomputeTick, 60_000);
  setInterval(memoryTick, 60_000); // Stream 2: nightly memory maintenance
  setTimeout(garminTick, 45_000); // the boot-time pass; later passes ride the minute tick

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
