// @ts-check
// "Send feedback" (Settings -> Data and Settings -> System): a calm sheet on the shared
// overlay primitive. Kind chips, the person's own words, an optional contact, and an
// opt-in "Include anonymous diagnostics" whose preview shows exactly the snapshot the
// server would attach (GET /feedback/preview — version, platform, coalesced error
// fingerprints; never health data, chat text or names). With no feedback service the
// server hands back a prefilled GitHub issue URL, and this sheet opens it instead.

type SettingsFeedbackApi = (
  path: string,
  opts?: RequestInit & { headers?: Record<string, string>; acceptErrorBody?: boolean }
) => Promise<unknown>;

type SettingsFeedbackDeps = {
  api: SettingsFeedbackApi;
  toast?: (message: string) => unknown;
  /** Injected in tests; the browser opens a new tab. */
  openWindow?: (url: string) => Window | null;
};

const SETTINGS_FEEDBACK_KINDS: Array<[string, string]> = [
  ["bug", "Something's broken"],
  ["idea", "An idea"],
  ["praise", "Something I like"],
  ["other", "Something else"],
];

function settingsFeedbackRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function feedbackSheetHtml(): string {
  const chips = SETTINGS_FEEDBACK_KINDS.map(
    ([kind, label], index) =>
      `<button class="fbk-chip" type="button" aria-pressed="${index === 0 ? "true" : "false"}" data-fbk-kind="${escAttr(kind)}">${escHtml(label)}</button>`
  ).join("");
  return `<div class="fbk-hd"><h2 class="fbk-h" id="fbkTitle">Send feedback</h2><button class="xbtn fbk-x" type="button" data-ui-sheet-close aria-label="Close">✕</button></div>
    <div class="fbk-body">
      <p class="fbk-p" id="fbkLede">Tell the people who make Cairn what's working, what isn't, or what you wish it did.</p>
      <div class="fbk-kinds" role="group" aria-label="Kind of feedback">${chips}</div>
      <label class="fbk-lbl" for="fbkMsg">Your message</label>
      <textarea id="fbkMsg" class="fbk-in fbk-msg" rows="5" maxlength="4000"></textarea>
      <label class="fbk-lbl" for="fbkContact">Email or handle <span class="fbk-opt">optional, for a reply</span></label>
      <input id="fbkContact" class="fbk-in" type="text" maxlength="200" autocomplete="email" autocapitalize="none" spellcheck="false">
      <label class="toggle fbk-diag"><input type="checkbox" id="fbkDiag"><span>Include anonymous diagnostics</span></label>
      <details class="fbk-preview">
        <summary>Exactly what this adds</summary>
        <p class="fbk-note">Cairn's version, the host platform, and its own coalesced error counts — never health data, chat text or names.</p>
        <pre class="fbk-pre" id="fbkPre">Loading…</pre>
      </details>
      <p class="fbk-note fbk-dest" hidden></p>
      <div class="fbk-err" role="alert" hidden></div>
      <div class="fbk-ft"><button class="ghostbtn" type="button" data-ui-sheet-close>Cancel</button><button class="logbtn" type="button" data-fbk-send>Send</button></div>
    </div>`;
}

// What the sheet says once the message has gone (or is ready on GitHub).
function feedbackDoneHtml(result: Record<string, unknown>, opened: boolean): string {
  const url = typeof result.url === "string" ? result.url : "";
  if (!url) {
    return `<p class="fbk-p">${escHtml(String(result.message || "Thanks — your feedback was sent."))}</p>
      <div class="fbk-ft"><button class="logbtn" type="button" data-ui-sheet-close>Done</button></div>`;
  }
  const lede =
    result.method === "github" && result.ok
      ? opened
        ? "A prefilled GitHub issue opened in a new tab. Review it there, then submit."
        : "Your message is ready as a prefilled GitHub issue. Open it, review it, then submit."
      : `${escHtml(String(result.error || "The feedback service couldn't take it right now."))} You can send it as a GitHub issue instead.`;
  return `<p class="fbk-p">${lede}</p>
    <div class="fbk-ft"><button class="ghostbtn" type="button" data-ui-sheet-close>Close</button><a class="logbtn fbk-gh" href="${escAttr(url)}" target="_blank" rel="noopener noreferrer">Open the GitHub issue</a></div>`;
}

