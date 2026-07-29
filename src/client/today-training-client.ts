// @ts-check
// Pure Today training/cardio helpers for the vanilla PWA.

type ClientPrescription = import("../contracts/client.js").ClientPrescription;
type ClientProgressionAction = import("../contracts/client.js").ClientProgressionAction;
type ClientPrescriptionTarget = import("../contracts/client.js").ClientPrescriptionTarget;

type ClientProgressionMeta = { word: string; cls: string };
type ClientPrescriptionLike = Partial<ClientPrescription> | null | undefined;
type ClientPrescriptionRecord = Record<string, ClientPrescriptionLike>;

const TODAY_RX_ACTION: Record<ClientProgressionAction, ClientProgressionMeta> = {
  overload: { word: "next up", cls: "ex-rx-up" },
  hold: { word: "hold", cls: "ex-rx-hold" },
  deload: { word: "ease off", cls: "ex-rx-down" },
  vary: { word: "switch it up", cls: "ex-rx-vary" },
  introduce: { word: "new", cls: "ex-rx-up" },
};

function finiteNumber(value: unknown): number | null {
  return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
}

function rxTargetText(rx: ClientPrescriptionLike): string {
  const suggested: Partial<ClientPrescriptionTarget> =
    rx && typeof rx.suggested === "object" && rx.suggested ? rx.suggested : {};
  if (rx?.mode === "timed") {
    const seconds = finiteNumber(suggested.seconds);
    const secs = seconds != null ? fmtDur(Math.round(seconds)) : "time";
    return `${suggested.sets ?? "?"} × ${secs}`;
  }
  const lo = suggested.rep_low;
  const hi = suggested.rep_high;
  const reps = lo != null && hi != null ? (lo === hi ? `${lo}` : `${lo}–${hi}`) : (lo ?? hi ?? "");
  const weight = finiteNumber(suggested.weight);
  let load: string;
  if (weight == null) load = "BW";
  else if (weight < 0) load = `${-weight} assist`;
  else load = fmtWeight(weight);
  return `${load}${reps ? ` · ${suggested.sets ?? "?"} × ${reps}` : ""}`;
}

function exRxVaryMenuHtml(rx: ClientPrescriptionLike): string {
  const opts = Array.isArray(rx?.vary_options)
    ? rx.vary_options.filter((o) => o && typeof o === "object" && o.name)
    : [];
  if (!opts.length) return "";
  // Each chip updates the weekly plan (from → this option) via
  // /program/swap/apply. An already accepted Today snapshot is immutable, so the
  // change is deliberately future-facing rather than changing this workout.
  const from = rx?.exercise ? String(rx.exercise) : "";
  const day = rx?.day_number != null ? String(rx.day_number) : "";
  const swappable = !!from && !!day;
  const chips = opts
    .slice(0, 3)
    .map((opt) =>
      CairnUi.textChipHtml({
        className: "ex-rx-opt",
        label: opt.name,
        title: opt.why,
        attrs: swappable
          ? {
              role: "button",
              tabindex: "0",
              "data-rx-swap-from": from,
              "data-rx-swap-to": String(opt.name),
              "data-rx-swap-day": day,
            }
          : undefined,
      })
    )
    .join("");
  return `<div class="ex-rx-vary-menu"><span class="ex-rx-vary-lbl lbl">update a future session</span><div class="ex-rx-opts">${chips}</div></div>`;
}

// Update the weekly plan without mutating the accepted composition for today.
// Best-effort: uses the global api()/toast() when present; a no-op outside the
// browser (tests) or when api() is absent.
async function requestRxSwap(from: string, to: string, day: number | null): Promise<void> {
  if (typeof api !== "function" || !from || !to || day == null) return;
  try {
    const r = (await api("/program/swap/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ day, from, to }),
    })) as { ok?: boolean; error?: string } | null;
    if (r && r.ok) {
      if (typeof toast === "function") toast("Weekly plan updated — today’s accepted session stays the same.");
      refreshWeeklyPlanAfterSwap(day);
    } else if (typeof toast === "function") {
      toast((r && r.error) || "Couldn't make that swap.");
    }
  } catch {
    if (typeof toast === "function") toast("Couldn't make that swap.");
  }
}

// Drop only future-plan caches. Never invalidate or re-render Today's accepted
// daily-session snapshot; the athlete may already be logging against it.
function refreshWeeklyPlanAfterSwap(day: number): void {
  const g = globalThis as Record<string, unknown> & {
    state?: { plan?: unknown[] };
    swrInvalidate?(keyOrPrefix: string): void;
  };
  try {
    if (g.state) g.state.plan = [];
    g.swrInvalidate?.("plan");
    g.swrInvalidate?.(`program:progression:${day}`);
  } catch {}
}

// Delegated, idempotent wiring for the swap chips (registered once at load). Guarded
// for the browser so the pure helpers above stay unit-testable in a bare VM context.
if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  const chipFrom = (target: EventTarget | null): HTMLElement | null => {
    const el = target as HTMLElement | null;
    return el && typeof el.closest === "function" ? el.closest<HTMLElement>(".ex-rx-opt[data-rx-swap-to]") : null;
  };
  const fire = (chip: HTMLElement) => {
    const day = Number(chip.getAttribute("data-rx-swap-day"));
    void requestRxSwap(
      chip.getAttribute("data-rx-swap-from") || "",
      chip.getAttribute("data-rx-swap-to") || "",
      Number.isFinite(day) ? day : null
    );
  };
  document.addEventListener("click", (e) => {
    const chip = chipFrom(e.target);
    if (!chip) return;
    e.preventDefault();
    fire(chip);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const chip = chipFrom(e.target);
    if (!chip) return;
    e.preventDefault();
    fire(chip);
  });
}

