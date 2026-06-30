(() => {
// @ts-check
// Calm PWA install guidance used by Today and Settings.
(() => {
    let deferredInstallPrompt = null;
    try {
        window.addEventListener("beforeinstallprompt", (event) => {
            event.preventDefault();
            deferredInstallPrompt = event;
            refreshPhoneCoach();
        });
        window.addEventListener("appinstalled", () => {
            deferredInstallPrompt = null;
            try {
                localStorage.setItem("cairn_phone_coach_dismissed", "1");
            }
            catch { }
            document.querySelectorAll(".phone-coach").forEach((el) => el.remove());
        });
    }
    catch { }
    function isStandalonePWA() {
        try {
            if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)
                return true;
            if (navigator.standalone)
                return true;
        }
        catch { }
        return false;
    }
    function getInstallGuidance() {
        if (isStandalonePWA())
            return null;
        if (deferredInstallPrompt)
            return { mode: "prompt" };
        const ua = navigator.userAgent || "";
        const maxTouch = navigator.maxTouchPoints || 0;
        const isIOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouch > 1);
        const isAndroid = /Android/.test(ua);
        const isChromium = /\b(Chrome|Chromium|CriOS|Edg|EdgA|OPR|SamsungBrowser)\b/.test(ua);
        const isMacSafari = /Macintosh/.test(ua) && maxTouch === 0 && /Version\/.+Safari/.test(ua) && !isChromium;
        if (isIOS)
            return { mode: "ios" };
        if (isMacSafari)
            return { mode: "safari-desktop" };
        if (isChromium)
            return { mode: "chromium-menu" };
        if (isAndroid)
            return { mode: "menu-generic" };
        return null;
    }
    function phoneCoachContent(mode) {
        const dismiss = `<button class="ghostbtn phone-coach-dismiss" type="button">Got it</button>`;
        if (mode === "prompt") {
            return `
      <div class="sess-line"><b>Install Cairn as an app</b> — it opens in its own window, instantly.</div>
      <div class="sess-line phone-coach-sub">Your training data still lives on your Cairn server; the app is just a faster shell.</div>
      <div class="phone-coach-actions">
        <button class="phone-coach-install" type="button">Install Cairn</button>
        ${dismiss}
      </div>`;
        }
        if (mode === "ios") {
            return `
      <div class="sess-line"><b>Add Cairn to your home screen</b> — it opens like a real app, instantly.</div>
      <div class="sess-line phone-coach-sub">
        Tap <b>Share</b> → <b>Add to Home Screen</b>. HTTPS (Tailscale Serve) works best on iOS.
        Logging and a fresh Brief still need your Cairn server reachable.
      </div>
      <div class="phone-coach-actions">${dismiss}</div>`;
        }
        if (mode === "safari-desktop") {
            return `
      <div class="sess-line"><b>Add Cairn to your Dock</b> — it opens in its own window.</div>
      <div class="sess-line phone-coach-sub">In Safari: <b>File</b> → <b>Add to Dock</b>.</div>
      <div class="phone-coach-actions">${dismiss}</div>`;
        }
        if (mode === "menu-generic") {
            return `
      <div class="sess-line"><b>Add Cairn to your home screen</b> — it opens like a real app.</div>
      <div class="sess-line phone-coach-sub">
        Open your browser menu → <b>Install</b> / <b>Add to Home Screen</b>.
        Logging and a fresh Brief still need your Cairn server reachable.
      </div>
      <div class="phone-coach-actions">${dismiss}</div>`;
        }
        return `
    <div class="sess-line"><b>Install Cairn as an app</b> — it opens in its own window.</div>
    <div class="sess-line phone-coach-sub">Click the install icon in the address bar, or your browser menu → <b>Install Cairn</b>.</div>
    <div class="phone-coach-actions">${dismiss}</div>`;
    }
    function wirePhoneCoach(el) {
        const dismissBtn = el.querySelector(".phone-coach-dismiss");
        if (dismissBtn) {
            dismissBtn.addEventListener("click", () => {
                try {
                    localStorage.setItem("cairn_phone_coach_dismissed", "1");
                }
                catch { }
                el.remove();
            });
        }
        const installBtn = el.querySelector(".phone-coach-install");
        if (installBtn) {
            installBtn.addEventListener("click", async () => {
                const prompt = deferredInstallPrompt;
                if (!prompt) {
                    refreshPhoneCoach();
                    return;
                }
                installBtn.disabled = true;
                try {
                    prompt.prompt?.();
                    await prompt.userChoice;
                }
                catch { }
                deferredInstallPrompt = null;
                if (document.body.contains(el))
                    refreshPhoneCoach();
            });
        }
    }
    function renderPhoneCoachBanner(container) {
        if (!container || isStandalonePWA())
            return;
        if (localStorage.getItem("cairn_phone_coach_dismissed") === "1")
            return;
        if (container.querySelector(".phone-coach"))
            return;
        const guidance = getInstallGuidance();
        if (!guidance)
            return;
        const el = document.createElement("div");
        el.className = "sess phone-coach";
        el.dataset.coachMode = guidance.mode;
        el.innerHTML = phoneCoachContent(guidance.mode);
        wirePhoneCoach(el);
        container.append(el);
    }
    function refreshPhoneCoach() {
        try {
            document.querySelectorAll(".phone-coach").forEach((el) => {
                if (isStandalonePWA() || localStorage.getItem("cairn_phone_coach_dismissed") === "1") {
                    el.remove();
                    return;
                }
                const guidance = getInstallGuidance();
                if (!guidance) {
                    el.remove();
                    return;
                }
                if (el.dataset.coachMode === guidance.mode)
                    return;
                el.dataset.coachMode = guidance.mode;
                el.innerHTML = phoneCoachContent(guidance.mode);
                wirePhoneCoach(el);
            });
        }
        catch { }
    }
    const CAIRN_PWA_INSTALL = {
        isStandalonePWA,
        getInstallGuidance,
        phoneCoachContent,
        renderPhoneCoachBanner,
        refreshPhoneCoach,
    };
    Object.assign(globalThis, {
        CairnPwaInstall: CAIRN_PWA_INSTALL,
        isStandalonePWA,
        getInstallGuidance,
        phoneCoachContent,
        renderPhoneCoachBanner,
        refreshPhoneCoach,
    });
    if (typeof window !== "undefined") {
        Object.assign(window, {
            CairnPwaInstall: CAIRN_PWA_INSTALL,
            isStandalonePWA,
            getInstallGuidance,
            phoneCoachContent,
            renderPhoneCoachBanner,
            refreshPhoneCoach,
        });
    }
})();
})();
