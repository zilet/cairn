// ==== 03-today.js ====
// ---------- Today ----------
// Build one exercise logging card. `it` = plan item (or synthetic {exercise} for off-plan).
// `logged` = sets already logged for this exercise in the loaded session.
// `prefill` = {weight,reps,rir} to seed the inputs.
function exTimed(it, logged) {
  if (it.mode === "timed" || it.target_seconds != null) return true;
  if ((state.exModes || {})[it.exercise] === "timed") return true;
  return (logged || []).some((s) => s.duration_sec != null);
}

function exCard(it, logged, prefill, revealIdx) {
  const offPlan = !it.fromPlan;
  const timed = exTimed(it, logged);
  const range = offPlan ? "" : (it.rep_low === it.rep_high ? `${it.rep_low}` : `${it.rep_low}–${it.rep_high}`);
  const targetTxt = timed
    ? `${it.sets ?? "?"} × ${it.target_seconds != null ? fmtDur(it.target_seconds) : "time"}`
    : `${it.sets} × ${range}`;
  const target = offPlan
    ? `<span class="ex-sets ex-offplan">off-plan</span>`
    : `<span class="ex-sets">${targetTxt}${!timed && it.target_weight != null ? ` @ <span class="ex-target numeral">${fmtWeight(it.target_weight)}</span>` : ""}</span>`;
  const done = logged.length;
  const goal = offPlan ? 0 : (it.sets || 0);
  const complete = goal && done >= goal;
  const progress = `<span class="ex-prog${complete ? " done" : ""}" data-prog>${done}${goal ? ` / ${goal}` : ""} <span>set${done === 1 && !goal ? "" : "s"}</span></span>`;
  const pw = prefill.weight, pr = prefill.reps, prir = prefill.rir;
  const tile = artImg("exercise", it.exercise, "artile-sm ex-art", art("exercise", it.exercise, it.muscle_group));
  const logrow = timed
    ? `<div class="logrow" data-ex="${encodeURIComponent(it.exercise)}" data-day="${state.day}" data-mode="timed">
        <input type="text" inputmode="numeric" autocomplete="off" placeholder="TIME · 1:30" class="in-dur" value="${prefill.duration_sec != null ? fmtDur(prefill.duration_sec) : ""}">
        <button class="logbtn">+</button>
      </div>`
    : `<div class="logrow" data-ex="${encodeURIComponent(it.exercise)}" data-day="${state.day}">
        <input type="number" inputmode="decimal" placeholder="WT" class="in-w" aria-label="Weight" value="${pw ?? ""}">
        <input type="number" inputmode="numeric" placeholder="REPS" class="in-r" aria-label="Reps" value="${pr ?? ""}">
        <input type="number" inputmode="decimal" placeholder="RIR" class="in-rir" title="Reps in reserve — how many more you could have done" aria-label="RIR (reps in reserve)" value="${prir ?? ""}">
        <button class="logbtn">+</button>
      </div>`;
  // "Not today" — only a planned exercise with nothing logged yet is skippable
  // (once a set lands, the log wins; the control disappears).
  const skipBtn = (!offPlan && !done)
    ? `<button class="ex-skip" data-skip="${encodeURIComponent(it.exercise)}" title="Not today" aria-label="Skip ${escAttr(it.exercise)} today">✕</button>`
    : "";
  // off-plan cards (added on the fly) get a remove ✕ even before a set lands, so a
  // mis-added exercise is never stuck on the page; planned-but-unlogged gets "skip".
  const removeBtn = (offPlan && !done)
    ? `<button class="ex-skip ex-remove" data-remove-card title="Remove" aria-label="Remove ${escAttr(it.exercise)}">✕</button>`
    : "";
  return `<div class="ex${complete ? " ex-complete" : ""}${revealIdx != null ? " reveal" : ""}" data-card="${escAttr(it.exercise)}" data-mode="${timed ? "timed" : "reps"}"${revealIdx != null ? ` style="${stagger(revealIdx)}"` : ""}>
      <div class="ex-top">
        ${tile}
        <button class="ex-name" data-guide="${encodeURIComponent(it.exercise)}">${escHtml(it.exercise)} <span class="guide-i">ⓘ</span></button>
        ${target}
        ${skipBtn}${removeBtn}
      </div>
      <div class="ex-meta">${progress}</div>
      ${it.note ? `<div class="ex-note">${escHtml(it.note)}</div>` : ""}
      ${it.constraint_note ? `<div class="ex-flag">${escHtml(it.constraint_note)}</div>` : ""}
      <div class="logged" data-logged>${logged.map(setChip).join("")}</div>
      ${logrow}
    </div>`;
}

// Today: a planned cardio effort. A prescription (distance/duration/zone/interval)
// + a calm "log this" affordance that prefills the free-text capture (it routes
// through the same activity log as everything else — no separate set-logger). Reuses
// the .ex card vocabulary so it sits naturally among the strength cards.
//
// `done` (optional) = a matched synced cardio effort (a CardioEffort from
// /api/cardio). When present the card flips to a calm "✓ Easy run — 8.2 km · mostly
// Z2 · synced from Garmin" read (see cardioDoneCard) with NO "log this" button — the
// run already happened, the watch carried it. When absent we keep the prescription,
// but "Log this run →" is the FALLBACK with a quiet "or it'll sync from your watch"
// hint, since a synced run is the runner's preferred path. (Sync freshness rides on a
// separate line — see cardioSyncLine — only when Garmin is configured.)
function cardioPlanCard(it, revealIdx, done, syncline) {
  if (done) return cardioDoneCard(it, done, revealIdx);
  const tile = artImg("activity", cardioArtPhrase(it), "artile-sm ex-art", art("activity", cardioArtPhrase(it)));
  const pres = cardioPrescription(it);
  const label = cardioLabel(it);
  const verb = cardioVerb(label);
  // When Garmin is configured, the single freshness line below (cardioSyncLine) carries
  // the whole "your watch will log it · synced Xh ago · Sync now" story — so "Log this
  // run →" reads as the fallback without a second, redundant "or it'll sync" hint
  // stacked above it (a non-Garmin user shows neither — syncline is "").
  return `<div class="ex ex-cardio${revealIdx != null ? " reveal" : ""}" data-cardio-card${revealIdx != null ? ` style="${stagger(revealIdx)}"` : ""}>
      <div class="ex-top">
        ${tile}
        <span class="ex-name ex-name-static">${escHtml(label)} <span class="cardio-tag lbl">cardio</span></span>
        ${pres ? `<span class="ex-sets ex-cardio-pres">${escHtml(pres)}</span>` : ""}
      </div>
      ${it.interval_note || cardioIntervalNote(it.interval) ? `<div class="ex-note">${escHtml(cardioIntervalNote(it.interval) || it.interval_note)}</div>` : ""}
      <div class="cardio-logrow">
        <button class="ghostbtn cardio-log-btn" data-cardio-log="${escAttr(cardioLogPhrase(it))}">Log this ${escHtml(verb)} →</button>
      </div>
      ${syncline || ""}
    </div>`;
}

// A calm "the run happened" card — the cardio analogue of garminSessionCard's
// "body's reaction" tone. Shows the real distance / zone / pace / HR off the synced
// effort, a sage ✓, and NO log button (it's done). Falls back gracefully when a field
// is missing. Numbers are plain reads — never a score. `eff` is a CardioEffort row
// from /api/cardio (the matched run); `it` is the prescription it satisfied.
function cardioDoneCard(it, eff, revealIdx) {
  const label = cardioLabel(it);
  const tile = artImg("activity", cardioArtPhrase(it), "artile-sm ex-art", art("activity", eff.type || cardioArtPhrase(it)));
  const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  // Headline read: "Easy run — 8.2 km" (distance preferred, else duration).
  const dist = num(eff.distance_km);
  const dur = num(eff.duration_min);
  const headBits = [];
  if (dist != null && dist > 0) headBits.push(`${fmtKm(dist)} km`);
  else if (dur != null && dur > 0) headBits.push(`${Math.round(dur)} min`);
  const headline = `${label}${headBits.length ? ` — ${headBits.join(" · ")}` : ""}`;
  // Detail chips: dominant zone (in plain words), pace, avg HR, source.
  const chips = [];
  const zoneWord = cardioDominantZone(eff.zones);
  if (zoneWord) chips.push(zoneWord);
  if (eff.pace) chips.push(`${String(eff.pace)}/km`);
  const ahr = num(eff.avg_hr);
  if (ahr != null) chips.push(`${Math.round(ahr)} avg hr`);
  if (dur != null && dur > 0 && headBits[0] && !headBits[0].includes("min")) chips.push(`${Math.round(dur)} min`);
  const fromGarmin = eff.source === "garmin";
  const chipHtml = chips.map((c) => `<span class="done-chip">${escHtml(c)}</span>`).join("");
  return `<div class="ex ex-cardio ex-cardio-done${revealIdx != null ? " reveal" : ""}" data-cardio-card${revealIdx != null ? ` style="${stagger(revealIdx)}"` : ""}>
      <div class="ex-top">
        ${tile}
        <span class="ex-name ex-name-static cardio-done-head">
          <span class="cardio-done-mark" aria-hidden="true">✓</span>${escHtml(headline)}
        </span>
        ${fromGarmin ? `<span class="garmin-tag">✦ synced from Garmin</span>` : ""}
      </div>
      ${chipHtml ? `<div class="cardio-done-chips">${chipHtml}</div>` : ""}
    </div>`;
}

// The dominant HR zone of a synced effort, in plain words ("mostly Z2"). Reads the
// parsed hr_zones [{zone,secs}] off /api/cardio; "" when there's no zone data — never
// a score, just where the run mostly sat. Mirrors garminSessionCard's zone handling.
function cardioDominantZone(zones) {
  const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const zs = (Array.isArray(zones) ? zones : [])
    .map((z) => ({ zi: Math.min(5, Math.max(1, num(z && z.zone) || 0)), secs: num(z && z.secs) || 0 }))
    .filter((z) => z.zi >= 1 && z.secs > 0);
  if (!zs.length) return "";
  const total = zs.reduce((t, z) => t + z.secs, 0);
  if (total <= 0) return "";
  const top = zs.reduce((a, b) => (b.secs > a.secs ? b : a));
  return top.secs / total >= 0.5 ? `mostly Z${top.zi}` : `Z${top.zi}`;
}

// Does a synced cardio effort satisfy a planned cardio item? The bar is deliberately
// low (per spec): a compatible-type effort logged today is enough to call the
// prescription done — a runner's plan day is "did a run happen?", not an exact-match
// audit. Compatibility falls back to "any endurance effort" when neither side names a
// recognizable verb (so a generic activity still flips a generic cardio prescription).
function cardioEffortMatches(it, eff) {
  if (!eff) return false;
  const want = cardioVerb(cardioLabel(it));          // run / ride / swim / row / effort
  const got = cardioVerb(eff.type || eff.name || ""); // map the effort's type the same way
  if (want === "effort" || got === "effort") return true; // unrecognized either side → presence is enough
  return want === got;
}

// ---------- sync trust: a quiet freshness line where a runner needs the mileage ----------
// A runner trusts the watch — so where mileage is shown (the run card, the Endurance
// view) we surface, calmly: "synced 2h ago · Sync now". Read freshness from the
// settings object (garmin_last_sync_at / garmin_last_sync_status). Only shown when
// Garmin is actually configured; otherwise we stay silent (no nag, no empty chrome).
//
// Garmin counts as configured when credentials are present (username/password, from
// settings or env) — the same signal the Settings sync card uses.
function garminConfigured(settings) {
  if (!settings) return false;
  if (settings.garmin_credentials_source && settings.garmin_credentials_source !== "none") return true;
  return !!(settings.garmin_username || settings.garmin_password_configured);
}

// Build the quiet "synced 2h ago · Sync now" line for a run/Endurance surface. When a
// run is prescribed today but nothing's synced yet AND the last sync is stale, swaps
// the lead for a calm "this morning's run not synced yet?" nudge (never nagging).
// Returns "" when Garmin isn't configured. `opts.expectingRun` flags the stale-nudge
// case (a prescribed run with no synced effort today).
function cardioSyncLine(settings, { expectingRun } = {}) {
  if (!garminConfigured(settings)) return "";
  const at = settings.garmin_last_sync_at;
  const raw = String(settings.garmin_last_sync_status || "");
  const failed = raw.startsWith("failed");
  // "Stale" = no sync, a failed sync, or the last good sync was a while ago (>3h) —
  // long enough that this morning's run may not be in yet.
  const ageH = at ? Math.max(0, (Date.now() - Date.parse(at)) / 3600000) : Infinity;
  const stale = !at || failed || ageH > 3;
  let lead;
  if (expectingRun && stale) {
    lead = `<span class="cardio-sync-dot stale" aria-hidden="true"></span><span class="cardio-sync-text">this morning's run not synced yet?</span>`;
  } else if (!at) {
    lead = `<span class="cardio-sync-dot" aria-hidden="true"></span><span class="cardio-sync-text">not synced yet</span>`;
  } else {
    const dotCls = failed ? "err" : "";
    const word = failed ? "Sync failed" : "synced";
    lead = `<span class="cardio-sync-dot ${dotCls}" aria-hidden="true"></span><span class="cardio-sync-text">${word} ${escHtml(relTime(at))}</span>`;
  }
  return `<div class="cardio-sync" data-cardio-sync>
      ${lead}
      <button class="cardio-sync-go" type="button" data-syncnow>Sync now</button>
    </div>`;
}

// Wire every "Sync now" control within `scope`: POST /garmin/sync, pulse while it
// runs, then refresh the surface so the fresh mileage / synced run lands. Shared by
// Today (re-renders Today) and Endurance (re-renders the endurance view via the passed
// onDone). Degrades calmly: a failure restores the button + toasts, never throws.
function wireCardioSync(scope, onDone) {
  (scope || view).querySelectorAll("[data-syncnow]").forEach((btn) => {
    if (btn._wired) return; btn._wired = true;
    btn.addEventListener("click", async () => {
      const line = btn.closest("[data-cardio-sync]");
      btn.disabled = true;
      const text = line && line.querySelector(".cardio-sync-text");
      const prevText = text ? text.textContent : "";
      const dot = line && line.querySelector(".cardio-sync-dot");
      if (dot) dot.classList.add("pulse");
      if (text) text.textContent = "Syncing…";
      btn.textContent = "…";
      let r = null;
      try { r = await api("/garmin/sync", { method: "POST" }); } catch {}
      if (!btn.isConnected) return; // a re-render replaced the view while we waited
      const ok = r && r.ok;
      toast(ok ? `Garmin synced · ${r.activities} activit${r.activities === 1 ? "y" : "ies"}` : "Garmin sync failed");
      if (ok) {
        // a sync may have landed today's run + reshaped the day — drop the relevant
        // peeks so the refresh reads truth.
        swrInvalidate("today:session:" + state.logDate);
        swrInvalidate("stats");
        if (onDone) { onDone(); return; }
      }
      // not ok (or no onDone): restore the line in place so it never stays stuck.
      if (dot) dot.classList.remove("pulse");
      if (text) text.textContent = prevText;
      btn.disabled = false;
      btn.textContent = "Sync now";
    });
  });
}
// The verb for the "Log this …" button — "run" / "ride" / "swim" / "session".
function cardioVerb(label) {
  const l = String(label || "").toLowerCase();
  if (/run|jog|tempo|interval|long/.test(l)) return "run";
  if (/ride|bike|cycl|spin/.test(l)) return "ride";
  if (/swim/.test(l)) return "swim";
  if (/row/.test(l)) return "row";
  return "effort";
}
// A natural-language prefill for the capture box — "ran 12 km easy (Z2)" style — so
// one tap drops a sensible sentence in and they tweak the actuals before logging.
function cardioLogPhrase(it) {
  const verb = cardioVerb(cardioLabel(it));
  const v = verb === "run" ? "ran" : verb === "ride" ? "rode" : verb === "swim" ? "swam" : verb === "row" ? "rowed" : "did";
  const bits = [];
  if (it.target_distance_km != null) bits.push(`${fmtKm(it.target_distance_km)} km`);
  else if (it.target_duration_min != null) bits.push(`${Math.round(Number(it.target_duration_min))} min`);
  if (it.target_zone) bits.push(`(${it.target_zone})`);
  return `${v} ${bits.join(" ")}`.trim() || `${v} my planned ${verb}`;
}

function setChip(s, i) {
  const n = s.set_number ?? (i != null ? i + 1 : null);
  const figure = s.duration_sec != null
    ? fmtDur(s.duration_sec)
    : `${fmtWeight(s.weight)} <span>×</span> ${s.reps}${s.rir != null ? ` <span>@${s.rir}</span>` : ""}`;
  return `<span class="chip" data-set="${s.id}">${n != null ? `<span class="chip-n">#${n}</span> ` : ""}${figure}<button class="chip-x" data-del="${s.id}" title="delete">×</button></span>`;
}

// Tonnage = Σ weight×reps over LOADED sets (positive weight AND reps; timed and
// bodyweight/assisted sets excluded). One definition of "what counts" — reused by
// the done card, the finish row, and history so the rule can't drift.
function setsTonnage(sets) {
  return (sets || []).reduce((t, s) => t + (s.weight > 0 && s.reps ? s.weight * s.reps : 0), 0);
}

// Set an exercise's mode by name (upsert-by-name). Returns the api() promise.
function postExerciseMode(name, mode) {
  return api("/exercises", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, mode }) });
}

