// @ts-check
// Offline outbox, part 3 of 5: reading a replayed response. Whether a replayed
// write actually landed (a semantic refusal, a prepare that came back as some
// other session, an adaptive preview whose inputs drifted), and how a landed
// replay refreshes what the athlete is looking at. Pure apart from the cache
// writes in storePreparedReplayTruth / freshenAfterSync.
type PreparedReplayTruth = { date: string; session: Record<string, unknown>; dailySession: Record<string, unknown> };
type OutboxReplayApi = {
  canonicalPreparedReplay(item: OutboxItem, value: unknown): PreparedReplayTruth | null;
  replayHasSemanticFailure(item: OutboxItem, value: unknown): boolean;
  queuedAdaptivePreviewDrift(item: OutboxItem, error: unknown): boolean;
  supersededByOwner(item: OutboxItem, error: unknown): boolean;
  openSupersededDays(dates: string[]): void;
  storePreparedReplayTruth(truth: PreparedReplayTruth): void;
  freshenAfterSync(prepared?: PreparedReplayTruth[]): void;
};
declare const CairnOutboxReplay: OutboxReplayApi;

{
  function storePreparedReplayTruth(truth: PreparedReplayTruth): void {
    const g = globalThis as { swrSet?(key: string, data: unknown): void; swrInvalidate?(key: string): void };
    g.swrSet?.(`today:session:${truth.date}`, truth.session);
    g.swrSet?.(`today:daily-session:${truth.date}`, truth.dailySession);
    g.swrInvalidate?.(`today:aggregate:${truth.date}`);
    // The server confirmed this date's session, so its staged-offline block lifts.
    outboxResolveSessionPrerequisite(truth.date);
  }

  function normalizedPrepareValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(normalizedPrepareValue);
    if (value && typeof value === "object") {
      const normalized: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        const entry = (value as Record<string, unknown>)[key];
        if (entry !== undefined) normalized[key] = normalizedPrepareValue(entry);
      }
      return normalized;
    }
    return value ?? null;
  }

  function sameNormalizedPrepareValue(left: unknown, right: unknown): boolean {
    return JSON.stringify(normalizedPrepareValue(left)) === JSON.stringify(normalizedPrepareValue(right));
  }

  function samePrepareIntent(item: OutboxItem, dailySession: Record<string, unknown>): boolean {
    const expected = item.prepare_intent;
    if (!expected) return false;
    for (const key of ["date", "source", "plan_day_id", "title", "focus", "est_minutes"] as const) {
      if ((expected[key] ?? null) !== (dailySession[key] ?? null)) return false;
    }
    const planSource = expected.source === "adaptive_plan" || expected.source === "manual_plan";
    if (!planSource && (expected.why ?? null) !== (dailySession.why ?? null)) return false;
    if (
      Object.hasOwn(expected, "constraints") &&
      !sameNormalizedPrepareValue(expected.constraints, dailySession.constraints)
    )
      return false;
    if (Object.hasOwn(expected, "provenance")) {
      const expectedProvenance =
        expected.provenance && typeof expected.provenance === "object"
          ? (expected.provenance as Record<string, unknown>)
          : null;
      const actualProvenance =
        dailySession.provenance && typeof dailySession.provenance === "object"
          ? (dailySession.provenance as Record<string, unknown>)
          : null;
      if (!expectedProvenance || !actualProvenance) {
        if (!sameNormalizedPrepareValue(expectedProvenance, actualProvenance)) return false;
      } else {
        if (expected.source === "agent_suggest") {
          const expectedJobId = Number(expectedProvenance.agent_job_id);
          if (!Number.isInteger(expectedJobId) || expectedJobId <= 0) return false;
          if (Number(actualProvenance.agent_job_id) !== expectedJobId) return false;
        }
        // Compare every provenance promise the client persisted, but tolerate
        // server-owned enrichment fields added to the canonical record.
        for (const key of Object.keys(expectedProvenance)) {
          if (!Object.hasOwn(actualProvenance, key)) return false;
          if (!sameNormalizedPrepareValue(expectedProvenance[key], actualProvenance[key])) return false;
        }
      }
    }
    const expectedItems = Array.isArray(expected.items) ? expected.items : [];
    const actualItems = Array.isArray(dailySession.items) ? dailySession.items : [];
    if (expectedItems.length !== actualItems.length) return false;
    const fields = [
      "position",
      "kind",
      "exercise",
      "sets",
      "rep_low",
      "rep_high",
      "target_weight",
      "target_seconds",
      "warmup_sets",
      "mode",
      "note",
      "target_distance_km",
      "target_duration_min",
      "target_zone",
      "interval",
      "superset_group",
    ] as const;
    return expectedItems.every((expectedItem, index) => {
      if (!expectedItem || typeof expectedItem !== "object") return false;
      const actualItem = actualItems[index];
      if (!actualItem || typeof actualItem !== "object") return false;
      const expectedRow = expectedItem as Record<string, unknown>;
      const actualRow = actualItem as Record<string, unknown>;
      return fields.every((field) => {
        if (!(field in expectedRow)) return true;
        return sameNormalizedPrepareValue(expectedRow[field], actualRow[field]);
      });
    });
  }

  function canonicalPreparedReplay(item: OutboxItem, value: unknown): PreparedReplayTruth | null {
    if (item.kind !== "daily_session_prepare" || !value || typeof value !== "object") return null;
    const response = value as Record<string, unknown>;
    const request = item.body && typeof item.body === "object" ? (item.body as Record<string, unknown>) : {};
    const session =
      response.session && typeof response.session === "object" ? (response.session as Record<string, unknown>) : null;
    const dailySession =
      response.daily_session && typeof response.daily_session === "object"
        ? (response.daily_session as Record<string, unknown>)
        : null;
    const date = String(request.date || "");
    if (response.ok !== true || !date || !session || !dailySession) return null;
    if (String(dailySession.date || "") !== date || (session.date != null && String(session.date) !== date))
      return null;
    const expectedActiveId = Number(request.expected_active_id);
    if (Number.isInteger(expectedActiveId) && expectedActiveId > 0) {
      if (Number(dailySession.id) !== expectedActiveId) return null;
    } else if (response.reused === true) {
      // An open answers with the date's existing session (any source, any items): the
      // athlete asked for "a session today" and has one. It is the truth, not a mismatch.
      return { date, session, dailySession };
    } else if (String(dailySession.source || "") !== String(request.source || "")) return null;
    if (!samePrepareIntent(item, dailySession)) return null;
    return { date, session, dailySession };
  }

  function replayHasSemanticFailure(item: OutboxItem, value: unknown): boolean {
    if (!value || typeof value !== "object")
      return item.kind === "skip" || item.kind === "restore" || item.kind === "symptom_observation";
    const response = value as Record<string, unknown>;
    if (response.ok === false) return true;
    if (Object.hasOwn(response, "error") && response.error != null && response.error !== "" && response.error !== false)
      return true;
    return (
      (item.kind === "skip" || item.kind === "restore" || item.kind === "symptom_observation") && response.ok !== true
    );
  }

  function queuedAdaptivePreviewDrift(item: OutboxItem, error: unknown): boolean {
    if (
      item.kind !== "daily_session_prepare" ||
      !(error instanceof CairnApiError) ||
      error.status !== 409 ||
      !item.body ||
      typeof item.body !== "object"
    ) {
      return false;
    }
    const body = item.body as Record<string, unknown>;
    return (
      body.source === "adaptive_plan" &&
      typeof body.expected_input_fingerprint === "string" &&
      /^[a-f0-9]{64}$/.test(body.expected_input_fingerprint)
    );
  }

  const OWNER_CONFLICTS = new Set(["daily_session_active_changed", "daily_session_changed", "daily_session_locked"]);

  /**
   * A queued START (never a replace or an assertion) that lost the day to a session begun
   * elsewhere while this device was offline: the refusal names the owner. Nothing is wrong
   * with the athlete's data and nothing needs their attention — the owner is the day's
   * session, so the staged copy is dropped and the owner opens (`openSupersededDays`).
   */
  function supersededByOwner(item: OutboxItem, error: unknown): boolean {
    if (item.kind !== "daily_session_prepare" || !(error instanceof CairnApiError) || error.status !== 409) return false;
    const body = item.body && typeof item.body === "object" ? (item.body as Record<string, unknown>) : {};
    if (body.replace === true || body.expected_active_id != null) return false;
    const refusal = error.body && typeof error.body === "object" ? (error.body as Record<string, unknown>) : {};
    const owner = refusal.owner && typeof refusal.owner === "object" ? (refusal.owner as Record<string, unknown>) : null;
    return OWNER_CONFLICTS.has(String(refusal.code || "")) && Number(owner?.session_id) > 0;
  }

  /** Where the athlete is looking at a date whose staged start gave way to the owner: open the owner there. */
  function openSupersededDays(dates: string[]): void {
    const g = globalThis as Record<string, unknown> & {
      openSession?(date: string, options: Record<string, unknown>): unknown;
      reshapeToday?(): unknown;
      state?: { tab?: string; logDate?: string };
    };
    try {
      for (const date of dates) {
        if (g.state?.tab === "session" && g.state.logDate === date && typeof g.openSession === "function") {
          void g.openSession(date, { source: "adaptive_plan", provenance: { entry: "outbox_owner" } });
        } else if (g.state?.tab === "today" && typeof g.reshapeToday === "function") g.reshapeToday();
      }
    } catch {}
  }

  function freshenAfterSync(prepared: PreparedReplayTruth[] = []): void {
    const g = globalThis as Record<string, unknown> & {
      swrInvalidate?(keyOrPrefix: string): void;
      reshapeToday?(): unknown;
      renderSession?(opts?: unknown): unknown;
      state?: { tab?: string; brief?: unknown };
    };
    try {
      g.swrInvalidate?.("stats");
      g.swrInvalidate?.("plan");
      g.swrInvalidate?.("today:session:");
      g.swrInvalidate?.("today:daily-session:");
      g.swrInvalidate?.("history:sessions");
      g.swrInvalidate?.("progress:volume");
      g.swrInvalidate?.("progress:volume-balance");
      g.swrInvalidate?.("progress:1rm:");
      g.swrInvalidate?.("progress:energy");
      if (g.state) g.state.brief = null;
      for (const truth of prepared) storePreparedReplayTruth(truth);
    } catch {}
    // Reflect the just-synced logs where the user is actually looking. Both
    // renderers preserve their surface (Today re-reads the calm Brief; the Session
    // destination keeps scroll), so this is safe mid-review.
    try {
      const tab = g.state && g.state.tab;
      if (tab === "session" && typeof g.renderSession === "function") g.renderSession();
      else if (tab === "today" && typeof g.reshapeToday === "function") g.reshapeToday();
    } catch {}
  }

  const CAIRN_OUTBOX_REPLAY: OutboxReplayApi = {
    canonicalPreparedReplay,
    replayHasSemanticFailure,
    queuedAdaptivePreviewDrift,
    supersededByOwner,
    openSupersededDays,
    storePreparedReplayTruth,
    freshenAfterSync,
  };

  Object.assign(globalThis, { CairnOutboxReplay: CAIRN_OUTBOX_REPLAY });
}
