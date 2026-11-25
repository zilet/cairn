// @ts-check
type ViewportProbeEnv = {
  softKeyboard: () => boolean;
  vvMax: () => number;
  threshold: () => number;
  visibleTop: (vv: VisualViewport) => number;
  textInput: (el: EventTarget | Element | null | undefined) => boolean;
};
declare const CairnViewportProbe:
  | {
      viewportAnomalies(input: object): string[];
      createAnomalyLimiter(perCodeMs?: number, maxReports?: number): { admit(codes: readonly string[], now: number): string[] };
      install(vv: VisualViewport, env: ViewportProbeEnv): () => void;
    }
  | undefined;

{
  // The viewport probe: REPORT-ONLY evidence for a blank Session (installed by
  // app/mobile-viewport.ts, which hands it its own measurements).
  // On an installed iPhone PWA the Session screen has gone blank (and the fixed rest bar
  // adrift) after a return to the app, with nothing recorded. This watches for that shape
  // and sends ONE warning through the client diagnostics pipeline; it never touches
  // layout, scroll, focus, classes or styles: every read below is a measurement.
  // The decision is pure (numbers and booleans in, anomaly codes out) so it is testable
  // without a DOM; the sampler further down only gathers the inputs.
  type ProbeRect = { top: number; bottom: number; left?: number; right?: number };
  type ViewportProbeInput = {
    visible: boolean; // the document is visible
    softKeyboard: boolean; // a touch device: only there does a stuck viewport mean anything
    textFocused: boolean;
    msSinceFocusout: number | null; // null: no text field has been left this page life
    scale: number;
    offsetTop: number; // visualViewport.offsetTop
    visTop: number; // pageTop - scrollY: where the visible area starts in rect coordinates
    vvb: number; // the resolved --vvb, px
    standalone: boolean;
    vvHeight: number;
    vvMax: number; // the tallest visual viewport seen
    threshold: number; // the keyboard-open threshold
    kbUp: boolean; // html.kb-up
    sessionSurface: boolean; // .sess-dest exists and the tab is "session"
    centerBlank: boolean; // elementFromPoint at the centre is html/body/null
    quarterBlank: boolean; // the same, a quarter down
    sessInBand: boolean; // .sess-dest's rect meets the visible band
    restShown: boolean; // .rest.show is displayed, not stepped away by kb-up
    rest: ProbeRect | null;
    band: ProbeRect; // the visual viewport in rect coordinates
  };
  function viewportAnomalies(i: ViewportProbeInput): string[] {
    const out: string[] = [];
    const h = i.band.bottom - i.band.top;
    if (!i.visible || !i.softKeyboard || !(h > 0)) return out;
    // No field and the keyboard has had a second to go: only then is a displaced viewport
    // or a lingering kb-up wrong rather than mid-animation.
    const idle = !i.textFocused && (i.msSinceFocusout === null || i.msSinceFocusout >= 1000);
    if (i.sessionSurface && ((i.centerBlank && i.quarterBlank) || !i.sessInBand)) out.push("blank_surface");
    if (idle && i.scale <= 1.05 && (i.offsetTop > 2 || i.visTop > 2 || (i.standalone && i.vvb > 40) || i.vvMax - i.vvHeight > i.threshold)) out.push("viewport_stuck");
    if (i.restShown && i.rest && (i.rest.top < i.band.top + (h * 2) / 3 - 2 || i.rest.bottom > i.band.bottom + 2)) out.push("rest_bar_adrift");
    if (idle && i.kbUp) out.push("kb_up_stale");
    return out;
  }

  // At most one report per code a minute and a handful a page life, so a stuck state
  // cannot flood the diagnostics table.
  function createAnomalyLimiter(perCodeMs = 60_000, maxReports = 6) {
    const last: Record<string, number> = {};
    let sent = 0;
    return {
      admit(codes: readonly string[], now: number): string[] {
        const ok = sent < maxReports ? codes.filter((c) => !(c in last) || now - last[c] >= perCodeMs) : [];
        for (const c of ok) last[c] = now;
        if (ok.length) sent += 1;
        return ok;
      },
    };
  }

  // What the probe borrows from the viewport guards: their own measurements, never a copy.
  type ProbeEnv = ViewportProbeEnv;

  // The sampler: reads the page and returns what the pure decision needs plus the report's
  // payload. It writes nothing. The payload is plain numbers in a fixed order (documented on
  // the server's VIEWPORT_PROBE_KEYS): vv = width height offsetTop pageTop scale*100;
  // win = innerHeight scrollY scrollHeight --vvb --vvt; sess/rest = top bottom left right.
  function viewportSample(vv: VisualViewport, env: ProbeEnv, msSinceFocusout: number | null, since: number) {
    const vvMax = env.vvMax();
    const threshold = env.threshold();
    const root = document.documentElement;
    const nums = (...a: number[]) => a.map((x) => ~~x).join(" ");
    const css = (name: string) => parseFloat(root.style.getPropertyValue(name)) || 0;
    const box = (r?: ProbeRect | null) => (r ? nums(r.top, r.bottom, r.left!, r.right!) : "none");
    const visTop = env.visibleTop(vv);
    const band = { top: visTop, bottom: visTop + vv.height };
    const active = document.activeElement;
    const textFocused = env.textInput(active);
    const sess = document.querySelector(".sess-dest");
    const sessionSurface = !!sess && state.tab === "session";
    const at = (f: number) => (sessionSurface ? document.elementFromPoint(vv.width / 2, visTop + vv.height * f) : null);
    const blank = (el: Element | null) => !el || el === root || el === document.body;
    const centre = at(0.5);
    const sessBox = sess?.getBoundingClientRect();
    const restEl = document.querySelector(".rest");
    const rest = restEl?.getBoundingClientRect();
    const kbUp = root.classList.contains("kb-up");
    const restShown = !!rest && rest.bottom > rest.top && restEl!.classList.contains("show") && !kbUp && getComputedStyle(restEl!).visibility !== "hidden";
    const vvb = css("--vvb");
    const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
    const cls = document.body.classList;
    return {
      found: viewportAnomalies({
        visible: true, softKeyboard: true, textFocused, msSinceFocusout, scale: vv.scale, offsetTop: vv.offsetTop, visTop, vvb, standalone,
        vvHeight: vv.height, vvMax, threshold, kbUp, sessionSurface, restShown, band, rest: restShown ? rest! : null,
        centerBlank: blank(centre), quarterBlank: blank(at(0.25)),
        sessInBand: !sessBox || (sessBox.bottom > band.top && sessBox.top < band.bottom),
      }),
      // Metadata only: numbers, flags and tag names. No field value, name or text.
      viewport: {
        vv: nums(vv.width, vv.height, vv.offsetTop, vv.pageTop, vv.scale * 100),
        win: nums(innerHeight, scrollY, root.scrollHeight, vvb, css("--vvt")),
        flags: [kbUp && "kb-up", ...["kb-open", "kb-geometry-open", "resting"].filter((c) => cls.contains(c)), textFocused && (active?.closest(".sess-dest") ? "in-session" : "text"), standalone && "standalone"].filter(Boolean).join(" ") || "none",
        hit: centre ? `${centre.tagName.toLowerCase()}.${(centre.getAttribute("class") || "").split(" ")[0].replace(/[^\w-]/g, "")}` : "none",
        sess: box(sessBox),
        rest: box(restShown ? rest : null),
        since,
      } as Record<string, string | number>,
    };
  }

  // Debounced: focus in/out and a resume ask after a second, a viewport resize after a
  // second and a half. The returned function is the resize ask, called from the caller's
  // own visualViewport resize handler so no listener is added.
  function installViewportProbe(vv: VisualViewport, env: ProbeEnv): () => void {
    const limiter = createAnomalyLimiter();
    let timer: ReturnType<typeof setTimeout> | 0 = 0;
    let visibleAt = Date.now();
    let focusoutAt = 0;
    const sample = () => {
      timer = 0;
      if (document.visibilityState !== "visible" || !env.softKeyboard()) return;
      try {
        const now = Date.now();
        const r = viewportSample(vv, env, focusoutAt ? now - focusoutAt : null, now - visibleAt);
        const codes = limiter.admit(r.found, now);
        if (codes.length) (globalThis as { CairnClientDiagnostics?: { report(input: object): boolean } }).CairnClientDiagnostics?.report({ kind: "viewport_anomaly", level: "warning", message: `viewport anomaly ${codes.join(" ")}`, viewport: { ...r.viewport, codes: codes.join(" ") } });
      } catch {
        // a probe must never be a failure of its own
      }
    };
    const request = (delay: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(sample, delay);
    };
    const resumed = () => { visibleAt = Date.now(); request(1000); };
    document.addEventListener("focusin", (e) => { if (env.textInput(e.target)) request(1000); }, true);
    document.addEventListener("focusout", (e) => { if (env.textInput(e.target)) { focusoutAt = Date.now(); request(1000); } }, true);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") resumed(); });
    window.addEventListener("pageshow", resumed);
    return () => request(1500);
  }

  Object.assign(globalThis, {
    CairnViewportProbe: { viewportAnomalies, createAnomalyLimiter, install: installViewportProbe },
  });
}