function planDayNumberForSession(session, plan) {
  if (!session || !(session.sets || []).length) return null;
  const byId = plan.find((d) => Number(d.id) === Number(session.plan_day_id));
  if (byId) return byId.day_number;

  const loggedNames = new Set((session.sets || []).map((s) => s.exercise).filter(Boolean));
  let best = null;
  for (const d of plan) {
    const plannedNames = new Set((d.items || []).map((it) => it.exercise));
    let hits = 0;
    loggedNames.forEach((name) => { if (plannedNames.has(name)) hits++; });
    if (hits && (!best || hits > best.hits)) best = { day_number: d.day_number, hits };
  }
  return best?.day_number ?? null;
}

function nextPlanDayNumber(dayNumber, plan) {
  const ordered = [...plan].sort((a, b) => a.day_number - b.day_number);
  if (!ordered.length) return null;
  const idx = ordered.findIndex((d) => d.day_number === dayNumber);
  return ordered[idx >= 0 ? (idx + 1) % ordered.length : 0].day_number;
}

async function suggestedPlanDayNumber(session, isToday) {
  const currentLoggedDay = planDayNumberForSession(session, state.plan);
  if (currentLoggedDay) return currentLoggedDay;
  if (!isToday) return state.plan[0]?.day_number ?? 1;

  try {
    const recent = await api("/sessions?limit=20");
    const latest = (recent || []).find((s) =>
      s.date !== state.logDate && planDayNumberForSession(s, state.plan)
    );
    const latestDay = planDayNumberForSession(latest, state.plan);
    return latestDay ? nextPlanDayNumber(latestDay, state.plan) : (state.plan[0]?.day_number ?? 1);
  } catch {
    return state.plan[0]?.day_number ?? 1;
  }
}

// ---------- The Brief (day-read) ----------
// Phase 1: Today opens with a calm day-read — rest / easy / train — fetched from
// GET /api/today-read. It's a SUGGESTION, never a gate: every read carries one-tap
// redirects (train anyway · ask for a session · pull in your plan) so the rest of
// the surface is always one move away. The read is cached per-date on state.brief
// (keyed by date+override) so re-renders that don't change the day don't re-fetch.

// Map the read kind to its calm copy + glyph. Restful for rest, light for easy,
// energetic-but-quiet for train. Phrasing is plain language — never a score.
const BRIEF_KIND = {
  rest: { word: "Rest", glyph: "◐", lead: "A quiet day" },
  easy: { word: "Easy", glyph: "◑", lead: "Keep it light" },
  train: { word: "Train", glyph: "◆", lead: "Good to go" },
};
// Escape-hatch chips — each reshapes the read via ?override=. They open, never scold.
// "Train anyway" intentionally lives only in the launchpad (an instant plan-reveal),
// not here: an override chip of the same name would be a slow agentic round-trip AND
// a confusing duplicate of the primary button.
const BRIEF_OVERRIDES = [
  { intent: "rough night", label: "Rough night" },
  { intent: "short on time", label: "Short on time" },
  { intent: "give me an easy day", label: "Easy day instead" },
];

// Fetch (or reuse) the day-read for the selected date. Always resolves to a read
// object — the endpoint is always 200 (agentic or deterministic fallback). On a
// hard network failure we synthesize a minimal "train" read so the launchpad still
// works; the Brief never blocks the rest of Today.
// A bare provisional read used only to paint Today's structure instantly when the
// agentic read isn't warm yet. Marked _provisional so the background upgrade knows
// to replace it; it's never cached as the final read.
function provisionalRead(_date) {
  return { kind: "train", headline: "Today", why: "", focus: null, est_minutes: null, signals: {}, source: "deterministic", _provisional: true };
}

async function loadBrief(date, override, opts = {}) {
  const cached = state.brief;
  // Reuse a non-provisional cached read for the same date/override.
  if (cached && cached.date === date && cached.override === (override || "") && !cached.read._provisional) return cached.read;
  const fetchRead = (async () => {
    let read = null;
    try {
      const qs = new URLSearchParams({ date, agent: "auto" });
      if (override) qs.set("override", override);
      read = await api("/today-read?" + qs.toString());
    } catch { read = null; }
    if (!read || !read.kind) read = provisionalRead(date);
    return read;
  })();
  // Fast mode (first paint): never block more than ~the timeout. The endpoint
  // returns a cached read instantly, so the common case resolves immediately;
  // only a cold cache (first-ever agentic compute) hits the timeout, where we
  // paint a provisional read and let the background upgrade swap the real one in.
  if (opts.fast) {
    const TIMEOUT = 1200;
    const raced = await Promise.race([
      fetchRead.then((r) => ({ r })),
      new Promise((resolve) => setTimeout(() => resolve(null), TIMEOUT)),
    ]);
    if (raced && raced.r && !raced.r._provisional) {
      // Adopt the server-persisted steer (read.override) on a fresh open/reload —
      // the warm-cache reload hits this fast path, so the steer must survive here.
      state.brief = { date, override: override || raced.r.override || "", read: raced.r };
      return raced.r;
    }
    // timed out (or only got a provisional) — keep the real fetch alive so the
    // upgrade can await the SAME promise instead of firing a second request.
    state._briefInflight = { date, override: override || "", promise: fetchRead };
    const prov = (raced && raced.r) || provisionalRead(date);
    state.brief = { date, override: override || "", read: prov };
    return prov;
  }
  state._briefInflight = null; // a non-fast (deliberate) load supersedes any pending upgrade
  const read = await fetchRead;
  // The server PERSISTS the athlete's steer on the read (read.override). When we
  // didn't request one explicitly (a fresh open / reload), adopt the persisted steer
  // so the chips filter correctly and the active-steer styling shows — this is what
  // makes "Easy day instead" survive a reload instead of snapping back to canonical.
  state.brief = { date, override: override || read.override || "", read };
  return read;
}

// Upgrade a provisionally-painted Brief to the real (agentic) read in place,
// without re-rendering the rest of Today. Runs the .is-thinking filament while
// it waits, then swaps the .brief element. No-op if the read was already real,
// the tab changed, or the date/override moved on. Pull-never-push: it just
// quietly settles into the better read; nothing nags.
async function upgradeBriefInPlace(date, isToday) {
  const inflight = state._briefInflight;
  if (!inflight || inflight.date !== date) return; // nothing provisional to upgrade
  const briefEl = view.querySelector(".brief");
  if (briefEl && !reducedMotion()) briefEl.classList.add("is-thinking");
  let read = null;
  try { read = await inflight.promise; } catch { read = null; }
  // Stale-guard: bail if we navigated away or the date moved while waiting.
  if (state.tab !== "today" || state.logDate !== date) return;
  if (state._briefInflight === inflight) state._briefInflight = null;
  if (!read || read._provisional) { briefEl?.classList.remove("is-thinking"); return; }
  // Adopt the server-persisted steer when the real read settles (cold-cache path).
  state.brief = { date, override: inflight.override || read.override || "", read };
  const live = view.querySelector(".brief");
  if (!live) return;
  // Re-derive showPlan in case the real read flipped train↔rest/easy; only the
  // Brief element is swapped, so the logging surface below is untouched.
  const day = state.plan.find((d) => d.day_number === state.day) || state.plan[0] || { items: [] };
  const hasPlanDay = (day.items || []).length > 0;
  const showPlan = !!view.querySelector(".plansurface");
  const tmp = document.createElement("div");
  tmp.innerHTML = briefHtml(read, { showPlan, hasPlanDay, isToday });
  const fresh = tmp.firstElementChild;
  if (!fresh) { live.classList.remove("is-thinking"); return; }
  fresh.classList.add(reducedMotion() ? "" : "brief-settle");
  live.replaceWith(fresh);
  wireBrief(read, { isToday });
  runCountUps(fresh);
  if (showPlan) loadTrainingProvenance(isToday); // re-attach the causal line after the swap
}

// A relevant log just reshaped today (an activity, a check-in) — drop the cached
// Brief so it re-fetches the server-recomputed read, and if Today is the live
// surface, re-render it with the hero morph so the change shows immediately. A
// logged set doesn't need this: the first set already re-renders Today, and
// nulling state.brief there lets that render pick up the fresh read.
async function reshapeToday() {
  state.brief = null;
  // A relevant log (activity / food / weight / check-in) can shift the day's
  // session, weekly stats, and energy read — drop their SWR caches so the
  // re-render below reads truth instead of a stale warm peek.
  swrInvalidate("today:session:" + state.logDate);
  swrInvalidate("stats");
  swrInvalidate("progress:energy");
  if (state.tab !== "today") return;
  // Re-fetch the read BEFORE the transition so renderToday's loadBrief hits the
  // warm cache and the DOM update is instant — running the (slow, agentic) fetch
  // inside withViewTransition trips its ~4s timeout and aborts the morph. This
  // mirrors the override-chip path. The fetch can take a few seconds; the "Logged"
  // toast already gave feedback, and the old read stays put until the flip lands.
  await loadBrief(state.logDate, "");
  if (state.tab !== "today") return; // navigated away during the await
  const morph = !reducedMotion();
  if (morph) { view.querySelector(".brief")?.classList.add("brief-morph"); state._briefMorph = true; }
  try {
    await withViewTransition(() => renderToday());
  } finally {
    state._briefMorph = false;
    view.querySelector(".brief")?.classList.remove("brief-morph");
  }
}

// One launchpad redirect chip. `primary` gets the accent treatment (the day's
// smart default action); the rest are quiet hairline pills.
function briefRedirect(action, label, primary) {
  return `<button class="brief-redirect${primary ? " brief-redirect-primary" : ""}" data-redirect="${escAttr(action)}">${escHtml(label)}</button>`;
}

function visibleBriefOverrides({ kind, estMinutes, activeOverride }) {
  return BRIEF_OVERRIDES.filter((o) => {
    if (o.intent === activeOverride) return false;
    if (kind === "easy" && o.intent === "give me an easy day") return false;
    if (kind === "rest" && o.intent === "rough night") return false;
    if (estMinutes != null && estMinutes <= 30 && o.intent === "short on time") return false;
    return true;
  });
}

// ---------- honest degradation: one calm line when coaching is offline ----------
// The agentic endpoints (day-read, session-suggest, meal-plan, insight) return an
// `agent_status` of 'ok' | 'unconfigured' | 'all_failed'. When no agent is reachable
// the deterministic floor still answers, but silently — so we surface ONE quiet,
// dismissible line where the agentic read was expected. Never alarming (no red,
// no warn band — a hairline aside), absent when status is 'ok'/missing, and
// dismissed for the session so it never nags. Pull-never-push.
let _agentOfflineDismissed = false;
function agentOffline(status) {
  return status === "unconfigured" || status === "all_failed";
}
function agentOfflineNoticeHtml(status) {
  if (_agentOfflineDismissed || !agentOffline(status)) return "";
  const line = status === "unconfigured"
    ? "Coaching is offline — connect an agent in Settings for the agentic read."
    : "Couldn't reach a coaching agent just now — showing the deterministic read.";
  return `<div class="agent-offline" role="note">
      <span class="agent-offline-dot" aria-hidden="true"></span>
      <span class="agent-offline-text">${escHtml(line)}</span>
      <button class="agent-offline-x" data-agentoffx aria-label="Dismiss">✕</button>
    </div>`;
}
// Wire the dismiss ✕ on any rendered offline notice within `scope`. Dismissal is
// for the session (a module flag), so it stays quiet until the next reload.
function wireAgentOffline(scope) {
  (scope || view).querySelectorAll("[data-agentoffx]").forEach((b) =>
    b.addEventListener("click", () => {
      _agentOfflineDismissed = true;
      const el = b.closest(".agent-offline");
      if (el) collapseEl(el, () => el.remove()); else b.remove();
    }));
}

// Build the Brief hero + actions row + steer line. `showPlan` = the plan surface
// is already (or about to be) visible. The controls split into two clear tiers:
// an ACTIONS row (one primary thing to do, scaled to the day) and a quiet, labeled
// STEER line ("tell me different" — each option reshapes the read agentically).
function briefHtml(read, { showPlan, isToday }) {
  const kind = BRIEF_KIND[read.kind] ? read.kind : "train";
  const meta = BRIEF_KIND[kind];
  const focus = read.focus ? escHtml(read.focus) : "";
  const estMinutes = read.est_minutes != null && Number(read.est_minutes) > 0 ? Math.round(read.est_minutes) : null;
  const est = estMinutes != null ? `${estMinutes} min` : "";
  // Headline leads; on a train day the focus IS the headline-adjacent line.
  const headline = escHtml(read.headline || meta.lead);
  const why = read.why ? escHtml(read.why) : "";

  // ---- Actions: ONE clear thing to do. The accent primary is reserved for a
  // train day ("start the session"); easy/rest stay calm with NO accent CTA, so
  // the card never contradicts a read the athlete just chose to take easy.
  const actions = [];
  if (kind === "train") {
    actions.push(briefRedirect("start-session", "Start session", true));
  } else if (!showPlan) {
    // easy / rest — a quiet way into the plan if they want it, never shouted
    actions.push(briefRedirect("reveal-plan", "Train anyway", false));
  }
  actions.push(briefRedirect("ask-session", "Ask for a session", false));

  // ---- Steer line: visually subordinate to the actions. Only meaningful for
  // today (a live read to reshape). When a steer is already active, the label
  // shifts and a quiet "back to today's read" clears it (the un-steer escape).
  const activeOverride = state.brief && state.brief.date === state.logDate ? state.brief.override : "";
  const steered = !!activeOverride;
  const opts = visibleBriefOverrides({ kind, estMinutes, activeOverride });
  let steer = "";
  if (isToday && (opts.length || steered)) {
    const optBtns = opts.map((o) =>
      `<button class="brief-steer-opt" data-override="${escAttr(o.intent)}">${escHtml(o.label)}</button>`
    ).join(`<span class="brief-steer-dot" aria-hidden="true">·</span>`);
    const reset = steered ? `<button class="brief-steer-reset" data-steerreset>back to today's read</button>` : "";
    steer = `<div class="brief-steer">
        <span class="brief-steer-lead">${steered ? "Changed your mind?" : "Not quite right?"}</span>
        <span class="brief-steer-opts">${optBtns}</span>
        ${reset}
      </div>`;
  }

  // When reshaping via a steer, the hero morphs through a view transition —
  // skip the entrance `rise` so the two motions don't stack.
  const morph = state._briefMorph ? " brief-morph" : "";
  const enter = state._briefMorph ? "" : " reveal";
  // A provisional (cold-cache) read paints with the terracotta→gold filament so
  // the wait reads as the agentic read still arriving, not a stalled guess.
  const thinking = read._provisional && !reducedMotion() ? " is-thinking" : "";
  const busy = read._provisional ? ` aria-busy="true"` : "";
  // Honest degradation: a real (non-provisional) read whose agent_status says no
  // agent answered surfaces ONE calm line. Skipped while provisional (the agentic
  // read may still be arriving via upgradeBriefInPlace).
  const offline = read._provisional ? "" : agentOfflineNoticeHtml(read.agent_status);
  return `<section class="brief brief-${kind}${morph}${enter}${thinking}" style="--i:0" aria-live="polite"${busy}>
      ${offline}
      <div class="brief-kicker lbl"><span class="brief-glyph" aria-hidden="true">${meta.glyph}</span> ${meta.word.toUpperCase()} DAY${est ? ` · ${escHtml(est)}` : ""}</div>
      <h2 class="brief-headline">${headline}</h2>
      ${focus && kind === "train" ? `<div class="brief-focus">${focus}</div>` : ""}
      ${why ? `<p class="brief-why">${why}</p>` : ""}
      <div id="briefProvenance" class="prov-slot"></div>
      <div class="brief-launch">${actions.join("")}</div>
      ${steer}
      <button class="brief-why-more" data-briefwhy hidden>tap to see why</button>
    </section>`;
}

// ---- Focus mode: a distraction-free logging view for a training day ----
// Per the constitution it's a calm OPTION, never forced: it auto-engages once you've
// logged a set today (you've committed to the work), you can toggle it on/off any
// time, and an explicit choice for the date always wins over the auto rule. When on,
// Today sheds the Brief/insight/capture/week chrome and keeps just a slim sticky
// header (day · progress · one-line read · exit) above the logging cards.
function focusEngaged(date, { showPlan, hasLoggedSets, isToday }) {
  if (!showPlan) return false;
  const f = state.focus;
  if (f && f.date === date) return f.on;   // the athlete's explicit choice for this date
  return !!(isToday && hasLoggedSets);      // auto: engage once logging is underway
}
function setFocus(date, on) { state.focus = { date, on }; }

// The slim sticky header shown in focus mode — day name, sets-of-exercises progress,
// the one-line Brief read for context, and a one-tap exit back to the full Today.
function focusBarHtml(read, day, { exDone, exTotal, isToday }) {
  const meta = BRIEF_KIND[BRIEF_KIND[read.kind] ? read.kind : "train"];
  const line = read.headline || read.focus || meta.lead;
  const dayName = day && day.name ? day.name : "Today's session";
  const prog = exTotal
    ? `<span class="focus-prog"><span class="focus-prog-done">${exDone}</span><span class="focus-prog-sep">/</span>${exTotal} done</span>`
    : "";
  return `<div class="focus-bar reveal" style="--i:0" aria-label="Workout focus">
      <div class="focus-bar-row">
        ${!isToday ? `<button class="focus-back" id="backToday" aria-label="Back to today">←</button>` : `<span class="focus-glyph" aria-hidden="true">${meta.glyph}</span>`}
        <div class="focus-id">
          <span class="focus-day">${escHtml(dayName)}</span>
          ${prog}
        </div>
        <button class="focus-exit" id="focusExit">Exit focus</button>
      </div>
      ${line ? `<div class="focus-read">${escHtml(line)}</div>` : ""}
    </div>`;
}

