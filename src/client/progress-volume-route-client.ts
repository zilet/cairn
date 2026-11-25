// @ts-check
// Train › Volume, the route (split out of progress-screen.ts): the ranked per-muscle
// bars under one voice line, with the balance read above them painted in the same
// frame. renderVolume / paintVolumeBody stay globals for the shell's segment handlers.
// ---------- Progress: volume by muscle group ----------
// SWR over /volume?days=30 (key progress:volume): the Volume seg paints the
// per-muscle bars instantly on a warm re-entry, then revalidates.
//
// The balance read (/program/balance) sits ABOVE the ranked bars, so it rides the same
// cycle: it has its own SWR key (dropped with progress:volume on every set write), the
// warm path paints both from their peeks at once, and a cold open waits (bounded) for
// both before the first paint. It used to land on its own and push every bar down.
const VOLUME_BALANCE_KEY = "progress:volume-balance";
const VOLUME_BALANCE_WAIT_MS = 2000;

async function renderVolume() {
  headerTitle.textContent = "Volume";
  state.progressSeg = "volume";
  const token = ++pollToken;
  const peek = peekCached("progress:volume");
  const balancePeek = peekCached(VOLUME_BALANCE_KEY);
  const warm = !!(peek && balancePeek);
  // `undefined` = not answered yet; null = answered with nothing to say.
  let balance: unknown = warm ? balancePeek!.data : undefined;
  let volumeBalanceHeld = false;
  const live = () => token === pollToken && state.tab === "progress" && state.progressSeg === "volume";
  const balanceRead = cachedApi("/program/balance", {
    key: VOLUME_BALANCE_KEY,
    onUpgrade: (data, { changed }) => {
      if (changed && warm && live()) paintVolumeBalance(data);
    },
  })
    .then((data) => {
      balance = data;
      return data;
    })
    .catch(() => {
      if (balance === undefined) balance = null;
      return null;
    });
  // A slow balance read paints into its slot when it lands, as it always did.
  void balanceRead.then((data) => {
    if (!warm && live() && volumeBalanceHeld) paintVolumeBalance(data);
  });
  if (!warm) view.innerHTML = segSkeleton("volume", PROGRESS_SEG, 2); // cold: skeleton-first
  const balanceSettled = warm ? Promise.resolve() : settledWithin([balanceRead], VOLUME_BALANCE_WAIT_MS);
  let painted: Promise<void> = Promise.resolve();
  const result = await paintSWR({
    key: "progress:volume",
    path: "/volume?days=30",
    peek: (warm ? peek : null) as never,
    token,
    tab: "progress",
    render: (data: unknown) => {
      if (warm) return paintVolumeBody(CairnProgressData.record(data), balance);
      painted = balanceSettled.then(() => {
        if (!live()) return;
        volumeBalanceHeld = balance === undefined;
        paintVolumeBody(CairnProgressData.record(data), balance);
      });
    },
  });
  await painted;
  return result;
}

function paintVolumeBody(data: ProgressRecord, balance: unknown) {
  const groups = CairnProgressData.rows<ProgressVolumeGroup>(data.by_muscle)
    .slice()
    .sort((a, b) => CairnProgressData.number(b.sets) - CairnProgressData.number(a.sets));
  const head = segBar("volume", PROGRESS_SEG);
  if (!groups.length) {
    view.innerHTML =
      head +
      progressHero("Volume", []) +
      emptyStateHtml(
        art("exercise", "barbell row"),
        `Nothing logged in the last ${CairnProgressData.number(data.days, 30)} days.`
      );
    wireSeg(PROGRESS_HANDLERS);
    return;
  }
  const totalSets = groups.reduce((t, g) => t + CairnProgressData.number(g.sets), 0);
  const maxSets = Math.max(1, ...groups.map((g) => CairnProgressData.number(g.sets)));
  const tonnage = CairnProgressData.number(data.total_tonnage);
  const hero = progressHero("Volume", [], {
    line: `${Math.round(totalSets).toLocaleString()} working set${Math.round(totalSets) === 1 ? "" : "s"} across ${progressCountWord(groups.length)} muscle group${groups.length === 1 ? "" : "s"}.`,
    fact: tonnage > 0 ? `${tonnage >= 10000 ? `${Math.round(tonnage / 100) / 10}k` : Math.round(tonnage).toLocaleString()} lb moved` : "",
  });
  const rows = groups
    .map(
      (g, i) => `
    <div class="volrow reveal" style="${stagger(i + 2)}">
      <div class="volrow-top">
        <span class="volrow-name">${escHtml(g.muscle_group)}</span>
        <span class="volrow-meta"><b>${CairnProgressData.number(g.sets)}</b> set${CairnProgressData.number(g.sets) === 1 ? "" : "s"}${CairnProgressData.number(g.tonnage) > 0 ? ` · ${CairnProgressData.number(g.tonnage).toLocaleString()} lb` : ""}</span>
      </div>
      <div class="volbar"><div class="volbar-fill barfill" style="width:${Math.max(3, Math.round((CairnProgressData.number(g.sets) / maxSets) * 100))}%"></div></div>
    </div>`
    )
    .join("");
  // Words lead (Amendment 2): the voice line is the page's one focal point, and the
  // balance read — which groups are due, which patterns are missing — sits right
  // under it, ahead of the ranked bars.
  view.innerHTML =
    head +
    hero +
    `<div id="volBalanceSlot" class="vol-balance-slot reveal" style="${stagger(1)}"></div>` +
    `<div class="vol-kicker lbl reveal" style="${stagger(2)}">Last ${CairnProgressData.number(data.days, 30)} days · ranked by sets</div>` +
    rows +
    `<div id="volUngroupedSlot"></div>`;
  wireSeg(PROGRESS_HANDLERS);
  runCountUps(view);
  // The balance read sits above the numbers — the engine reads your volume per
  // canonical muscle group, names what's DUE and what's running high, and flags the
  // patterns (core / grip / mobility) that are absent. Painted in the same frame when
  // it has answered; a read still out fills the slot when it lands.
  if (balance !== undefined) paintVolumeBalance(balance);
}

// ---------- Volume: the balance read (which groups are due / high / missing) ----------
// Fed by GET /api/program/balance — working-set volume per CANONICAL group banded
// against the volume landmarks, in PLAIN WORDS (never a 0–100 grade). Surfaces the
// adherence skew (summary) + the due / high groups + the missing-pattern gaps the
// new taxonomy made visible (core, forearms/grip). Best-effort + null-safe: the
// SURFACE endpoint may not be wired yet (404) — guard like every optional fetch,
// leaving the bars untouched if it's missing. Constitution: pull, never push.
function paintVolumeBalance(bal: unknown) {
  const slot = view.querySelector("#volBalanceSlot");
  if (!slot || state.tab !== "progress" || state.progressSeg !== "volume") return;
  slot.innerHTML = volBalanceHtml(bal as never) || "";
  // The server's own sentence about lifts no group counted: a footnote under the bars.
  const note = view.querySelector("#volUngroupedSlot");
  if (note) note.innerHTML = ungroupedNoteHtml(bal as never);
}


Object.assign(globalThis, { renderVolume, paintVolumeBody });
