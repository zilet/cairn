// @ts-check
// The sets this page watched the server save — the last line that keeps a logged set on
// the athlete's screen. A set's chip is DOM until its POST answers, and the surface is
// rebuilt from a session READ: a read that began before the write landed (a resume, an
// outbox replay, a slow aggregate) knows nothing about the set, and once the POST has
// answered the outbox no longer holds it either, so the rebuilt card came back empty and
// the athlete logged the set again. The server's own answer (its id) is remembered here
// per date and laid back over every read that lacks it, until a read carries it. Memory
// only: a reloaded page starts from the server, and a failed read there says so plainly.
//
// It also notices the one shape that duplicate looks like: a set entered while the screen
// showed fewer of that lift's sets than the server held, matching one of the sets the
// screen was missing. Those are flagged on the card (never blocked).
type SessionSetLedgerEntry = {
  id: string;
  date: string;
  session_id: unknown;
  exercise: string;
  set_number: unknown;
  weight: unknown;
  reps: unknown;
  rir: unknown;
  duration_sec: unknown;
  /** How many of this lift's chips were on screen when it was entered; null = not entered here. */
  seen: number | null;
  /** The athlete answered "Keep" to the repeat line. */
  kept: boolean;
};
type SessionSetLedgerOutboxItem = {
  id?: string;
  kind?: string;
  session_date?: unknown;
  body?: unknown;
  state?: "pending" | "sending" | "prepared" | "needs_attention";
};
type SessionSetLedgerState = {
  logDate: string;
  pendingOffPlan?: Record<string, Array<{ name: string; mode?: string | null }>>;
};
type SessionSetLedgerApi = {
  remember(set: unknown, opts?: { seen?: number | null }): void;
  forget(id: unknown): SessionSetLedgerEntry | undefined;
  keep(ids: string[]): void;
  saved(date: string): SessionSetLedgerEntry[];
  merge<T>(session: T, state: SessionSetLedgerState): T;
  repeats(date: string, session: unknown): string[];
  seenOnScreen(root: ParentNode, exercise: string): number;
  undeliveredSets(date: string): SessionSetLedgerOutboxItem[];
  bodyOf(body: unknown): Record<string, unknown>;
  cardFor(cards: HTMLElement[], exercise: unknown): HTMLElement | undefined;
  reset(): void;
};
declare const CairnSessionSetLedger: SessionSetLedgerApi;