// `supporting` is set by the card when its header ALREADY prints today's dose.
// One authoritative number per card: the standing verdict then keeps its word and
// its why but drops its own load/sets/reps arithmetic, so the athlete is never
// asked to reconcile two prescriptions for the same lift.
function exRxLineHtml(rx: ClientPrescriptionLike, options: { supporting?: boolean } = {}): string {
  if (!rx) return "";
  const action = rx.action && Object.hasOwn(TODAY_RX_ACTION, rx.action) ? rx.action : "hold";
  const meta = TODAY_RX_ACTION[action];
  const why = rx.why ? `<div class="ex-rx-why">${escHtml(rx.why)}</div>` : "";
  const varyMenu = rx.action === "vary" || rx.action === "introduce" ? exRxVaryMenuHtml(rx) : "";
  if (options.supporting) {
    // With nothing left to explain, a bare verdict word beside the number is noise.
    if (!why && !varyMenu) return "";
    return `<div class="ex-rx ex-rx-supporting ${meta.cls}">
      <div class="ex-rx-line"><span class="ex-rx-tag lbl">${escHtml(meta.word)}</span></div>
      ${why}
      ${varyMenu}
    </div>`;
  }
  const delta = rx.delta_text ? escHtml(rx.delta_text) : "";
  const target = escHtml(rxTargetText(rx));
  return `<div class="ex-rx ${meta.cls}">
      <div class="ex-rx-line">
        <span class="ex-rx-tag lbl">${escHtml(meta.word)}</span>
        <span class="ex-rx-target numeral">${target}</span>
        ${delta ? `<span class="ex-rx-delta">${delta}</span>` : ""}
      </div>
      ${why}
      ${varyMenu}
    </div>`;
}

function rxMoveCount(rxByExercise: ClientPrescriptionRecord | null | undefined): number {
  return Object.values(rxByExercise || {}).filter((rx) => rx && rx.action && rx.action !== "hold").length;
}

function cardioDominantZone(zones: unknown): string {
  const rows = (Array.isArray(zones) ? zones : [])
    .map((z) => {
      const row = z && typeof z === "object" ? (z as Record<string, unknown>) : {};
      return {
        zi: Math.min(5, Math.max(1, finiteNumber(row.zone) || 0)),
        secs: finiteNumber(row.secs) || 0,
      };
    })
    .filter((z) => z.zi >= 1 && z.secs > 0);
  if (!rows.length) return "";
  const total = rows.reduce((t, z) => t + z.secs, 0);
  if (total <= 0) return "";
  const top = rows.reduce((a, b) => (b.secs > a.secs ? b : a));
  return top.secs / total >= 0.5 ? `mostly Z${top.zi}` : `Z${top.zi}`;
}

function cardioVerb(label: unknown): string {
  const l = String(label || "").toLowerCase().replace(/[_-]+/g, " ");
  // Explicit modality always outranks generic workout modifiers. Otherwise
  // "Bike intervals" or "Long swim" silently becomes a run, corrupting both
  // capture language and synced-effort matching.
  if (/\b(ride|riding|bike|biking|cycle|cycling|cyclist|spin|spinning)\b/.test(l)) return "ride";
  if (/\b(swim|swimming)\b/.test(l)) return "swim";
  if (/\b(row|rowing|erg)\b/.test(l)) return "row";
  if (/\b(hike|hiking)\b/.test(l)) return "hike";
  if (/\b(walk|walking)\b/.test(l)) return "walk";
  if (/\b(run|running|jog|jogging)\b/.test(l)) return "run";
  if (/\b(tempo|intervals?|long)\b/.test(l)) return "run";
  return "effort";
}

function cardioLogPhrase(item: Record<string, unknown>): string {
  const label = item.label || item.note || item.exercise || "";
  const verb = cardioVerb(label);
  const pastTense: Record<string, string> = {
    run: "ran",
    ride: "rode",
    swim: "swam",
    row: "rowed",
    hike: "hiked",
    walk: "walked",
  };
  const v = pastTense[verb] || "did";
  const bits = [];
  if (item.target_distance_km != null) bits.push(`${fmtKm(item.target_distance_km)} km`);
  else if (item.target_duration_min != null) bits.push(`${Math.round(Number(item.target_duration_min))} min`);
  if (item.target_zone) bits.push(`(${item.target_zone})`);
  return `${v} ${bits.join(" ")}`.trim() || `${v} my planned ${verb}`;
}

Object.assign(globalThis, {
  CairnTodayTraining: {
    RX_ACTION: TODAY_RX_ACTION,
    rxTargetText,
    exRxVaryMenuHtml,
    exRxLineHtml,
    rxMoveCount,
    cardioDominantZone,
    cardioVerb,
    cardioLogPhrase,
    requestRxSwap,
    refreshWeeklyPlanAfterSwap,
  },
});
