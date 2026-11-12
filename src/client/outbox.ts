// @ts-check
// Offline outbox, part 5 of 5: the drain and the public API. flushOutbox claims
// the oldest deliverable item under the cross-tab lease, replays it through
// api(), and settles it as delivered, pending (a transient failure: stop and
// keep the rest for the next flush) or needing attention (a real refusal the
// athlete reviews). It runs whenever Cairn is reachable again. CairnOutbox and
// the outbox* globals are the surface every capture / set-log path writes to;
// the bar and the review sheet are outbox-ui.ts.
{
  const { createOutbox, SEND_CLAIM_MS: OUTBOX_SEND_CLAIM_MS } = CairnOutboxQueue;
  const { queue: outbox, withLock: withOutboxRuntimeLock, enqueueUnlocked: enqueueOutboxUnlocked } = CairnOutboxRuntime;
  const {
    canonicalPreparedReplay,
    replayHasSemanticFailure,
    queuedAdaptivePreviewDrift,
    supersededByOwner,
    openSupersededDays,
    storePreparedReplayTruth,
    freshenAfterSync,
  } = CairnOutboxReplay;
  const { rekeyStagedCachePair, clearMatchingStagedCachePair } = CairnOutboxSession;
  const { isTransientApiFailure } = CairnApiCache;

  let outboxFlushing = false;
  let outboxFlushAgain = false;
  let outboxFlushWaiters: Array<() => void> = [];
  let outboxClaimRetryTimer: ReturnType<typeof setTimeout> | null = null;

  // outbox-ui.ts paints the bar; whether a drain is running is this module's state.
  function renderOutboxBar(): void {
    CairnOutboxUi.renderBar({ flushing: outboxFlushing });
  }

  function scheduleOutboxClaimRetry(blockedUntil: number | undefined): void {
    if (blockedUntil == null || typeof setTimeout !== "function") return;
    if (outboxClaimRetryTimer != null && typeof clearTimeout === "function") clearTimeout(outboxClaimRetryTimer);
    const delay = Math.max(0, Math.min(OUTBOX_SEND_CLAIM_MS, blockedUntil - Date.now() + 25));
    outboxClaimRetryTimer = setTimeout(() => {
      outboxClaimRetryTimer = null;
      void flushOutbox();
    }, delay);
  }

  async function retryOutboxItem(id: string): Promise<boolean> {
    const result = await withOutboxRuntimeLock(() => {
      const box = outbox();
      const before = box.list();
      const index = before.findIndex((item) => item.id === id);
      const previous = index >= 0 ? before[index] : null;
      if (!previous || !box.retry(id)) return false;
      const replacement = box.list()[index];
      if (previous.kind === "daily_session_prepare" && replacement && replacement.id !== id) {
        rekeyStagedCachePair(String(previous.session_date || ""), id, replacement.id);
      }
      return true;
    });
    if (!result) return false;
    renderOutboxBar();
    await flushOutbox();
    return true;
  }

  async function discardOutboxItem(id: string): Promise<boolean> {
    let clearedDate = "";
    const result = await withOutboxRuntimeLock(() => {
      const box = outbox();
      const item = box.list().find((candidate) => candidate.id === id);
      if (!item || !box.remove(id)) return false;
      if (item.kind === "daily_session_prepare") {
        const date = String(item.session_date || "");
        if (clearMatchingStagedCachePair(date, id)) clearedDate = date;
      }
      return true;
    });
    if (!result) return false;
    renderOutboxBar();
    if (clearedDate) {
      const g = globalThis as {
        state?: { tab?: string; logDate?: string };
        activateTab?(tab: string): unknown;
      };
      if (g.state?.tab === "session" && g.state.logDate === clearedDate) {
        try {
          g.activateTab?.("today");
        } catch {}
      }
    }
    // Removing the failed member is an explicit resolution of its workout-group
    // barrier. Let pending siblings resume immediately in their original order.
    await flushOutbox();
    return true;
  }

  async function flushOutbox(): Promise<void> {
    const box = outbox();
    if (outboxFlushing) {
      outboxFlushAgain = true;
      renderOutboxBar();
      await new Promise<void>((resolve) => outboxFlushWaiters.push(resolve));
      return;
    }
    if (box.count() === 0) {
      renderOutboxBar();
      return;
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      renderOutboxBar();
      return;
    }

    outboxFlushing = true;
    renderOutboxBar();
    let sent = 0;
    let blockedUntil: number | undefined;
    const canonicalByDate = new Map<string, PreparedReplayTruth>();
    const mutatedPreparedDates = new Set<string>();
    const supersededDates = new Set<string>();
    try {
      do {
        outboxFlushAgain = false;
        for (;;) {
          const claim = await withOutboxRuntimeLock(() => box.claimNext());
          if (claim.blockedUntil != null) {
            blockedUntil = blockedUntil == null ? claim.blockedUntil : Math.min(blockedUntil, claim.blockedUntil);
          }
          if (!claim.item || claim.storageError) break;
          const item = claim.item;
          let outcome: "delivered" | "attention" | "pending" = "delivered";
          let superseded = false;
          let failureStatus: number | undefined;
          try {
            const response = await api(item.path as string, {
              method: item.method === "DELETE" ? "DELETE" : "POST",
              headers: { "Content-Type": "application/json", "X-Idempotency-Key": item.id },
              body: JSON.stringify(item.body),
            });
            if (replayHasSemanticFailure(item, response)) outcome = "attention";
            else if (item.kind === "daily_session_prepare") {
              const canonical = canonicalPreparedReplay(item, response);
              if (!canonical) outcome = "attention";
              else {
                storePreparedReplayTruth(canonical);
                canonicalByDate.set(canonical.date, canonical);
              }
            } else if (item.depends_on) {
              if (item.session_date) mutatedPreparedDates.add(item.session_date);
            }
          } catch (error) {
            // A queued adaptive candidate is a compare-and-set request, never a
            // retry-until-it-wins write. Fingerprint drift becomes an explicit
            // attention barrier so dependent sets/finish cannot overtake it.
            if (supersededByOwner(item, error)) {
              const date = String(item.session_date || (item.body as Record<string, unknown> | null)?.date || "");
              clearMatchingStagedCachePair(date, item.id);
              outboxResolveSessionPrerequisite(date);
              supersededDates.add(date);
              superseded = true;
            } else if (queuedAdaptivePreviewDrift(item, error)) {
              outcome = "attention";
              failureStatus = 409;
            } else if (isTransientApiFailure(error)) outcome = "pending";
            else {
              outcome = "attention";
              if (error instanceof CairnApiError && error.status != null) failureStatus = error.status;
            }
          }
          const settled = await withOutboxRuntimeLock(() =>
            box.settle(item.id, item.claim_token, outcome, failureStatus)
          );
          renderOutboxBar();
          if (!settled || outcome === "pending") break;
          if (outcome === "delivered" && !superseded) sent++;
        }
      } while (outboxFlushAgain && box.count() > 0 && (typeof navigator === "undefined" || navigator.onLine !== false));
    } finally {
      outboxFlushing = false;
      outboxFlushAgain = false;
      const waiters = outboxFlushWaiters;
      outboxFlushWaiters = [];
      for (const resolve of waiters) resolve();
    }
    renderOutboxBar();
    scheduleOutboxClaimRetry(blockedUntil);
    if (supersededDates.size > 0) openSupersededDays([...supersededDates]);
    if (sent > 0) {
      const prepared = [...canonicalByDate.values()].filter((truth) => !mutatedPreparedDates.has(truth.date));
      freshenAfterSync(prepared);
      try {
        toast(`${sent} log${sent === 1 ? "" : "s"} synced`);
      } catch {}
    }
  }

  // Public enqueue: hold a failed POST and update the affordance. Callers pass the
  // exact path + JSON body they tried, so replay is byte-for-byte the original write.
  async function outboxEnqueue(
    kind: string,
    path: string,
    body: unknown,
    options: OutboxEnqueueRuntimeOptions = {}
  ): Promise<OutboxItem | null> {
    const item = await withOutboxRuntimeLock(() => enqueueOutboxUnlocked(kind, path, body, options));
    renderOutboxBar();
    return item;
  }

  function outboxCount(): number {
    return outbox().count();
  }

  const CAIRN_OUTBOX = {
    createOutbox,
    enqueue: outboxEnqueue,
    flush: flushOutbox,
    count: outboxCount,
    list: () => outbox().list(),
    reviewItems: () => outbox().review(),
    renderBar: renderOutboxBar,
    openReview: () => CairnOutboxUi.openReview(),
    closeReview: () => CairnOutboxUi.closeReview(),
    retry: retryOutboxItem,
    discard: discardOutboxItem,
    itemSummary: (item: OutboxItem) => CairnOutboxUi.itemSummary(item),
    sessionGroupId: outboxSessionGroupId,
    runSessionMutation,
    sessionDependency: outboxSessionDependency,
    sessionPrerequisite: outboxSessionPrerequisite,
    resolveSessionPrerequisite: outboxResolveSessionPrerequisite,
  };

  // Connectivity wiring lives here, the one module that sees both halves: the
  // offline hairline is api-core's setOffline, and reconnecting drains the queue.
  if (typeof window !== "undefined") {
    window.addEventListener("offline", () => setOffline(true));
    window.addEventListener("online", () => {
      setOffline(false);
      void flushOutbox();
    });
    if (navigator.onLine === false) setOffline(true);
    // Boot: paint any leftover queue and try to drain what a previous session held.
    if (typeof setTimeout === "function")
      setTimeout(() => {
        renderOutboxBar();
        void flushOutbox();
      }, 0);
  }

  Object.assign(globalThis, { CairnOutbox: CAIRN_OUTBOX, outboxEnqueue, flushOutbox, outboxCount });
}
