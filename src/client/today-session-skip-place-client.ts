// @ts-check
// Today session skip, part 2: where a skipped card sat, and seating it back for an Undo.
// By ITEM position — the card after it, else the card before it — never beside a pair caption,
// which a regroup may remove.

type CardPlace = { prev: Element | null; next: Element | null; tail?: Element | null };

{
  // Where the cards sat, as CARDS (never a pair caption, which a regroup may remove): the card
  // after them and the card before them, in item order.

  function cardPlace(cards: HTMLElement[], root: ParentNode): CardPlace {
    const all = [...root.querySelectorAll<HTMLElement>(".ex[data-card]")];
    const first = all.indexOf(cards[0]);
    const last = all.indexOf(cards[cards.length - 1]);
    return {
      prev: first > 0 ? all.slice(0, first).reverse().find((el) => !cards.includes(el)) ?? null : null,
      next: last >= 0 ? all.slice(last + 1).find((el) => !cards.includes(el)) ?? null : null,
      tail: cards[cards.length - 1].nextElementSibling,
    };
  }

  // Seat detached cards back by item position: before the card that followed them, else after the
  // one that preceded them, else at the end of the list. False when there is nowhere to seat them.
  function seatCards(detached: HTMLElement[], place: CardPlace, root: ParentNode): boolean {
    const next = place.next?.isConnected ? place.next : null;
    const prev = place.prev?.isConnected ? place.prev : null;
    const end = root.querySelector(".addex") ?? (place.tail?.isConnected ? place.tail : null);
    if (next?.parentNode) for (const el of detached) next.parentNode.insertBefore(el, next);
    else if (prev?.parentNode) {
      let after = prev.nextSibling;
      for (const el of detached) prev.parentNode.insertBefore(el, after);
    } else if (end?.parentNode) for (const el of detached) end.parentNode.insertBefore(el, end);
    else return false;
    return true;
  }

  Object.assign(globalThis, { CairnTodaySkipPlace: { cardPlace, seatCards } });
}
