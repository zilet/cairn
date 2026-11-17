// @ts-check
// "Your team this week", the view (docs/IA.md "Horizon landing" 6): the six stones as six
// seats at the table, and the at most three that had something to say this week, read off
// GET /api/team-week (`seats`, `link`, `changes_count`; the same read Today's weekly card
// draws). Each seat is a row: the stone dot, the role as a mono eyebrow in the seat's deep
// hue, what it did as the sentence, then what it expects and how its last call landed as
// one muted line. Roles, never personas.
//
// The link note sits under "Where you stand": two seats reading one thing together — a
// quiet block with a dawn rule, a mono kicker naming the seats ("Fuel and Strength,
// together"), the text, and a "Talk it through" chip that opens chat with `link.ask`
// prefilled (never sent for the athlete; the controller hands it over through
// `state.chatPrefill`, the starter chips' one-tap opener).
//
// `model` is pure (a read in, a view model out; an older read without the fields is null);
// the renderers are deterministic strings, every word escaped, no colour written here.
//
// LAZY ("horizon" bundle).
{
  type TeamWeek = import("../contracts/client-api.js").ClientTeamWeek;

  /** A seat's name, the stone it sits in. */
  const SEAT_WORD: Readonly<Record<string, string>> = {
    strength: "Strength",
    endurance: "Run",
    recovery: "Recovery",
    fuel: "Fuel",
    body: "Body",
    heart: "Heart",
  };
  const SEATS_MAX = 3;

  function text(value: unknown): string {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function seatKey(value: unknown): ClientRowStone | null {
    const key = text(value);
    return Object.hasOwn(SEAT_WORD, key) ? (key as ClientRowStone) : null;
  }

  /** "Fuel and Strength", "Fuel, Body and Strength". */
  function names(keys: ReadonlyArray<ClientRowStone>): string {
    const words = keys.map((k) => SEAT_WORD[k]);
    return words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}` : words[0] || "";
  }

  /** The team read as the landing draws it; null when the read carries no seats and no link. */
  function model(read: unknown): ClientTeamSeats | null {
    const team = read && typeof read === "object" && !Array.isArray(read) ? (read as Partial<TeamWeek>) : null;
    if (!team) return null;
    const seats = (Array.isArray(team.seats) ? team.seats : [])
      .map((s): ClientTeamSeatRow | null => {
        const seat = seatKey(s?.seat);
        const did = text(s?.did);
        if (!seat || !did) return null;
        return {
          seat,
          role: text(s?.role) || SEAT_WORD[seat],
          did,
          tail: [text(s?.expects), text(s?.landed)].filter(Boolean).join(" "),
        };
      })
      .filter((s): s is ClientTeamSeatRow => !!s)
      .slice(0, SEATS_MAX);
    const l = team.link && typeof team.link === "object" ? team.link : null;
    const linkSeats = (Array.isArray(l?.seats) ? l.seats : []).map(seatKey).filter((k): k is ClientRowStone => !!k);
    const link =
      l && text(l.text) && linkSeats.length
        ? { seats: linkSeats, who: `${names(linkSeats)}, together`, text: text(l.text), ask: text(l.ask) }
        : null;
    const count = Number(team.changes_count);
    if (!seats.length && !link) return null;
    return { seats, link, changes: Number.isInteger(count) && count > 0 ? count : 0 };
  }

  /** The seat rows; "" with none. */
  function seatsHtml(team: ClientTeamSeats | null): string {
    if (!team?.seats.length) return "";
    const rows = team.seats
      .map(
        (s) => `<li class="seat stone-${escAttr(s.seat)}">
          <span class="seat-dot" aria-hidden="true"></span>
          <span class="lbl seat-role">${escHtml(s.role)}</span>
          <span class="seat-did">${escHtml(s.did)}</span>
          ${s.tail ? `<span class="seat-tail">${escHtml(s.tail)}</span>` : ""}
        </li>`
      )
      .join("");
    return `<ul class="seat-list" aria-label="Your team this week">${rows}</ul>`;
  }

  /** The masthead aside: this week's changes, opening Ask › Changes; "" with none. */
  function changesHtml(team: ClientTeamSeats | null, href: string): string {
    if (!team?.changes) return "";
    const words = team.changes === 1 ? "1 change this week ›" : `${team.changes} changes this week ›`;
    return `<a class="linkbtn-quiet hwk-aside-link" href="${escAttr(href || "#")}" data-hwk-changes>${escHtml(words)}</a>`;
  }

  /** The link note under the goals; "" with none. */
  function linkHtml(team: ClientTeamSeats | null): string {
    const link = team?.link;
    if (!link) return "";
    const chip = link.ask
      ? `<button type="button" class="hwk-link-ask" data-hwk-ask="${escAttr(link.ask)}"><span class="hwk-link-chip">Talk it through</span></button>`
      : "";
    return `<aside class="hwk-linknote" aria-label="${escAttr(link.who)}">
      <span class="lbl hwk-linknote-k">${escHtml(link.who)}</span>
      <p class="hwk-linknote-t">${escHtml(link.text)}</p>
      ${chip}
    </aside>`;
  }

  const CAIRN_TEAM_SEATS = { model, seatsHtml, changesHtml, linkHtml, SEAT_WORD };

  Object.assign(globalThis, { CairnTeamSeats: CAIRN_TEAM_SEATS });
}
