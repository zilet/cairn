// @ts-check
// ==== 01-core.js ====
{
  const query = <T extends Element = Element>(selector: string): T | null => document.querySelector<T>(selector);

  const appView = (() => {
    const el = query<HTMLElement>("#view");
    if (!el) throw new Error("Missing #view app root");
    return el;
  })();

  const appHeaderTitle = (() => {
    const el = query<HTMLElement>("#header-title");
    if (!el) throw new Error("Missing #header-title");
    return el;
  })();

  const appState: ClientAppState = { tab: "today", day: null, dayPicked: false, plan: [], today: {}, logDate: localISO() };

  // Classic client scripts read these names directly. Defining them as explicit
  // globalThis properties avoids relying on cross-file lexical declarations.
  Object.assign(globalThis, { $: query, view: appView, headerTitle: appHeaderTitle, state: appState });
}
