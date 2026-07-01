(() => {
// @ts-check
// Lazy xterm asset loading for the in-app agent-login terminal.
(() => {
    let xtermAssets = null;
    function agentLoginXtermWindow() {
        return window;
    }
    function loadAgentLoginScript(src) {
        return new Promise((resolve, reject) => {
            let el = document.querySelector(`script[data-xterm-src="${src}"]`);
            if (el) {
                el.addEventListener("load", () => resolve());
                el.addEventListener("error", () => reject(new Error("load " + src)));
                if (el.dataset.loaded)
                    resolve();
                return;
            }
            el = document.createElement("script");
            el.src = src;
            el.async = false;
            el.setAttribute("data-xterm-src", src);
            el.addEventListener("load", () => { el.dataset.loaded = "1"; resolve(); });
            el.addEventListener("error", () => reject(new Error("load " + src)));
            document.head.appendChild(el);
        });
    }
    function loadAgentLoginXtermAssets() {
        if (xtermAssets)
            return xtermAssets;
        xtermAssets = new Promise((resolve, reject) => {
            try {
                if (!document.querySelector('link[data-xterm-css]')) {
                    const link = document.createElement("link");
                    link.rel = "stylesheet";
                    link.href = "/vendor/xterm.css";
                    link.setAttribute("data-xterm-css", "1");
                    document.head.appendChild(link);
                }
                const globals = agentLoginXtermWindow();
                if (globals.Terminal && globals.FitAddon) {
                    resolve();
                    return;
                }
                loadAgentLoginScript("/vendor/xterm.js")
                    .then(() => loadAgentLoginScript("/vendor/xterm-addon-fit.js"))
                    .then(() => resolve())
                    .catch(reject);
            }
            catch (error) {
                reject(error);
            }
        });
        return xtermAssets;
    }
    const CAIRN_AGENT_LOGIN_ASSETS = {
        globals: agentLoginXtermWindow,
        load: loadAgentLoginXtermAssets,
    };
    Object.assign(globalThis, { CairnAgentLoginAssets: CAIRN_AGENT_LOGIN_ASSETS });
    if (typeof window !== "undefined") {
        Object.assign(window, { CairnAgentLoginAssets: CAIRN_AGENT_LOGIN_ASSETS });
    }
})();
})();
