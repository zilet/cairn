// @ts-check
// First run: decide, at boot, whether the welcome opens.
//
// The welcome itself (welcome-*.ts, the lazy "welcome" bundle) is a full-screen
// stage, not a form: it gets the person to connect the AI they already use, then the
// real coach says hello and puts a first week and a starting fuel target in place.
// This module only decides when it opens:
//   - not onboarded yet      → the welcome, at Hello — or straight at Meet when an AI
//                               is already usable (a server its owner set up);
//   - a /app/welcome address → that stage, whatever the onboarding state (a reload, a
//                               "say hello" link);
//   - otherwise              → nothing; Today's coach line carries the rest.
// openOnboarding() (older callers) opens the welcome at Hello.
{
  // The landing address, read before the shell canonicalises it to a home.
  const LANDING: { pathname: string; search: string } =
    typeof location !== "undefined" ? { pathname: location.pathname, search: location.search } : { pathname: "/", search: "" };
  const KNOWN_KEY = "cairn.onboarded";

  function knownOnboarded(): boolean {
    try {
      return localStorage.getItem(KNOWN_KEY) === "1";
    } catch {
      return false;
    }
  }

  // A browser that has never seen this install onboarded keeps the app shell hidden
  // until the boot decision lands, so a first open never flashes Today before the
  // welcome covers it. A fail-safe lifts it whatever happens.
  if (typeof document !== "undefined" && document.body && !knownOnboarded()) {
    document.body.classList.add("welcome-pending");
    setTimeout(() => document.body.classList.remove("welcome-pending"), 4000);
  }

  function landingStage(): WelcomeOpenOptions | null {
    const parts = LANDING.pathname.toLowerCase().split("/").filter(Boolean);
    if (parts[0] !== "app" || parts[1] !== "welcome") return null;
    const stage = parts[2] === "connect" || parts[2] === "meet" ? parts[2] : "hello";
    const id = new URLSearchParams(LANDING.search).get("id");
    return { stage, agent: id || null };
  }

  async function maybeOnboard(): Promise<void> {
    let data: unknown = null;
    try {
      data = await api("/settings");
      const settings = (data as { settings?: Record<string, unknown> } | null)?.settings;
      if (settings && "art_enabled" in settings) artEnabled = !!settings.art_enabled;
    } catch {
      data = null;
    }
    const model = data ? CairnCoachLink.model(data) : null;
    if (model) swrSet(CairnCoachLink.KEY, model);
    const landing = landingStage();
    if (landing) {
      CairnCoachLink.openWelcome({ ...landing, replace: true });
      return;
    }
    // Unknown (offline) reads as onboarded: never trap someone in a welcome.
    if (!model || model.onboarded) {
      try {
        if (model) localStorage.setItem(KNOWN_KEY, "1");
      } catch {}
      document.body.classList.remove("welcome-pending");
      return;
    }
    const ready = model.usable[0];
    CairnCoachLink.openWelcome(ready ? { stage: "meet", agent: ready.name, replace: true } : { stage: "hello", replace: true });
  }

  function openOnboarding(): void {
    CairnCoachLink.openWelcome({ stage: "hello" });
  }

  Object.assign(globalThis, { maybeOnboard, openOnboarding });

  if (typeof window !== "undefined") {
    window.maybeOnboard = maybeOnboard;
    window.openOnboarding = openOnboarding;
  }
}