// The optional "tap to see why" detail — plain-language signals, never raw numbers
// as a verdict. Built lazily into a toast-like inline expander under the Brief.
function briefSignalsText(read) {
  const s = read.signals || {};
  const bits = [];
  if (s.consecutive_training_days != null && s.consecutive_training_days > 0) {
    bits.push(`${s.consecutive_training_days} day${s.consecutive_training_days === 1 ? "" : "s"} of training in a row`);
  }
  if (s.low_sleep) bits.push("your sleep's been running short");
  else if (s.avg_sleep_min != null && s.has_recovery_data) bits.push("sleep's been about normal for you");
  if (s.checkin) bits.push("you mentioned how you're feeling");
  if (!bits.length) return "Reading your recent training and recovery.";
  return bits.join("; ") + ".";
}

// Render one session-suggest item line (sets × reps, or seconds for timed; assisted
// / bodyweight per the weight convention). `it` is one item from the suggested session.
function suggestItemHtml(it, i = 0) {
  const name = escHtml(it.exercise || "Exercise");
  const timed = it.mode === "timed" || it.target_seconds != null;
  let prescription;
  if (timed) {
    const secs = it.target_seconds != null ? fmtDur(it.target_seconds) : "time";
    prescription = `${it.sets ?? "?"} × ${secs}`;
  } else {
    const lo = it.rep_low, hi = it.rep_high;
    const reps = lo != null && hi != null ? (lo === hi ? `${lo}` : `${lo}–${hi}`) : (lo ?? hi ?? "");
    prescription = `${it.sets ?? "?"}${reps ? ` × ${reps}` : ""}`;
    if (it.target_weight != null) {
      prescription += it.target_weight < 0 ? ` · ${-it.target_weight} assist` : ` · ${it.target_weight} lb`;
    } else {
      prescription += " · BW";
    }
  }
  const tile = artImg("exercise", it.exercise || "", "artile-sm sug-art", art("exercise", it.exercise || ""));
  return `<div class="sug-item reveal" style="${stagger(i + 1)}">
      ${tile}
      <div class="sug-item-main">
        <div class="sug-item-name">${name}</div>
        ${it.note ? `<div class="sug-item-note">${escHtml(it.note)}</div>` : ""}
      </div>
      <div class="sug-item-rx numeral">${escHtml(prescription)}</div>
    </div>`;
}

// Render the suggested session as a reviewable card under the Brief. It is a
// SUGGESTION — not saved. "Log these" surfaces the items in the existing Today
// logging UI (reuse appendOffPlanCard); "Dismiss" clears it.
function suggestCardHtml(session, verified) {
  const name = escHtml(session.name || "Session");
  const focus = session.focus ? escHtml(session.focus) : "";
  const est = session.est_minutes != null && Number(session.est_minutes) > 0 ? `${Math.round(session.est_minutes)} min` : "";
  const why = session.why ? escHtml(session.why) : "";
  const items = (Array.isArray(session.items) ? session.items : []).map((it, i) => suggestItemHtml(it, i)).join("");
  return `<section class="sug-card settle-in">
      <div class="sug-head">
        <div class="sug-kicker lbl">A session for today${est ? ` · ${escHtml(est)}` : ""}</div>
        <h3 class="sug-name">${name}</h3>
        ${focus ? `<div class="sug-focus">${focus}</div>` : ""}
      </div>
      ${why ? `<p class="sug-why">${why}</p>` : ""}
      <div class="sug-items">${items || `<div class="sug-empty">No exercises came back — try again.</div>`}</div>
      ${verifiedBadgeHtml(verified)}
      ${session.notes ? `<div class="sug-notes">${escHtml(session.notes)}</div>` : ""}
      <div class="sug-actions">
        <button class="pillbtn pill-accent" data-sugaction="log">Log these</button>
        <button class="pillbtn" data-sugaction="dismiss">Not now</button>
      </div>
      <div class="sug-hint">A suggestion to follow or ignore — it isn't saved as your plan.</div>
    </section>`;
}

// The shared runOp options for a session-suggest — used by both the live trigger
// (askForSession) and the reload reconnector, so the render/fail behavior is
// identical whether the result lands now or after a refresh.
function sessionSuggestOpOpts() {
  return {
    path: "/session-suggest",
    anchor: "#sugSlot",
    caption: "session_suggest",
    // The slot left the DOM (re-render / tab switch): drop the stream — the job
    // keeps running server-side and re-attaches via jobReconnect. Release the lock
    // so a later trigger isn't wedged on a stale in-flight flag.
    guard: () => { const gone = !view.querySelector("#sugSlot")?.isConnected; if (gone) sessionSuggestInFlight = false; return gone; },
    isFail: (r) => !r || r.ok !== true || !r.session,
    render: (r) => {
      sessionSuggestInFlight = false;
      const s = view.querySelector("#sugSlot");
      if (!s) return;
      state.suggestedSession = r.session;
      s.innerHTML = suggestCardHtml(r.session, r.verified);
      runCountUps(s);
      wireSuggestCard(s);
      s.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "nearest" });
    },
    onFail: (r) => {
      sessionSuggestInFlight = false;
      const s = view.querySelector("#sugSlot");
      if (!s) return;
      // designed failure (ok:false) or unreachable — gentle, never an error. When the
      // result says coaching is simply unconfigured, point at Settings (honest cause).
      const line = r && r.agent_status === "unconfigured"
        ? "Building a session needs a coaching agent — connect one in Settings. You can train anyway in the meantime."
        : "Couldn't draft a session just now — your buddy may be offline. You can train anyway or try again.";
      s.innerHTML = `<div class="sug-card sug-fail settle-in">
          <div class="sug-fail-line">${escHtml(line)}</div>
          <div class="sug-actions"><button class="pillbtn" data-sugaction="retry">Try again</button></div>
        </div>`;
      wireSuggestCard(s);
    },
  };
}

// Reconnector: after a reload mid-run, jobReconnect rebuilds the loading card in
// #sugSlot and returns the same handlers runOp would have used, so a session that
// finished (or finishes) while we were away lands in place. The translation from
// runOp's option shape to raw openJobStream handlers mirrors runOp's internals.
// Registered at boot (the job-runner registry is defined later in the file).
function reconnectSessionSuggest() {
  const slot = view.querySelector("#sugSlot");
  if (!slot) return null; // not on Today — a later renderToday() will retry reconnect
  sessionSuggestInFlight = true;
  slot.innerHTML = `<div class="sug-card sug-loading settle-in">
      <span class="aspin" aria-hidden="true"></span>
      <div class="sug-loading-line job-cap"></div>
    </div>`;
  const o = sessionSuggestOpOpts();
  let stop = () => {};
  const capEl = slot.querySelector(".job-cap");
  if (capEl) stop = thinkingCaption(capEl, o.caption);
  if (!reducedMotion()) slot.classList.add("is-thinking");
  const clear = () => { stop(); const s = view.querySelector("#sugSlot"); if (s) { s.classList.remove("is-thinking", "is-thinking--determinate"); s.style.removeProperty("--frac"); } };
  return {
    guard: o.guard,
    onDone: (result) => { clear(); if (o.isFail(result)) o.onFail(result); else o.render(result); },
    onError: () => { clear(); o.onFail(null); },
    onCanceled: () => { clear(); o.onFail(null); },
  };
}

// Ask the buddy for a session right now. POSTs /session-suggest as a durable
// background job (server backgrounds it; falls back to an inline result when the
// toggle is off — runOp handles both). The op streams evolving progress into
// #sugSlot and reconnects after a reload. Mirrors the meal-swap failure UX:
// ok:false (or unreachable) surfaces as a gentle inline line, never a hard error.
let sessionSuggestInFlight = false;
async function askForSession(opts = {}) {
  if (sessionSuggestInFlight) { toast("Already drafting a session…"); return; }
  const slot = view.querySelector("#sugSlot");
  if (!slot) return;
  sessionSuggestInFlight = true;
  // The loading card carries a .job-cap for the evolving thinkingCaption; a running
  // session re-attaches after a reload via its registered reconnector.
  slot.innerHTML = `<div class="sug-card sug-loading settle-in">
      <span class="aspin" aria-hidden="true"></span>
      <div class="sug-loading-line job-cap"></div>
    </div>`;
  const body = { date: state.logDate };
  if (opts.minutes != null) body.minutes = opts.minutes;
  if (opts.focus) body.focus = opts.focus;

  await runOp("session_suggest", body, sessionSuggestOpOpts());
}

// Wire the suggest card's actions (log these / dismiss / retry).
function wireSuggestCard(slot) {
  slot.querySelectorAll("[data-sugaction]").forEach((b) =>
    b.addEventListener("click", () => {
      const act = b.dataset.sugaction;
      const card = slot.querySelector(".sug-card");
      if (act === "dismiss") {
        // ease the card out instead of a hard clear
        state.suggestedSession = null;
        if (card) collapseEl(card, () => { slot.innerHTML = ""; }); else slot.innerHTML = "";
        return;
      }
      if (act === "retry") { askForSession(); return; }
      if (act === "log") {
        const session = state.suggestedSession;
        if (!session || !Array.isArray(session.items)) return;
        // reveal the plan surface so the off-plan cards have somewhere to land,
        // then drop each suggested item in via the existing add-exercise path.
        const handoff = () => {
          revealPlanThen(() => {
            for (const it of session.items) {
              if (!it || !it.exercise) continue;
              appendOffPlanCard(it.exercise, it.mode === "timed" || it.target_seconds != null ? "timed" : "reps");
            }
            state.suggestedSession = null;
            const s = view.querySelector("#sugSlot");
            if (s) s.innerHTML = "";
            toast("Added to today — log as you go");
          }, { blank: true });
        };
        // when the plan surface is already shown the hand-off happens in place, so
        // collapse the card first for continuity; otherwise the full re-render
        // replaces the empty slot and the collapse would be cut short — go straight.
        if (card && view.querySelector(".addex")) collapseEl(card, handoff); else handoff();
      }
    })
  );
}

// Reveal the plan/logging surface for the selected date, then run `after` once the
// surface exists in the DOM. If it's already shown, run immediately.
function revealPlanThen(after, opts = {}) {
  if (view.querySelector(".addex")) { after && after(); return; }
  // `blank`: reveal a clean logging surface with NO plan day pre-loaded (used by a
  // logged session suggestion). On a day with nothing planned, this stops Today from
  // borrowing — and mislabeling the session as — the next rotation day's workout.
  state.planReveal = { date: state.logDate, on: true, blank: !!opts.blank };
  Promise.resolve(renderToday()).then(() => { after && after(); });
}

