// @ts-check
// Inspectable beliefs (W3.6): pure HTML for the Stand → Learned "beliefs" surface —
// one calm, grouped list over learned models / felt-signal correlations /
// personal-response modifiers, each row in athlete voice with its evidence in
// plain words and a "that's not right" affordance. Wiring lives in
// health-beliefs-loader-client.ts.

type ClientBeliefRow = import("../contracts/client-api.js").ClientBeliefRow;
type ClientBeliefGroupView = import("../contracts/client-api.js").ClientBeliefGroupView;
type ClientBeliefsView = import("../contracts/client-api.js").ClientBeliefsView;

(() => {
  function beliefRowHtml(row: ClientBeliefRow, index: number, setAside: boolean): string {
    const action = setAside
      ? `<button class="linkbtn" data-belief-undispute="${escAttr(row.id)}">restore this belief</button>`
      : `<button class="linkbtn" data-belief-dispute="${escAttr(row.id)}">that's not right</button>`;
    return `<div class="sess reveal" style="${stagger(index + 1)}" data-belief-row="${escAttr(row.id)}">
        <div class="sess-line">${escHtml(row.statement)}</div>
        <div class="sess-line lbl" style="color:var(--muted);margin-top:4px">${escHtml(row.why)}</div>
        <div style="margin-top:6px">${action}</div>
      </div>`;
  }

  function beliefGroupHtml(group: ClientBeliefGroupView, startIndex: number): { html: string; count: number } {
    if (!group.rows.length) return { html: "", count: 0 };
    let index = startIndex;
    const rows = group.rows.map((row) => beliefRowHtml(row, index++, false)).join("");
    return {
      html: `<section style="margin-top:22px">
          <h2 class="lbl" style="margin:0 0 4px">${escHtml(group.label)}</h2>
          ${rows}
        </section>`,
      count: group.rows.length,
    };
  }

  function beliefsSetAsideHtml(rows: ClientBeliefRow[], startIndex: number): string {
    if (!rows.length) return "";
    let index = startIndex;
    return `<details style="margin-top:22px">
        <summary class="lbl" style="cursor:pointer">Set aside (${rows.length})</summary>
        <p class="hpic-hero-sub" style="margin:8px 0 10px;text-align:left">
          Beliefs you've marked "that's not right." They're excluded from prompts and
          personal-response defaults, but stay here — nothing is deleted, and you can
          restore one anytime.
        </p>
        ${rows.map((row) => beliefRowHtml(row, index++, true)).join("")}
      </details>`;
  }

  function beliefsViewHtml(data: ClientBeliefsView | null | undefined): string {
    const groups = Array.isArray(data?.groups) ? data.groups : [];
    const setAside = Array.isArray(data?.set_aside) ? data.set_aside : [];
    const directivesNote = data?.directives?.note
      ? `<div class="sess-line lbl" style="color:var(--muted);margin-top:10px">${escHtml(
          data.directives.active_count
            ? `${data.directives.note} (${data.directives.active_count} active in Connections)`
            : data.directives.note
        )}</div>`
      : "";
    const anyRows = groups.some((g) => g.rows.length) || setAside.length;
    if (!anyRows) {
      return `<div class="empty-state reveal" style="${stagger(0)}">
          <div class="empty-state-line">No beliefs yet</div>
          <div class="hpic-hero-sub">As Cairn learns your patterns, what it believes about you will show up here — plain words, with a way to correct anything that's off.</div>
        </div>`;
    }
    let index = 0;
    let body = "";
    for (const group of groups) {
      const rendered = beliefGroupHtml(group, index);
      body += rendered.html;
      index += rendered.count;
    }
    body += beliefsSetAsideHtml(setAside, index);
    return body + directivesNote;
  }

  const CAIRN_HEALTH_BELIEFS = { beliefsViewHtml };

  Object.assign(globalThis, { CairnHealthBeliefs: CAIRN_HEALTH_BELIEFS });
  if (typeof window !== "undefined") {
    Object.assign(window, { CairnHealthBeliefs: CAIRN_HEALTH_BELIEFS });
  }
})();
