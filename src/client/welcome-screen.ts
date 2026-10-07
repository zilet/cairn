// @ts-check
// The first-run welcome: a full-screen stage at /app/welcome, over the app rather
// than inside a sheet. It owns its own three addresses —
//   /app/welcome                    Hello: the brand moment and the four providers
//   /app/welcome/connect?id=<name>  Connect: set up, sign in, say hello
//   /app/welcome/meet[?id=<name>]   Meet: the coach's first conversation
// — so Back walks between stages, a reload keeps the stage, and a Back past the first
// stage simply leaves for the app. The app's popstate handler asks popped() first
// (the same contract as the day drill), so the shell's router never rewrites these.
//
// Opened by the boot (maybeOnboard: not onboarded yet), by Today's coach line and by
// Ask's connect card, always through CairnCoachLink.openWelcome.
(() => {
  const BASE = "/app/welcome";
  const STAGES: readonly WelcomeStage[] = ["hello", "connect", "meet"];

  let root: HTMLElement | null = null;
  let teardown: (() => void) | null = null;
  let stage: WelcomeStage = "hello";
  let agent: string | null = null;
  let paintSeq = 0;
  // The last read found no server at all (a cold start offline), so Hello says so.
  let unreachable = false;

  function urlFor(next: WelcomeStage, name: string | null): string {
    const id = name ? `?id=${encodeURIComponent(name)}` : "";
    if (next === "connect") return `${BASE}/connect${id}`;
    if (next === "meet") return `${BASE}/meet${id}`;
    return BASE;
  }

  /** The stage an address names, or null when it is not a welcome address. */
  function parse(loc: Pick<Location, "pathname" | "search">): { stage: WelcomeStage; agent: string | null } | null {
    const parts = loc.pathname.toLowerCase().split("/").filter(Boolean);
    if (parts[0] !== "app" || parts[1] !== "welcome") return null;
    const named = (parts[2] || "hello") as WelcomeStage;
    const id = new URLSearchParams(loc.search).get("id");
    const name = id && /^[a-z0-9_-]{1,40}$/i.test(id) ? id : null;
    const next: WelcomeStage = STAGES.includes(named) ? named : "hello";
    return { stage: next === "connect" && !name ? "hello" : next, agent: name };
  }

  function shell(): HTMLElement[] {
    return [document.querySelector("header"), document.getElementById("view"), document.querySelector(".tabbar")].filter(
      (el): el is HTMLElement => el instanceof HTMLElement
    );
  }

  // Hello's three ways on: a provider (straight to Meet when it already works), the
  // "I don't have one yet" explainer, and "Look around first".
  function onHelloClick(event: Event): void {
    if (stage !== "hello" || !root) return;
    const target = event.target instanceof Element ? event.target : null;
    const pick = target?.closest<HTMLElement>("[data-wel-pick]")?.dataset.welPick;
    if (pick) {
      const p = CairnCoachLink.peek()?.providers.find((x) => x.name === pick);
      go(p?.usable ? "meet" : "connect", pick);
      return;
    }
    const none = target?.closest<HTMLButtonElement>("[data-wel-none]");
    if (none) {
      const box = root.querySelector<HTMLElement>("#welNone");
      if (!box) return;
      box.hidden = !box.hidden;
      none.setAttribute("aria-expanded", String(!box.hidden));
      if (!box.hidden) box.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
      return;
    }
    if (target?.closest("[data-wel-skip]")) close({ markOnboarded: true });
    if (target?.closest("[data-wel-reload]")) go("hello", null, { replace: true });
  }

  function ensureRoot(): HTMLElement {
    if (root && root.isConnected) return root;
    const el = document.createElement("div");
    el.id = "welcome";
    el.className = "wel";
    el.setAttribute("role", "region");
    el.setAttribute("aria-label", "Welcome to Cairn");
    el.addEventListener("click", onHelloClick);
    document.body.appendChild(el);
    document.body.classList.add("welcome-open");
    document.body.classList.remove("welcome-pending");
    // The app behind the stage is out of reach until the welcome is left.
    for (const node of shell()) node.setAttribute("inert", "");
    root = el;
    return el;
  }

  function providerFor(model: CoachLinkModel | null, name: string | null): CoachLinkProvider | null {
    if (!model) return null;
    if (name) {
      const hit = model.providers.find((p) => p.name === name);
      if (hit) return hit;
    }
    return model.usable[0] || null;
  }

  // A provider the model does not know yet (a cold open of /app/welcome/connect?id=x).
  function placeholder(name: string): CoachLinkProvider {
    const loginModel = (globalThis as { CairnAgentLoginModel?: AgentLoginModelApi }).CairnAgentLoginModel;
    const label = loginModel?.label(name) || name;
    return { name, label, plan: "", usable: false, present: false, installable: false, canLogin: false, configured: null };
  }

  function focusHeading(el: HTMLElement): void {
    const h = el.querySelector<HTMLElement>("h1");
    try {
      h?.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
    } catch {
      h?.focus();
    }
  }

  function paint(next: WelcomeStage, name: string | null, model: CoachLinkModel | null): void {
    const el = ensureRoot();
    teardown?.();
    teardown = null;
    stage = next;
    agent = name;
    el.dataset.stage = next;
    el.scrollTop = 0;
    if (next === "hello") {
      el.innerHTML = CairnWelcomeClient.helloHtml(model?.providers || [], !model && unreachable);
    } else if (next === "connect") {
      const p = providerFor(model, name) || placeholder(name || "");
      el.innerHTML = CairnWelcomeClient.connectHtml(p);
      const pane = el.querySelector<HTMLElement>(".wel-connect");
      if (pane) {
        teardown = CairnWelcomeConnect.mount(pane, {
          provider: p,
          onSwitch: () => go("hello", null),
          onConnected: (ready) => go("meet", ready.name, { replace: true }),
        });
      }
    } else {
      const p = providerFor(model, name);
      el.innerHTML = CairnWelcomeClient.meetHtml(p);
      const pane = el.querySelector<HTMLElement>(".wel-meet");
      if (pane) {
        teardown = CairnWelcomeMeet.mount(pane, {
          provider: p,
          onReconnect: () => go("connect", p?.name || name || null),
          onDone: () => close({ markOnboarded: true }),
          onSkip: () => close({ markOnboarded: true }),
        });
      }
    }
    focusHeading(el);
  }

  function show(next: WelcomeStage, name: string | null): void {
    const seq = ++paintSeq;
    const peeked = CairnCoachLink.peek();
    const swap = (model: CoachLinkModel | null) => () => paint(next, name, model);
    const reading = CairnCoachLink.read();
    if (!peeked) {
      // A true cold start: never paint an empty provider list; wait for the server.
      ensureRoot();
      void reading.then((model) => {
        unreachable = !model;
        if (!model) CairnWelcomeModel.reportFailure("hello", null, "unreachable");
        if (seq === paintSeq) swap(model)();
      });
      return;
    }
    if (root && root.dataset.stage && typeof withViewTransition === "function") void withViewTransition(swap(peeked));
    else swap(peeked)();
    // Hello lists the providers: the remembered list first, then the server's own,
    // swapping only the list so the hero does not settle twice. Connect and Meet
    // re-read inside their controllers.
    void reading.then((model) => {
      if (seq !== paintSeq || !root || stage !== next || next !== "hello" || !model) return;
      if (JSON.stringify(model.providers) === JSON.stringify(peeked.providers)) return;
      const list = root.querySelector(".wel-provs, .wel-empty");
      const fresh = document.createElement("template");
      fresh.innerHTML = CairnWelcomeClient.helloHtml(model.providers);
      const replacement = fresh.content.querySelector(".wel-provs, .wel-empty");
      if (list && replacement) list.replaceWith(replacement);
    });
  }

  function go(next: WelcomeStage, name: string | null, opts: { replace?: boolean } = {}): void {
    try {
      history[opts.replace ? "replaceState" : "pushState"]({ cairn: true, welcome: 1 }, "", urlFor(next, name));
    } catch {}
    show(next, name);
  }

  function open(opts: WelcomeOpenOptions = {}): void {
    const next: WelcomeStage = opts.stage && STAGES.includes(opts.stage) ? opts.stage : "hello";
    const name = opts.agent || null;
    if (root && stage === next && agent === name) return;
    go(next === "connect" && !name ? "hello" : next, name, { replace: !!opts.replace });
  }

  function dismantle(): void {
    paintSeq++;
    teardown?.();
    teardown = null;
    root?.remove();
    root = null;
    document.body.classList.remove("welcome-open", "welcome-pending");
    for (const node of shell()) node.removeAttribute("inert");
  }

  function close(opts: { markOnboarded?: boolean } = {}): void {
    if (opts.markOnboarded) {
      try {
        localStorage.setItem("cairn.onboarded", "1");
      } catch {}
      void api("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ onboarded: true }),
      })
        .then(() => CairnCoachLink.invalidate())
        .catch(() => {});
    }
    dismantle();
    // Whatever the welcome put in place (a week, a fuel target, a profile) is new
    // truth for Today: drop the remembered copies before it paints.
    state.plan = [];
    state.day = null;
    state.dayPicked = false;
    state.dayPickedOn = null;
    ["plan", "profile", "stats", "progress:weight", "progress:energy", "supplements", "memory", "coach-link"].forEach(swrInvalidate);
    swrInvalidate("today:session:");
    if (typeof hideSaveBar === "function") hideSaveBar();
    activateTab("today", { replace: true });
  }

  function popped(): boolean {
    const target = parse(location);
    if (target) {
      // Back/Forward between stages: the stage follows the address.
      show(target.stage, target.agent);
      return true;
    }
    // Back past the welcome: leave it quietly and let the app take the address.
    if (root) dismantle();
    return false;
  }

  const CAIRN_WELCOME: WelcomeApi = {
    open,
    close,
    isOpen: () => !!root,
    popped,
  };

  Object.assign(globalThis, { CairnWelcome: CAIRN_WELCOME, CairnWelcomeRoute: { parse } });
})();
