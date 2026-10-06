// @ts-check
// The training drive on Today, the controller: paints the push line (`#todayPushSlot`,
// under the Brief's why) and the coach's push offer (`#todayPushOfferSlot`, under the
// Path card) from the Brief's read, and answers the offer.
//
//   - Accept (POST /api/training-drive/offer/accept) is optimistic but truthful: the
//     card says "Opening the throttle…" while the server answers; a refusal puts the
//     card back exactly as it was with the server's own words in a toast; a yes is
//     re-read (the Brief repaints from a fresh /today-read, never from a guess), and a
//     toast carries the stance's one-tap Undo through the decision ledger.
//   - "Not now" (…/dismiss) takes the card away at once and remembers it on this device
//     too, so a cached read never paints the question again; a refusal brings it back.
//   - A holding chip opens the Brief's own "tap to see why", where the push section
//     says every hold in full beside the server's "why not more" sentence.
//
// The Brief's in-place upgrade repaints both slots through `repaint` (the Brief swap
// gives back empty slots, and a fresh read may move the line without moving the
// sentence). Both slots are optional: an absent push read leaves them empty, collapsed.
//
// LAZY (today-ahead bundle). Mounted by today-ahead-controller.ts; reached from the
// eager Brief controller only through an optional-chain guard.
{
  type DriveRead = import("../contracts/training-drive.js").ClientTrainingDriveRead;
  type PushOffer = import("../contracts/training-drive.js").ClientPushOffer;
  type OfferAnswer = import("../contracts/training-drive.js").ClientPushOfferAnswerResponse;
  type PushDeps = {
    api(path: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    toast(message: string, options?: { action?: string; onAction?: () => void }): void;
    /** Re-read Today (the Brief from a fresh /today-read); awaited after a yes. */
    refresh(): unknown;
  };
  type ReadLike = { kind?: unknown; push?: DriveRead | null; _provisional?: unknown } | null;

  const DISMISSED_KEY = "cairn.pushOffer.dismissed.v1";
  /** The deps of the last mount, so the Brief's in-place upgrade can repaint. */
  let LAST: PushDeps | null = null;
  /** The push read each Brief was painted from (its why panel says the holds). */
  const PUSH = new WeakMap<Element, DriveRead | null>();
  /** The offer each offer slot is showing. */
  const OFFER = new WeakMap<Element, PushOffer | null>();
  /** "tap to see why" buttons this module already listens to. */
  const WHY_WIRED = new WeakSet<Element>();

  function storage(): Storage | null {
    try {
      return typeof localStorage !== "undefined" ? localStorage : null;
    } catch {
      return null;
    }
  }

  function dismissedIds(): number[] {
    try {
      const raw = JSON.parse(storage()?.getItem(DISMISSED_KEY) || "[]");
      return Array.isArray(raw) ? raw.map(Number).filter((n) => Number.isFinite(n)) : [];
    } catch {
      return [];
    }
  }

  function setDismissed(id: number, on: boolean): void {
    const ids = dismissedIds().filter((n) => n !== id);
    if (on) ids.push(id);
    try {
      storage()?.setItem(DISMISSED_KEY, JSON.stringify(ids.slice(-8)));
    } catch {}
  }

  /** Write a slot only when it changed — or when it still shows a held copy (the write releases it). */
  function write(slot: Element, html: string): void {
    if (slot.innerHTML !== html || slot.hasAttribute("data-held")) slot.innerHTML = html;
  }

  function invalidate(name: string): void {
    try {
      (globalThis as { CairnWriteInvalidation?: { invalidateWrite(name: string): unknown } }).CairnWriteInvalidation?.invalidateWrite(name);
    } catch {}
  }

  // ---------- "why not more": the chips and the why panel ----------

  function whyButton(brief: Element | null): HTMLElement | null {
    return brief ? brief.querySelector<HTMLElement>("[data-briefwhy]") : null;
  }

  /** The chips mirror whether the why they open is open. */
  function syncChips(brief: Element | null): void {
    if (!brief) return;
    const btn = whyButton(brief);
    const open =
      (!!btn && btn.getAttribute("aria-expanded") === "true") || !!brief.querySelector("[data-tpush-own]");
    brief.querySelectorAll("[data-tpush-why]").forEach((chip) => chip.setAttribute("aria-expanded", open ? "true" : "false"));
  }

  /** Once the Brief's why panel is open, its push section says every hold in full. */
  function fillWhy(brief: Element): void {
    const btn = whyButton(brief);
    const html = CairnTodayPush.whyHtml(PUSH.get(brief));
    if (!btn || btn.getAttribute("aria-expanded") !== "true" || !html) return syncChips(brief);
    let panel = brief.querySelector(".brief-why-panel");
    if (!panel) {
      // A read with no signal rows still opens a panel for the holds.
      panel = document.createElement("div");
      panel.className = "brief-why-panel chip-in";
      (brief.querySelector("[data-brief-stamp]") || btn).before(panel);
    }
    if (!panel.querySelector("[data-tpush-panel]")) panel.insertAdjacentHTML("afterbegin", html);
    syncChips(brief);
  }

  function wireWhy(brief: Element): void {
    const btn = whyButton(brief);
    if (!btn || WHY_WIRED.has(btn)) return;
    WHY_WIRED.add(btn);
    // Registered after the Brief's own handler, so its panel is already built.
    btn.addEventListener("click", () => fillWhy(brief));
  }

  /** A chip: open (or close) the Brief's why; with nothing else to disclose, the holds alone. */
  function openWhy(chip: HTMLElement): void {
    const brief = chip.closest(".brief");
    if (!brief) return;
    const btn = whyButton(brief);
    if (btn && !btn.hidden) {
      btn.click();
    } else {
      // The Brief has nothing else behind its why: the push section is its own panel.
      const own = brief.querySelector("[data-tpush-own]");
      if (own) own.remove();
      else chip.closest(".tpush")?.insertAdjacentHTML("afterend", `<div class="brief-why-panel chip-in" data-tpush-own>${CairnTodayPush.whyHtml(PUSH.get(brief))}</div>`);
    }
    syncChips(brief);
    const panel = brief.querySelector("[data-tpush-panel]");
    try {
      panel?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    } catch {}
  }

  // ---------- the offer ----------

  async function answer(slot: Element, accepted: boolean, deps: PushDeps): Promise<void> {
    const offer = OFFER.get(slot) ?? null;
    const id = CairnTodayPush.offerId(offer);
    if (id == null || slot.getAttribute("data-busy") === "1") return;
    slot.setAttribute("data-busy", "1");
    // Optimistic: the card says what is happening; "not now" takes it away at once.
    if (accepted) {
      slot.querySelector(".tpush-offer")?.setAttribute("aria-busy", "true");
      const btns = slot.querySelector("[data-tpush-offer-btns]");
      if (btns) btns.innerHTML = CairnTodayPush.answeringHtml(offer, true);
    } else {
      setDismissed(id, true);
      slot.innerHTML = CairnTodayPush.answeringHtml(offer, false);
    }
    let result: OfferAnswer | null = null;
    try {
      result = (await deps.api(accepted ? "/training-drive/offer/accept" : "/training-drive/offer/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision_id: id }),
      })) as OfferAnswer | null;
    } catch {
      result = null;
    }
    slot.removeAttribute("data-busy");
    if (!result || result.ok !== true) {
      // Truthful: it did not happen, so the question stands exactly as it was.
      if (!accepted) setDismissed(id, false);
      slot.innerHTML = CairnTodayPush.offerHtml(offer);
      deps.toast(typeof result?.error === "string" && result.error ? result.error : "That didn't go through — try again");
      slot.querySelector<HTMLElement>(accepted ? "[data-tpush-accept]" : "[data-tpush-dismiss]")?.focus();
      return;
    }
    invalidate(accepted ? "push_offer_accept" : "push_offer_dismiss");
    slot.innerHTML = "";
    if (!accepted) {
      deps.toast("Noted — the coach won't ask again for a few weeks.");
      return;
    }
    const until = CairnTodayPush.monthDay(result.read?.stance?.until || offer?.until);
    CairnDecisionUndoController.offer(`Push is on${until ? ` through ${until}` : ""}`, result.decision_id, "Undo", deps, {
      reason: "undo the push the athlete accepted from the coach's offer",
      success: "Back to steady",
      stale: "That push can no longer be undone.",
      failed: "Could not undo the push",
      after: () => deps.refresh(),
    });
    // Re-read: the push line and the day's reach come from the server, never from here.
    await deps.refresh();
  }

  // ---------- paint ----------

  function paint(root: Element, value: unknown, deps: PushDeps): void {
    LAST = deps;
    const read = (value && typeof value === "object" ? value : null) as ReadLike;
    // A placeholder read says nothing about the drive: leave what is painted.
    if (!read || read._provisional) return;
    const push = read.push && typeof read.push === "object" ? read.push : null;
    const lineSlot = root.querySelector("#todayPushSlot");
    const offerSlot = root.querySelector("#todayPushOfferSlot");
    const brief = (lineSlot || offerSlot)?.closest(".brief") ?? null;
    if (brief) {
      PUSH.set(brief, push);
      wireWhy(brief);
    }
    if (lineSlot) {
      write(lineSlot, CairnTodayPush.stateHtml(push, String(read.kind || "train")));
      CairnUiActions.mount(lineSlot, "tpush", ({ delegate }) => {
        delegate("click", { "tpush-why": (el) => openWhy(el) });
      });
    }
    if (offerSlot && offerSlot.getAttribute("data-busy") !== "1") {
      const offer = push?.offer ?? null;
      const id = CairnTodayPush.offerId(offer);
      const shown = id != null && !dismissedIds().includes(id) ? offer : null;
      OFFER.set(offerSlot, shown);
      write(offerSlot, CairnTodayPush.offerHtml(shown));
      CairnUiActions.mount(offerSlot, "tpush-offer", ({ delegate }) => {
        delegate("click", {
          "tpush-accept": () => void answer(offerSlot, true, deps),
          "tpush-dismiss": () => void answer(offerSlot, false, deps),
        });
      });
    }
    if (brief) fillWhy(brief);
  }

  /** Paint under `root` from `read` with the last mount's deps; a no-op before the first mount. */
  function repaint(root: Element, read: unknown): void {
    if (LAST) paint(root, read, LAST);
  }

  const CAIRN_TODAY_PUSH_CONTROLLER = { mount: paint, repaint, DISMISSED_KEY };

  Object.assign(globalThis, { CairnTodayPushController: CAIRN_TODAY_PUSH_CONTROLLER });
}
