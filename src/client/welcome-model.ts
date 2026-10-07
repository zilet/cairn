// @ts-check
// The welcome's pure shaping: step states for Connect, the coach's three working
// phases, and the reveal (the first week as weekday rows, the starting fuel in plain
// words). No DOM, no fetching — welcome-client.ts prints what this decides.
(() => {
  const STEPS: ReadonlyArray<{ key: WelcomeStepKey; title: string }> = [
    { key: "setup", title: "Set up" },
    { key: "signin", title: "Sign in" },
    { key: "hello", title: "Say hello" },
  ];

  // The welcome job's phases, in order (server: job.meta.step, job.phase as words).
  const PHASES: ReadonlyArray<{ step: string; text: string }> = [
    { step: "understand", text: "Reading what you said" },
    { step: "week", text: "Building your first week" },
    { step: "fuel", text: "Setting your starting fuel" },
  ];

  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const DOW_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  /** Which phase index a job is on: meta.step first, then the phase words, else -1. */
  function phaseIndex(job: unknown): number {
    const row = job && typeof job === "object" ? (job as Record<string, unknown>) : {};
    const meta = row.meta && typeof row.meta === "object" ? (row.meta as Record<string, unknown>) : {};
    const step = String(meta.step || "");
    const byStep = PHASES.findIndex((p) => p.step === step);
    if (byStep >= 0) return byStep;
    const words = String(row.phase || "").toLowerCase();
    return PHASES.findIndex((p) => words.startsWith(p.text.toLowerCase().split(" ")[0] || "\u0000"));
  }

  /** The first week as rows Monday-first; a day with no stated weekday reads "Day n". */
  function weekRows(week: unknown): WelcomeWeekRow[] {
    if (!Array.isArray(week)) return [];
    const rows: WelcomeWeekRow[] = [];
    for (const item of week) {
      const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const name = String(row.name || "").trim();
      if (!name) continue;
      const dow = typeof row.dow === "number" && row.dow >= 0 && row.dow <= 6 ? row.dow : null;
      const n = Number(row.day_number);
      if (dow != null) {
        rows.push({ day: DOW[dow] || "", dayLong: DOW_LONG[dow] || "", name, order: (dow + 6) % 7, dow });
      } else {
        const label = Number.isFinite(n) && n > 0 ? `Day ${n}` : `Day ${rows.length + 1}`;
        rows.push({ day: label, dayLong: label, name, order: 10 + (Number.isFinite(n) ? n : rows.length), dow: null });
      }
    }
    return rows.sort((a, b) => a.order - b.order);
  }

  /** What became of the week, in one plain line (null when the rows say it all). */
  function weekNote(state: unknown, hasRows: boolean): string | null {
    switch (String(state || "")) {
      case "announced":
        return "It takes over from your next training day.";
      case "draft":
        return "It's drafted and waits for your yes on Today.";
      case "existing":
        return "You already had a plan, so I left it as it is.";
      case "queued":
        return "Your first week is still being put together. It will be on Today shortly.";
      case "failed":
        return "I couldn't put your first week together just now. Ask me for it any time.";
      default:
        return hasRows ? null : "Your first week comes together as we talk a little more.";
    }
  }

  /** Whether something real landed, so "It's in place" is true when it is said. */
  function landed(weekState: unknown, fuelState: unknown): boolean {
    return ["applied", "announced", "draft", "existing"].includes(String(weekState || "")) || ["set", "existing"].includes(String(fuelState || ""));
  }

  function round(n: number, step: number): number {
    return Math.round(n / step) * step;
  }

  /** The starting fuel as a calm estimate ("About 2,200 kcal a day"), never a score. */
  function fuelLines(fuel: unknown, state: unknown): { main: string; sub: string } | null {
    const row = fuel && typeof fuel === "object" ? (fuel as Record<string, unknown>) : null;
    const kcal = row && typeof row.target_kcal === "number" && row.target_kcal > 0 ? round(row.target_kcal, 50) : null;
    const protein = row && typeof row.protein_g === "number" && row.protein_g > 0 ? round(row.protein_g, 5) : null;
    if (kcal == null && protein == null) return null;
    const parts: string[] = [];
    if (kcal != null) parts.push(`about ${kcal.toLocaleString("en-US")} kcal a day`);
    if (protein != null) parts.push(`around ${protein} g of protein`);
    const main = parts.join(", with ");
    const sub =
      String(state || "") === "existing"
        ? "Your target was already set, so I kept it."
        : "A starting estimate. It settles as you log meals and weigh in.";
    return { main: main.charAt(0).toUpperCase() + main.slice(1), sub };
  }

  /**
   * Every failure path of the welcome leaves exactly one bounded diagnostic: the step,
   * the provider's key, a taxonomy code and (when there is one) an HTTP status. Never a
   * message, a prompt, the person's words, a coach reply or CLI output; the reporter
   * rebuilds its own message from these tokens and the server re-validates all three.
   */
  function reportFailure(step: WelcomeFailureStep, provider: string | null | undefined, code: string, status?: unknown): boolean {
    try {
      const reporter = (globalThis as { CairnClientDiagnostics?: { report?(event: unknown): boolean } }).CairnClientDiagnostics;
      if (typeof reporter?.report !== "function") return false;
      const key = String(provider || "").toLowerCase();
      const http = typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
      return reporter.report({
        kind: "api_failure",
        level: "warning",
        route: "/api/welcome",
        ...(http != null ? { status: http } : {}),
        welcome: { step, provider: /^[a-z][a-z0-9-]{0,31}$/.test(key) ? key : "other", code },
      });
    } catch {
      return false;
    }
  }

  const CAIRN_WELCOME_MODEL: WelcomeModelApi = { STEPS, PHASES, phaseIndex, weekRows, weekNote, landed, fuelLines, reportFailure };

  Object.assign(globalThis, { CairnWelcomeModel: CAIRN_WELCOME_MODEL });
})();
