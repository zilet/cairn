// @ts-check
// ==== 01-core.js ====
{
    const query = (selector) => document.querySelector(selector);
    const appView = (() => {
        const el = query("#view");
        if (!el)
            throw new Error("Missing #view app root");
        return el;
    })();
    const appHeaderTitle = (() => {
        const el = query("#header-title");
        if (!el)
            throw new Error("Missing #header-title");
        return el;
    })();
    const appState = { tab: "today", day: null, dayPicked: false, plan: [], today: {}, logDate: localISO() };
    // Classic client scripts read these names directly. Defining them as explicit
    // globalThis properties avoids relying on cross-file lexical declarations.
    Object.assign(globalThis, { $: query, view: appView, headerTitle: appHeaderTitle, state: appState });
}