async function renderToday(opts = {}) {
  // `soft:true` marks a warm SWR re-render (a background revalidate found new data):
  // numerals snap to their final value instead of re-counting from zero. Passed
  // explicitly (not a shared flag) so re-entrant renders never race over it.
  const soft = !!opts.soft;
  pollToken++; // invalidate any in-flight enrichment polls from a previous render
  if (!state.logDate) state.logDate = localISO();
  setTodayHeaderTitle();
  // Skeleton-first: paint the shell synchronously so a tab switch never leaves the
  // previous tab frozen during the data/agent awaits below. The real render swaps
  // view.innerHTML wholesale once the data is in hand. Skip when re-rendering
  // in-place (the Brief is already on screen — a skeleton flash would be jarring).
  // SWR data load: when every input is warm in cache, Today paints REAL content
  // instantly (no skeleton, no network wait) and a single background revalidate
  // upgrades it in place only if something changed. A cold input keeps the existing
  // skeleton + await. The Brief self-SWRs (loadBrief), so it's left untouched.
  // `changed` accumulates from each revalidate; once any input differs we softly
  // re-render Today (guarded against clobbering active logging). `warm` drives the
  // count-up snap so already-shown numerals never re-count from zero.
  const sessKey = "today:session:" + state.logDate;
  const peeks = {
    plan: state.plan.length ? { data: state.plan, fresh: true } : peekCached("plan"),
    session: peekCached(sessKey),
    stats: peekCached("stats"),
    profile: peekCached("profile"),
    exercises: peekCached("exercises"),
  };
  const warm = Object.values(peeks).every(Boolean);
  const myToken = pollToken; // staleness guard for the background revalidate tail
  let _todayChanged = false;
  const revals = [];
  // Background revalidations; each writes its cache tier and flags a change. Only the
  // 5 primary inputs feed the soft-repaint decision (last-set prefills don't).
  const reval = (path, key) => { revals.push(cachedApi(path, { key, onUpgrade: (_d, { changed }) => { if (changed) _todayChanged = true; } }).catch(() => {})); };
  // Cold + no existing surface → skeleton-first (the old frozen-tab guard). Warm
  // skips the skeleton entirely: the prior content stays until the synchronous
  // render below swaps in the real today-wrap, so there's no blank/skeleton flash.
  if (!warm && !view.querySelector(".today-wrap")) view.innerHTML = todaySkeleton();

  // /plan
  if (!state.plan.length) state.plan = peeks.plan ? peeks.plan.data : await api("/plan");
  reval("/plan", "plan");
  const isToday = state.logDate === localISO();

  // session for the selected date (single object or null)
  const session = peeks.session ? peeks.session.data : await api("/sessions?date=" + state.logDate);
  reval("/sessions?date=" + state.logDate, sessKey);
  const loggedByEx = {};
  if (session) for (const s of session.sets) (loggedByEx[s.exercise] ??= []).push(s);
  for (const k of Object.keys(loggedByEx)) loggedByEx[k].sort((a, b) => (a.set_number ?? 0) - (b.set_number ?? 0));

  // A blank reveal (a logged session suggestion on a day with nothing planned): don't
  // auto-pick a rotation day — leave the session unlinked and the surface clean, so
  // only the suggested/off-plan cards show. The day-switch still lets the athlete pull
  // a real plan day in (which sets dayPicked and exits this branch).
  const revealBlank = !!(state.planReveal && state.planReveal.date === state.logDate && state.planReveal.on && state.planReveal.blank);
  const hasSelectedDay = state.plan.some((d) => d.day_number === state.day);
  if (revealBlank && !state.dayPicked) {
    state.day = null;
  } else if (!state.dayPicked || state.day === null || !hasSelectedDay) {
    state.day = await suggestedPlanDayNumber(session, isToday);
    state.dayPicked = false;
  }

  const day = (revealBlank && state.day === null)
    ? { items: [] }
    : (state.plan.find((d) => d.day_number === state.day) || state.plan[0] || { items: [] });
  // Cardio plan items (kind:'cardio') carry NO loaded exercise — they're a prescription
  // logged through the free-text capture, not the set logger. Keep them out of the
  // name/skip/prefill plumbing (all keyed on a strength exercise name).
  const planNames = new Set((day.items || []).filter((it) => !isCardioItem(it) && it.exercise).map((it) => it.exercise));

  // "Not today" skips for this session. A skip only holds while the exercise
  // has no logged sets — if sets exist (e.g. logged via chat/MCP), the card wins.
  const skippedSet = new Set(((session && session.skips) || []).map((n) => String(n).toLowerCase()));
  const isSkipped = (it) => !isCardioItem(it) && it.exercise && skippedSet.has(it.exercise.toLowerCase()) && !(loggedByEx[it.exercise] || []).length;
  const activeItems = (day.items || []).filter((it) => !isSkipped(it));
  const skippedItems = (day.items || []).filter(isSkipped);

  // ---- Runner loop: synced cardio + sync freshness ----
  // Pull the day's logged cardio efforts ONCE (GET /api/cardio?date=) so each
  // prescription can flip to a calm "done" card on a matched synced run, and pull
  // /settings ONCE for Garmin sync freshness. Both are best-effort + null-safe. We
  // pay for these reads only when the day is plausibly about running — it prescribes
  // cardio, OR (it's today and the plan day has no strength to log, a likely run /
  // rest day where a synced run IS the day's training). A pure lifting day pays
  // nothing. These are a per-render read (always-fresh), not SWR-cached.
  const cardioItems = activeItems.filter(isCardioItem);
  const strengthPlanned = (day.items || []).some((it) => !isCardioItem(it) && it.exercise);
  const couldHaveRun = cardioItems.length > 0 || (isToday && !strengthPlanned);
  let cardioEfforts = [];
  let todaySettings = null;
  if (couldHaveRun) {
    [cardioEfforts, todaySettings] = await Promise.all([
      api("/cardio?date=" + state.logDate).catch(() => []),
      api("/settings").then((r) => (r && r.settings) || null).catch(() => null),
    ]);
    cardioEfforts = Array.isArray(cardioEfforts) ? cardioEfforts : [];
  }
  // Match each prescription to a synced effort (presence of a compatible run is
  // enough). One effort satisfies at most one prescription (consume as matched).
  const matchedCardio = new Map(); // plan item ref → CardioEffort
  if (cardioItems.length && cardioEfforts.length) {
    const pool = [...cardioEfforts];
    for (const it of cardioItems) {
      const i = pool.findIndex((eff) => cardioEffortMatches(it, eff));
      if (i >= 0) matchedCardio.set(it, pool.splice(i, 1)[0]);
    }
  }

  // prefill: for plan exercises with no set yet this session, fetch most-recent-ever
  // once. Cache-first per exercise so a warm Today never waits on these either; cold
  // ones are fetched (and cached) in parallel as before.
  const planEx = activeItems.filter((it) => !isCardioItem(it) && it.exercise).map((it) => it.exercise);
  const offPlanEx = Object.keys(loggedByEx).filter((ex) => !planNames.has(ex));
  // Pending off-plan cards: exercises added on the fly ("+ Add exercise" or a logged
  // session suggestion) that have NO set yet, so they live only in state. A full
  // re-render — e.g. the first set on a previously-empty day brings in the FINISH
  // block via refreshFinishStat — would otherwise drop them, since off-plan cards are
  // rebuilt from loggedByEx alone. Re-materialize any not already covered by the plan
  // or a logged set, and prune the rest (a now-logged/planned exercise is no longer
  // "pending" — it owns a real card, so deleting its sets drops it as before).
  const planLower = new Set([...planNames].map((n) => n.toLowerCase()));
  const loggedLower = new Set(Object.keys(loggedByEx).map((n) => n.toLowerCase()));
  const pendingOffPlan = (((state.pendingOffPlan || {})[state.logDate]) || []).filter(
    (p) => p && p.name && !planLower.has(p.name.toLowerCase()) && !loggedLower.has(p.name.toLowerCase()),
  );
  if (state.pendingOffPlan && state.pendingOffPlan[state.logDate]) state.pendingOffPlan[state.logDate] = pendingOffPlan;
  const needLast = [...new Set([...planEx, ...pendingOffPlan.map((p) => p.name)])].filter((ex) => !(loggedByEx[ex] && loggedByEx[ex].length));
  const lastSets = {};
  await Promise.all(needLast.map(async (ex) => {
    const lk = "last-set:" + ex;
    const pk = peekCached(lk);
    if (pk) { lastSets[ex] = pk.data; cachedApi("/last-set?exercise=" + encodeURIComponent(ex), { key: lk }).catch(() => {}); return; }
    try { lastSets[ex] = await cachedApi("/last-set?exercise=" + encodeURIComponent(ex), { key: lk }); } catch { lastSets[ex] = null; }
  }));

  function prefillFor(it) {
    const logged = loggedByEx[it.exercise] || [];
    if (logged.length) { const s = logged[logged.length - 1]; return { weight: s.weight, reps: s.reps, rir: s.rir, duration_sec: s.duration_sec ?? null }; }
    const last = lastSets[it.exercise];
    if (last) return { weight: last.weight, reps: last.reps, rir: last.rir, duration_sec: last.duration_sec ?? null };
    return { weight: it.target_weight ?? null, reps: it.rep_low ?? null, rir: null, duration_sec: it.target_seconds ?? null };
  }

  const stats = peeks.stats ? peeks.stats.data : await api("/stats");
  const profile = peeks.profile ? peeks.profile.data : await api("/profile").catch(() => null);
  const exercises = peeks.exercises ? peeks.exercises.data : await api("/exercises").catch(() => []);
  if (profile) { setDiscipline(profile.primary_discipline); setEnduranceGoalSet(!!profile.endurance_goal_json); } // keep the emphasis globals warm for Progress/Today/Plan
  reval("/stats", "stats");
  reval("/profile", "profile");
  reval("/exercises", "exercises");
  // exercise → mode map ('reps'|'timed'), used by exCard + the add-exercise flow
  state.exModes = Object.fromEntries((exercises || []).map((e) => [e.name, e.mode || "reps"]));
  const curW = stats.weight_lb ?? (profile && profile.weight_lb != null ? profile.weight_lb : null);
  // Compass strip: adherence to this week's plan + weight-trend pace vs the
  // goal — the two numbers that actually steer the week (raw tonnage/sets/
  // streak live on in the Progress hero bands).
  const planned = stats.week_planned || 0, done = stats.week_done || 0;
  const dots = planned
    ? `<div class="stat-dots">${Array.from({ length: planned }, (_, i) => `<span class="stat-dot${i < done ? " on" : ""}"></span>`).join("")}</div>`
    : "";
  const fmtPace = (v) => (v > 0 ? "+" : "") + (Math.round(v * 10) / 10);
  const PACE_WORD = { on: "on pace", behind: "behind", fast: "too fast" };
  let paceTile;
  if (stats.trend_lb_wk == null) {
    paceTile = `<div class="stat stat-pace"><div class="stat-n numeral stat-dim">—</div><div class="stat-l lbl">pace · log weigh-ins</div></div>`;
  } else if (stats.needed_lb_wk == null) {
    paceTile = `<div class="stat stat-pace"><div class="stat-n numeral">${fmtPace(stats.trend_lb_wk)}</div><div class="stat-l lbl">lb/wk · set a goal</div></div>`;
  } else {
    paceTile = `<div class="stat stat-pace pace-${stats.pace_status || "on"}" title="Trend ${fmtPace(stats.trend_lb_wk)} lb/wk over recent weigh-ins · need ${fmtPace(stats.needed_lb_wk)} to reach ${stats.goal_weight_lb} lb by ${stats.goal_date}">
        <div class="stat-n numeral">${fmtPace(stats.trend_lb_wk)}</div>
        <div class="stat-sub">${PACE_WORD[stats.pace_status] || ""} · need ${fmtPace(stats.needed_lb_wk)}</div>
        <div class="stat-l lbl">lb / week</div>
      </div>`;
  }
  // Pace offer: when the weight-trend pace deviates, one calm OPTIONAL line that
  // drops the athlete into Chat with the question already written — the coach
  // agent sees the full context and can draft the fix (kcal, plan, both). Only
  // appears on a real deviation; a low signal is information, never a verdict, so
  // it reads as an offer to look together — not a warning or a goal-compliance score.
  const maxSafe = curW != null ? Math.round(curW * 0.01 * 10) / 10 : null;
  const PACE_OFFER = {
    fast: {
      line: "Trending a bit fast — want to look at your pace together?",
      ask: `My weight trend is ${fmtPace(stats.trend_lb_wk ?? 0)} lb/wk but the lean-safe ceiling for me is about -${maxSafe} lb/wk (needed pace ${fmtPace(stats.needed_lb_wk ?? 0)}). Should we add calories or adjust the plan to protect lean mass?`,
    },
    behind: {
      line: "A little behind your goal pace — want to look together?",
      ask: `My weight trend is ${fmtPace(stats.trend_lb_wk ?? 0)} lb/wk but I need ${fmtPace(stats.needed_lb_wk ?? 0)} lb/wk to hit ${stats.goal_weight_lb} lb by ${stats.goal_date}. What should we tighten — meals, cardio, or the timeline?`,
    },
  };
  const paceOffer = isToday && PACE_OFFER[stats.pace_status]
    ? `<button class="pace-offer pace-offer-${stats.pace_status}" id="paceOffer">${escHtml(PACE_OFFER[stats.pace_status].line)} · <span class="pace-offer-cta">ask the coach →</span></button>`
    : "";

  // ---- The Brief: the day-read leads. A suggestion, never a gate. ----
  // The plan/logging surface is revealed when the read says "train", when the
  // user has already logged on this date (they've committed), when they tapped
  // "train anyway"/"log these" (state.planReveal), or when reviewing a past date.
  const hasLoggedSets = !!(session && (session.sets || []).length);
  const hasPlanDay = (day.items || []).length > 0;
  const revealOn = state.planReveal && state.planReveal.date === state.logDate && state.planReveal.on;
  const isFinished = !!(session && session.finished_at);
  // Non-blocking Brief: fetch the read in FAST mode — the endpoint returns a warm
  // cached read instantly, so the common case is immediate; a cold cache resolves
  // to a provisional read (painted with the .is-thinking filament) and the real
  // agentic read swaps in via upgradeBriefInPlace() once it lands. First paint
  // never waits on agent:"auto". (Honors an active override.)
  const briefOverride = state.brief && state.brief.date === state.logDate ? state.brief.override : "";
  const read = await loadBrief(state.logDate, briefOverride, { fast: true });
  const hasGarmin = !!(session && session.garmin);
  const showPlan = !isToday || hasLoggedSets || hasGarmin || revealOn || read.kind === "train";
  // A finished session reads as a calm "done" card (the work now lives in History),
  // not the live logging surface — "Log more" reopens it. Only on today: a past date
  // keeps its full logged surface for review, and history editing has its own tab.
  const showDone = isFinished && isToday && !revealOn;
  // Focus mode strips Today to the logging surface (see focusEngaged). Never engages
  // on a finished session (the done card replaces the surface). Progress for the slim
  // header: how many of today's exercises have at least one logged set.
  const focus = !showDone && focusEngaged(state.logDate, { showPlan, hasLoggedSets, isToday });
  // The "n / m exercises logged" progress is a strength-logging count — cardio items
  // are logged through the activity feed, not the set logger, so they don't count here.
  const strengthItems = activeItems.filter((it) => !isCardioItem(it));
  const exDone = strengthItems.filter((it) => (loggedByEx[it.exercise] || []).length).length;
  const exTotal = strengthItems.length;

  // ---- Day-type-aware lead: read the day as run / lift / both / rest ----
  // When the day is about running — cardio prescribed and/or a synced run, with NO
  // strength logged today — the run is the HERO of the plan area, not buried under a
  // strength shell. We don't rewrite Today; we just (a) lead the session head with the
  // run's name + prescription, and (b) order the cardio card(s) FIRST in the surface.
  // A mixed day (both lift + cardio) keeps the lift-led head but still floats cardio
  // up so it's never lost at the bottom. Pure lifting is unchanged.
  const hasSyncedCardioToday = cardioEfforts.length > 0;
  const isRunDay = (cardioItems.length > 0 || hasSyncedCardioToday) && exTotal === 0;
  // Sync freshness: only when Garmin is configured. The stale "this morning's run not
  // synced yet?" nudge fires when a run is prescribed today but no synced effort has
  // landed AND the last sync is stale (see cardioSyncLine). One shared line under the
  // run card (and on the Endurance view).
  const expectingRun = isToday && cardioItems.length > 0
    && !cardioItems.some((it) => matchedCardio.has(it)); // a prescribed run with nothing matched yet
  const syncline = cardioItems.length ? cardioSyncLine(todaySettings, { expectingRun }) : "";

  // In focus mode the chrome (context banner, Brief, insight, capture) gives way to
  // the slim sticky focus header; otherwise the Brief leads as always.
  // Desktop two-column model (≥1100px): the Brief + capture + logging surface are
  // the PRIMARY column (.today-main); the week-ahead / weekly-read / connection-
  // insight / garmin-reconcile / "lately" are the secondary RIGHT RAIL (.today-rail).
  // The rail slots keep their stable ids — every loader (loadWeekAhead, loadTodayReads,
  // loadRecentActivities, loadGarminReconcile) binds to them exactly as before. On
  // mobile/tablet the two wrappers stack (single column): the rail flows right after
  // the capture row, where the week-ahead/reads naturally sat before.
  const railHtml = focus ? "" : `<aside class="today-rail">
    ${isToday ? `<div id="weekAheadSlot" class="weekahead-slot"></div>` : ""}
    <div id="weeklySlot" class="weekly-slot"></div>
    <div id="insightSlot" class="insight-slot"></div>
    ${isToday ? `<div id="garminReconcileSlot" class="garmin-reconcile-slot"></div>` : ""}
    <div id="qlRecent" class="ql-recent lately-slot"></div>
  </aside>`;

  let html = focus
    ? focusBarHtml(read, day, { exDone, exTotal, isToday })
    : `${isToday ? "" : `<button id="backToday" class="ghostbtn back-today">← Back to today</button>`}
    <div id="ctxBanner"><div id="ctxEvents"></div><div id="ctxHealth"></div></div>
    ${briefHtml(read, { showPlan, hasPlanDay, isToday })}
    ${goalLineHtml(stats, curW, isToday)}
    <div id="draftSlot" class="draft-slot"></div>
    <div id="sugSlot" class="sug-slot"></div>
    <div class="capture-row reveal" style="--i:1">
      <div class="wt-inline" id="wtInline" hidden>
        <input id="wtInlineInput" type="number" inputmode="decimal" step="0.1" placeholder="Weight (lb)">
        <button id="wtInlineGo" class="logbtn">+</button>
      </div>
      <div class="quicklog">
        <input id="qlInput" type="text" placeholder="Log a ride, run, meal, or weight…">
        <button id="qlMic" class="qlmic" type="button" hidden aria-label="Dictate" title="Say it out loud">${MIC_GLYPH}</button>
        <button id="qlBtn" class="logbtn">↵</button>
        <button id="wtChipMini" class="wt-mini" title="Log bodyweight">${curW != null ? `${curW}<span class="wt-mini-unit">lb</span>` : "weight"}<span class="stat-plus">+</span></button>
      </div>
      <div id="freqFoods" class="freq-foods"></div>
      ${isToday ? `<div id="checkinSlot" class="checkin-slot"></div>` : ""}
    </div>`;

  // ---- A finished workout: calm "done" card, the live surface put away ----
  if (showDone) {
    html += sessionDoneCard(session, day, { isToday });
  } else if (showPlan) {
  // ---- Plan / logging surface — the launchpad, shown when the day calls for it ----
    html += `<div class="plansurface reveal" style="--i:2">`;
    // A designed break between the analysis above (Brief + capture) and the logging
    // surface below — the eye lands on "here begins the work" instead of one flat,
    // undifferentiated scroll. Focus mode has its own slim sticky header, so skip it there.
    if (!focus) {
      // On a run day (cardio-led, no strength), the head names the RUN — its label +
      // prescription — so the day reads as "today is a run", not a strength shell with
      // a cardio card hiding inside. No focus pill (there's no set-by-set logging to
      // focus into). Otherwise the strength session leads exactly as before.
      if (isRunDay) {
        const lead = cardioItems[0] || null;
        const rName = lead ? cardioLabel(lead) : "Today's run";
        const rPres = lead ? cardioPrescription(lead) : "";
        html += `<div class="session-head session-head-run">
          <div class="session-head-main">
            <div class="session-kicker lbl">${isToday ? "TODAY · A RUN" : "A RUN"}</div>
            <h2 class="session-title">${escHtml(rName)}${rPres ? `<span class="session-focus"> · ${escHtml(rPres)}</span>` : ""}</h2>
          </div>
        </div>`;
      } else {
        const sName = day && day.name ? day.name : "Today's session";
        // Describe the plan day actually being logged (its own focus) — the Brief's
        // suggested focus lives in the card above and can name a different day.
        const sFocus = (day && day.focus) ? day.focus : "";
        // A MIXED day (strength + a prescribed/synced run) reads as "LIFT + RUN" so a
        // hybrid athlete sees both at a glance — the run cards float up right below.
        const mixed = cardioItems.length > 0 || hasSyncedCardioToday;
        const kicker = mixed
          ? (isToday ? "TODAY · LIFT + RUN" : "LIFT + RUN")
          : (isToday ? "TODAY'S SESSION" : "SESSION");
        html += `<div class="session-head">
          <div class="session-head-main">
            <div class="session-kicker lbl">${kicker}</div>
            <h2 class="session-title">${escHtml(sName)}${sFocus ? `<span class="session-focus"> · ${escHtml(sFocus)}</span>` : ""}</h2>
          </div>
          <div class="session-head-side">
            ${exTotal ? `<span class="session-prog" title="exercises with a logged set"><b>${exDone}</b><span class="session-prog-sep">/</span>${exTotal}</span>` : ""}
            <button class="focus-enter" id="focusEnter" title="Distraction-free logging">${BRIEF_KIND.train.glyph} Focus</button>
          </div>
        </div>`;
      }
    }
    html += `<div class="day-switch">`;
    for (const d of state.plan) {
      html += `<button class="daybtn ${d.day_number === state.day ? "active" : ""}" data-day="${d.day_number}">${d.day_number} · ${escHtml(d.name)}</button>`;
    }
    html += `</div><div id="tableHint"></div>`;

    // Garmin "body's reaction" card — the strength session's physiology layer
    // (HR / zones / calories / training effect), reconciled from a synced watch.
    if (hasGarmin) html += garminSessionCard(session.garmin);

    let cardIdx = 0;
    // The sync-freshness line rides on the first UNMATCHED cardio card (where a runner
    // looks to trust this morning's mileage). A matched run is already "done" — no line.
    let syncLineUsed = false;
    // On a run/mixed day float the cardio prescription(s) to the top of the surface so
    // the run is the hero, not the tail. A pure lifting day preserves plan order.
    const surfaceItems = (isRunDay || cardioItems.length > 1 || (cardioItems.length && strengthItems.length))
      ? [...activeItems.filter(isCardioItem), ...activeItems.filter((it) => !isCardioItem(it))]
      : activeItems;
    for (const it of surfaceItems) {
      // A planned cardio effort is a prescription + a "log this" affordance (it routes
      // through the free-text capture), not the set-by-set logger. A matched synced run
      // flips it to a calm "done" card; an unmatched one keeps the prescription + a
      // quiet "or it'll sync from your watch" fallback and (once) the freshness line.
      if (isCardioItem(it)) {
        const matched = matchedCardio.get(it) || null;
        const line = (!matched && !syncLineUsed) ? syncline : "";
        if (line) syncLineUsed = true;
        html += cardioPlanCard(it, cardIdx++, matched, line);
        continue;
      }
      html += exCard({ ...it, fromPlan: true }, loggedByEx[it.exercise] || [], prefillFor(it), cardIdx++);
    }
    for (const ex of offPlanEx) {
      const logged = loggedByEx[ex];
      const s = logged[logged.length - 1];
      html += exCard({ exercise: ex, fromPlan: false }, logged, { weight: s.weight, reps: s.reps, rir: s.rir }, cardIdx++);
    }
    // Pending off-plan cards (added but not yet logged) — rebuilt so a re-render never
    // drops a freshly-added exercise before its first set lands. Prefill from last-set.
    for (const p of pendingOffPlan) {
      const last = lastSets[p.name];
      const prefill = last
        ? { weight: last.weight, reps: last.reps, rir: last.rir, duration_sec: last.duration_sec ?? null }
        : { weight: null, reps: null, rir: null, duration_sec: null };
      html += exCard({ exercise: p.name, fromPlan: false, mode: p.mode || null }, [], prefill, cardIdx++);
    }
    html += `<div class="addex">
      <button id="addExBtn" class="ghostbtn addex-btn">+ Add exercise</button>
      <div id="addExForm" class="addex-form" hidden>
        <div class="addex-row">
          <input id="addExInput" type="text" autocomplete="off" placeholder="Search or type an exercise" list="exOptions">
          <datalist id="exOptions"></datalist>
          <button id="addExGo" class="logbtn">+</button>
        </div>
        <div class="addex-mode" id="addExMode" role="group" aria-label="Exercise type">
          <button class="modebtn active" data-exmode="reps">Reps</button>
          <button class="modebtn" data-exmode="timed">Timed</button>
        </div>
      </div>
    </div>`;
    if (hasLoggedSets) {
      const tonnage = setsTonnage(session.sets);
      html += `<div class="finish">
        <div class="finish-stat" data-finishstat>${session.sets.length} sets · ${Math.round(tonnage).toLocaleString()} lb ${isToday ? "logged today" : "on " + state.logDate}</div>
        <div id="feedbackSlot" class="feedback-slot"></div>
        <div class="logrow" style="margin-top:8px">
          <input id="sessNotes" type="text" placeholder="Session notes (optional)" value="${escAttr(session.notes || "")}" style="text-align:left">
          <button id="finishBtn" class="logbtn" style="width:auto;padding:0 16px;font-size:.82rem;letter-spacing:.04em">FINISH</button>
        </div>
      </div>`;
    }
    // Skipped exercises live on as one slim, muted line at the very bottom —
    // recoverable later in the day (tap a name to restore), never buried.
    html += skipLineHtml(skippedItems.map((it) => it.exercise));
    html += `</div>`; // .plansurface
  }

  // ---- Trajectory tier (this week), quiet, below the fold — hidden in focus ----
  if (!focus) {
    // Discipline-aware emphasis (gentle): an endurance athlete leads with mileage,
    // a hybrid shows lifts + mileage side by side, a lifter is unchanged. Never
    // hides a surface — only reorders which number the week opens with.
    const end = stats.endurance || {};
    const weekKm = Number(end.week_km) || 0;
    const mileageTile = `<div class="stat" title="Distance logged this week">
        <div class="stat-n numeral"><span data-cu="${weekKm}">0</span><span class="stat-frac">km</span></div>
        <div class="stat-l lbl">this week${end.week_moving_min ? ` · ${Math.round(end.week_moving_min)} min` : ""}</div>
      </div>`;
    const adherenceTile = `<div class="stat" title="Training sessions logged this week vs your plan">
        <div class="stat-n numeral"><span data-cu="${done}">0</span><span class="stat-frac">/${planned || "—"}</span></div>
        ${dots}
        <div class="stat-l lbl">this week</div>
      </div>`;
    const wtTile = `<button class="stat stat-wt" id="wtChip" title="Log bodyweight">
        <div class="stat-n numeral" data-wtval>${curW != null ? curW : "—"}<span class="stat-plus">+</span></div>
        <div class="stat-l lbl">${stats.goal_weight_lb != null ? `lb → ${escHtml(String(stats.goal_weight_lb))}` : "weight · lb"}</div>
      </button>`;
    // Compass cells per mode: endurance leads mileage; hybrid pairs lifts+mileage;
    // strength keeps the original adherence + pace + weight.
    let compassCells;
    if (isEndurance()) compassCells = `${mileageTile}${paceTile}${wtTile}`;
    else if (isHybrid()) compassCells = `${adherenceTile}${mileageTile}${wtTile}`;
    else compassCells = `${adherenceTile}${paceTile}${wtTile}`;

    // Collapsed-state recap: speak to BOTH modalities, ordering by the active
    // discipline so the summary opens with what the athlete trains for.
    const liftBit = done ? `${done} lift${done === 1 ? "" : "s"}` : "";
    const cardioBits = [];
    if (stats.week_cardio) cardioBits.push(`${stats.week_cardio} cardio`);
    if (weekKm) cardioBits.push(`${fmtKm(weekKm)} km`);
    const cardioBit = cardioBits.join(" · ");
    const recapBits = (isEndurance() ? [cardioBit, liftBit] : [liftBit, cardioBit]).filter(Boolean);
    const weekRecap = recapBits.join(" · ");
    html += `${paceOffer}
    <details class="weekfold" id="weekFold">
      <summary class="weekfold-sum"><span class="lbl">This week</span>${weekRecap ? `<span class="weekfold-recap">${escHtml(weekRecap)}</span>` : ""}<span class="weekfold-chev" aria-hidden="true">▾</span></summary>
      <div class="statstrip statstrip-compass">
        ${compassCells}
      </div>
      <div id="wearStrip"></div>
    </details>`;
  }

  // Scope the focus class to this render via a wrapper, so a tab switch (which
  // replaces #view wholesale) can never leave the class stranded. The primary
  // column (.today-main) holds the Brief, capture, and logging surface; the rail
  // (.today-rail) sits beside it on wide screens (section 36) and stacks under it
  // on mobile/tablet. Focus mode is a single centered column — no rail.
  view.innerHTML = focus
    ? `<div class="today-wrap today-focus">${html}</div>`
    : `<div class="today-wrap"><div class="today-main">${html}</div>${railHtml}</div>`;
  updateHeaderCondense(); // re-render may reset scroll → recompute the pinned-header state
  // On a warm SWR re-render (a background revalidate found new data) snap the
  // numerals to their final value — never re-count an already-shown number from 0.
  runCountUps(view, { snap: soft });

  const qlBtn = view.querySelector("#qlBtn");
  const qlInput = view.querySelector("#qlInput");
  if (qlBtn) qlBtn.addEventListener("click", quickLog);
  if (qlInput) qlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") quickLog(); });
  // "Log this run/ride" on a planned cardio card: prefill the free-text capture with
  // a sensible sentence and focus it, so logging the effort is one tap + a tweak —
  // the same activity-log path everything else flows through, never a new logger.
  view.querySelectorAll("[data-cardio-log]").forEach((b) => b.addEventListener("click", () => {
    const inp = view.querySelector("#qlInput");
    if (!inp) return;
    inp.value = b.dataset.cardioLog;
    inp.focus();
    try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch {}
    inp.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
  }));
  // "Sync now" on a run card's freshness line — pull from the watch, then re-render
  // Today so this morning's run (and its zones/pace) lands in place.
  wireCardioSync(view, () => renderToday({ soft: true }));

  wireBrief(read, { isToday });
  // If we painted a provisional (cold-cache) read, upgrade it to the agentic read
  // in place — the filament keeps running until the real read settles in.
  if (read._provisional) upgradeBriefInPlace(state.logDate, isToday);
  // Connected-brain provenance: a quiet causal line under the Brief on a training
  // day, if a training/watch directive shaped it ("eased volume — RHR ran high · why").
  if (!focus && showPlan) loadTrainingProvenance(isToday);

  loadTableHint();
  // The chrome — capture row, context banners, insight, frequents, week tier — only
  // exists outside focus mode; skip its wiring entirely when focused.
  if (!focus) {
    setupWeightChip();
    setupVoiceCapture();
    loadFrequentFoods();
    loadRecentActivities();
    loadContextBanner();
    loadHealthFocusBanner();
    loadWearable(isToday);
    if (isToday) { loadTodayReads(); loadCheckin(); loadGarminReconcile(); loadDraftProposals(); loadWeekAhead(); }
    view.querySelector("#goalLine")?.addEventListener("click", () => activateTab("progress"));
  }

  // Focus toggle — enter (pill above the cards) / exit (slim header), each a smooth
  // view-transition morph between the full Today and the focused logging view.
  const focusEnterBtn = view.querySelector("#focusEnter");
  if (focusEnterBtn) focusEnterBtn.addEventListener("click", () => {
    setFocus(state.logDate, true);
    withViewTransition(() => Promise.resolve(renderToday()).then(viewEnter));
  });
  const focusExitBtn = view.querySelector("#focusExit");
  if (focusExitBtn) focusExitBtn.addEventListener("click", () => {
    setFocus(state.logDate, false);
    withViewTransition(() => Promise.resolve(renderToday()).then(viewEnter));
  });

  const paceOfferBtn = view.querySelector("#paceOffer");
  if (paceOfferBtn) paceOfferBtn.addEventListener("click", () => {
    state.chatPrefill = PACE_OFFER[stats.pace_status]?.ask || "";
    activateTab("chat");
  });

  const backBtn = view.querySelector("#backToday");
  if (backBtn) backBtn.addEventListener("click", () => {
    state.logDate = localISO();
    state.day = null;
    state.dayPicked = false;
    renderToday();
  });

  view.querySelectorAll(".daybtn").forEach((b) =>
    b.addEventListener("click", () => {
      state.day = Number(b.dataset.day);
      state.dayPicked = true;
      renderToday();
    })
  );

  wireDeletes();

  wireSkips();

  wireGuides(view);

  const finishBtn = view.querySelector("#finishBtn");
  if (finishBtn) finishBtn.addEventListener("click", async () => {
    finishBtn.disabled = true;
    const notes = view.querySelector("#sessNotes").value.trim();
    let r;
    try {
      r = await api(`/sessions/${session.id}/finish`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notes }),
      });
    } catch { finishBtn.disabled = false; toast("Couldn't finish — check your connection"); return; }
    const sm = r.summary || {};
    // finishing stamps the session (Today flips to the done card) and lands it in
    // History — invalidate so renderToday + History read the finished state.
    state.brief = null;
    swrInvalidate("today:session:" + state.logDate);
    swrInvalidate("history:sessions");
    swrInvalidate("stats");
    stopRest();
    // Elite micro-exit: the logging surface lifts away, then Today re-renders to the
    // calm "done" card (which reveals in). The workout now lives in your history.
    const surface = view.querySelector(".plansurface");
    const settle = () => {
      if (state.tab !== "today") return; // user navigated away during the exit animation
      toast(`Done · ${sm.sets || 0} sets · ${(sm.tonnage || 0).toLocaleString()} lb`);
      renderToday();
    };
    if (surface && !reducedMotion()) {
      surface.classList.add("slide-out");
      setTimeout(settle, 300);
    } else { settle(); }
  });

  // Done card: reopen to keep logging, or jump to the session in History.
  const reopenBtn = view.querySelector("#reopenBtn");
  if (reopenBtn) reopenBtn.addEventListener("click", async () => {
    reopenBtn.disabled = true;
    try { await api(`/sessions/${session.id}/reopen`, { method: "POST" }); } catch {}
    // reopening clears finished_at — Today returns to the live surface; refresh caches.
    state.brief = null;
    swrInvalidate("today:session:" + state.logDate);
    swrInvalidate("history:sessions");
    state.planReveal = { date: state.logDate, on: true };
    withViewTransition(() => Promise.resolve(renderToday()).then(viewEnter));
  });
  const toHistoryBtn = view.querySelector("#toHistoryBtn");
  if (toHistoryBtn) toHistoryBtn.addEventListener("click", () => activateTab("progress"));

  view.querySelectorAll(".ex .logrow").forEach((row) => wireLogRow(row));

  if (hasLoggedSets) renderFeedback(view.querySelector("#feedbackSlot"), session);

  setupAddExercise();

  // SWR tail: once the background revalidations settle, if any of the 5 primary
  // inputs actually changed, softly re-render Today in place (numerals SNAP, never
  // re-count). Guarded so a refresh never clobbers what the athlete is doing: bail
  // if we navigated away / the date moved (pollToken), if a logging input is
  // focused, or if the Brief is mid-reshape.
  if (revals.length) Promise.all(revals).then(() => {
    if (!_todayChanged) return;
    if (myToken !== pollToken || state.tab !== "today") return; // moved on / a newer render superseded us
    const ae = document.activeElement;
    if (ae && (ae.closest?.(".ex") || ae.closest?.(".quicklog") || ae.closest?.(".addex") || ae.closest?.(".wt-inline"))) return; // mid-entry
    if (view.querySelector(".brief.is-thinking")) return; // a steer reshape is in flight
    renderToday({ soft: true });
  });
}

