// @ts-check
// The welcome's markup (docs/DESIGN.md "Welcome"): three stages on one full-screen
// stage — Hello (the brand moment and the four providers), Connect (three steps that
// each lay a stone of a small cairn) and Meet (the coach's first conversation, then
// the reveal of the first week and the starting fuel). Pure strings: every caller
// string goes through escHtml/escAttr, and the stones come from CairnStone.
(() => {
  // The hero cairn, top → base. All six stones: the whole picture the coach reads.
  const HERO: ReadonlyArray<string> = ["heart", "recovery", "fuel", "endurance", "body", "strength"];
  // Connect's cairn, top → base: one stone per step, laid from the base up.
  const STEP_STONES: ReadonlyArray<string> = ["recovery", "endurance", "fuel"];

  function heroHtml(): string {
    return CairnStone.cairnSvg(
      HERO.map((key, i) => ({ key, cls: "wel-drop", attrs: { style: `--i:${HERO.length - 1 - i}` } })),
      { idPrefix: "welHero", drift: true, cls: "wel-cairn" }
    );
  }

  /** The step cairn: `laid` stones from the base up are set; the rest are outlines. */
  function cairnHtml(laid: number, idPrefix: string): string {
    const n = STEP_STONES.length;
    return CairnStone.cairnSvg(
      STEP_STONES.map((key, i) => ({ key, cls: n - i <= laid ? "wel-stone is-laid" : "wel-stone is-open" })),
      { idPrefix, cls: "wel-cairn wel-cairn-sm" }
    );
  }

  const chevron = `<svg class="wel-chev" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 3.5 10.5 8 6 12.5"/></svg>`;

  function providerHtml(p: CoachLinkProvider, i: number): string {
    const state = p.usable
      ? `<span class="wel-prov-on"><span class="wel-prov-dot" aria-hidden="true"></span>Connected</span>`
      : chevron;
    return `<li class="wel-prov-li reveal" style="--i:${i + 3}">
      <button class="wel-prov" type="button" data-wel-pick="${escAttr(p.name)}">
        <span class="wel-prov-name">${escHtml(p.label)}</span>
        <span class="wel-prov-plan">${escHtml(p.plan || p.label)}</span>
        ${state}
      </button>
    </li>`;
  }

  function helloHtml(providers: CoachLinkProvider[], unreachable = false): string {
    const list = unreachable
      ? `<div class="wel-empty reveal" style="--i:3"><p>Couldn't reach your Cairn.</p><button class="btn btn-solid" type="button" data-wel-reload>Try again</button></div>`
      : providers.length
      ? `<ul class="wel-provs" aria-label="Connect the AI you use">${providers.map(providerHtml).join("")}</ul>`
      : `<p class="wel-empty reveal" style="--i:3">This server has no AI sign-ins set up yet. Its owner can add one from Settings, then this page offers it.</p>`;
    return `<div class="wel-pane wel-hello">
      <p class="wel-mark">Cairn</p>
      <div class="wel-hero" aria-hidden="true">${heroHtml()}</div>
      <div class="wel-copy">
        <h1 class="wel-h1" tabindex="-1">A coach that reads your whole picture.</h1>
        <p class="wel-lead reveal" style="--i:2">It runs on the AI you already pay for. Any one of these works.</p>
        ${list}
        <div class="wel-quiet reveal" style="--i:8">
          <button class="linkbtn-quiet" type="button" data-wel-none aria-expanded="false" aria-controls="welNone">I don't have one yet</button>
          <button class="linkbtn-quiet" type="button" data-wel-skip>Look around first</button>
        </div>
        <div class="wel-none" id="welNone" hidden>
          <p>Any one of them is enough. Pick the one you'd use anyway: Cairn works through the plan you already pay for, so there's nothing extra to buy here.</p>
          <p>When you have one, connect it any time from Settings → Agents. Until then, have a look around.</p>
        </div>
      </div>
    </div>`;
  }

  function stepHtml(key: WelcomeStepKey, title: string, i: number): string {
    return `<li class="wel-step" data-wel-step="${key}" data-state="waiting">
      <span class="wel-mk" aria-hidden="true"><span class="wel-mk-n">${i + 1}</span></span>
      <div class="wel-step-b">
        <h2 class="wel-step-t">${escHtml(title)}</h2>
        <p class="wel-step-s" role="status" aria-live="polite"></p>
        <div class="wel-step-x"></div>
      </div>
    </li>`;
  }

  function connectHtml(p: CoachLinkProvider): string {
    return `<div class="wel-pane wel-connect">
      <button class="wel-back linkbtn-quiet" type="button" data-wel-back>All providers</button>
      <div class="wel-connect-hd">
        <div class="wel-mini" aria-hidden="true">${cairnHtml(0, "welStep")}</div>
        <div>
          <h1 class="wel-h1 wel-h1-sm" tabindex="-1">Connect ${escHtml(p.label)}</h1>
          <p class="wel-sub">${escHtml(p.plan || p.label)}</p>
        </div>
      </div>
      <ol class="wel-steps">${CairnWelcomeModel.STEPS.map((s, i) => stepHtml(s.key, s.title, i)).join("")}</ol>
    </div>`;
  }

  // The dictation glyph from the capture module (eager); absent → no mic.
  function micGlyph(): string {
    return (globalThis as { CairnCaptureVoice?: { micGlyph?: string } }).CairnCaptureVoice?.micGlyph || "";
  }

  const sendIcon = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/></svg>`;

  function meetHtml(p: CoachLinkProvider | null): string {
    return `<div class="wel-pane wel-meet">
      <div class="wel-meet-hd">
        <div class="wel-mini" aria-hidden="true">${cairnHtml(3, "welAvatar")}</div>
        <h1 class="wel-h1 wel-h1-sm" tabindex="-1">Meet your coach</h1>
        <button class="linkbtn-quiet wel-skip" type="button" data-wel-skip>Look around first</button>
      </div>
      <div class="wel-log" role="log" aria-live="polite" aria-label="Your first conversation">
        ${coachBubbleHtml(
          `Connected through ${p ? p.label : "your AI"}. Tell me what you're training for and what a normal week looks like. A sentence is plenty.`
        )}
      </div>
      <div class="wel-dock">
        <form class="wel-compose" novalidate>
          <label class="sr-only" for="welText">Tell your coach about you</label>
          <textarea id="welText" class="wel-text" rows="1" enterkeyhint="send" autocomplete="off"
            placeholder="Your goal, a normal week…"></textarea>
          <button class="wel-mic qlmic" type="button" hidden aria-label="Say it out loud" title="Say it out loud">${micGlyph()}</button>
          <button class="wel-send" type="submit" aria-label="Send" disabled>${sendIcon}</button>
        </form>
      </div>
    </div>`;
  }

  function paragraphs(text: string): string {
    return String(text || "")
      .split(/\n{2,}/)
      .map((para) => para.trim())
      .filter(Boolean)
      .map((para) => `<p>${escHtml(para)}</p>`)
      .join("");
  }

  function userBubbleHtml(text: string): string {
    return `<div class="wel-msg is-you">${paragraphs(text)}</div>`;
  }

  function coachBubbleHtml(text: string): string {
    return `<div class="wel-msg is-coach">${paragraphs(text)}</div>`;
  }

  function phasesHtml(current: number, finished: boolean): string {
    return CairnWelcomeModel.PHASES.map((ph, i) => {
      const state = finished || i < current ? "done" : i === current ? "working" : "waiting";
      return `<li class="wel-ph" data-state="${state}"><span class="wel-ph-mk" aria-hidden="true"></span><span>${escHtml(ph.text)}</span></li>`;
    }).join("");
  }

  function workingHtml(): string {
    return `<div class="wel-msg is-coach is-working" data-job-anchor="welcome">
      <ol class="wel-phs" aria-label="What your coach is doing">${phasesHtml(0, false)}</ol>
    </div>`;
  }

  function weekStripHtml(rows: WelcomeWeekRow[]): string {
    // Monday-first, one pebble per day: a lifting day is a stone, the rest a quiet mark.
    const byDow = new Map<number, WelcomeWeekRow>();
    for (const r of rows) if (r.dow != null) byDow.set(r.dow, r);
    if (!byDow.size) return "";
    const days = [1, 2, 3, 4, 5, 6, 0];
    const letters = ["S", "M", "T", "W", "T", "F", "S"];
    let lifted = 0;
    return `<ol class="wel-strip" aria-hidden="true">${days
      .map((dow) => {
        const hit = byDow.get(dow);
        const mark = hit
          ? `<span class="wel-strip-stone" style="--i:${lifted++}">${CairnStone.pebbleSvg("strength", { idPrefix: `welWk${dow}` })}</span>`
          : `<span class="wel-strip-dot"></span>`;
        return `<li class="wel-strip-d${hit ? " is-lift" : ""}">${mark}<span class="wel-strip-l">${letters[dow]}</span></li>`;
      })
      .join("")}</ol>`;
  }

  function revealHtml(r: WelcomeReveal): string {
    const week = r.week.length
      ? `${weekStripHtml(r.week)}<ul class="wel-week">${r.week
          .map(
            (row, i) =>
              `<li class="wel-wk reveal" style="--i:${i + 2}"><span class="wel-wk-d" title="${escAttr(row.dayLong)}">${escHtml(row.day)}</span><span class="wel-wk-n">${escHtml(row.name)}</span></li>`
          )
          .join("")}</ul>`
      : "";
    const weekNote = r.weekNote ? `<p class="wel-note">${escHtml(r.weekNote)}</p>` : "";
    const fuel = r.fuel
      ? `<section class="wel-rv-sec reveal" style="--i:${r.week.length + 3}" aria-labelledby="welFuelH">
          <h2 class="lbl" id="welFuelH">Starting fuel</h2>
          <p class="wel-fuel">${escHtml(r.fuel.main)}</p>
          <p class="wel-note">${escHtml(r.fuel.sub)}</p>
        </section>`
      : "";
    return `<div class="wel-reveal">
      <section class="wel-rv-sec reveal" style="--i:1" aria-labelledby="welWeekH">
        <h2 class="lbl" id="welWeekH">Your first week</h2>
        ${week}${weekNote}
      </section>
      ${fuel}
    </div>`;
  }

  function failBubbleHtml(message: string): string {
    return `<div class="wel-msg is-coach is-fail">
      <p>${escHtml(message)}</p>
      <div class="wel-fail-acts">
        <button class="btn btn-solid" type="button" data-wel-retry>Try again</button>
        <button class="linkbtn-quiet" type="button" data-wel-reconnect>Check the connection</button>
      </div>
    </div>`;
  }

  function doneDockHtml(inPlace: boolean): string {
    const line = inPlace ? "It's in place. Change anything by just telling me." : "Tell me more any time in Ask.";
    return `<div class="wel-done reveal" style="--i:6">
      <p class="wel-done-l">${line}</p>
      <button class="btn btn-solid wel-cta" type="button" data-wel-today>Open Today</button>
    </div>`;
  }

  const CAIRN_WELCOME_CLIENT: WelcomeClientApi = {
    helloHtml,
    connectHtml,
    cairnHtml,
    meetHtml,
    userBubbleHtml,
    coachBubbleHtml,
    workingHtml,
    phasesHtml,
    revealHtml,
    failBubbleHtml,
    doneDockHtml,
  };

  Object.assign(globalThis, { CairnWelcomeClient: CAIRN_WELCOME_CLIENT });
})();
