// @ts-check
// The forward foot of Today (docs/DESIGN.md "Today"): one new-connection sentence,
// only when a new insight exists. The road ahead ("Coming up", the progress board,
// the Path card) left Today: it lives on Horizon in full, and Today keeps one glance
// line into it (today-path-client.ts). Lives in the lazy today-ahead bundle.

(() => {
  type TodayAheadInsight = { id?: unknown; text?: unknown; kind?: unknown; status?: unknown } | null | undefined;

  // One new connection, as one sentence: its first sentence, clipped.
  function insightSentence(insight: TodayAheadInsight): string {
    if (!insight || insight.kind === "weekly_read" || insight.status !== "new") return "";
    const text = String(insight.text ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return "";
    const first = /^(.+?[.!?])(\s|$)/.exec(text)?.[1] ?? text;
    return first.length > 200 ? `${first.slice(0, 197).replace(/\s+\S*$/, "")}…` : first;
  }

  /** The one new connection, a sentence and a way to ask; "" without a new insight. */
  function connectionHtml(insight?: TodayAheadInsight): string {
    const line = insightSentence(insight);
    if (!line) return "";
    return `<section class="thd thd-connection" aria-label="New connection">
      <p class="thd-insight"><span class="lbl">New connection</span> ${escHtml(line)} <button class="linkbtn linkbtn-plain" type="button" data-thd-insight="${escAttr(line)}">Ask about it →</button></p>
    </section>`;
  }

  const CAIRN_TODAY_HORIZON = { connectionHtml, insightSentence };

  Object.assign(globalThis, { CairnTodayHorizon: CAIRN_TODAY_HORIZON });
})();
