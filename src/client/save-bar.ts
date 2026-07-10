// @ts-check
// Shared floating unsaved-changes save bar.

type SaveBarContext = {
  sentinel: Element | null;
  fields: Element | null;
  onSave: () => boolean | Promise<boolean>;
  onDiscard?: () => unknown;
  dirty: boolean;
  busy: boolean;
};

let saveCtx: SaveBarContext | null = null;
let saveBarHideTimer: ReturnType<typeof setTimeout> | null = null;

function saveBarButton(bar: Element, selector: string): HTMLButtonElement {
  const button = bar.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`Missing save bar button: ${selector}`);
  return button;
}

function ensureSaveBar(): HTMLElement {
  let bar = document.querySelector<HTMLElement>(".savebar");
  if (bar) return bar;
  bar = document.createElement("div");
  bar.className = "savebar";
  bar.setAttribute("role", "status");
  bar.setAttribute("aria-hidden", "true");
  bar.innerHTML = `
    <div class="savebar-row">
      <span class="savebar-dot" aria-hidden="true"></span>
      <span class="savebar-msg">Unsaved changes</span>
      <button type="button" class="savebar-discard">Discard</button>
      <button type="button" class="savebar-save">Save</button>
    </div>
    <div class="savebar-done" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path class="savebar-tick" d="M4.5 12.5l5 5L19.5 7"/></svg>
      <span>Saved</span>
    </div>`;
  document.body.appendChild(bar);
  saveBarButton(bar, ".savebar-save").addEventListener("click", saveBarCommit);
  saveBarButton(bar, ".savebar-discard").addEventListener("click", () => {
    const ctx = saveCtx;
    if (!ctx || ctx.busy) return;
    hideSaveBar();
    if (ctx.onDiscard) ctx.onDiscard();
  });
  return bar;
}

function hideSaveBar(): void {
  if (saveBarHideTimer) clearTimeout(saveBarHideTimer);
  const bar = document.querySelector<HTMLElement>(".savebar");
  if (bar) {
    bar.classList.remove("show", "busy", "saved");
    bar.setAttribute("aria-hidden", "true");
    const btn = saveBarButton(bar, ".savebar-save");
    btn.disabled = false;
    btn.textContent = "Save";
  }
  document.body.classList.remove("savebar-open");
  if (saveCtx) saveCtx.dirty = false;
}

function setSaveDirty(): void {
  if (!saveCtx || saveCtx.dirty || saveCtx.busy) return;
  saveCtx.dirty = true;
  if (saveBarHideTimer) clearTimeout(saveBarHideTimer);
  const bar = ensureSaveBar();
  bar.removeAttribute("aria-hidden");
  bar.classList.remove("saved", "busy");
  const btn = saveBarButton(bar, ".savebar-save");
  btn.disabled = false;
  btn.textContent = "Save";
  void bar.offsetHeight;
  bar.classList.add("show");
  document.body.classList.add("savebar-open");
}

async function saveBarCommit(): Promise<void> {
  const ctx = saveCtx;
  if (!ctx || ctx.busy) return;
  const bar = ensureSaveBar();
  const btn = saveBarButton(bar, ".savebar-save");
  const wasShown = bar.classList.contains("show");
  ctx.busy = true;
  bar.classList.add("busy");
  btn.disabled = true;
  btn.textContent = "Saving...";
  let ok = false;
  try {
    ok = (await ctx.onSave()) !== false;
  } catch {
    ok = false;
    if (wasShown) toast("Couldn't save");
  }
  ctx.busy = false;
  bar.classList.remove("busy");
  btn.disabled = false;
  btn.textContent = "Save";
  if (!ok) return;
  ctx.dirty = false;
  if (!wasShown) {
    toast("Saved");
    return;
  }
  bar.classList.add("saved");
  if (saveBarHideTimer) clearTimeout(saveBarHideTimer);
  saveBarHideTimer = setTimeout(() => {
    bar.classList.remove("show", "saved");
    bar.setAttribute("aria-hidden", "true");
    document.body.classList.remove("savebar-open");
  }, reducedMotion() ? 700 : 1300);
}

function mountSaveBar(options: {
  sentinel: Element | null;
  fields: Element | null;
  onSave: () => boolean | Promise<boolean>;
  onDiscard?: () => unknown;
}): ClientSaveBar {
  const bar = ensureSaveBar();
  saveCtx = { ...options, dirty: false, busy: false };
  if (!bar.classList.contains("saved") && !bar.classList.contains("busy")) hideSaveBar();
  return { markDirty: setSaveDirty, save: saveBarCommit };
}

function controlAtDefault(el: EventTarget | null): boolean {
  if (el instanceof HTMLSelectElement) {
    const selected = el.selectedOptions[0];
    return !selected || selected.defaultSelected;
  }
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
    return el.checked === el.defaultChecked;
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el.value === el.defaultValue;
  }
  return false;
}

for (const evt of ["input", "change"]) {
  document.addEventListener(
    evt,
    (event) => {
      if (!saveCtx || saveCtx.dirty || saveCtx.busy) return;
      if (!saveCtx.sentinel?.isConnected) return;
      if (!saveCtx.fields || !(event.target instanceof Node) || !saveCtx.fields.contains(event.target)) return;
      if (event.target instanceof Element && event.target.closest("[data-save-ignore]")) return;
      if (controlAtDefault(event.target)) return;
      setSaveDirty();
    },
    true,
  );
}

new MutationObserver(() => {
  if (saveCtx && !saveCtx.sentinel?.isConnected) {
    saveCtx = null;
    const bar = document.querySelector<HTMLElement>(".savebar");
    if (bar && bar.classList.contains("show") && !bar.classList.contains("saved")) hideSaveBar();
  }
}).observe(view, { childList: true });

Object.assign(globalThis, { hideSaveBar, mountSaveBar });

if (typeof window !== "undefined") {
  Object.assign(window, { hideSaveBar, mountSaveBar });
}