{
  const MAX_ENTRIES = 400;
  const entries = new Map<string, SessionSetLedgerEntry>();
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const sameName = (a: unknown, b: unknown): boolean => String(a || "").toLowerCase() === String(b || "").toLowerCase();
  const idOf = (value: unknown): string => (value == null ? "" : String(value));
  const numericId = (value: unknown): number => Number(value) || 0;

  /** A POST /sets answer (the tap's, or the outbox replay's): the row the server saved. */
  function remember(set: unknown, opts: { seen?: number | null } = {}): void {
    const row = record(set);
    const id = idOf(row.id);
    const date = String(row.date || "");
    if (!/^\d+$/.test(id) || !date || !row.exercise || row.ok === false || row.error) return;
    entries.set(id, {
      id,
      date,
      session_id: row.session_id ?? null,
      exercise: String(row.exercise),
      set_number: row.set_number ?? null,
      weight: row.weight ?? null,
      reps: row.reps ?? null,
      rir: row.rir ?? null,
      duration_sec: row.duration_sec ?? null,
      seen: typeof opts.seen === "number" ? opts.seen : null,
      kept: false,
    });
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
  }

  /** A delete from this device: returned, so a refused delete can put it back. */
  function forget(id: unknown): SessionSetLedgerEntry | undefined {
    const entry = entries.get(idOf(id));
    entries.delete(idOf(id));
    return entry;
  }

  function keep(ids: string[]): void {
    for (const id of ids) {
      const entry = entries.get(id);
      if (entry) entry.kept = true;
    }
  }

  /**
   * Every set this page saw saved for `date`, oldest first. An entry leaves only when this
   * device deletes it: a read that lacks it is far likelier to predate it (a resume, a
   * replay, a slow aggregate) than to follow a delete made on another device, and a set
   * deleted elsewhere costs one tap on its × (the DELETE of a gone row is a no-op).
   */
  function saved(date: string): SessionSetLedgerEntry[] {
    return [...entries.values()]
      .filter((entry) => entry.date === date)
      .sort((a, b) => numericId(a.id) - numericId(b.id));
  }

  function rowOf(entry: SessionSetLedgerEntry): Record<string, unknown> {
    const { id, session_id, exercise, set_number, weight, reps, rir, duration_sec } = entry;
    return { id: numericId(id), session_id, exercise, set_number, weight, reps, rir, duration_sec };
  }

  // claimNext / drain replay rows with no `state` (the queued default), explicit
  // `pending`, and `sending`. `needs_attention` stays in the review sheet; `prepared`
  // is a prepare barrier.
  function undeliveredSets(date: string): SessionSetLedgerOutboxItem[] {
    const runtime = globalThis as { CairnOutbox?: { list?: () => SessionSetLedgerOutboxItem[] } };
    const items = typeof runtime.CairnOutbox?.list === "function" ? runtime.CairnOutbox.list() : [];
    return items.filter((item) => {
      if (item.kind !== "set" || !(item.state == null || item.state === "pending" || item.state === "sending"))
        return false;
      return String(item.session_date || bodyOf(item.body).date || "") === date;
    });
  }

  function bodyOf(body: unknown): Record<string, unknown> {
    return record(body);
  }

  // Peak-day duplicate names share data-card; a set for a lift rendered twice lands on the first card.
  function cardFor(cards: HTMLElement[], exercise: unknown): HTMLElement | undefined {
    if (!exercise) return undefined;
    return cards.find((el) => sameName(el.dataset.card, exercise));
  }

  /**
   * The session a screen is about to be built from, with every set this page saw saved
   * that the read does not carry yet — and a card kept for a lift whose only sets still
   * wait in the outbox (an off-plan lift has no card until the server lists it).
   */
  function merge<T>(session: T, state: SessionSetLedgerState): T {
    const date = state.logDate;
    for (const item of undeliveredSets(date)) {
      const body = bodyOf(item.body);
      if (!body.exercise) continue;
      state.pendingOffPlan ??= {};
      const list = (state.pendingOffPlan[date] ??= []);
      if (!list.some((pending) => sameName(pending.name, body.exercise))) {
        list.push({ name: String(body.exercise), mode: body.exercise_mode === "timed" ? "timed" : null });
      }
    }
    const kept = saved(date);
    if (!kept.length) return session;
    const read = record(session);
    const readSets = Array.isArray(read.sets) ? (read.sets as unknown[]) : [];
    const carried = new Set(readSets.map((set) => idOf(record(set).id)));
    const missing = kept.filter((entry) => !carried.has(entry.id)).map(rowOf);
    if (!missing.length) return session;
    // No session yet in the read (it predates the first set): the POST's own answer names it.
    const base = session && typeof session === "object" ? read : { id: kept[0].session_id, date };
    const sets = [...readSets, ...missing].sort((a, b) => numericId(record(a).id) - numericId(record(b).id));
    return { ...base, sets } as T;
  }

  /** How many chips of `exercise` the screen shows right now (every card that lift has). */
  function seenOnScreen(root: ParentNode, exercise: string): number {
    let count = 0;
    for (const card of root.querySelectorAll<HTMLElement>(".ex[data-card]")) {
      if (sameName(card.dataset.card, exercise)) count += card.querySelectorAll("[data-logged] .chip").length;
    }
    return count;
  }

  const sameValues = (entry: SessionSetLedgerEntry, set: Record<string, unknown>): boolean =>
    (["weight", "reps", "duration_sec"] as const).every((key) => String(entry[key] ?? "") === String(set[key] ?? ""));

  /**
   * Ids of sets entered here that look like a repeat: when it was entered, the screen held
   * fewer of that lift's sets than the server had already saved, and one of those earlier
   * saved sets has the same load and reps. Matched one to one, oldest first.
   */
  function repeats(date: string, session: unknown): string[] {
    const sets = (Array.isArray(record(session).sets) ? (record(session).sets as unknown[]) : []).map(record);
    const flagged = new Set<string>();
    const matched = new Set<string>();
    for (const entry of saved(date)) {
      if (entry.seen == null || entry.kept) continue;
      const earlier = sets.filter(
        (set) => sameName(set.exercise, entry.exercise) && numericId(set.id) < numericId(entry.id)
      );
      if (earlier.length <= entry.seen) continue;
      const twin = earlier.find((set) => {
        const id = idOf(set.id);
        return !matched.has(id) && !flagged.has(id) && sameValues(entry, set);
      });
      if (!twin || !sets.some((set) => idOf(set.id) === entry.id)) continue;
      matched.add(idOf(twin.id));
      flagged.add(entry.id);
    }
    return [...flagged];
  }

  const CAIRN_SESSION_SET_LEDGER: SessionSetLedgerApi = {
    remember,
    forget,
    keep,
    saved,
    merge,
    repeats,
    seenOnScreen,
    undeliveredSets,
    bodyOf,
    cardFor,
    reset: () => entries.clear(),
  };
  Object.assign(globalThis, { CairnSessionSetLedger: CAIRN_SESSION_SET_LEDGER });
}
