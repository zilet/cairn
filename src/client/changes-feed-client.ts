// @ts-check
// The Changes feed renderer (docs/V2-PLAN.md wave 1, docs/DESIGN.md "Component
// architecture"). Pure: it frames the finished server read from GET /api/brain/changes
// — what changed, why in the spoken voice, one of the four fixed outcome phrases, a
// confidence word and the server-labelled Undo — grouped by day. It never works a word
// out again (contract rule 6), fetches nothing and wires nothing; the controller
// (changes-feed-controller.ts) owns loading, the seen marker and Undo.
{
  type BrainChanges = import("../contracts/brain-changes.js").ClientBrainChanges;
  type BrainChange = import("../contracts/brain-changes.js").ClientBrainChange;
  type BrainChangeDay = import("../contracts/brain-changes.js").ClientBrainChangeDay;
  type BrainSetAside = import("../contracts/brain-changes.js").ClientBrainSetAside;

  type ChangesFeedRowOptions = {
    /** Stagger index for the first-paint `.reveal` entrance; omitted means no entrance. */
    index?: number | null;
    /** A row that just arrived into a painted feed eases in with `settle-in`. */
    enter?: boolean;
    /** The row the athlete just changed: its accent washes once (`is-settled`). */
    settled?: boolean;
  };

  type ChangesFeedOptions = {
    /** First paint gets the row stagger; an in-place upgrade does not re-flash it. */
    reveal?: boolean;
    /** Rows arriving into a surface that was showing something else ease in with `settle-in`. */
    enter?: boolean;
  };

  // The outcome key picks the tone word the reading layer already uses — never a new
  // vocabulary, and never the only signal (the phrase itself is printed).
  const OUTCOME_TONE: Record<string, string> = {
    as_expected: "ok",
    not_as_expected: "watch",
    too_early: "quiet",
    stopped: "quiet",
  };

  const STATES = new Set(["announced", "applied", "reverted", "held"]);

  // The stone a change belongs to, by its decision domain: its dot leads the row in that
  // stone's own hue. A domain the palette has no stone for keeps the team's ink dot.
  const DOMAIN_STONE: Record<string, string> = {
    training: "strength",
    train: "strength",
    strength: "strength",
    running: "endurance",
    endurance: "endurance",
    nutrition: "fuel",
    fuel: "fuel",
    recovery: "recovery",
    recover: "recovery",
    sleep: "recovery",
    body: "body",
    health: "heart",
    labs: "heart",
    recheck: "heart",
  };

  function dotHtml(change: BrainChange): string {
    const stone = DOMAIN_STONE[text(change.domain).toLowerCase()];
    return `<span class="dot chfeed-dot${stone ? ` stone-${stone}` : " is-team"}" aria-hidden="true"></span>`;
  }

  // The same row grammar as Today's overnight digest (today-digest-client.ts): an arrow
  // in a small circle leads the title. Its direction is read off the server's own verb
  // ("Raised…", "Lowered…") and is decoration only (aria-hidden) — the title says it.
  const ARROW_VERBS: Array<[RegExp, string, string]> = [
    [/^(raised|added)\b/i, "↑", "is-up"],
    [/^(lowered|trimmed|eased)\b/i, "↓", "is-down"],
    [/^held\b/i, "=", "is-same"],
    [/^(reshaped|rotated|moved|adjusted)\b/i, "↔", "is-range"],
    [/^(swapped|replaced|substituted)\b/i, "⇄", "is-range"],
  ];

  function arrowHtml(title: string): string {
    const hit = ARROW_VERBS.find(([pattern]) => pattern.test(title));
    // No verb the row can read: no glyph at all, never an empty circle with a dot in it.
    return hit ? `<span class="tdg-arrow chfeed-arrow ${hit[2]}" aria-hidden="true">${hit[1]}</span>` : "";
  }

  // A long why folds to three lines with "Read all"; the full text stays in the node.
  const WHY_FOLD_CHARS = 180;

  function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
  }

  /** The Undo action attribute for a row: an announced change is held, a landed one is put back. */
  function undoAttr(change: BrainChange): string {
    return change.state === "announced" ? "chfeed-hold" : "chfeed-undo";
  }

  function undoHtml(change: BrainChange): string {
    const undo = change.undo;
    if (!undo || undo.available !== true) return "";
    return CairnDecisionUndo.buttonHtml({
      id: change.id,
      label: undo.label,
      attr: undoAttr(change),
      className: "linkbtn-quiet chfeed-undo",
    });
  }

  function metaHtml(change: BrainChange): string {
    const status = text(change.status_line);
    const confidence = text(change.confidence);
    const parts: string[] = [];
    if (status) parts.push(`<span class="chfeed-status">${escHtml(status)}</span>`);
    if (confidence) {
      parts.push(
        `<span class="chfeed-conf" data-conf="${escAttr(confidence)}"><span class="chfeed-conf-k">confidence</span> ${escHtml(confidence)}</span>`
      );
    }
    return parts.length
      ? `<p class="chfeed-meta">${parts.join('<span class="chfeed-sep" aria-hidden="true"> · </span>')}</p>`
      : "";
  }

  function outcomeHtml(change: BrainChange): string {
    const phrase = text(change.outcome?.phrase);
    if (!phrase) return "";
    const tone = OUTCOME_TONE[String(change.outcome?.key)] || "quiet";
    return `<p class="chfeed-outcome chfeed-outcome-${tone}">${escHtml(phrase)}</p>`;
  }

  // The athlete's own words, as the row's first line ("You said “push me until the block
  // ends”") — the row reads "You said X → the brain changed Y". Stray quote marks are
  // dropped so the curly pair is never doubled, the same way the server writes its quote.
  function saidWords(change: BrainChange): string {
    return text(change.said).replace(/[“”"]/g, "").trim();
  }

  function saidHtml(said: string): string {
    return said
      ? `<p class="chfeed-said"><span class="chfeed-said-k">You said</span> <q class="chfeed-said-q">${escHtml(said)}</q></p>`
      : "";
  }

  // The server's why OPENS on the same quote for a stated row (`You said “X”. Y`); with
  // the quote printed as its own line, the why keeps only what the brain changed.
  function whyAfterSaid(why: string, said: string): string {
    if (!said) return why;
    const quote = `You said “${said}”.`;
    return why.startsWith(quote) ? why.slice(quote.length).trim() : why;
  }

  /** One change. `data-chfeed-id` is the key the controller patches a single row by. */
  function rowHtml(change: BrainChange, options: ChangesFeedRowOptions = {}): string {
    const title = text(change.title);
    if (!title) return "";
    const said = saidWords(change);
    const state = STATES.has(change.state) ? change.state : "applied";
    const classes = ["chfeed-row", `is-${state}`];
    if (change.new === true) classes.push("is-new");
    if (options.enter) classes.push("settle-in");
    else if (options.index != null) classes.push("reveal");
    if (options.settled) classes.push("is-settled");
    if (said) classes.push("is-said");
    const stagger =
      !options.enter && options.index != null ? ` style="--i:${Math.max(0, Math.trunc(options.index))}"` : "";
    const why = whyAfterSaid(text(change.why), said);
    const fresh = change.new === true ? `<span class="chfeed-new">New</span>` : "";
    const folds = why.length > WHY_FOLD_CHARS;
    const whyHtml = why
      ? `<p class="chfeed-why${folds ? " is-folded" : ""}">${escHtml(why)}</p>${
          folds ? `<button class="linkbtn-quiet chfeed-more" type="button" data-chfeed-more aria-expanded="false">Read all</button>` : ""
        }`
      : "";
    const talk = `<button class="linkbtn-quiet chfeed-talk" type="button" data-chfeed-talk="${escAttr(change.id)}">Talk it through</button>`;
    return `<li class="${classes.join(" ")}" data-chfeed-id="${escAttr(change.id)}"${stagger}>
      ${saidHtml(said)}
      <div class="chfeed-head">${dotHtml(change)}${arrowHtml(title)}<p class="chfeed-title">${escHtml(title)}</p>${fresh}</div>
      ${whyHtml}
      ${outcomeHtml(change)}
      ${metaHtml(change)}
      <div class="chfeed-acts">${undoHtml(change)}${talk}</div>
    </li>`;
  }

  /** A day's printed label: the server's word ("Today"), else its date. */
  function dayLabel(day: BrainChangeDay): string {
    return text(day.label) || text(day.day);
  }

  /** One day group around already-rendered rows; with none, the empty shell the controller fills. */
  function dayShellHtml(day: BrainChangeDay, rows = ""): string {
    return `<section class="chfeed-day" data-chfeed-day="${escAttr(day.day)}">
      <h2 class="lbl chfeed-day-label">${escHtml(dayLabel(day))}</h2>
      <ol class="chfeed-rows">${rows}</ol>
    </section>`;
  }

  function dayHtml(day: BrainChangeDay, start: number, options: ChangesFeedOptions): string {
    const rows = (Array.isArray(day.changes) ? day.changes : [])
      .map((change, i) => rowHtml(change, { index: options.reveal ? start + i : null, enter: options.enter }))
      .filter(Boolean);
    return rows.length ? dayShellHtml(day, rows.join("")) : "";
  }

  function emptyHtml(): string {
    return CairnUi.emptyStateHtml({
      title: "Nothing has changed lately",
      body: "When the team adjusts your training or meals, what changed, why, and an Undo arrive here.",
      className: "empty-state chfeed-empty",
    });
  }

  /**
   * Drafts the team set aside: housekeeping, not changes — nothing moved, so no Undo,
   * no outcome, no "New". One quiet line each under the changes, in the server's own
   * finished words. "" when there are none.
   */
  function setAsideHtml(data: BrainChanges | null | undefined): string {
    const rows = (data && Array.isArray(data.set_aside) ? data.set_aside : [])
      .map((row: BrainSetAside) => {
        const line = text(row?.line);
        if (!line) return "";
        const when = text(row.label);
        return `<li class="chfeed-aside-row" data-chfeed-aside="${escAttr(row.id)}"><p class="chfeed-why">${escHtml(line)}</p>${
          when ? `<p class="chfeed-meta">${escHtml(when)}</p>` : ""
        }</li>`;
      })
      .filter(Boolean);
    if (!rows.length) return "";
    return `<section class="chfeed-aside" aria-label="Drafts set aside">
      <h2 class="lbl chfeed-day-label">Set aside</h2>
      <ul class="chfeed-aside-rows">${rows.join("")}</ul>
    </section>`;
  }

  /** The whole feed: day groups, newest first, or the calm empty state; set-aside drafts last. */
  function feedHtml(data: BrainChanges | null | undefined, options: ChangesFeedOptions = {}): string {
    const days = data && Array.isArray(data.days) ? data.days : [];
    let start = 0;
    const html = days
      .map((day) => {
        const out = dayHtml(day, start, options);
        start += Array.isArray(day.changes) ? day.changes.length : 0;
        return out;
      })
      .join("");
    const aside = setAsideHtml(data);
    if (html) return `<div class="chfeed">${html}${aside}</div>`;
    return aside ? `${emptyHtml()}<div class="chfeed">${aside}</div>` : emptyHtml();
  }

  /** A calm one-sentence failure with a way to try again; the surface is otherwise untouched. */
  function errorHtml(): string {
    return `<div class="chfeed-error" role="status" aria-live="polite">
      <p class="chfeed-error-line">Couldn't reach the record of changes just now.</p>
      <button class="linkbtn-quiet chfeed-retry" type="button" data-chfeed-retry="1">Try again</button>
    </div>`;
  }

  const CAIRN_CHANGES_FEED = {
    feedHtml,
    setAsideHtml,
    rowHtml,
    dayShellHtml,
    dayLabel,
    errorHtml,
    undoAttr,
  };

  Object.assign(globalThis, { CairnChangesFeed: CAIRN_CHANGES_FEED });
}
