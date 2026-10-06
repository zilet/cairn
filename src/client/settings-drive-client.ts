// @ts-check
// Settings → Automation: the TRAINING DRIVE card (Steady / Push, always dated). Pure: it
// frames the finished server read from GET /api/training-drive
// (src/contracts/training-drive.ts) and the controller's small UI state, fetches nothing
// and wires nothing (settings-drive-controller.ts owns loading and the PUT).
//
// The card shows the drive IN FORCE (`drive`), never the bare standing toggle: a push
// that has run out reads steady here, with its end said, so choosing Push again opens a
// new dated stance instead of looking like it is already on. Plain words only — dates
// and a day count, never a score.
{
  type DriveRead = import("../contracts/training-drive.js").ClientTrainingDriveRead;

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
  /** A push runs at most this long before the athlete re-states it (PUSH_STANCE_MAX_DAYS). */
  const MAX_DAYS = 84;

  const UNTIL_CHOICES: ReadonlyArray<[SettingsDriveUntilChoice, string]> = [
    ["block", "This block"],
    ["two_weeks", "2 weeks"],
    ["four_weeks", "4 weeks"],
    ["date", "Pick a date"],
  ];

  function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
  }

  function validIso(value: unknown): string {
    const raw = text(value).slice(0, 10);
    const m = ISO.exec(raw);
    if (!m) return "";
    const d = new Date(`${raw}T00:00:00Z`);
    return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw ? "" : raw;
  }

  function addDays(iso: string, days: number): string {
    const base = validIso(iso);
    if (!base) return "";
    const d = new Date(`${base}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  /** "Oct 20" — the way the server's own lines say a day. Locale-free on purpose. */
  function dayWords(iso: unknown): string {
    const m = ISO.exec(validIso(iso));
    return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : "";
  }

  function daysLeftWords(daysLeft: unknown): string {
    const n = Math.max(0, Math.trunc(Number(daysLeft)));
    if (!Number.isFinite(n)) return "";
    if (n === 0) return "last day today";
    return n === 1 ? "1 day left" : `${n} days left`;
  }

  /** Which of the four honest states the read is in. */
  function driveView(read: DriveRead | null | undefined): SettingsDriveView {
    if (!read || (read.drive !== "push" && read.drive !== "steady")) return "unknown";
    if (read.drive === "push") return read.stance ? "active" : "open";
    // Steady in force, but the standing value still says push (or the end is news): a
    // stance ran out. Said, and Push opens a new one.
    return read.ended || read.standing === "push" ? "lapsed" : "steady";
  }

  /**
   * The `until` a choice resolves to, from the read's own date. `null` for "this block"
   * (the server resolves the block's end) and for a picked date that is not yet usable.
   */
  function untilFor(choice: SettingsDriveUntilChoice | null, today: string, picked = ""): string | null {
    if (choice === "two_weeks") return addDays(today, 13) || null;
    if (choice === "four_weeks") return addDays(today, 27) || null;
    if (choice === "date") {
      const date = validIso(picked);
      if (!date || date < today || date > addDays(today, MAX_DAYS)) return null;
      return date;
    }
    return null;
  }

  /** The PUT /api/training-drive body for a push the athlete is about to confirm. */
  function pushBody(ui: SettingsDriveUi, today: string): import("../contracts/training-drive.js").ClientSetTrainingDriveBody | null {
    if (!ui.choice) return null;
    const words = text(ui.words).slice(0, 240) || null;
    if (ui.choice === "block") return { drive: "push", scope: "block", words };
    const until = untilFor(ui.choice, today, ui.date);
    return until ? { drive: "push", until, words } : null;
  }

  function confirmLabel(ui: SettingsDriveUi, today: string): string {
    if (ui.choice === "block") return "Push through this block";
    const until = untilFor(ui.choice, today, ui.date);
    if (until) return `Push through ${dayWords(until)}`;
    return ui.choice === "date" ? "Pick a last day" : "Choose an end";
  }

  function segHtml(view: SettingsDriveView, ui: SettingsDriveUi): string {
    const pushShown = ui.composing || view === "active" || view === "open";
    const opt = (value: "steady" | "push", label: string, on: boolean) =>
      `<button type="button" class="drive-opt${on ? " is-on" : ""}" data-drive-pick="${value}" aria-pressed="${on ? "true" : "false"}"${ui.busy ? " disabled" : ""}>${label}</button>`;
    return `<div class="drive-seg" role="group" aria-label="Training drive">${opt("steady", "Steady", !pushShown)}${opt("push", "Push", pushShown)}</div>`;
  }

  function quoteHtml(words: unknown): string {
    const said = text(words).replace(/[“”"]/g, "");
    return said ? `<p class="drive-said"><span class="drive-said-k">You said</span> “${escHtml(said)}”</p>` : "";
  }

  function stateHtml(read: DriveRead, view: SettingsDriveView): string {
    if (view === "active" && read.stance) {
      const left = daysLeftWords(read.stance.days_left);
      return `<p class="lbl drive-k">Push is on${left ? ` · ${escHtml(left)}` : ""}</p>
        <p class="drive-line">${escHtml(text(read.stance.line) || `Pushing through ${dayWords(read.stance.until)}.`)}</p>
        ${quoteHtml(read.stance.words)}`;
    }
    if (view === "open") {
      return `<p class="lbl drive-k">Push is on · no end date</p>
        <p class="drive-line">This push has no end date. Give it one, so it never outlives what you meant.</p>`;
    }
    if (view === "lapsed") {
      const ended = text(read.ended?.line) || "Your last push has run its course, so the drive is back where it was.";
      return `<p class="lbl drive-k">Steady</p>
        <p class="drive-line">${escHtml(ended)}</p>`;
    }
    return `<p class="lbl drive-k">Steady</p>
      <p class="drive-line">The usual rhythm: a run of loading days reads as a rest day, and the evidence decides when a session reaches.</p>`;
  }

  function composeHtml(read: DriveRead, ui: SettingsDriveUi, view: SettingsDriveView): string {
    const today = validIso(read.date);
    const chips = UNTIL_CHOICES.map(([key, label]) => {
      const on = ui.choice === key;
      return `<button type="button" class="drive-chip${on ? " is-on" : ""}" data-drive-until="${key}" aria-pressed="${on ? "true" : "false"}"${ui.busy ? " disabled" : ""}>${label}</button>`;
    }).join("");
    const date =
      ui.choice === "date"
        ? `<div class="field drive-field"><label for="driveDate">Last day of the push</label>
            <input id="driveDate" type="date" value="${escAttr(validIso(ui.date))}" min="${escAttr(today)}" max="${escAttr(addDays(today, MAX_DAYS))}"></div>`
        : "";
    const ready = !!pushBody(ui, today);
    const title = view === "active" || view === "open" ? "Push until" : "Push until when?";
    return `<div class="drive-compose" role="group" aria-labelledby="driveUntilLbl">
        <p class="lbl drive-k" id="driveUntilLbl">${title}</p>
        <div class="drive-chips">${chips}</div>
        ${date}
        <div class="field drive-field"><label for="driveWords">In your words · optional</label>
          <input id="driveWords" type="text" maxlength="240" autocomplete="off" value="${escAttr(ui.words)}" placeholder="I can push harder than this"></div>
        <div class="drive-acts">
          <button type="button" class="btn btn-solid drive-go" data-drive-go${ready && !ui.busy ? "" : " disabled"}>${escHtml(ui.busy ? "Saving…" : confirmLabel(ui, today))}</button>
          <button type="button" class="linkbtn-quiet drive-cancel" data-drive-cancel${ui.busy ? " disabled" : ""}>Not now</button>
        </div>
      </div>`;
  }

  function actsHtml(view: SettingsDriveView, ui: SettingsDriveUi): string {
    if (ui.confirmingEnd) {
      return `<div class="drive-confirm" role="group" aria-label="End the push">
          <p class="drive-line">Back to steady from today? The change and its Undo wait in Changes.</p>
          <div class="drive-acts">
            <button type="button" class="btn btn-solid" data-drive-end-yes${ui.busy ? " disabled" : ""}>${ui.busy ? "Saving…" : "Back to steady"}</button>
            <button type="button" class="linkbtn-quiet" data-drive-end-no${ui.busy ? " disabled" : ""}>Keep pushing</button>
          </div>
        </div>`;
    }
    if (view === "active")
      return `<div class="drive-acts"><button type="button" class="ghostbtn" data-drive-compose>Change the end</button><button type="button" class="ghostbtn" data-drive-end>End push</button></div>`;
    if (view === "open")
      return `<div class="drive-acts"><button type="button" class="ghostbtn" data-drive-compose>Set an end</button><button type="button" class="ghostbtn" data-drive-end>Back to steady</button></div>`;
    return "";
  }

  function listHtml(items: unknown, cls: string): string {
    const rows = (Array.isArray(items) ? items : []).map(text).filter(Boolean);
    return rows.length ? `<ul class="drive-list ${cls}">${rows.map((row) => `<li>${escHtml(row)}</li>`).join("")}</ul>` : "";
  }

  function moreHtml(read: DriveRead): string {
    const opens = Array.isArray(read.push_opens) && read.push_opens.length ? read.push_opens : read.licenses;
    const open = listHtml(opens, "drive-list-opens");
    const never = listHtml(read.never_overrides, "drive-list-never");
    if (!open && !never) return "";
    return `<details class="set-more drive-more"><summary>What Push opens, and what never gives way</summary>
        ${open ? `<p class="lbl drive-more-k">On a clean day, Push opens</p>${open}` : ""}
        ${never ? `<p class="lbl drive-more-k">Nothing ever overrides</p>${never}` : ""}
      </details>`;
  }

  /** The card's inner HTML (the controller owns the `#driveCard` element around it). */
  function cardHtml(read: DriveRead | null | undefined, ui: SettingsDriveUi): string {
    const head = `<div class="set-card-head"><h2 class="set-card-h">Training drive</h2><span class="lbl">your call · always dated</span></div>`;
    if (ui.status === "loading" && !read)
      return `${head}<p class="drive-line drive-wait" role="status" aria-live="polite">Reading your drive…</p>`;
    const view = driveView(read);
    if (!read || view === "unknown") {
      return `${head}<div class="drive-error" role="status" aria-live="polite"><p class="drive-line">Couldn't read your training drive just now.</p>
        <button type="button" class="linkbtn-quiet" data-drive-retry>Try again</button></div>`;
    }
    const note = text(ui.note);
    const error = text(ui.error);
    return `${head}
      ${segHtml(view, ui)}
      <div class="drive-state" role="status" aria-live="polite">${stateHtml(read, view)}${
        note ? `<p class="drive-note">${escHtml(note)}</p>` : ""
      }${error ? `<p class="drive-err">${escHtml(error)}</p>` : ""}</div>
      ${ui.composing ? composeHtml(read, ui, view) : actsHtml(view, ui)}
      ${moreHtml(read)}`;
  }

  function initialUi(): SettingsDriveUi {
    return { status: "loading", composing: false, choice: null, date: "", words: "", confirmingEnd: false, busy: false, error: null, note: null };
  }

  const CAIRN_SETTINGS_DRIVE = {
    cardHtml,
    driveView,
    untilFor,
    pushBody,
    confirmLabel,
    dayWords,
    daysLeftWords,
    initialUi,
  };

  Object.assign(globalThis, { CairnSettingsDrive: CAIRN_SETTINGS_DRIVE });
}
