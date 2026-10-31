// @ts-check
// "Your data", the controller. `mount(host, deps)` reads GET /api/health/data-coverage
// through the SWR cache (a `health:` key, so it stays in memory and never lands on
// disk), paints the card, and repaints only when the read changed. The card is
// optional: a cold read that fails collapses the slot, and a failed revalidation leaves
// the last-known card standing.
//
// A row opens the screen that source already lives on (the screen decides where). "+ Add"
// opens a small sheet whose File / Photo / Paste feed Records' OWN upload — the files
// are picked here, inside the tap (a picker opened after a navigation would lose the
// gesture), and handed over; nothing is uploaded from this module. On a desktop, files
// dropped onto the card take the same path.
{
  type Deps = ClientYouDataDeps;
  type Read = import("../contracts/data-coverage.js").DataCoverageRead;

  function filesOf(list: FileList | null | undefined): File[] {
    return list ? Array.from(list) : [];
  }

  function openAddSheet(deps: Deps): void {
    if (typeof CairnUiSheet === "undefined") {
      deps.addPaste();
      return;
    }
    const sheet = CairnUiSheet.open({
      html: CairnYouData.addSheetHtml(),
      labelledBy: "youAddH",
      sheetClass: "ui-sheet you-add-sheet",
      initialFocus: '[data-you-add="file"]',
    });
    const root = sheet.sheet;
    const take = (kind: "file" | "photo") => (event: Event) => {
      const files = filesOf((event.currentTarget as HTMLInputElement).files);
      if (!files.length) return;
      sheet.close({ reason: "api" });
      deps.addFiles(files);
    };
    root.querySelector('[data-you-add-input="file"]')?.addEventListener("change", take("file"));
    root.querySelector('[data-you-add-input="photo"]')?.addEventListener("change", take("photo"));
    root.addEventListener("click", (event) => {
      const el = (event.target as Element | null)?.closest?.<HTMLElement>("[data-you-add]");
      if (!el || !root.contains(el)) return;
      const kind = el.dataset.youAdd;
      if (kind === "file" || kind === "photo") {
        // Inside the tap, so the browser lets the picker (or the camera) open.
        root.querySelector<HTMLInputElement>(`[data-you-add-input="${kind}"]`)?.click();
        return;
      }
      sheet.close({ reason: "api" });
      if (kind === "paste") deps.addPaste();
      else if (kind === "sources") deps.openSources();
    });
  }

  function mountYouData(host: Element, deps: Deps): () => void {
    let live = true;
    let real = false;
    let painted: string | null = null;
    let current: Read | null = null;

    function paint(read: Read | null | undefined): void {
      if (!live || !host.isConnected) return;
      real = true;
      const sig = JSON.stringify(read ?? null);
      if (sig === painted) return;
      const html = CairnYouData.html(read, { relTime: deps.relTime });
      host.innerHTML = html;
      painted = sig;
      current = html ? (read as Read) : null;
    }

    const warm = deps.peek(CairnYouData.KEY);
    if (warm && warm.data) paint(warm.data);
    else host.innerHTML = CairnYouData.skeletonHtml();

    deps
      .load(CairnYouData.PATH, { key: CairnYouData.KEY })
      .then((read) => paint(read))
      .catch(() => {
        if (live && host.isConnected && !real) host.innerHTML = "";
      });

    return CairnUiActions.mount(host, "you-data", ({ delegate, signal }) => {
      delegate("click", {
        "you-data-open": (el) => {
          const row = current?.rows.find((r) => r.key === el.getAttribute("data-you-data-open"));
          if (row) deps.openRow(row);
        },
        "you-data-gap": (el) => {
          const gap = current?.gaps.find((g) => g.key === el.getAttribute("data-you-data-gap"));
          if (!gap) return;
          if (gap.action === "add") openAddSheet(deps);
          else deps.openGap(gap);
        },
        "you-data-add": () => openAddSheet(deps),
      });
      // A desktop drop onto the card is the File option without the picker.
      const card = () => host.querySelector<HTMLElement>("[data-you-data-drop]");
      const dragging = (on: boolean) => card()?.classList.toggle("is-drop", on);
      const hasFiles = (event: DragEvent) =>
        !!event.dataTransfer && [...(event.dataTransfer.types || [])].includes("Files");
      host.addEventListener(
        "dragover",
        (event) => {
          const e = event as DragEvent;
          if (!hasFiles(e) || !card()) return;
          e.preventDefault();
          dragging(true);
        },
        { signal }
      );
      host.addEventListener(
        "dragleave",
        (event) => {
          if (!host.contains((event as DragEvent).relatedTarget as Node | null)) dragging(false);
        },
        { signal }
      );
      host.addEventListener(
        "drop",
        (event) => {
          const e = event as DragEvent;
          const files = filesOf(e.dataTransfer?.files);
          dragging(false);
          if (!files.length) return;
          e.preventDefault();
          deps.addFiles(files);
        },
        { signal }
      );
      return () => {
        live = false;
      };
    });
  }

  const YOU_DATA_CONTROLLER: Window["CairnYouDataController"] = { mount: mountYouData, openAddSheet };

  Object.assign(globalThis, { CairnYouDataController: YOU_DATA_CONTROLLER });
}
