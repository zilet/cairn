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
  // Each chip is ACTIONABLE: tapping it swaps this option in RIGHT NOW (from → this
  // option) via /program/swap/apply — the plan adapts and the new movement is ready
  // to log against immediately. Carries the from-exercise + the plan day for the handler.
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
  return `<div class="ex-rx-vary-menu"><span class="ex-rx-vary-lbl lbl">rotate one in</span><div class="ex-rx-opts">${chips}</div></div>`;
}

// Swap the movement in RIGHT NOW — "adapts as I go", no Coach review gate. The swap
// lands in the plan immediately (/program/swap/apply) and the surface the athlete is
// looking at re-renders so the new movement's card is ready to log against. The plan
// quietly follows what they actually do. Best-effort: uses the global api()/toast()
// when present; a no-op outside the browser (tests) or when api() is absent.
async function requestRxSwap(from: string, to: string, day: number | null): Promise<void> {
  if (typeof api !== "function" || !from || !to || day == null) return;
  try {
    const r = (await api("/program/swap/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ day, from, to }),
    })) as
      | { ok?: boolean; error?: string }
      | null;
    if (r && r.ok) {
      if (typeof toast === "function") toast(`Swapped in ${to} — log your sets.`);
      refreshAfterSwap(day);
    } else if (typeof toast === "function") {
      toast((r && r.error) || "Couldn't make that swap.");
    }
  } catch {
    if (typeof toast === "function") toast("Couldn't make that swap.");
  }
}

// The swap changed the plan — drop the cached plan/prescriptions and re-render
// wherever the athlete is (Session or Today) so the new movement appears in place,
// ready to log. Mirrors the coach-apply refresh (state.plan = [] forces a fresh
// /plan fetch). All guarded: a missing global is simply skipped.
function refreshAfterSwap(day: number): void {
  const g = globalThis as Record<string, unknown> & {
    state?: { tab?: string; plan?: unknown[]; brief?: unknown };
    swrInvalidate?(keyOrPrefix: string): void;
    renderSession?(opts?: unknown): unknown;
    reshapeToday?(): unknown;
  };
  try {
    if (g.state) {
      g.state.plan = [];
      g.state.brief = null;
    }
    g.swrInvalidate?.("plan");
    g.swrInvalidate?.("today");
    g.swrInvalidate?.(`program:progression:${day}`);
  } catch {}
  try {
    const tab = g.state && g.state.tab;
    if (tab === "session" && typeof g.renderSession === "function") g.renderSession();
    else if (typeof g.reshapeToday === "function") g.reshapeToday();
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

function exRxLineHtml(rx: ClientPrescriptionLike): string {
  if (!rx) return "";
  const action = rx.action && Object.hasOwn(TODAY_RX_ACTION, rx.action) ? rx.action : "hold";
  const meta = TODAY_RX_ACTION[action];
  const delta = rx.delta_text ? escHtml(rx.delta_text) : "";
  const target = escHtml(rxTargetText(rx));
  return `<div class="ex-rx ${meta.cls}">
      <div class="ex-rx-line">
        <span class="ex-rx-tag lbl">${escHtml(meta.word)}</span>
        <span class="ex-rx-target numeral">${target}</span>
        ${delta ? `<span class="ex-rx-delta">${delta}</span>` : ""}
      </div>
      ${rx.why ? `<div class="ex-rx-why">${escHtml(rx.why)}</div>` : ""}
      ${rx.action === "vary" || rx.action === "introduce" ? exRxVaryMenuHtml(rx) : ""}
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
  const l = String(label || "").toLowerCase();
  if (/run|jog|tempo|interval|long/.test(l)) return "run";
  if (/ride|bike|cycl|spin/.test(l)) return "ride";
  if (/swim/.test(l)) return "swim";
  if (/row/.test(l)) return "row";
  return "effort";
}

function cardioLogPhrase(item: Record<string, unknown>): string {
  const label = item.label || item.note || item.exercise || "";
  const verb = cardioVerb(label);
  const v =
    verb === "run" ? "ran" : verb === "ride" ? "rode" : verb === "swim" ? "swam" : verb === "row" ? "rowed" : "did";
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
  },
});
