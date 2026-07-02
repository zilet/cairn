// @ts-check
// Shared full-screen detail overlay scaffold.

(() => {
  let detailOrigin: HTMLElement | null = null;
  // The element that held focus before the overlay opened, so keyboard/SR users
  // are returned exactly where they were on close (the tapped tile in practice).
  let detailRestoreFocus: HTMLElement | null = null;
  let bodyScrollLocked = false;
  let prevBodyOverflow = "";

  function lockBodyScroll(): void {
    if (bodyScrollLocked || typeof document === "undefined") return;
    prevBodyOverflow = document.body.style.overflow || "";
    document.body.style.overflow = "hidden";
    bodyScrollLocked = true;
  }
  function unlockBodyScroll(): void {
    if (!bodyScrollLocked) return;
    document.body.style.overflow = prevBodyOverflow;
    bodyScrollLocked = false;
  }
  function restoreDetailFocus(): void {
    const target = detailRestoreFocus;
    detailRestoreFocus = null;
    if (target && target.isConnected && typeof target.focus === "function") {
      try { target.focus({ preventScroll: true }); } catch { target.focus(); }
    }
  }
  // Focusable elements inside the overlay, for the wrap-around Tab trap.
  function detailFocusable(root: Element): HTMLElement[] {
    return [...root.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
    )].filter((el) => el.offsetParent !== null || el === document.activeElement);
  }

  function closeDetail(instant?: boolean): void {
    const detail = document.querySelector<HTMLElement>(".detail");
    if (!detail) return;
    const origin = detailOrigin;
    detailOrigin = null;
    unlockBodyScroll();
    if (instant || !document.startViewTransition || reducedMotion()) {
      if (origin && origin.isConnected) origin.style.viewTransitionName = "";
      detail.remove();
      restoreDetailFocus();
      return;
    }
    withViewTransition(() => {
      detail.remove();
      if (origin && origin.isConnected) {
        origin.style.viewTransitionName = "detail-art";
        setTimeout(() => { origin.style.viewTransitionName = ""; }, 450);
      }
    });
    restoreDetailFocus();
  }

  function openDetailFrom(tile: Element | null | undefined, build: () => unknown): void {
    closeDetail(true);
    const origin = tile instanceof HTMLElement ? tile : null;
    detailOrigin = origin;
    if (origin && document.startViewTransition && !reducedMotion()) {
      origin.style.viewTransitionName = "detail-art";
      try {
        const transition = document.startViewTransition(() => {
          origin.style.viewTransitionName = "";
          build();
        });
        transition.finished.catch(() => {});
        return;
      } catch {
        origin.style.viewTransitionName = "";
      }
    }
    build();
  }

  function mountDetail(inner: string, photoSrc?: string | null): HTMLElement {
    // Remember where focus was so we can restore it on close; prefer the live
    // active element, falling back to the shared-element origin tile.
    const active = document.activeElement;
    detailRestoreFocus = (active instanceof HTMLElement && active !== document.body)
      ? active
      : (detailOrigin && detailOrigin.isConnected ? detailOrigin : null);

    const detail = document.createElement("div");
    detail.className = "detail";
    // Dialog semantics so screen readers announce a modal context and scope their
    // reading to it; the visible title becomes the accessible name when present.
    detail.setAttribute("role", "dialog");
    detail.setAttribute("aria-modal", "true");
    detail.innerHTML = `<div class="detail-bg">${photoSrc ? `<img alt="" src="${escAttr(photoSrc)}" data-remove-on-error="1">` : ""}</div>
      <button class="detail-x" aria-label="Close">&times;</button>
      <div class="detail-scroll">${inner}</div>`;
    const titleText = detail.querySelector(".detail-title")?.textContent?.trim();
    detail.setAttribute("aria-label", titleText || "Details");
    document.body.appendChild(detail);
    lockBodyScroll();
    detail.querySelector(".detail-x")?.addEventListener("click", () => closeDetail());
    detail.addEventListener("click", (event) => { if (event.target === detail) closeDetail(); });
    // Wrap-around Tab trap — keyboard focus can't escape the open overlay.
    detail.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = detailFocusable(detail);
      if (focusable.length < 2) {
        // Only the close button is focusable — keep focus pinned to it.
        if (focusable.length === 1) { event.preventDefault(); focusable[0].focus(); }
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    // Land focus inside the dialog (the close control) so keyboard users start here.
    const closeBtn = detail.querySelector<HTMLElement>(".detail-x");
    if (closeBtn) { try { closeBtn.focus({ preventScroll: true }); } catch { closeBtn.focus(); } }
    return detail;
  }

  function wireArtZoom(artEl: Element | null | undefined): void {
    if (!artEl) return;
    const host = artEl as HTMLElement;
    const inner = (host.firstElementChild || host) as HTMLElement;
    let scale = 1;
    const apply = () => { inner.style.transform = `scale(${scale})`; };
    host.addEventListener("wheel", (event: WheelEvent) => {
      event.preventDefault();
      scale = Math.min(2.2, Math.max(1, scale - event.deltaY * 0.0028));
      apply();
    }, { passive: false });
    const touches = new Map<number, { x: number; y: number }>();
    let pinchBase = 0;
    let pinchScale = 1;
    const dist = () => {
      const [a, b] = [...touches.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    host.addEventListener("pointerdown", (event: PointerEvent) => {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.size === 2) {
        pinchBase = dist();
        pinchScale = scale;
      }
    });
    host.addEventListener("pointermove", (event: PointerEvent) => {
      if (!touches.has(event.pointerId)) return;
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.size === 2 && pinchBase > 0) {
        scale = Math.min(2.2, Math.max(1, pinchScale * (dist() / pinchBase)));
        apply();
      }
    });
    const lift = (event: PointerEvent) => {
      touches.delete(event.pointerId);
      if (touches.size < 2) pinchBase = 0;
    };
    host.addEventListener("pointerup", lift);
    host.addEventListener("pointercancel", lift);
  }

  function wireDetailCommon(): void {
    const detail = document.querySelector(".detail");
    if (!detail) return;
    wireArtZoom(detail.querySelector(".detail-art"));
    detail.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => closeDetail()));
    const scroller = detail.querySelector<HTMLElement>(".detail-scroll");
    const artEl = detail.querySelector<HTMLElement>(".detail-art");
    if (scroller && artEl && !reducedMotion()) {
      scroller.addEventListener("scroll", () => {
        artEl.style.translate = `0 ${Math.min(40, scroller.scrollTop * 0.35)}px`;
        artEl.style.opacity = String(Math.max(0.25, 1 - scroller.scrollTop / 420));
      }, { passive: true });
    }
  }

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (document.querySelector(".sheet") && typeof globalThis.closeMealSheet === "function") {
      globalThis.closeMealSheet();
      return;
    }
    closeDetail();
  });

  const CAIRN_DETAIL_OVERLAY = {
    closeDetail,
    openDetailFrom,
    mountDetail,
    wireDetailCommon,
    wireArtZoom,
  };

  Object.assign(globalThis, {
    CairnDetailOverlay: CAIRN_DETAIL_OVERLAY,
    closeDetail,
    openDetailFrom,
    mountDetail,
    wireDetailCommon,
    wireArtZoom,
  });

  if (typeof window !== "undefined") {
    Object.assign(window, {
      CairnDetailOverlay: CAIRN_DETAIL_OVERLAY,
      closeDetail,
      openDetailFrom,
      mountDetail,
      wireDetailCommon,
      wireArtZoom,
    });
  }
})();
