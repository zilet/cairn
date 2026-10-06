// @ts-check
// Mounts the redesigned Today's async sections into the slots the screen owns
// (today-main-shell-client.ts): the overnight digest, the week's strip / gauges /
// block clock / km note / bodyweight sparkline, Coming up, and the one new connection.
// Each read goes through the SWR cache (`peek` for a warm paint, `load` to
// revalidate), so a warm Today paints at once and a slot is rewritten only when its
// markup actually changed. Every slot is optional: an empty answer or a failed read
// leaves it empty (it collapses), never an error. Lives in the lazy today-ahead
// bundle; the screen reaches it only through withBundle("today-ahead", …).
{
  type TodayAheadPathRead = import("../contracts/today-path.js").TodayPath;
  type TodayAheadDigestRead = import("../contracts/today-digest.js").TodayDigest;
  type TodayAheadDeps = {
    date: string;
    /** The Brief's read (its block clock rides the week's header). */
    read: {
      periodization_context?: {
        program_block?: { week_index?: unknown; total_weeks?: unknown } | null;
        recovery_overlay?: { day_index?: unknown; total_days?: unknown } | null;
      } | null;
    } | null;
    /** The day's agenda, once phase two has it (its one genuine ask). */
    agenda(): Promise<unknown>;
    peek(key: string): { data: unknown; fresh: boolean } | null;
    load(path: string, options: { key: string }): Promise<unknown>;
    api(path: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    toast(message: string, options?: { action?: string; onAction?: () => void }): void;
    gotoChatWith(text: string): void;
    openChanges(): void;
    openCheckup(): void;
    openRace(): void;
    openPlanCoach(): void;
    refreshToday(): unknown;
    invalidate(key: string): void;
  };

  const SLOTS = {
    digest: "#todayDigestSlot",
    strip: "#tweekStrip",
    block: "#tweekBlock",
    km: "#tweekKmNote",
    spark: "#tweekSpark",
    gauges: "#tweekGauges",
    horizon: "#todayHorizonSlot",
    connection: "#todayHeadingSlot",
  } as const;

  function keys(date: string) {
    return {
      path: [`/today-path?date=${encodeURIComponent(date)}`, `today:path:${date}`],
      digest: [`/today-digest?date=${encodeURIComponent(date)}`, `today:digest:${date}`],
      week: ["/plan/week", "plan:week"],
      baseline: ["/recovery/baseline", "recovery:baseline"],
      insights: ["/insights", "today:insights"],
    } as const;
  }

  function mountTodayAhead(root: Element, deps: TodayAheadDeps): () => void {
    let live = true;
    const painted = new Map<string, string>();
    const k = keys(deps.date);
    let path: TodayAheadPathRead | null = null;
    let digest: TodayAheadDigestRead | null = null;
    let ask: ReturnType<Window["CairnTodayWorth"]["askCandidate"]> = null;
    let insight: unknown = null;

    // "What's ahead": the week's seven days under the Brief's why, a tapped day opening
    // inline (today-strip-controller.ts). "Open in Horizon" reads another day under
    // Horizon; today is Today's own, so in Horizon it is a row of the week.
    const strip = root.querySelector("#todayStripSlot");
    if (strip) {
      CairnTodayStripController.mount(strip, {
        date: deps.date,
        peek: deps.peek,
        load: deps.load,
        openInHorizon: (date) => {
          if (date !== deps.date) return CairnDayOpen.openDay(date, { home: "horizon" });
          void withBundle("horizon", () => {
            if (typeof CairnHorizonController !== "undefined") CairnHorizonController.pickView("week");
          });
          activateTab("horizon");
        },
      });
    }

    function write(slot: string, html: string): void {
      if (!live || !root.isConnected) return;
      const el = root.querySelector<HTMLElement>(slot);
      if (!el) return;
      // A held copy (today-slot-hold.ts) is released by any write; an unchanged one stays quiet.
      if (painted.get(slot) === html && !el.hasAttribute("data-held")) return;
      painted.set(slot, html);
      el.innerHTML = html; // the write itself releases a hold
    }

    function paintDigest(): void {
      write(SLOTS.digest, CairnTodayDigest.html(digest, ask));
    }

    function paintPath(): void {
      if (!path) return;
      write(SLOTS.horizon, CairnTodayHorizon.horizonHtml(path));
      const week = path.week;
      // The block clock rides the week's header; a running recovery week says so first.
      const clock = deps.read?.periodization_context;
      const overlay = clock?.recovery_overlay;
      const recoveryDay = overlay ? Math.max(1, Math.min(7, Math.round(Number(overlay.day_index) || 1))) : 0;
      write(
        SLOTS.block,
        escHtml(
          recoveryDay
            ? `Recovery week · day ${recoveryDay} of 7`
            : CairnTodayWeek.blockLine(week?.phase ?? null, clock?.program_block ?? null)
        )
      );
      const long = (path.milestones || []).find((m) => m.kind === "long_run");
      const weekEnd = (() => {
        const ms = Date.parse(`${deps.date}T12:00:00Z`);
        const dow = Number.isFinite(ms) ? (new Date(ms).getUTCDay() + 6) % 7 : 0;
        return new Date(ms + (6 - dow) * 864e5).toISOString().slice(0, 10);
      })();
      write(
        SLOTS.km,
        escHtml(CairnTodayWeek.kmNote(week?.km_planned ?? null, long && long.date <= weekEnd ? long.date : null))
      );
      write(SLOTS.spark, CairnTodayWeek.sparkSvg(path.weight?.points, path.weight?.goal_lb ?? null));
    }

    // One read: a warm paint from the cache, then the revalidated answer.
    function read<T>(entry: readonly [string, string], use: (value: T) => void): void {
      const warm = deps.peek(entry[1]);
      if (warm) {
        try {
          use(warm.data as T);
        } catch {}
      }
      deps
        .load(entry[0], { key: entry[1] })
        .then((value) => {
          if (live) use(value as T);
        })
        .catch(() => {});
    }

    read<TodayAheadPathRead>(k.path, (value) => {
      path = value && typeof value === "object" ? value : null;
      paintPath();
    });
    read<TodayAheadDigestRead>(k.digest, (value) => {
      digest = value && typeof value === "object" ? value : null;
      paintDigest();
    });
    read<import("../contracts/client.js").ClientPlanWeek>(k.week, (value) =>
      write(SLOTS.strip, CairnTodayWeek.stripHtml(value, deps.date))
    );
    read<import("../contracts/client.js").ClientRecoveryBaselineRead>(k.baseline, (value) =>
      write(SLOTS.gauges, CairnTodayWeek.gaugesHtml(value, deps.date))
    );
    read<unknown[]>(k.insights, (value) => {
      const list = Array.isArray(value) ? value : [];
      insight = list.find((row) => row && (row as { kind?: unknown }).kind !== "weekly_read") ?? null;
      write(SLOTS.connection, CairnTodayHorizon.connectionHtml(insight as never));
    });
    deps
      .agenda()
      .then((agenda) => {
        ask = CairnTodayWorth.askCandidate(agenda as never);
        paintDigest();
      })
      .catch(() => {});

    const repaintAfterWrite = () => {
      deps.invalidate(k.digest[1]);
      deps.invalidate(k.path[1]);
      return deps.refreshToday();
    };

    async function answer(button: HTMLElement, path: string, done: string): Promise<void> {
      if (button.dataset.busy === "1") return;
      button.dataset.busy = "1";
      button.setAttribute("aria-busy", "true");
      let result: unknown = null;
      try {
        result = await deps.api(path, { method: "POST" });
      } catch {
        result = null;
      }
      const r = (result && typeof result === "object" ? result : {}) as { ok?: unknown; error?: unknown };
      if (!result || r.ok === false || r.error) {
        deps.toast(typeof r.error === "string" && r.error ? r.error : "That didn't go through — try again");
        button.dataset.busy = "";
        button.removeAttribute("aria-busy");
        return;
      }
      try {
        (
          globalThis as { CairnWriteInvalidation?: { invalidateWrite(name: string): unknown } }
        ).CairnWriteInvalidation?.invalidateWrite("proposal_apply");
      } catch {}
      deps.toast(done);
      await repaintAfterWrite();
    }

    return CairnUiActions.mount(root, "today-ahead", ({ delegate }) => {
      delegate("click", {
        "tdg-undo": (el) =>
          void CairnDecisionUndoController.revert(el, el.getAttribute("data-tdg-undo"), deps, {
            reason: "undo from Today's digest",
            success: "Put back",
            stale: "That change can no longer be put back.",
            failed: "Could not undo that change",
            after: repaintAfterWrite,
          }),
        "tdg-apply": (el) =>
          void answer(
            el,
            `/proposals/${encodeURIComponent(el.getAttribute("data-tdg-apply") || "")}/apply`,
            "Done — your plan has it"
          ),
        "tdg-keep": (el) =>
          void answer(
            el,
            `/proposals/${encodeURIComponent(el.getAttribute("data-tdg-keep") || "")}/discard`,
            "Kept your plan as it is"
          ),
        "tdg-talk": (el) => deps.gotoChatWith(`Let's talk this through: ${el.getAttribute("data-tdg-talk") || ""}`),
        "tdg-review": () => deps.openPlanCoach(),
        "tdg-all": () => deps.openChanges(),
        "thz-checkup": () => deps.openCheckup(),
        "thz-race": () => deps.openRace(),
        "thd-insight": (el) =>
          deps.gotoChatWith(`Tell me more about this: ${el.getAttribute("data-thd-insight") || ""}`),
      });
      return () => {
        live = false;
      };
    });
  }

  const CAIRN_TODAY_AHEAD = { mount: mountTodayAhead, slots: SLOTS };

  Object.assign(globalThis, { CairnTodayAhead: CAIRN_TODAY_AHEAD });
}
