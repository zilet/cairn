// @ts-check
// Settings → Automation: the training drive card's controller. Loads GET /api/training-drive
// (painting the last-known read first), and writes ONLY through PUT /api/training-drive —
// the stance door (src/domain/training/training-drive.ts). It never rides the Settings save
// bar: the card is `data-save-ignore`, and the generic settings save no longer carries
// training_drive at all, so no stale save can end or fake a stance.
{
  const DRIVE_CACHE_KEY = "settings:drive";

  type DriveRead = import("../contracts/training-drive.js").ClientTrainingDriveRead;
  type DriveSetResponse = import("../contracts/training-drive.js").ClientSetTrainingDriveResponse;
  type DriveBody = import("../contracts/training-drive.js").ClientSetTrainingDriveBody;

  function asRead(value: unknown): DriveRead | null {
    const read = value && typeof value === "object" ? (value as DriveRead) : null;
    return read && CairnSettingsDrive.driveView(read) !== "unknown" ? read : null;
  }

  function mountSettingsDrive(deps: ClientSettingsDriveControllerDeps): ClientSettingsDriveHandle {
    const root = deps.root;
    let read: DriveRead | null = asRead(deps.cache?.peek(DRIVE_CACHE_KEY));
    let ui: SettingsDriveUi = { ...CairnSettingsDrive.initialUi(), status: read ? "ready" : "loading" };

    function paint(focusSelector?: string): void {
      if (!root.isConnected) return;
      root.innerHTML = CairnSettingsDrive.cardHtml(read, ui);
      if (focusSelector) root.querySelector<HTMLElement>(focusSelector)?.focus();
    }

    function settle(next: DriveRead): void {
      read = next;
      try {
        deps.cache?.set(DRIVE_CACHE_KEY, next);
      } catch {}
    }

    async function load(): Promise<void> {
      try {
        const fresh = asRead(await deps.api("/training-drive"));
        if (!root.isConnected) return;
        if (fresh) settle(fresh);
        // A pending choice is never wiped by a background refresh.
        ui = { ...ui, status: fresh || read ? "ready" : "unavailable" };
      } catch {
        if (!root.isConnected) return;
        ui = { ...ui, status: read ? "ready" : "unavailable" };
      }
      if (!ui.composing && !ui.confirmingEnd) paint();
      else if (!root.querySelector(".drive-seg")) paint();
    }

    async function submit(body: DriveBody, focusAfter: string): Promise<void> {
      if (ui.busy) return;
      ui = { ...ui, busy: true, error: null, note: null };
      paint();
      let res: DriveSetResponse | null = null;
      try {
        res = (await deps.api("/training-drive", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })) as DriveSetResponse | null;
      } catch {
        res = null;
      }
      if (!root.isConnected) return;
      const next = res && res.ok ? asRead(res.read) : null;
      if (!res || !res.ok || !next) {
        ui = {
          ...ui,
          busy: false,
          error: res && !res.ok && res.error ? res.error : "That didn't reach Cairn just now. Nothing changed.",
        };
        paint();
        return;
      }
      // Drop every cache the drive feeds (the Brief, Train's card, the plan reads) first,
      // then keep this fresh read as the card's own last-known copy.
      try {
        deps.onWrite?.();
      } catch {}
      settle(next);
      const notes = Array.isArray(res.notes) ? res.notes.filter((n) => typeof n === "string" && n.trim()) : [];
      ui = { ...CairnSettingsDrive.initialUi(), status: "ready", note: notes[0] ?? null };
      paint(focusAfter);
      const until = next.stance ? CairnSettingsDrive.dayWords(next.stance.until) : "";
      deps.toast(next.drive === "push" ? (until ? `Push is on through ${until}` : "Push is on") : "Back to steady");
    }

    function syncGo(): void {
      const go = root.querySelector<HTMLButtonElement>("[data-drive-go]");
      if (!go || !read) return;
      const ready = !!CairnSettingsDrive.pushBody(ui, read.date);
      go.disabled = !ready || ui.busy;
      go.textContent = CairnSettingsDrive.confirmLabel(ui, read.date);
    }

    root.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("button") : null;
      if (!target || !root.contains(target) || (target as HTMLButtonElement).disabled) return;
      const view = CairnSettingsDrive.driveView(read);
      const d = target.dataset;
      if (d.driveRetry !== undefined) {
        ui = { ...ui, status: "loading" };
        paint();
        void load();
        return;
      }
      if (!read) return;
      if (d.drivePick === "push") {
        if (view === "active" || ui.composing) return;
        ui = { ...ui, composing: true, confirmingEnd: false, error: null, note: null };
        paint("[data-drive-until]");
        return;
      }
      if (d.drivePick === "steady") {
        if (ui.composing) {
          ui = { ...ui, composing: false, choice: null, error: null };
          paint('[data-drive-pick="steady"]');
        } else if (view === "active" || view === "open") {
          ui = { ...ui, confirmingEnd: true, error: null, note: null };
          paint("[data-drive-end-no]");
        }
        return;
      }
      if (d.driveUntil) {
        const choice = d.driveUntil as SettingsDriveUntilChoice;
        ui = { ...ui, choice, error: null };
        paint(choice === "date" ? "#driveDate" : `[data-drive-until="${choice}"]`);
        return;
      }
      if (d.driveGo !== undefined) {
        const body = CairnSettingsDrive.pushBody(ui, read.date);
        if (body) void submit(body, '[data-drive-pick="push"]');
        return;
      }
      if (d.driveCancel !== undefined) {
        ui = { ...ui, composing: false, choice: null, error: null };
        paint(view === "active" || view === "open" ? "[data-drive-compose]" : '[data-drive-pick="push"]');
        return;
      }
      if (d.driveCompose !== undefined) {
        ui = { ...ui, composing: true, confirmingEnd: false, choice: null, error: null, note: null };
        paint("[data-drive-until]");
        return;
      }
      if (d.driveEnd !== undefined) {
        ui = { ...ui, confirmingEnd: true, error: null, note: null };
        paint("[data-drive-end-no]");
        return;
      }
      if (d.driveEndYes !== undefined) {
        void submit({ drive: "steady" }, '[data-drive-pick="steady"]');
        return;
      }
      if (d.driveEndNo !== undefined) {
        ui = { ...ui, confirmingEnd: false };
        paint(view === "active" ? "[data-drive-end]" : '[data-drive-pick="steady"]');
      }
    });

    // Typing never re-renders (focus and the caret stay put); only the confirm button moves.
    const onField = (event: Event): void => {
      const field = event.target instanceof HTMLInputElement ? event.target : null;
      if (!field) return;
      if (field.id === "driveWords") ui = { ...ui, words: field.value };
      else if (field.id === "driveDate") {
        ui = { ...ui, date: field.value };
        syncGo();
      }
    };
    root.addEventListener("input", onField);
    root.addEventListener("change", onField);

    paint();
    const ready = load();
    return {
      ready,
      refresh: load,
      snapshot: () => ({ read, ui: { ...ui } }),
    };
  }

  const CAIRN_SETTINGS_DRIVE_CONTROLLER = { mount: mountSettingsDrive, CACHE_KEY: DRIVE_CACHE_KEY };

  Object.assign(globalThis, { CairnSettingsDriveController: CAIRN_SETTINGS_DRIVE_CONTROLLER });
}