// A finished workout's calm wrap-up: a quiet checkmark, the day, the numbers that
// matter, the "how did that feel?" slot, and two soft ways forward (log more /
// see it in history). No score, no verdict — just "that's done, well played".
function sessionDoneCard(session, day, { isToday }) {
  const sets = (session.sets || []).length;
  const tonnage = setsTonnage(session.sets);
  const name = (day && day.name) || session.day_name || "Session";
  const chips = [
    `${sets} set${sets === 1 ? "" : "s"}`,
    tonnage ? `${Math.round(tonnage).toLocaleString()} lb` : null,
    session.duration_min ? `${session.duration_min} min` : null,
  ].filter(Boolean).map((t) => `<span class="done-chip">${escHtml(t)}</span>`).join("");
  return `<div class="sessiondone reveal" style="--i:2">
      <div class="done-mark" aria-hidden="true">✓</div>
      <div class="done-kicker lbl">${isToday ? "Today · complete" : "Complete"}</div>
      <h2 class="done-title">${escHtml(name)}</h2>
      <div class="done-chips">${chips}</div>
      ${session.notes ? `<div class="done-notes">“${escHtml(session.notes)}”</div>` : ""}
      <div id="feedbackSlot" class="feedback-slot done-feedback"></div>
      <div class="done-actions">
        <button class="ghostbtn done-reopen" id="reopenBtn">Log more</button>
        <button class="ghostbtn done-history" id="toHistoryBtn">In your history →</button>
      </div>
    </div>`;
}

// ---------- Autoregulation: gentle 1-tap "how did that feel?" ----------
// Optional, calm, dismissible. A 1-5 soreness + 1-5 performance tap and an
// optional joint/area field, on a session that already has logged sets. The
// session object (from GET /api/sessions?date=) already carries any prior
// answer, so we render it as recorded when it's set. Recovery INFORMS the
// coach — it never auto-changes a plan (you drive).
function hasFeedback(session) {
  return session && (session.soreness != null || session.performance != null ||
    (session.joint_pain != null && String(session.joint_pain).trim()));
}

function renderFeedback(slot, session) {
  if (!slot) return;
  if (hasFeedback(session)) { renderFeedbackDone(slot, session); return; }
  // collapsed by default — one quiet line, opt-in
  slot.innerHTML = `<button class="checkin-open" id="feedbackOpen" type="button">
      <span class="checkin-open-dot" aria-hidden="true"></span>
      how did that feel?
    </button>`;
  const open = slot.querySelector("#feedbackOpen");
  if (open) open.addEventListener("click", () => renderFeedbackForm(slot, session));
}

function renderFeedbackForm(slot, session) {
  slot.innerHTML = `<div class="checkin-form feedback-form chip-in">
      ${feelScale("soreness", "soreness")}
      ${feelScale("performance", "performance")}
      <input id="feedbackJoint" class="feedback-joint" type="text" autocomplete="off"
        placeholder="any joint or area? (e.g. left knee)" value="${escAttr(session.joint_pain || "")}">
      <button class="checkin-dismiss" id="feedbackDismiss" type="button" aria-label="Not now">✕</button>
    </div>`;
  const date = session.date || state.logDate;
  const picked = {};
  const save = async () => {
    const joint = slot.querySelector("#feedbackJoint");
    const jointVal = joint ? joint.value.trim() : "";
    try {
      const saved = await api(`/sessions/${date}/feedback`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          soreness: picked.soreness, performance: picked.performance,
          joint_pain: jointVal || null,
        }),
      });
      if (saved && !saved.error) { Object.assign(session, saved); }
    } catch { /* silent — it's optional */ }
  };
  slot.querySelectorAll(".feel-dot").forEach((b) =>
    b.addEventListener("click", async () => {
      const kind = b.dataset.feel, val = Number(b.dataset.val);
      picked[kind] = val;
      slot.querySelectorAll(`.feel-dot[data-feel="${kind}"]`).forEach((d) =>
        d.classList.toggle("feel-dot-on", Number(d.dataset.val) <= val));
      await save();
      toast("Noted");
    }));
  // a joint/area entered on its own is still worth recording
  const joint = slot.querySelector("#feedbackJoint");
  if (joint) joint.addEventListener("change", () => { if (picked.soreness || picked.performance || joint.value.trim()) save(); });
  const dismiss = slot.querySelector("#feedbackDismiss");
  if (dismiss) dismiss.addEventListener("click", () => { slot.innerHTML = ""; });
}

function renderFeedbackDone(slot, session) {
  const parts = [];
  if (session.soreness != null) parts.push(`soreness ${Number(session.soreness)}/5`);
  if (session.performance != null) parts.push(`performance ${Number(session.performance)}/5`);
  if (session.joint_pain && String(session.joint_pain).trim()) parts.push(escHtml(String(session.joint_pain).trim()));
  if (!parts.length) { slot.innerHTML = ""; return; }
  slot.innerHTML = `<div class="checkin-done feedback-done chip-in">
      <span class="checkin-done-mark" aria-hidden="true">✓</span> ${parts.join(" · ")}
      <button class="feedback-edit" id="feedbackEdit" type="button">edit</button>
    </div>`;
  const edit = slot.querySelector("#feedbackEdit");
  if (edit) edit.addEventListener("click", () => renderFeedbackForm(slot, session));
}

