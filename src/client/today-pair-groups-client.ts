// @ts-check
// Superset pair groups on the Today session surface. Items that share a
// `superset_group` render as ONE visible group (a caption, head/tail classes, a
// partner chip on each card). The renderer lays the groups out at paint time
// (`html`); a skip or undo moves cards without a repaint, so `regroup` re-reads
// who is still on screen from the DOM.

type TodayPairGroupItem = Record<string, unknown>;
type TodayPairGroupsApi = {
  html(
    items: TodayPairGroupItem[],
    cardHtml: (item: TodayPairGroupItem, pair: Record<string, unknown>) => string,
    esc: (value: unknown) => string
  ): string;
  regroup(root: ParentNode | null | undefined): void;
};

(() => {
  function groupCaptionText(count: number): string {
    return count === 2 ? "Pair — alternate sets, rest after both" : "Group — rotate sets, rest after all";
  }

  function groupCaptionHtml(count: number, key: number, esc: (value: unknown) => string): string {
    return `<div class="ex-group-cap" data-group="${key}">${esc(groupCaptionText(count))}</div>`;
  }

  // The head/tail classes are set by the renderer (never inferred with :has() or a
  // sibling combinator), so an engine without :has() still draws the group right.
  function groupClasses(position: number, size: number): string {
    return ` ex-in-group${position === 0 ? " ex-group-head" : ""}${position === size - 1 ? " ex-group-tail" : ""}`;
  }

  // Items that share a superset_group are ONE visible group: the members sit together
  // (at the first member's place) under a single caption, each card naming its
  // partner(s). Only the render order changes — the items, their names and the logged
  // sets are untouched, and the athlete may still log in any order. A group with a
  // single member on screen (partner skipped, swapped out) is a plain card.
  function html(
    items: TodayPairGroupItem[],
    cardHtml: (item: TodayPairGroupItem, pair: Record<string, unknown>) => string,
    esc: (value: unknown) => string
  ): string {
    let out = "";
    const groups = new Map<number, TodayPairGroupItem[]>();
    for (const item of items) {
      if (item.superset_group == null || !Number.isFinite(Number(item.superset_group))) continue;
      const key = Number(item.superset_group);
      groups.set(key, [...(groups.get(key) || []), item]);
    }
    const emitted = new Set<number>();
    for (const item of items) {
      const key = Number(item.superset_group);
      const members = (item.superset_group != null && groups.get(key)) || [];
      if (members.length < 2) {
        out += cardHtml(item, {});
        continue;
      }
      if (emitted.has(key)) continue;
      emitted.add(key);
      out += groupCaptionHtml(members.length, key, esc);
      members.forEach((member, position) => {
        out += cardHtml(member, {
          pairPartners: members.filter((other) => other !== member).map((other) => String(other.exercise || "")),
          pairGroup: key,
          pairClasses: groupClasses(position, members.length),
        });
      });
    }
    return out;
  }

  // A card leaving (skip) or returning (undo) changes who is still on screen without a
  // repaint. Re-evaluate every group from the DOM: a lone remaining member is a plain
  // card (no rail, caption or partner chip); two or more are one group again, with the
  // caption, chips and corners to match. Cards keep `data-group` for exactly this.
  function regroup(root: ParentNode | null | undefined): void {
    if (!root || typeof root.querySelectorAll !== "function") return;
    const byGroup = new Map<string, HTMLElement[]>();
    root.querySelectorAll<HTMLElement>(".ex[data-group]").forEach((card) => {
      const key = card.dataset.group || "";
      byGroup.set(key, [...(byGroup.get(key) || []), card]);
    });
    root.querySelectorAll<HTMLElement>(".ex-group-cap[data-group]").forEach((cap) => {
      if (!byGroup.has(cap.dataset.group || "")) cap.remove();
    });
    const makeChip = (names: string[]): string => {
      const cards = typeof CairnTodayCards !== "undefined" ? CairnTodayCards : null;
      return cards && typeof cards.pairChipHtml === "function" ? cards.pairChipHtml(names) : "";
    };
    for (const [key, members] of byGroup) {
      const caption = [...root.querySelectorAll<HTMLElement>(".ex-group-cap[data-group]")].find(
        (cap) => cap.dataset.group === key
      );
      const lone = members.length < 2;
      members.forEach((card, index) => {
        card.classList.toggle("ex-in-group", !lone);
        card.classList.toggle("ex-group-head", !lone && index === 0);
        card.classList.toggle("ex-group-tail", !lone && index === members.length - 1);
        const meta = card.querySelector<HTMLElement>(".ex-meta");
        meta?.querySelector(".ex-pair-chip")?.remove();
        if (lone || !meta) return;
        const names = members.filter((other) => other !== card).map((other) => other.dataset.card || "");
        meta.insertAdjacentHTML("beforeend", makeChip(names));
      });
      if (lone) {
        caption?.remove();
      } else if (caption) {
        caption.textContent = groupCaptionText(members.length);
      } else {
        members[0].insertAdjacentHTML(
          "beforebegin",
          groupCaptionHtml(members.length, Number(key), (v) =>
            String(v ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string)
          )
        );
      }
    }
  }

  const CAIRN_TODAY_PAIR_GROUPS: TodayPairGroupsApi = { html, regroup };

  Object.assign(globalThis, { CairnTodayPairGroups: CAIRN_TODAY_PAIR_GROUPS });
  if (typeof window !== "undefined") {
    Object.assign(window, { CairnTodayPairGroups: CAIRN_TODAY_PAIR_GROUPS });
  }
})();
