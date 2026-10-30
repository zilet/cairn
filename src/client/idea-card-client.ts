// @ts-check
// Idea cards (docs/V2-PLAN.md wave 2, "idea-card"). The view: up to three ideas for
// the rest of today (Intake shows ONE, `limit`) from GET /api/fuel/ideas, each built from the athlete's own
// staples, sized protein first, its macros in one line, with the server's own
// sentence for why it was offered.
// An idea is never shown as eaten and never as a plan: it is labelled an idea, has no
// done state, and its only actions are "Start from this" (fills the composer for
// editing — nothing is logged until the athlete sends it) and "Another idea".
{
  type Idea = import("../contracts/fuel.js").ClientFuelIdea;
  type Ideas = import("../contracts/fuel.js").ClientFuelIdeas;

  /**
   * "38 g protein · 20 g carbs · 12 g fat · ~420 kcal" — the idea's own macros in one
   * fixed order, fiber only when it is a real source, and a zero macro left out (a
   * melon never reads "0 g protein"). "" when nothing is known.
   */
  function numsText(idea: Idea): string {
    const bits: string[] = [];
    const grams = (value: number | null | undefined, label: string, min = 1) => {
      if (value != null && Math.round(value) >= min) bits.push(`${Math.round(value)} g ${label}`);
    };
    grams(idea.protein_g, "protein");
    grams(idea.carbs_g, "carbs");
    grams(idea.fat_g, "fat");
    grams(idea.fiber_g, "fiber", 3);
    if (idea.kcal != null) bits.push(`~${Math.round(idea.kcal)} kcal`);
    return bits.join(" · ");
  }

  function ideaCardHtml(idea: Idea, opts: { index?: number; enter?: boolean } = {}): string {
    const nums = numsText(idea);
    const reveal = opts.enter ? " settle-in" : opts.index != null ? " reveal" : "";
    const style = !opts.enter && opts.index != null ? ` style="--i:${Number(opts.index) || 0}"` : "";
    return `<li class="idea-card${reveal}"${style} data-idea-card="${escAttr(idea.key)}">
      <div class="idea-card-head">
        <span class="lbl idea-card-kind">Idea</span>
        <span class="idea-card-portion">${escHtml(idea.portion_words)}</span>
      </div>
      <h3 class="idea-card-title">${escHtml(idea.title)}</h3>
      ${nums ? `<p class="idea-card-nums">${escHtml(nums)}</p>` : ""}
      ${idea.why ? `<p class="idea-card-why">${escHtml(idea.why)}</p>` : ""}
      <div class="idea-card-actions">
        <button class="pillbtn idea-card-start" type="button" data-idea-card-start>Start from this</button>
        <button class="linkbtn linkbtn-quiet idea-card-another" type="button" data-idea-card-another>Another idea</button>
      </div>
      <p class="idea-card-status" role="status" aria-live="polite"></p>
    </li>`;
  }

  // One idea is "An idea", a set "Ideas": the heading names what is on screen.
  function titleFor(limit: number | undefined): string {
    return limit === 1 ? "An idea for the rest of today" : "Ideas for the rest of today";
  }

  /** The set: a heading, the server's line about the ideas, and the cards (the first `limit`). */
  function ideasHtml(data: Ideas, opts: { reveal?: boolean; limit?: number } = {}): string {
    const all = Array.isArray(data.ideas) ? data.ideas : [];
    const ideas = opts.limit && opts.limit > 0 ? all.slice(0, opts.limit) : all;
    const words = data.words ? `<p class="idea-cards-words">${escHtml(data.words)}</p>` : "";
    const cards = ideas.length
      ? `<ul class="idea-cards-list">${ideas.map((idea, i) => ideaCardHtml(idea, { index: opts.reveal ? i + 1 : undefined })).join("")}</ul>`
      : "";
    const title = titleFor(opts.limit);
    return `<section class="idea-cards" aria-label="${escAttr(title)}">
      <h2 class="lbl idea-cards-title">${escHtml(title)}</h2>
      ${words}${cards}
    </section>`;
  }

  function errorHtml(limit?: number): string {
    return `<section class="idea-cards" role="status" aria-live="polite">
      <h2 class="lbl idea-cards-title">${escHtml(titleFor(limit))}</h2>
      <p class="idea-cards-words">Ideas couldn't be read just now.</p>
      <button class="linkbtn linkbtn-quiet idea-cards-retry" type="button" data-idea-cards-retry>Try again</button>
    </section>`;
  }

  const CAIRN_IDEA_CARD = {
    ideasHtml,
    ideaCardHtml,
    numsText,
    errorHtml,
  };

  Object.assign(globalThis, { CairnIdeaCard: CAIRN_IDEA_CARD });
}
