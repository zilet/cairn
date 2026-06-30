// @ts-check
// Pure Today session-suggestion rendering helpers for the vanilla PWA.

type ClientSessionSuggestion = import("../contracts/client.js").ClientSessionSuggestion;
type ClientSessionSuggestionItem = import("../contracts/client.js").ClientSessionSuggestionItem;

type SuggestedItemLike = Partial<ClientSessionSuggestionItem> | null | undefined;
type SuggestedSessionLike = Partial<ClientSessionSuggestion> | null | undefined;

(() => {
  const SESSION_VIBES = ["easier on the legs", "30 min", "upper body", "no barbell", "low impact", "push hard"];

  function todaySuggestItemHtml(item: SuggestedItemLike, index = 0): string {
    const it = item && typeof item === "object" ? item : {};
    const exercise = String(it.exercise || "Exercise");
    const name = escHtml(exercise);
    const timed = it.mode === "timed" || it.target_seconds != null;
    let prescription: string;
    if (timed) {
      const secs = it.target_seconds != null ? fmtDur(it.target_seconds) : "time";
      prescription = `${it.sets ?? "?"} × ${secs}`;
    } else {
      const lo = it.rep_low;
      const hi = it.rep_high;
      const reps = lo != null && hi != null ? (lo === hi ? `${lo}` : `${lo}–${hi}`) : (lo ?? hi ?? "");
      prescription = `${it.sets ?? "?"}${reps ? ` × ${reps}` : ""}`;
      if (it.target_weight != null) {
        prescription += Number(it.target_weight) < 0 ? ` · ${Math.abs(Number(it.target_weight))} assist` : ` · ${it.target_weight} lb`;
      } else {
        prescription += " · BW";
      }
    }
    const tile = artImg("exercise", exercise, "artile-sm sug-art", art("exercise", exercise));
    return `<div class="sug-item reveal" style="${stagger(index + 1)}">
      ${tile}
      <div class="sug-item-main">
        <div class="sug-item-name">${name}</div>
        ${it.note ? `<div class="sug-item-note">${escHtml(it.note)}</div>` : ""}
      </div>
      <div class="sug-item-rx numeral">${escHtml(prescription)}</div>
    </div>`;
  }

  function todaySuggestCardHtml(session: SuggestedSessionLike, verified?: unknown): string {
    const s = session && typeof session === "object" ? session : {};
    const name = escHtml(s.name || "Session");
    const focus = s.focus ? escHtml(s.focus) : "";
    const est = s.est_minutes != null && Number(s.est_minutes) > 0 ? `${Math.round(Number(s.est_minutes))} min` : "";
    const why = s.why ? escHtml(s.why) : "";
    const items = (Array.isArray(s.items) ? s.items : []).map((it, i) => todaySuggestItemHtml(it, i)).join("");
    return `<section class="sug-card settle-in">
      <div class="sug-head">
        <div class="sug-kicker lbl">A session for today${est ? ` · ${escHtml(est)}` : ""}</div>
        <h3 class="sug-name">${name}</h3>
        ${focus ? `<div class="sug-focus">${focus}</div>` : ""}
      </div>
      ${why ? `<p class="sug-why">${why}</p>` : ""}
      <div class="sug-items">${items || `<div class="sug-empty">No exercises came back — try again.</div>`}</div>
      ${CairnProposal.verifiedBadgeHtml(verified)}
      ${s.notes ? `<div class="sug-notes">${escHtml(s.notes)}</div>` : ""}
      <div class="sug-actions">
        <button class="pillbtn pill-accent" data-sugaction="log">Log these</button>
        <button class="pillbtn" data-sugaction="dismiss">Not now</button>
      </div>
      <div class="sug-hint">A suggestion to follow or ignore — it isn't saved as your plan.</div>
    </section>`;
  }

  function todaySuggestLoadingHtml(): string {
    return `<div class="sug-card sug-loading settle-in">
      <span class="aspin" aria-hidden="true"></span>
      ${CairnUi.jobCaptionHtml({ tag: "div", className: "sug-loading-line job-cap" })}
    </div>`;
  }

  function todaySuggestFailureHtml(result?: unknown): string {
    const row = result && typeof result === "object" ? result as Record<string, unknown> : {};
    const line = row.agent_status === "unconfigured"
      ? "Building a session needs a coaching agent — connect one in Settings. You can train anyway in the meantime."
      : "Couldn't draft a session just now — your buddy may be offline. You can train anyway or try again.";
    return `<div class="sug-card sug-fail settle-in">
          <div class="sug-fail-line">${escHtml(line)}</div>
          <div class="sug-actions"><button class="pillbtn" data-sugaction="retry">Try again</button></div>
        </div>`;
  }

  function todaySuggestComposerHtml(vibes: readonly string[] = SESSION_VIBES): string {
    return `<div class="sug-composer settle-in">
      <input class="sug-prompt" type="text" autocomplete="off" enterkeyhint="go"
        aria-label="Describe the session you want"
        placeholder="say what you want — e.g. legs sore from yesterday's run, easier on the legs">
      <div class="sug-composer-row">
        <div class="sug-vibes">${vibes.map((v) => `<button class="sug-vibe" type="button" data-vibe="${escAttr(v)}">${escHtml(v)}</button>`).join("")}</div>
        <div class="sug-composer-actions">
          <button class="pillbtn" type="button" data-sugcancel>Cancel</button>
          <button class="pillbtn pill-accent" type="button" data-sugbuild>Build it</button>
        </div>
      </div>
    </div>`;
  }

  const CAIRN_TODAY_SESSION_SUGGEST = {
    SESSION_VIBES,
    itemHtml: todaySuggestItemHtml,
    cardHtml: todaySuggestCardHtml,
    loadingHtml: todaySuggestLoadingHtml,
    failureHtml: todaySuggestFailureHtml,
    composerHtml: todaySuggestComposerHtml,
  };

  Object.assign(globalThis, { CairnTodaySessionSuggest: CAIRN_TODAY_SESSION_SUGGEST });

  if (typeof window !== "undefined") {
    window.CairnTodaySessionSuggest = CAIRN_TODAY_SESSION_SUGGEST;
  }
})();