function openFeedbackSheet(deps: SettingsFeedbackDeps): void {
  if (typeof document === "undefined" || typeof CairnUiSheet === "undefined") return;
  if (document.querySelector(".fbk-sheet")) return;
  const handle = CairnUiSheet.open({
    sheetClass: "ui-sheet fbk-sheet",
    labelledBy: "fbkTitle",
    describedBy: "fbkLede",
    initialFocus: "#fbkMsg",
    html: feedbackSheetHtml(),
  });
  const sheet = handle.sheet;
  const body = sheet.querySelector<HTMLElement>(".fbk-body");
  const pre = sheet.querySelector<HTMLElement>("#fbkPre");
  const dest = sheet.querySelector<HTMLElement>(".fbk-dest");
  const err = sheet.querySelector<HTMLElement>(".fbk-err");
  const send = sheet.querySelector<HTMLButtonElement>("[data-fbk-send]");
  const message = sheet.querySelector<HTMLTextAreaElement>("#fbkMsg");
  if (!body || !pre || !dest || !err || !send || !message) return;
  let kind = SETTINGS_FEEDBACK_KINDS[0][0];

  sheet.querySelectorAll<HTMLButtonElement>("[data-fbk-kind]").forEach((chip) =>
    chip.addEventListener("click", () => {
      kind = chip.dataset.fbkKind || "other";
      sheet
        .querySelectorAll<HTMLButtonElement>("[data-fbk-kind]")
        .forEach((other) => other.setAttribute("aria-pressed", other === chip ? "true" : "false"));
    })
  );

  // The preview is the server's own snapshot, printed as text (never markup).
  deps
    .api("/feedback/preview")
    .then((value) => {
      const preview = settingsFeedbackRecord(value);
      if (!preview || !pre.isConnected) return;
      pre.textContent = JSON.stringify(preview.diagnostics ?? {}, null, 2);
      if (preview.destination === "github") {
        dest.textContent =
          "No feedback service is set up for this Cairn, so sending opens a prefilled GitHub issue you can review before submitting. Your contact stays out of it.";
        dest.hidden = false;
      }
    })
    .catch(() => {
      if (pre.isConnected) pre.textContent = "The preview isn't available right now.";
    });

  send.addEventListener("click", async () => {
    const text = message.value.trim();
    if (!text) {
      err.textContent = "Write a few words first.";
      err.hidden = false;
      message.focus();
      return;
    }
    err.hidden = true;
    send.disabled = true;
    send.textContent = "Sending…";
    const payload = {
      kind,
      message: text,
      contact: (sheet.querySelector<HTMLInputElement>("#fbkContact")?.value || "").trim(),
      include_diagnostics: !!sheet.querySelector<HTMLInputElement>("#fbkDiag")?.checked,
    };
    let result: Record<string, unknown> | null = null;
    try {
      result = settingsFeedbackRecord(
        await deps.api("/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          acceptErrorBody: true,
        })
      );
    } catch {
      result = null;
    }
    if (!body.isConnected) return;
    if (!result || (!result.ok && typeof result.url !== "string")) {
      err.textContent = String(result?.error || "Couldn't send that just now. Your message is still here — try again.");
      err.hidden = false;
      send.disabled = false;
      send.textContent = "Send";
      return;
    }
    if (result.ok && result.method === "service") {
      deps.toast?.("Thanks — feedback sent");
      handle.close({ reason: "api" });
      return;
    }
    let opened = false;
    if (result.ok && typeof result.url === "string") {
      const win = (deps.openWindow || ((url: string) => window.open(url, "_blank")))(result.url);
      if (win) {
        try {
          win.opener = null;
        } catch {}
        opened = true;
      }
    }
    body.innerHTML = feedbackDoneHtml(result, opened);
  });
}

const CAIRN_SETTINGS_FEEDBACK = {
  feedbackSheetHtml,
  feedbackDoneHtml,
  open: openFeedbackSheet,
};

Object.assign(globalThis, { CairnSettingsFeedback: CAIRN_SETTINGS_FEEDBACK });
