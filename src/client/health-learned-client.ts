// @ts-check
// Health Learned timeline renderers: pure HTML for the pull-only memory/learning read.

type ClientLearnedItem = import("../contracts/client-api.js").ClientLearnedItem;
type ClientLearnedKind = import("../contracts/client-api.js").ClientLearnedKind;
type ClientLearnedTimeline = import("../contracts/client-api.js").ClientLearnedTimeline;
type LearnedGroup = readonly [kind: ClientLearnedKind, label: string, blurb: string];

(() => {
  const LEARNED_GROUPS: readonly LearnedGroup[] = [
    [
      "memory",
      "Understood about you",
      "Constraints, preferences and goals it carries — the durable picture of who you are.",
    ],
    [
      "learning",
      "What we tried, and how it went",
      "Quiet observations from comparing a suggestion to what actually happened. Never a verdict — just what it noticed.",
    ],
    [
      "outcome",
      "Decisions, expectations and outcomes",
      "What Cairn changed, what it expected, what happened, and the personal defaults it is carefully earning from repeated clean results.",
    ],
    [
      "directive",
      "Connections it made",
      "When a finding in your labs quietly shaped your meals, training, or what to watch. Informational, never medical advice.",
    ],
    [
      "applied",
      "Plan changes you accepted",
      "Adjustments Cairn proposed that you chose to apply. Nothing here changed on its own.",
    ],
  ];

function learnedItemHtml(item: Partial<ClientLearnedItem> | null | undefined, index: number): string {
  const row = item ?? {};
  const when = row.when ? String(row.when) : "";
  const rel = when ? relAge(when) : "";
  const abs = when ? absDate(when) : "";
  const dateHtml = rel
    ? `<span class="sess-day"${abs ? ` title="${escAttr(abs)}"` : ""}>${escHtml(rel)}</span>`
    : "";
  const detail = row.detail ? `<div class="sess-line">${escHtml(row.detail)}</div>` : "";
  const source = row.source ? `<div class="sess-line lbl" style="color:var(--muted);margin-top:6px">${escHtml(row.source)}</div>` : "";
  return `<div class="sess reveal" style="${stagger(index + 1)}">
      <div class="sess-head"><span class="sess-date">${escHtml(row.title || "")}</span>${dateHtml}</div>
      ${detail}
      ${source}
    </div>`;
}

  function learnedTimelineHtml(data: ClientLearnedTimeline | null | undefined): string {
    const items = Array.isArray(data?.items) ? data.items : [];
    const intro = `<div class="learned-intro sess"><div class="sess-line" style="color:var(--muted)">
      A quiet record of what Cairn has come to understand about you, the changes it's made with you, and whether those changes worked as expected. It's here to show its working — not to grade anything. Visit it whenever; it never nudges.
    </div></div>`;
  if (!items.length) {
    return intro + `<div class="empty-state reveal" style="${stagger(0)}">
        <div class="empty-state-line">Nothing learned yet</div>
        <div class="hpic-hero-sub">As you log, chat, and add labs, Cairn builds up a picture of you — and what it understands will show up here, in plain words.</div>
      </div>`;
  }
  let body = "";
  let index = 0;
  for (const [kind, label, blurb] of LEARNED_GROUPS) {
    const group = items.filter((item) => item.kind === kind);
    if (!group.length) continue;
    const foot = kind === "memory"
      ? `<button class="linkbtn" id="learnedToMemory" style="margin-top:8px">Curate these in Memory →</button>`
      : "";
    body += `<section style="margin-top:22px">
        <h2 class="lbl" style="margin:0 0 4px">${escHtml(label)}</h2>
        <p class="hpic-hero-sub" style="margin:0 0 10px;text-align:left">${escHtml(blurb)}</p>
        ${group.map((item) => learnedItemHtml(item, index++)).join("")}
        ${foot}
      </section>`;
  }
  return intro + (body || `<div class="empty-state reveal" style="${stagger(0)}"><div class="empty-state-line">Nothing learned yet</div></div>`);
}

const CAIRN_HEALTH_LEARNED = {
  LEARNED_GROUPS,
  learnedItemHtml,
  learnedTimelineHtml,
};

Object.assign(globalThis, {
  CairnHealthLearned: CAIRN_HEALTH_LEARNED,
  learnedTimelineHtml,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnHealthLearned: CAIRN_HEALTH_LEARNED,
    learnedTimelineHtml,
  });
}
})();
