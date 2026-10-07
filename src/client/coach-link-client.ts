// @ts-check
// The coach link: whether the person's AI coach is connected, and the two quiet
// places that say so when it is not. EAGER (bundle-02): Today mounts its card and Ask
// asks it before showing a composer; the full-screen welcome itself is the lazy
// "welcome" bundle, reached only through openWelcome.
//
// No agent means no coaching, never a fake one: Ask's composer gives way to one calm
// connect card (instead of a "No agents enabled" error bubble), and Today carries one
// line near the top. Once a coach is usable but has not said hello yet, Today's line
// becomes the invitation to meet it.
(() => {
  const KEY = "coach-link";
  const NOT_PROVIDERS = new Set(["stub"]);

  type AgentRow = Record<string, unknown>;

  function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
  }

  // The server names each provider (agents.json `label`); an older one does not.
  const LABELS: Record<string, string> = { claude: "Claude", codex: "ChatGPT", antigravity: "Google", grok: "Grok" };

  function label(name: string, row: AgentRow): string {
    return text(row.label) || LABELS[name] || name.charAt(0).toUpperCase() + name.slice(1);
  }

  /** GET /api/settings → the small model every coach-link surface reads. */
  function model(raw: unknown): CoachLinkModel {
    const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const settings = body.settings && typeof body.settings === "object" ? (body.settings as Record<string, unknown>) : {};
    const rows = Array.isArray(body.agents) ? (body.agents as AgentRow[]) : [];
    // A server that names plan lines lists exactly those as providers; an older one
    // (no `plan` on any row) offers every real CLI.
    const plans = rows.some((row) => text(row.plan));
    const providers: CoachLinkProvider[] = [];
    for (const row of rows) {
      const name = text(row.name);
      if (!name || NOT_PROVIDERS.has(name)) continue;
      if (plans && !text(row.plan)) continue;
      providers.push({
        name,
        label: label(name, row),
        plan: text(row.plan),
        usable: row.usable === true,
        present: row.present === true,
        installable: row.installable === true,
        canLogin: row.can_login === true,
        configured: typeof row.configured === "boolean" ? row.configured : null,
      });
    }
    return {
      onboarded: settings.onboarded === true,
      // An older server has no coach_welcomed: read that as already welcomed, so an
      // existing install never grows a "say hello" card it cannot clear.
      welcomed: settings.coach_welcomed !== false,
      providers,
      usable: providers.filter((p) => p.usable),
    };
  }

  function peek(): CoachLinkModel | null {
    const hit = peekCached<CoachLinkModel>(KEY, 60000);
    return hit && hit.data && Array.isArray(hit.data.providers) ? hit.data : null;
  }

  function read(): Promise<CoachLinkModel | null> {
    // A remembered read serves for half a minute: Today and Ask both ask on every
    // paint, and the moments that change the answer (a verified sign-in, the welcome
    // finishing) invalidate it themselves.
    return cachedApi("/settings", { key: KEY, serveFreshFor: 30000, project: (raw) => model(raw) as never })
      .then((data) => (data as unknown as CoachLinkModel) || null)
      .catch(() => peek());
  }

  function invalidate(): void {
    swrInvalidate(KEY);
  }

  function openWelcome(opts: WelcomeOpenOptions = {}): void {
    // The welcome bundle is not in the shared lazy-bundle name list yet; reach the
    // loader through a widened signature rather than a second loader.
    const load = withBundle as unknown as (name: string, fn: () => unknown) => unknown;
    void Promise.resolve(
      load("welcome", () => (globalThis as { CairnWelcome?: WelcomeApi }).CairnWelcome?.open(opts))
    ).catch(() => {
      if (typeof toast === "function") toast("Couldn't open the welcome. Check the connection and try again.");
    });
  }

  function cardHtml(kind: "today-connect" | "today-hello" | "ask"): string {
    if (kind === "ask") {
      // The same unbuilt cairn the welcome's Connect step lays stone by stone.
      const mark = (globalThis as { CairnStone?: Window["CairnStone"] }).CairnStone?.cairnSvg(
        [{ key: "recovery", cls: "wel-stone is-open" }, { key: "endurance", cls: "wel-stone is-open" }, { key: "fuel", cls: "wel-stone is-open" }],
        { idPrefix: "clinkAsk", cls: "clink-cairn" }
      ) || "";
      return `<section class="clink clink-ask" aria-labelledby="clinkAskT">
        ${mark ? `<span class="clink-mark" aria-hidden="true">${mark}</span>` : ""}
        <h2 class="clink-t" id="clinkAskT">Your coach isn't connected yet</h2>
        <p class="clink-s">It runs on the AI you already use. Connect one and this is where you'll talk.</p>
        <button class="btn btn-solid clink-go" type="button" data-clink-go="hello">Connect</button>
      </section>`;
    }
    const hello = kind === "today-hello";
    return `<button class="clink clink-today reveal" type="button" data-clink-go="${hello ? "meet" : "hello"}">
      <span class="clink-dot${hello ? " is-live" : ""}" aria-hidden="true"></span>
      <span class="clink-line">${hello ? "Your coach is connected. Say hello" : "Connect your coach to get your first week."}</span>
      <span class="chev" aria-hidden="true">›</span>
    </button>`;
  }

  function wireGo(host: HTMLElement): void {
    if (host.dataset.clinkWired) return;
    host.dataset.clinkWired = "1";
    host.addEventListener("click", (event) => {
      const go = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-clink-go]") : null;
      if (!go) return;
      const stage = go.dataset.clinkGo === "meet" ? "meet" : "hello";
      openWelcome({ stage });
    });
  }

  function todayKind(m: CoachLinkModel | null): "today-connect" | "today-hello" | null {
    if (!m || m.welcomed) return null;
    return m.usable.length ? "today-hello" : "today-connect";
  }

  function paintToday(slot: HTMLElement, m: CoachLinkModel | null): void {
    const kind = todayKind(m);
    const want = kind || "";
    if (slot.dataset.clink === want) return;
    slot.dataset.clink = want;
    slot.innerHTML = kind ? cardHtml(kind) : "";
  }

  function mountToday(root: ParentNode): void {
    const slot = root.querySelector<HTMLElement>("#coachLinkSlot");
    if (!slot) return;
    wireGo(slot);
    const known = peek();
    paintToday(slot, known);
    // Once the coach has said hello the line is gone for good: no read needed.
    if (known?.welcomed) return;
    void read().then((m) => {
      if (slot.isConnected) paintToday(slot, m);
    });
  }

  function paintAsk(dock: HTMLElement, m: CoachLinkModel | null): void {
    // Only a known "nobody can coach" swaps the composer out; an unknown (offline,
    // cold) leaves the composer as it always was.
    const off = !!m && m.providers.length > 0 && m.usable.length === 0;
    dock.classList.toggle("is-unlinked", off);
    let card = dock.querySelector<HTMLElement>(".clink-ask-slot");
    if (!off) {
      card?.remove();
      return;
    }
    if (!card) {
      card = document.createElement("div");
      card.className = "clink-ask-slot";
      card.innerHTML = cardHtml("ask");
      dock.prepend(card);
      wireGo(card);
    }
  }

  function mountAsk(dock: HTMLElement): void {
    paintAsk(dock, peek());
    void read().then((m) => {
      if (dock.isConnected) paintAsk(dock, m);
    });
  }

  const CAIRN_COACH_LINK: CoachLinkApi = { KEY, model, peek, read, invalidate, openWelcome, mountToday, mountAsk, cardHtml };

  Object.assign(globalThis, { CairnCoachLink: CAIRN_COACH_LINK });
})();