// Wire the Brief's launchpad: override chips reshape the read; redirects open the
// rest of Today (train anyway / pull in plan / ask for a session). Nothing here is
// a gate — each control is one tap to a different path through the day.
function wireBrief(read, { isToday }) {
  const brief = view.querySelector(".brief");
  if (!brief) return;
  wireAgentOffline(brief); // dismiss ✕ on the "coaching offline" notice, when present

  // Steer options → reshape the read agentically (POST /today-read/reshape) as a
  // durable background job, so a steer survives a tab switch / reload / restart
  // like the other ops. runOp streams the wait into the Brief; the `done` result
  // is the raw read object, which the op's render adopts + morphs into place.
  brief.querySelectorAll("[data-override]").forEach((b) =>
    b.addEventListener("click", () => {
      const intent = b.dataset.override;
      if (brief.classList.contains("is-thinking")) return; // a reshape is already in flight
      // Visible "thinking" state for the (slow, agentic) reshape: the tapped option
      // carries a ring, the rest freeze, a filament sweeps the card, and a quiet line
      // makes the wait read as intentional rather than stalled.
      paintBriefReshaping(brief, b);
      // bust the per-date cache so the next plain render re-reads the steered Brief
      state.brief = null;
      runOp("day_read_override", { date: state.logDate, override: intent, agent: "auto" },
        dayReadOverrideOpOpts({ intent, isToday, prevFocus: read.focus }));
    })
  );

  // Redirects: start the session (reveal + scroll), reveal the plan, pull in a
  // plan day, or ask for a session. None is a gate — each is one tap to a path.
  brief.querySelectorAll("[data-redirect]").forEach((b) =>
    b.addEventListener("click", () => {
      const action = b.dataset.redirect;
      if (action === "ask-session") { askForSession(); return; }
      if (action === "start-session") {
        // the day's primary on a train day: make sure the logging surface exists,
        // then bring its first card into view so "start" lands you in the work.
        revealPlanThen(() => {
          const surface = view.querySelector(".plansurface") || view.querySelector(".addex");
          surface?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
        });
        return;
      }
      if (action === "reveal-plan") {
        state.planReveal = { date: state.logDate, on: true };
        renderToday();
        return;
      }
      if (action === "pull-plan") {
        // surface the planned day's logging cards (the day switcher + cards)
        state.planReveal = { date: state.logDate, on: true };
        state.dayPicked = true;
        renderToday();
        return;
      }
    })
  );

  // "Back to today's read" — clear a persisted steer and recompute the canonical
  // read (?reset=1 invalidates the cached steer server-side). The athlete is never
  // trapped in an override they changed their mind about.
  const steerReset = brief.querySelector("[data-steerreset]");
  if (steerReset) steerReset.addEventListener("click", async () => {
    if (brief.classList.contains("is-thinking")) return;
    brief.querySelectorAll(".brief-steer-opt").forEach((c) => { c.disabled = true; });
    steerReset.disabled = true;
    steerReset.innerHTML = `<span class="aspin aspin-xs"></span>back to today's read`;
    brief.classList.add("is-thinking");
    const note = document.createElement("div");
    note.className = "athinking-note chip-in";
    note.textContent = "Reading the day again…";
    (steerReset.closest(".brief-steer") || steerReset.parentElement).after(note);
    state.brief = null;
    try {
      const qs = new URLSearchParams({ date: state.logDate, agent: "auto", reset: "1" });
      const fresh = await api("/today-read?" + qs.toString());
      state.brief = {
        date: state.logDate,
        override: fresh && fresh.override ? fresh.override : "",
        read: fresh && fresh.kind ? fresh : { kind: "train", headline: "Today", why: "", focus: null, est_minutes: null, signals: {}, source: "deterministic" },
      };
    } catch { state.brief = null; }
    if (state.tab !== "today") return;
    const morph = !reducedMotion();
    if (morph) { brief.classList.add("brief-morph"); state._briefMorph = true; }
    try { await withViewTransition(() => renderToday()); }
    finally { state._briefMorph = false; view.querySelector(".brief")?.classList.remove("brief-morph"); }
  });

  // "Tap to see why" — plain-language signals (never raw numbers as a verdict),
  // shown only on a deliberate tap, in a quiet inline line under the headline.
  const whyBtn = brief.querySelector("[data-briefwhy]");
  if (whyBtn && read.signals && Object.keys(read.signals).length) {
    whyBtn.hidden = false;
    whyBtn.addEventListener("click", () => {
      if (brief.querySelector(".brief-signals")) {
        brief.querySelector(".brief-signals").remove();
        whyBtn.textContent = "tap to see why";
        return;
      }
      const sig = document.createElement("p");
      sig.className = "brief-signals chip-in";
      sig.textContent = briefSignalsText(read);
      whyBtn.before(sig);
      whyBtn.textContent = "hide";
    });
  }
}

// Paint the Brief's "reshaping" state when a steer chip is tapped: the chosen
// option carries a ring, the rest freeze, the card gets the filament, and a quiet
// "Reading the day again…" line makes the wait read as intentional. Reused by the
// reload reconnector so a mid-flight reshape shows the same state after a refresh.
function paintBriefReshaping(brief, chip) {
  const chipLabel = chip ? (chip.textContent || "").trim() : "";
  brief.querySelectorAll(".brief-steer-opt").forEach((c) => {
    c.classList.toggle("brief-steer-active", c === chip);
    if (c !== chip) c.disabled = true;
  });
  const resetBtn = brief.querySelector("[data-steerreset]");
  if (resetBtn) resetBtn.disabled = true;
  if (chip) {
    chip.classList.add("brief-steer-busy");
    chip.innerHTML = `<span class="aspin aspin-xs"></span>${escHtml(chipLabel)}`;
  }
  if (!reducedMotion()) brief.classList.add("is-thinking");
  brief.setAttribute("aria-busy", "true"); // screen readers hear "busy" while the read reshapes
  if (!brief.querySelector(".athinking-note")) {
    const note = document.createElement("div");
    note.className = "athinking-note chip-in";
    note.setAttribute("role", "status");
    note.textContent = "Reading the day again…";
    const anchor = brief.querySelector(".brief-steer") || brief;
    anchor.after ? anchor.after(note) : brief.appendChild(note);
  }
}

// The shared runOp options for a Brief override reshape — used by both the live
// chip tap and the reload reconnector, so the morph/fail behavior is identical
// whether the read lands now or after a refresh. The job's `done` result is the
// raw read object (byte-for-byte what GET /api/today-read?override= returns).
function dayReadOverrideOpOpts({ intent, prevFocus } = {}) {
  return {
    path: "/today-read/reshape",
    anchor: ".brief",
    // No .job-cap inside the Brief — the chip + athinking-note carry the wait, so
    // skip runOp's caption (it still drives the filament + reconnect via the host).
    guard: () => !view.querySelector(".brief")?.isConnected,
    isFail: (r) => !r || !r.kind,
    render: (read) => {
      if (state.tab !== "today") { state.brief = null; return; }
      // Adopt the reshaped read exactly like loadBrief: carry the persisted steer.
      state.brief = { date: state.logDate, override: intent || read.override || "", read };
      // The re-render runs inside a view transition so the hero (brief-hero shared
      // element) morphs to its reshaped read fluidly instead of popping.
      const morph = !reducedMotion();
      if (morph) { view.querySelector(".brief")?.classList.add("brief-morph"); state._briefMorph = true; }
      Promise.resolve(withViewTransition(() => renderToday())).finally(() => {
        state._briefMorph = false;
        view.querySelector(".brief")?.classList.remove("brief-morph");
      });
      // "short on time" also offers a shorter session straight away.
      if (/short on time/i.test(intent || "")) askForSession({ minutes: 30, focus: read.focus || prevFocus || undefined });
    },
    onFail: (_err) => {
      // designed failure (no read) or unreachable — fall back to the canonical read.
      // A null err means the POST itself failed; either way, clear the steer and let
      // Today re-read the calm cached Brief so the chip never stays stuck "thinking".
      state.brief = null;
      const live = view.querySelector(".brief");
      if (live) { live.classList.remove("is-thinking"); live.removeAttribute("aria-busy"); live.querySelector(".athinking-note")?.remove(); }
      if (state.tab === "today") renderToday();
    },
  };
}

// Reconnector: after a reload mid-reshape, jobReconnect rebuilds the Brief's
// thinking state and returns the handlers runOp would have used, so a steer that
// finished (or finishes) while we were away lands in place. Mirrors the
// session-suggest reconnector's option→handler translation.
function reconnectDayReadOverride(job) {
  if (state.tab !== "today") return null; // not on Today — a later renderToday() retries
  const brief = view.querySelector(".brief");
  if (!brief) return null;
  const intent = (job && job.input && job.input.override) || "";
  // Mark the active chip (best-effort) and paint the reshaping state.
  const chip = [...brief.querySelectorAll(".brief-steer-opt")].find((c) => c.dataset.override === intent) || null;
  state.brief = null;
  paintBriefReshaping(brief, chip);
  const o = dayReadOverrideOpOpts({ intent, isToday: state.logDate === localISO(), prevFocus: null });
  const clearBusy = () => { const b = view.querySelector(".brief"); if (b) b.classList.remove("is-thinking", "is-thinking--determinate"); };
  return {
    guard: o.guard,
    onDone: (result) => { clearBusy(); if (o.isFail(result)) o.onFail(result); else o.render(result); },
    onError: () => { clearBusy(); o.onFail(null); },
    onCanceled: () => { clearBusy(); o.onFail(null); },
  };
}

// delete wiring (re-callable after inline chip inserts; guards against double-binding)
function wireDeletes() {
  view.querySelectorAll("[data-del]").forEach((b) => {
    if (b._wired) return; b._wired = true;
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      await api(`/sets/${b.dataset.del}`, { method: "DELETE" });
      // a removed set changes this date's session + stats + History — invalidate so
      // the wholesale renderToday below (and other surfaces) read truth.
      state.brief = null;
      swrInvalidate("today:session:" + state.logDate);
      swrInvalidate("stats");
      swrInvalidate("history:sessions");
      swrInvalidate("progress:volume");
      // refresh from server so set numbers + counts stay correct
      renderToday();
    });
  });
}

// ---------- skip an exercise for the day ("not today") ----------
// Smooth in-flow collapse: the element's box (height/padding/margin) eases to
// zero with a fade, then done() fires. Cancellable — expandEl() on the same
// element mid-flight reverses from wherever it is (the done callback is
// suppressed via the _collapsed flag). House motion tokens, reduced-motion safe.
function collapseEl(el, done) {
  el._collapsed = true;
  clearTimeout(el._animTimer);
  if (reducedMotion()) { done && done(); return; }
  el._h = el.offsetHeight;
  el.style.height = el._h + "px";
  el.style.overflow = "hidden";
  void el.offsetHeight; // commit the measured start state
  el.style.transition = "height var(--dur-2) var(--ease),opacity var(--dur-1) ease,margin var(--dur-2) var(--ease),padding var(--dur-2) var(--ease),transform var(--dur-2) var(--ease)";
  el.style.height = "0px"; el.style.opacity = "0"; el.style.transform = "scale(.97)";
  el.style.marginBottom = "0px"; el.style.paddingTop = "0px"; el.style.paddingBottom = "0px";
  el._animTimer = setTimeout(() => { if (el._collapsed && done) done(); }, 380);
}
function expandEl(el) {
  clearTimeout(el._animTimer);
  el._collapsed = false;
  const clear = () => {
    ["height", "overflow", "transition", "opacity", "transform", "margin-bottom", "padding-top", "padding-bottom"]
      .forEach((p) => el.style.removeProperty(p));
  };
  if (reducedMotion()) { clear(); return; }
  void el.offsetHeight;
  el.style.height = (el._h || el.scrollHeight) + "px";
  el.style.opacity = ""; el.style.transform = "";
  el.style.marginBottom = ""; el.style.paddingTop = ""; el.style.paddingBottom = "";
  el._animTimer = setTimeout(clear, 380);
}

// The slim "Skipped: …" line at the very bottom of Today. Hidden while empty.
function skipNameHtml(name) {
  return `<button class="skip-name" data-unskip="${encodeURIComponent(name)}" title="Restore ${escAttr(name)}">${escHtml(name)}<span class="skip-undo">↺</span></button>`;
}
function skipLineHtml(names) {
  return `<div class="skipline${names.length ? "" : " skipline-empty"}" id="skipLine" aria-live="polite">
      <span class="lbl">Skipped</span>
      <span class="skipline-names">${names.map(skipNameHtml).join("")}</span>
    </div>`;
}
function addSkipName(name) {
  const line = view.querySelector("#skipLine");
  if (!line) return;
  const names = line.querySelector(".skipline-names");
  const dup = [...names.querySelectorAll("[data-unskip]")]
    .some((b) => decodeURIComponent(b.dataset.unskip).toLowerCase() === name.toLowerCase());
  if (!dup) {
    const tpl = document.createElement("template");
    tpl.innerHTML = skipNameHtml(name).trim();
    const el = tpl.content.firstChild;
    el.classList.add("chip-in");
    names.appendChild(el);
  }
  line.classList.remove("skipline-empty");
}
function removeSkipName(name) {
  const line = view.querySelector("#skipLine");
  if (!line) return;
  [...line.querySelectorAll("[data-unskip]")]
    .filter((b) => decodeURIComponent(b.dataset.unskip).toLowerCase() === name.toLowerCase())
    .forEach((b) => b.remove());
  if (!line.querySelector("[data-unskip]")) line.classList.add("skipline-empty");
}

async function skipFromCard(card, exercise) {
  let res;
  try {
    res = await api("/sessions/skip", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: state.logDate, exercise }),
    });
  } catch { toast("Couldn't skip — try again"); return; }
  if (!res || res.ok !== true) {
    toast(res && res.error ? "Sets already logged — delete them first" : "Couldn't skip — try again");
    return;
  }
  swrInvalidate("today:session:" + state.logDate); // the session's skips changed
  // remember where the card sat so UNDO can put it back in place, wiring intact
  const anchor = card.nextElementSibling;
  collapseEl(card, () => { card.remove(); addSkipName(exercise); });
  toast(`${exercise} skipped today`, { action: "Undo", onAction: () => undoSkip(card, anchor, exercise) });
}

async function undoSkip(card, anchor, exercise) {
  try {
    await api("/sessions/skip", {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: state.logDate, exercise }),
    });
  } catch { toast("Couldn't restore — try again"); return; }
  swrInvalidate("today:session:" + state.logDate); // the session's skips changed
  if (state.tab !== "today") return;
  removeSkipName(exercise);
  if (!card.isConnected) {
    // the detached card kept all its listeners — slot it back where it was.
    // Insert relative to the ref node's own parent (.plansurface), since
    // insertBefore needs the ref to be a direct child of the caller.
    const before = anchor && anchor.isConnected ? anchor : view.querySelector(".addex");
    if (!before || !before.parentNode) { renderToday(); return; }
    before.parentNode.insertBefore(card, before);
  }
  expandEl(card);
}

// An off-plan card with no logged sets isn't persisted anywhere — it's a transient
// DOM card from appendOffPlanCard — so removing it is a pure in-flow collapse, no API.
function removeOffPlanCard(card) {
  if (!card) return;
  // drop it from the pending list too, so a later re-render doesn't bring it back.
  const name = card.dataset && card.dataset.card;
  if (name && state.pendingOffPlan && state.pendingOffPlan[state.logDate]) {
    state.pendingOffPlan[state.logDate] = state.pendingOffPlan[state.logDate].filter(
      (p) => p.name.toLowerCase() !== name.toLowerCase(),
    );
  }
  collapseEl(card, () => card.remove());
}

function wireSkips() {
  view.querySelectorAll(".ex-skip").forEach((b) => {
    if (b._wired) return; b._wired = true;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const card = b.closest(".ex");
      if (b.hasAttribute("data-remove-card")) { removeOffPlanCard(card); return; }
      skipFromCard(card, decodeURIComponent(b.dataset.skip));
    });
  });
  const line = view.querySelector("#skipLine");
  if (line && !line._wired) {
    line._wired = true;
    line.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-unskip]");
      if (!b) return;
      const exercise = decodeURIComponent(b.dataset.unskip);
      try {
        await api("/sessions/skip", {
          method: "DELETE", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date: state.logDate, exercise }),
        });
      } catch { toast("Couldn't restore — try again"); return; }
      swrInvalidate("today:session:" + state.logDate); // the session's skips changed
      toast(`${exercise} is back on`);
      renderToday(); // full refresh rebuilds the card in its plan position
    });
  }
}

// Log one set from a card's logrow; update the card inline without a full re-render.
function wireLogRow(row) {
  row.querySelector(".logbtn").addEventListener("click", async () => {
    const timed = row.dataset.mode === "timed";
    let body;
    if (timed) {
      const durEl = row.querySelector(".in-dur");
      const sec = parseDur(durEl.value);
      if (sec == null || sec <= 0) { toast("Time? e.g. 1:30 or 90"); durEl.focus(); return; }
      durEl.value = fmtDur(sec); // normalise the display for the next tap
      body = {
        exercise: decodeURIComponent(row.dataset.ex),
        weight: null, reps: null, rir: null,
        duration_sec: sec, exercise_mode: "timed",
        day_number: Number(row.dataset.day),
        date: state.logDate,
      };
    } else {
      const wEl = row.querySelector(".in-w"), rEl = row.querySelector(".in-r"), rirEl = row.querySelector(".in-rir");
      const w = wEl.value, r = rEl.value, rir = rirEl.value;
      if (r === "") { toast("Reps?"); rEl.focus(); return; }
      body = {
        exercise: decodeURIComponent(row.dataset.ex),
        weight: w === "" ? null : Number(w),
        reps: Number(r),
        rir: rir === "" ? null : Number(rir),
        day_number: Number(row.dataset.day),
        date: state.logDate,
      };
    }
    const res = await api("/sets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    state.brief = null; // a logged set reshapes today — the next Today render re-reads the Brief
    // a logged set changes this date's session, the weekly stats, and the History
    // list — drop their SWR caches so every surface revalidates to truth.
    swrInvalidate("today:session:" + state.logDate);
    swrInvalidate("stats");
    swrInvalidate("history:sessions");
    swrInvalidate("progress:volume"); // muscle-group volume shifts too
    // inline: append chip, tick progress, keep inputs populated for the next tap
    const card = row.closest(".ex");
    const loggedWrap = card.querySelector("[data-logged]");
    const tpl = document.createElement("template");
    tpl.innerHTML = setChip({ id: res.id, set_number: res.set_number, weight: res.weight, reps: res.reps, rir: res.rir, duration_sec: res.duration_sec ?? null }).trim();
    const chipEl = tpl.content.firstChild;
    chipEl.classList.add("chip-in");
    loggedWrap.appendChild(chipEl);
    wireDeletes();
    bumpProgress(card);
    const skipCtl = card.querySelector(".ex-skip");
    if (skipCtl) skipCtl.remove(); // a logged set makes the card no longer skippable
    if (res.pr) { toast("🏆 New PR!"); if (navigator.vibrate) navigator.vibrate([60, 40, 120]); }
    else toast("Set logged");
    startRest();
    refreshFinishStat();
  });
}

function bumpProgress(card) {
  const prog = card.querySelector("[data-prog]");
  if (!prog) return;
  const done = card.querySelectorAll("[data-logged] .chip").length;
  const m = (prog.textContent.match(/\/\s*(\d+)/) || [])[1];
  const goal = m ? Number(m) : 0;
  prog.innerHTML = `${done}${goal ? ` / ${goal}` : ""} <span>set${done === 1 && !goal ? "" : "s"}</span>`;
  const complete = goal && done >= goal;
  prog.classList.toggle("done", !!complete);
  card.classList.toggle("ex-complete", !!complete);
}

function refreshFinishStat() {
  const chips = view.querySelectorAll(".ex [data-logged] .chip");
  if (!chips.length) return;
  const stat = view.querySelector("[data-finishstat]");
  if (!stat) {
    // first set on a previously empty date — re-render to bring in the FINISH block.
    // This is also where focus mode auto-engages (hasLoggedSets just flipped true),
    // so morph through a view transition: Today gently collapses into the focus view.
    withViewTransition(() => Promise.resolve(renderToday()).then(viewEnter));
    return;
  }
  let sets = 0, tonnage = 0;
  chips.forEach((c) => {
    sets++;
    const mm = c.textContent.match(/(-?\d+(?:\.\d+)?)\s*×\s*(\d+)/);
    if (mm) { const wt = Number(mm[1]), reps = Number(mm[2]); if (wt > 0) tonnage += wt * reps; }
  });
  const isToday = state.logDate === localISO();
  stat.textContent = `${sets} sets · ${Math.round(tonnage).toLocaleString()} lb ${isToday ? "logged today" : "on " + state.logDate}`;
}

async function setupAddExercise() {
  const btn = view.querySelector("#addExBtn");
  const form = view.querySelector("#addExForm");
  const input = view.querySelector("#addExInput");
  const go = view.querySelector("#addExGo");
  const datalist = view.querySelector("#exOptions");
  if (!btn || !form) return;

  let mode = "reps";
  const modeWrap = view.querySelector("#addExMode");
  modeWrap.querySelectorAll("[data-exmode]").forEach((b) => b.addEventListener("click", () => {
    mode = b.dataset.exmode;
    modeWrap.querySelectorAll(".modebtn").forEach((x) => x.classList.toggle("active", x === b));
  }));
  const setMode = (m) => {
    mode = m;
    modeWrap.querySelectorAll(".modebtn").forEach((x) => x.classList.toggle("active", x.dataset.exmode === m));
  };

  btn.addEventListener("click", async () => {
    form.hidden = false; btn.hidden = true; input.focus();
    if (!datalist.children.length) {
      try {
        const exs = await api("/exercises");
        state.exModes = Object.fromEntries((exs || []).map((e) => [e.name, e.mode || "reps"]));
        datalist.innerHTML = (exs || []).map((e) => `<option value="${escAttr(e.name)}">${escHtml(e.muscle_group || "")}</option>`).join("");
      } catch { /* free-typed names still work */ }
    }
  });
  // picking a known timed exercise flips the toggle automatically
  input.addEventListener("input", () => {
    const m = (state.exModes || {})[input.value.trim()];
    if (m) setMode(m);
  });

  function resetAddForm() { input.value = ""; form.hidden = true; btn.hidden = false; setMode("reps"); }
  const add = async () => {
    const name = (input.value || "").trim();
    if (!name) { input.focus(); return; }
    // A card for this exercise already on the page. Match on name AND mode — so
    // re-adding "Dead hang" as Timed when only a Reps card exists is NOT swallowed.
    const existing = [...view.querySelectorAll(".ex[data-card]")]
      .find((el) => el.dataset.card.toLowerCase() === name.toLowerCase());
    if (existing) {
      const curMode = existing.dataset.mode || "reps";
      const hasSets = !!existing.querySelector(".logged .chip");
      if (curMode === mode || hasSets) {
        // same type, or it already has logged sets (can't switch type underfoot) —
        // just bring the card into view. Tell them how to change a type that's locked.
        existing.scrollIntoView({ behavior: "smooth", block: "center" });
        (existing.querySelector(".in-r") || existing.querySelector(".in-dur"))?.focus();
        resetAddForm();
        if (curMode !== mode && hasSets) toast(`${name} already has sets — delete them to change its type`);
        return;
      }
      // type change requested on an empty card → flip the exercise's mode + swap the
      // card to the new type in place (keeps it on the page, ready to log).
      try {
        await postExerciseMode(name, mode);
        (state.exModes ??= {})[name] = mode;
      } catch { /* fall through — the set itself still carries exercise_mode */ }
      const tpl = document.createElement("template");
      tpl.innerHTML = exCard({ exercise: name, fromPlan: false, mode }, [], { weight: null, reps: null, rir: null, duration_sec: null }).trim();
      const fresh = tpl.content.firstChild;
      existing.replaceWith(fresh);
      wireGuides(fresh); wireLogRow(fresh.querySelector(".logrow")); wireSkips();
      fresh.scrollIntoView({ behavior: "smooth", block: "center" });
      (fresh.querySelector(".in-dur") || fresh.querySelector(".in-r"))?.focus();
      resetAddForm();
      return;
    }
    // typed a name that's sitting in today's skipped line → restore it instead
    const skippedBtn = [...view.querySelectorAll("#skipLine [data-unskip]")]
      .find((b) => decodeURIComponent(b.dataset.unskip).toLowerCase() === name.toLowerCase());
    if (skippedBtn) { resetAddForm(); skippedBtn.click(); return; }
    if (mode === "timed" && (state.exModes || {})[name] !== "timed") {
      // register the exercise as timed so logging + history know its mode
      try {
        await postExerciseMode(name, "timed");
        (state.exModes ??= {})[name] = "timed";
      } catch { /* fall through — the set itself still carries exercise_mode */ }
    }
    appendOffPlanCard(name, mode);
    resetAddForm();
  };
  go.addEventListener("click", add);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
}

async function appendOffPlanCard(name, mode) {
  // Remember it in state (keyed by date) so a re-render rebuilds it instead of dropping
  // it — an unlogged off-plan card otherwise lives only in the DOM. Deduped by name.
  (state.pendingOffPlan ??= {});
  const list = (state.pendingOffPlan[state.logDate] ??= []);
  if (!list.some((p) => p.name.toLowerCase() === name.toLowerCase())) list.push({ name, mode: mode || "reps" });
  let prefill = { weight: null, reps: null, rir: null, duration_sec: null };
  try {
    const last = await api("/last-set?exercise=" + encodeURIComponent(name));
    if (last) prefill = { weight: last.weight, reps: last.reps, rir: last.rir, duration_sec: last.duration_sec ?? null };
  } catch {}
  const tpl = document.createElement("template");
  tpl.innerHTML = exCard({ exercise: name, fromPlan: false, mode: mode || null }, [], prefill).trim();
  const cardEl = tpl.content.firstChild;
  // .addex lives inside .plansurface — insert relative to its real parent
  // (insertBefore requires the ref node to be a direct child of the caller).
  const addBlock = view.querySelector(".addex");
  if (addBlock) addBlock.before(cardEl);
  else (view.querySelector(".plansurface") || view).appendChild(cardEl);
  wireGuides(cardEl);
  wireLogRow(cardEl.querySelector(".logrow"));
  wireSkips(); // wire the off-plan card's remove ✕
  cardEl.scrollIntoView({ behavior: "smooth", block: "center" });
  (cardEl.querySelector(".in-r") || cardEl.querySelector(".in-dur"))?.focus();
}

// Bare activity types make ambiguous image prompts ("ride" → horseback), so map
// common types to an explicit phrase for the generated photo; the SVG fallback
// still keys off the raw type.
const ACT_ART_PHRASE = {
  ride: "riding a road bicycle", bike: "riding a road bicycle", cycl: "riding a road bicycle",
  run: "running", jog: "jogging", hike: "hiking with a backpack",
  walk: "walking briskly", swim: "swimming freestyle", row: "rowing on a rowing machine",
  yoga: "holding a yoga pose", climb: "climbing an indoor wall", ski: "cross-country skiing",
};
function actArtText(a) {
  const t = (a.type || "").toLowerCase();
  for (const k in ACT_ART_PHRASE) if (t.includes(k)) return ACT_ART_PHRASE[k];
  return a.type || a.raw_text || "";
}

// Render one activity row (instant or enriched). `live` adds the pending badge while enriching.
function actEntryHtml(a) {
  const tile = artImg("activity", actArtText(a), "artile-sm qlent-art", art("activity", a.type));
  return `<div class="qlent" data-actid="${a.id}">
      ${tile}
      <div class="qlent-line">${escHtml(activityLine(a))}</div>
      <div class="qlent-badge">${enrichBadge(a.enrichment_status)}</div>
    </div>`;
}

// Shared poll-update for an activity entry: refresh text, badge, and (if present) the art tile.
function updateActEntry(el, row) {
  el.querySelector(".qlent-line").textContent = activityLine(row);
  el.querySelector(".qlent-badge").innerHTML = enrichBadge(row.enrichment_status);
  const tileEl = el.querySelector(".qlent-art");
  if (tileEl) {
    const t = artImg("activity", actArtText(row), "artile-sm qlent-art", art("activity", row.type));
    if (t) tileEl.outerHTML = t;
  }
  if (row.enrichment_status === "done") el.classList.add("qlent-done");
}

// Today: the "body's reaction" card for a strength session reconciled from Garmin —
// HR / calories / training-effect tiles + a time-in-HR-zone bar + the agent's
// one-line read. All server strings via escHtml; numbers coerced. "" without data.
const HR_ZONE_COLORS = ["#cdd7c0", "#b9c79a", "#e6c87a", "#d98a4e", "#b4552d"]; // z1..z5, calm → hot
function garminSessionCard(g) {
  if (!g) return "";
  const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const tiles = [];
  const tile = (val, lbl) => tiles.push(`<span class="wear-cell"><span class="wear-n numeral">${val}</span><span class="wear-l lbl">${lbl}</span></span>`);
  const dur = num(g.duration_min); if (dur != null) tile(`${Math.round(dur * 10) / 10}`, "min");
  const ahr = num(g.avg_hr); if (ahr != null) tile(`${Math.round(ahr)}`, "avg hr");
  const mhr = num(g.max_hr); if (mhr != null) tile(`${Math.round(mhr)}`, "max hr");
  const kcal = num(g.calories); if (kcal != null) tile(`${Math.round(kcal)}`, "kcal");
  const te = num(g.training_effect); if (te != null) tile(`${Math.round(te * 10) / 10}`, "effect");

  let bar = "";
  const zones = (Array.isArray(g.hr_zones) ? g.hr_zones : [])
    .filter((z) => z && num(z.secs) != null && num(z.secs) > 0)
    .sort((a, b) => (num(a.zone) || 0) - (num(b.zone) || 0));
  const total = zones.reduce((t, z) => t + (num(z.secs) || 0), 0);
  if (total > 0) {
    const segs = zones.map((z) => {
      const zi = Math.min(5, Math.max(1, num(z.zone) || 1));
      const pct = ((num(z.secs) || 0) / total) * 100;
      const mins = Math.round((num(z.secs) || 0) / 60);
      return `<span class="gz-seg" style="width:${pct.toFixed(1)}%;background:${HR_ZONE_COLORS[zi - 1]}" title="Zone ${zi} · ${mins} min"></span>`;
    }).join("");
    bar = `<div class="gz-bar">${segs}</div><div class="gz-legend lbl">time in HR zones</div>`;
  }

  if (!tiles.length && !bar && !g.summary) return "";
  const tag = g.extrapolated ? `<span class="garmin-tag">✦ logged from Garmin</span>` : "";
  return `<div class="garmin-card reveal" style="--i:2">
      <div class="garmin-card-h"><span class="lbl">Garmin · body's reaction</span>${tag}</div>
      ${tiles.length ? `<div class="garmin-tiles">${tiles.join("")}</div>` : ""}
      ${bar}
      ${g.summary ? `<div class="garmin-sum">${escHtml(g.summary)}</div>` : ""}
    </div>`;
}

// ---------- Today: the unified "Lately" feed ----------
// One timeline of what you actually did — finished strength sessions AND cardio
// merged (the old "Recent" strip read only the activities table, so it was blind
// to lifting). Each row carries a real relative time, and a Garmin-synced row taps
// open to its body-reaction (HR zones, effort, VO2, temp) — the same physiology a
// strength session already shows. Fed by GET /api/recent-training (FeedRow[]).

// Relative "when" for a feed row. A real timestamp (Garmin start / session finish)
// gives "2h ago" within a day, then "yesterday · 6:40pm"; a manual log with no
// honest time-of-day stays day-granular ("yesterday", "3 days ago").
function latelyWhen(row) {
  if (row.at) {
    const t = Date.parse(row.at);
    if (t) {
      const ageH = (Date.now() - t) / 3600000;
      if (ageH >= 0 && ageH < 22) return relTime(row.at); // "just now" / "2h ago"
      const clock = new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
        .toLowerCase().replace(/\s/g, "");
      return `${humanDate(row.date)} · ${clock}`;
    }
  }
  return humanDate(row.date);
}

// The tap-to-expand body-reaction for a Garmin-enriched row: physiology tiles +
// the HR-time-in-zone bar, reusing the garminSessionCard vocabulary verbatim.
// "" when the detail blob has nothing renderable.
function latelyDetail(d) {
  if (!d) return "";
  const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const tiles = [];
  const tile = (val, lbl) => tiles.push(`<span class="wear-cell"><span class="wear-n numeral">${val}</span><span class="wear-l lbl">${lbl}</span></span>`);
  const ahr = num(d.avg_hr); if (ahr != null) tile(Math.round(ahr), "avg hr");
  const mhr = num(d.max_hr); if (mhr != null) tile(Math.round(mhr), "max hr");
  const te = num(d.training_effect); if (te != null) tile(Math.round(te * 10) / 10, "effect");
  const vo2 = num(d.vo2max); if (vo2 != null) tile(Math.round(vo2), "vo₂max");
  const kcal = num(d.calories); if (kcal != null) tile(Math.round(kcal), "kcal");
  const temp = num(d.avg_temp); if (temp != null) tile(`${Math.round(temp)}°`, "temp");

  let bar = "";
  const zones = (Array.isArray(d.hr_zones) ? d.hr_zones : [])
    .filter((z) => z && num(z.secs) != null && num(z.secs) > 0)
    .sort((a, b) => (num(a.zone) || 0) - (num(b.zone) || 0));
  const total = zones.reduce((t, z) => t + (num(z.secs) || 0), 0);
  if (total > 0) {
    const segs = zones.map((z) => {
      const zi = Math.min(5, Math.max(1, num(z.zone) || 1));
      const pct = ((num(z.secs) || 0) / total) * 100;
      const mins = Math.round((num(z.secs) || 0) / 60);
      return `<span class="gz-seg" style="width:${pct.toFixed(1)}%;background:${HR_ZONE_COLORS[zi - 1]}" title="Zone ${zi} · ${mins} min"></span>`;
    }).join("");
    bar = `<div class="gz-bar">${segs}</div><div class="gz-legend lbl">time in HR zones</div>`;
  }
  if (!tiles.length && !bar) return "";
  return `<div class="lately-body">${tiles.length ? `<div class="garmin-tiles">${tiles.join("")}</div>` : ""}${bar}</div>`;
}

// One row of the Lately feed — strength or cardio, normalized.
function latelyRow(row) {
  const isStrength = row.kind === "strength";
  // Strength rows are a whole session (not one exercise), so they show the generic
  // kettlebell SVG with NO generated photo — an empty query keeps artImg SVG-only
  // and avoids filing a session title like "Push day" into the art cache. Cardio
  // keeps its activity photo (run/ride/…), exactly as the old Recent strip did.
  const tile = isStrength
    ? artImg("exercise", "", "artile-sm lately-art", art("exercise", row.title))
    : artImg("activity", actArtText({ type: row.title }), "artile-sm lately-art", art("activity", row.title));
  const detailHtml = row.detail ? latelyDetail(row.detail) : "";
  const expandable = !!detailHtml;
  return `<div class="lately-row${isStrength ? " lately-strength" : ""}">
      <div class="lately-head"${expandable ? ' role="button" tabindex="0" aria-expanded="false"' : ""}>
        ${tile}
        <div class="lately-main">
          <div class="lately-top">
            <span class="lately-title">${escHtml(row.title)}</span>
            <span class="lately-when lbl">${escHtml(latelyWhen(row))}</span>
          </div>
          ${row.stats ? `<div class="lately-stats">${escHtml(row.stats)}</div>` : ""}
          ${row.note ? `<div class="lately-note">${escHtml(row.note)}</div>` : ""}
        </div>
        ${expandable ? `<span class="lately-chev" aria-hidden="true">▾</span>` : ""}
      </div>
      ${expandable ? `<div class="lately-detail" hidden>${detailHtml}</div>` : ""}
    </div>`;
}

async function loadRecentActivities() {
  const wrap = view.querySelector("#qlRecent");
  if (!wrap) return;
  let rows = [];
  try { rows = await api("/recent-training?limit=6"); } catch { rows = []; }
  if (state.tab !== "today" || !wrap.isConnected) return;
  if (!rows || !rows.length) { wrap.innerHTML = ""; return; }
  wrap.innerHTML =
    `<div class="lately-h"><span class="ql-recent-h lbl">Lately</span>` +
    `<button class="lately-all lbl" id="latelyAll" type="button">see all →</button></div>` +
    rows.map(latelyRow).join("");

  const allBtn = wrap.querySelector("#latelyAll");
  if (allBtn) allBtn.addEventListener("click", () => activateTab("progress")); // lands on History

  wrap.querySelectorAll('.lately-head[role="button"]').forEach((h) => {
    const toggle = () => {
      const r = h.closest(".lately-row");
      const det = r && r.querySelector(".lately-detail");
      if (!det) return;
      const open = det.hidden;
      det.hidden = !open;
      r.classList.toggle("lately-open", open);
      h.setAttribute("aria-expanded", open ? "true" : "false");
    };
    h.addEventListener("click", toggle);
    h.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    });
  });
}

// Today: slim Garmin wearable strip under the compass — steps · sleep · resting
// HR (· HRV) from the most recent garmin_daily_metrics row. Renders nothing at
// all unless that row is from today or yesterday, so non-Garmin users (and the
// past-date view) see zero clutter. Values are numeric — server text never
// reaches innerHTML here.
async function loadWearable(isToday) {
  const slot = view.querySelector("#wearStrip");
  if (!slot || !isToday) return;
  let rows = [];
  try { rows = await api("/garmin/daily?limit=1"); } catch { return; }
  if (state.tab !== "today" || !slot.isConnected) return;
  const m = Array.isArray(rows) ? rows[0] : null;
  if (!m || !m.date) return;
  const yest = new Date(); yest.setDate(yest.getDate() - 1);
  if (m.date !== localISO() && m.date !== localISO(yest)) return;
  const cells = [];
  if (m.steps != null) {
    cells.push(`<span class="wear-cell"><span class="wear-n numeral" data-cu="${Number(m.steps) || 0}" data-cufmt="k">0</span><span class="wear-l lbl">steps</span></span>`);
  }
  if (m.sleep_min != null) {
    const v = Math.max(0, Math.round(Number(m.sleep_min) || 0));
    const score = m.sleep_score != null ? ` · ${Math.round(Number(m.sleep_score))}` : "";
    cells.push(`<span class="wear-cell"><span class="wear-n numeral">${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}</span><span class="wear-l lbl">sleep${score}</span></span>`);
  }
  if (m.resting_hr != null) {
    cells.push(`<span class="wear-cell"><span class="wear-n numeral" data-cu="${Math.round(Number(m.resting_hr)) || 0}">0</span><span class="wear-l lbl">rest hr</span></span>`);
  }
  if (m.hrv_ms != null && cells.length < 4) {
    cells.push(`<span class="wear-cell"><span class="wear-n numeral" data-cu="${Math.round(Number(m.hrv_ms)) || 0}">0</span><span class="wear-l lbl">hrv</span></span>`);
  }
  if (m.body_battery_avg != null && cells.length < 4) {
    cells.push(`<span class="wear-cell"><span class="wear-n numeral" data-cu="${Math.round(Number(m.body_battery_avg)) || 0}">0</span><span class="wear-l lbl">battery</span></span>`);
  }
  if (!cells.length) return;
  slot.innerHTML = `<div class="wearstrip reveal" style="${stagger(0)}">
      <span class="wear-kicker lbl">Garmin${m.date !== localISO() ? " · yest" : ""}</span>
      ${cells.join("")}
    </div>`;
  runCountUps(slot);
}

// Today: a one-line pointer to the day's planned meals — deliberately quiet
// (the full planner lives in Plan → Meals; this is just the shortcut there).
async function loadTableHint() {
  const wrap = view.querySelector("#tableHint");
  if (!wrap) return;
  let plans = [];
  try { plans = await api("/mealplans?limit=6"); } catch { return; }
  if (state.tab !== "today" || !wrap.isConnected) return;
  const p = (plans || []).find((x) => x.status === "accepted" && x.parsed) ||
            (plans || []).find((x) => x.status === "draft" && x.parsed);
  const days = p && Array.isArray(p.parsed.days) ? p.parsed.days : [];
  const lbl = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(state.logDate + "T12:00:00").getDay()];
  const day = days.find((d) => String(d.day || "").toLowerCase().startsWith(lbl));
  const meals = day && Array.isArray(day.meals) ? day.meals : [];
  if (!meals.length) return;
  const first = meals[0].name || meals[0].meal || "";
  wrap.innerHTML = `<button class="tablehint" id="tableHintBtn">
      <span class="lbl">Table</span> ${escHtml(first)}${meals.length > 1 ? `<span class="tablehint-more"> +${meals.length - 1}</span>` : ""}<span class="tablehint-go">→</span>
    </button>`;
  wrap.querySelector("#tableHintBtn").addEventListener("click", () => { state.planJump = "meals"; activateTab("plan"); });
}

// Today: a subtle banner summarising NEAR-TERM context (active injuries, ongoing or
// imminent trips/events). A far-future life event (a race months out) is deliberately
// NOT pinned here — Today stays focused on what's near; the event still lives in Plan
// and Me → Life. Dated context gains a calm countdown as it draws closer.
const CTX_ICONS = { trip: "✈", injury: "🤕", life_event: "◆", family_event: "◆" };
const CTX_NEAR_DAYS = 21; // an upcoming dated event surfaces on Today only within this window

function daysUntil(startISO) {
  if (!startISO) return null;
  const d = new Date(startISO + "T00:00:00"), now = new Date(localISO() + "T00:00:00");
  return Math.round((d - now) / 86400000);
}
function eventCountdown(days) {
  if (days == null) return "";
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  if (days <= 14) return `in ${days} days`;
  return `in ${Math.round(days / 7)} weeks`;
}

// Near-term = an active injury (always shapes today), an ongoing event, or a dated
// event within CTX_NEAR_DAYS. A far-future OR undated non-injury event is hidden from
// Today (it keeps living in Plan / Me → Life) — so a race months out, or one with no
// date yet, never dominates the top of Today.
function isNearTermContext(ev) {
  if (ev.archived) return false;
  if (ev.kind === "injury") return true; // an active injury always shapes today
  const today = localISO();
  const start = ev.start_date, end = ev.end_date;
  if (start && start <= today && (!end || end >= today)) return true; // ongoing
  if (start && start > today) return daysUntil(start) <= CTX_NEAR_DAYS; // imminent
  return false; // undated or far-future non-injury → not on Today
}

function ctxBannerLine(ev) {
  let meta = ev.meta_json;
  if (typeof meta === "string") { try { meta = JSON.parse(meta); } catch { meta = null; } }
  meta = meta || {};
  const icon = CTX_ICONS[ev.kind] || "◆";
  const title = ev.title || ev.kind;
  if (ev.kind === "injury") {
    return `${icon} ${escHtml(title)}${meta.area && !String(title).toLowerCase().includes(String(meta.area).toLowerCase()) ? ` (${escHtml(meta.area)})` : ""} — go easy`;
  }
  // trips / life / family events — title (+ trip destination) + a calm countdown / "now"
  const today = localISO();
  let when = "";
  if (ev.start_date && ev.start_date > today) when = ` · ${eventCountdown(daysUntil(ev.start_date))}`;
  else if (ev.start_date && (!ev.end_date || ev.end_date >= today)) when = " · now";
  const where = ev.kind === "trip" && meta.location ? ` to ${escHtml(meta.location)}` : "";
  return `${icon} ${escHtml(title)}${where}${escHtml(when)}`;
}

async function loadContextBanner() {
  const wrap = view.querySelector("#ctxEvents");
  if (!wrap) return;
  let events = [];
  try { events = await api("/context-events?active=1"); } catch { events = []; }
  if (state.tab !== "today" || !wrap.isConnected) return;
  events = (events || []).filter(isNearTermContext);
  if (!events.length) { wrap.innerHTML = ""; return; }
  const lines = events.slice(0, 3).map(ctxBannerLine);
  wrap.innerHTML = `<div class="ctxbanner">${lines.join('<span class="ctxbanner-sep">·</span>')}</div>`;
}

// Today: a calm near-term goal anchor under the Brief — "Toward 164 lb · ~11 weeks".
// The nearer-term arc (recomp by the goal date) is what Today should keep in view,
// not a score; tapping opens Progress. Renders nothing without a weight goal + a
// future goal date, and never on a past-date view.
function goalLineHtml(stats, curW, isToday) {
  if (!isToday || !stats) return "";
  const gw = stats.goal_weight_lb != null ? Number(stats.goal_weight_lb) : null;
  const gd = stats.goal_date || null;
  if (gw == null || !gd) return "";
  const days = daysUntil(gd);
  if (days == null || days < 0) return ""; // goal date passed → don't nag
  const when = days <= 7 ? "this week" : days <= 112 ? `~${Math.round(days / 7)} wk` : `~${Math.round(days / 30)} mo`;
  const from = curW != null && Number(curW) !== gw ? ` <span class="goalline-from">from ${escHtml(String(curW))}</span>` : "";
  return `<button class="goalline reveal" id="goalLine" style="--i:0" type="button">
      <span class="goalline-ico" aria-hidden="true">◎</span>
      <span class="goalline-txt">Toward <b>${gw} lb</b>${from} · ${escHtml(when)}</span>
      <span class="goalline-go" aria-hidden="true">→</span>
    </button>`;
}

// Today: react to agentic work — a quiet card when the coach has drafted a plan
// change waiting for review (a scheduler weekly-review draft, or a chat plan change).
// Pull, never push: it only appears when a `draft` proposal exists and clears the
// moment it's applied/discarded in Plan → Coach. Tapping jumps straight there.
async function loadDraftProposals() {
  const slot = view.querySelector("#draftSlot");
  if (!slot) return;
  let plans = [];
  try { plans = await api("/proposals?limit=8"); } catch { return; }
  if (state.tab !== "today" || !slot.isConnected) return;
  const drafts = (plans || []).filter((p) => p && p.status === "draft");
  if (!drafts.length) { slot.innerHTML = ""; return; }
  const head = drafts.length > 1 ? `${drafts.length} plan changes are waiting` : "A plan change is waiting";
  const raw = (drafts[0].instruction || "").replace(/^(auto|chat):\s*/i, "").trim();
  const sub = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "Drafted by your coach";
  slot.innerHTML = `<button class="draft-card reveal" id="draftCard" style="--i:0" type="button">
      <span class="draft-ico" aria-hidden="true">✦</span>
      <span class="draft-body">
        <span class="draft-h">${escHtml(head)}</span>
        <span class="draft-sub">${escHtml(sub)} · review</span>
      </span>
      <span class="draft-go" aria-hidden="true">→</span>
    </button>`;
  slot.querySelector("#draftCard").addEventListener("click", () => { state.planJump = "coach"; activateTab("plan"); });
}

// Today: a calm "week ahead" sketch — lift / run / mixed / rest across the next few
// days, so the athlete can see roughly when to train and run for their goals. Pull,
// never push: it waits quietly and is a SUGGESTION to reshape, never a schedule. The
// endpoint is agentic with a deterministic plan-rotation floor, so it always returns
// something usable. Renders nothing on an empty result.
const WEEK_AHEAD_GLYPH = { lift: "◆", run: "➜", mixed: "✦", rest: "○" };
async function loadWeekAhead() {
  const slot = view.querySelector("#weekAheadSlot");
  if (!slot) return;
  let r = null;
  try { r = await api("/week-ahead"); } catch { return; }
  if (state.tab !== "today" || !slot.isConnected) return;
  const days = r && r.ok && Array.isArray(r.days) ? r.days : [];
  if (!days.length) { slot.innerHTML = ""; return; }
  const rows = days.map((d) => {
    const kind = WEEK_AHEAD_GLYPH[d.kind] ? d.kind : "lift";
    return `<div class="wa-row wa-${escAttr(kind)}">
        <span class="wa-glyph" aria-hidden="true">${WEEK_AHEAD_GLYPH[kind]}</span>
        ${d.day ? `<span class="wa-day lbl">${escHtml(d.day)}</span>` : ""}
        <span class="wa-label">${escHtml(d.label)}</span>
        ${d.note ? `<span class="wa-note">${escHtml(d.note)}</span>` : ""}
      </div>`;
  }).join("");
  slot.innerHTML = `<div class="weekahead reveal" style="--i:0">
      <div class="weekahead-h"><span class="lbl">The week ahead</span></div>
      <div class="weekahead-days">${rows}</div>
      ${r.summary ? `<div class="weekahead-sum">${escHtml(r.summary)}</div>` : ""}
    </div>`;
}

// Today: one quiet health-focus line from the latest whole-picture review (first
// focus title + action), mirroring the context banner. Tap → Me → Health.
// Renders nothing when there's no review or no focus items — zero noise.
async function loadHealthFocusBanner() {
  const wrap = view.querySelector("#ctxHealth");
  if (!wrap) return;
  let review = null;
  try { review = await api("/health/review"); } catch { review = null; }
  if (state.tab !== "today" || !wrap.isConnected) return;
  if (review && !review.error) state.healthReview = review;
  let parsed = review && review.parsed;
  if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch { parsed = null; } }
  const f = parsed && Array.isArray(parsed.focus) ? parsed.focus.find((x) => x && x.title) : null;
  if (!f) { wrap.innerHTML = ""; return; }
  wrap.innerHTML = `<button class="ctxbanner ctxbanner-health" id="ctxHealthGo">
      <span class="ctxbanner-health-line">✦ ${escHtml(f.title)}${f.action ? ` — ${escHtml(f.action)}` : ""}</span>
      <span class="ctxbanner-go" aria-hidden="true">→</span>
    </button>`;
  wrap.querySelector("#ctxHealthGo").addEventListener("click", () => {
    state.meSeg = "health";
    state.healthSeg = "analysis"; // the focus line comes from the review
    activateTab("me");
  });
}

// Today: a calm "Garmin logged a lift that isn't in Cairn yet — reconcile?" card.
// Pull, never push: it waits quietly when the watch synced a strength activity that
// hasn't been linked to a session (session_id null), and renders NOTHING otherwise —
// so it never appears unless Garmin is configured AND there's an unlinked lift. The
// single Reconcile action runs the deterministic physiology merge (POST /garmin/
// reconcile), then refreshes Today so the reconciled garminSessionCard / Lately row
// replaces this. Degrades silently: a failed fetch → empty slot.
async function loadGarminReconcile() {
  const slot = view.querySelector("#garminReconcileSlot");
  if (!slot) return;
  let rows = [];
  try { rows = await api("/garmin/unreconciled"); } catch { rows = []; }
  if (state.tab !== "today" || !slot.isConnected) return;
  rows = Array.isArray(rows) ? rows : [];
  if (!rows.length) { slot.innerHTML = ""; return; }
  const n = rows.length;
  const noun = n === 1 ? "a lift" : `${n} lifts`;
  slot.innerHTML = `<div class="garmin-reconcile chip-in">
      <div class="garmin-reconcile-text">
        <span class="garmin-reconcile-glyph" aria-hidden="true">✦</span>
        <span>Garmin logged ${escHtml(noun)} that ${n === 1 ? "isn't" : "aren't"} in Cairn yet</span>
      </div>
      <button class="garmin-reconcile-btn" id="garminReconcileGo" type="button">Reconcile</button>
    </div>`;
  const btn = slot.querySelector("#garminReconcileGo");
  if (btn) btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Reconciling…";
    let r;
    try {
      r = await api("/garmin/reconcile", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
      });
    } catch {
      btn.disabled = false; btn.textContent = "Reconcile";
      toast("Couldn't reconcile — check your connection");
      return;
    }
    if (!r || r.error) {
      btn.disabled = false; btn.textContent = "Reconcile";
      toast("Couldn't reconcile right now");
      return;
    }
    toast(r.reconciled === 1 ? "Reconciled the Garmin lift" : `Reconciled ${r.reconciled || 0} Garmin lifts`);
    // The lift now lives on a Cairn session — drop the stale session peek so the
    // re-render reads truth and the reconciled garminSessionCard takes this card's place.
    swrInvalidate("today:session:" + state.logDate);
    renderToday({ soft: true });
  });
}
