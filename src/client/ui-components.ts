// @ts-check
// Tiny typed UI primitives for the vanilla PWA. Components are pure HTML
// renderers: no fetching, no global state mutation beyond the compatibility export.

type CairnUiAttrs = Record<string, unknown>;
type CairnUiAction = {
  id?: string;
  label: unknown;
  className?: string;
  attrs?: CairnUiAttrs;
};
type TextChipOptions = {
  label: unknown;
  className?: string;
  title?: unknown;
  attrs?: CairnUiAttrs;
};
type LoadingStateOptions = {
  label: unknown;
  className?: string;
  live?: boolean;
};
type SegmentedNavItem = readonly [unknown, unknown];
type SegmentedNavOptions = {
  active: unknown;
  items: ReadonlyArray<SegmentedNavItem>;
};
type SegmentedOptions = {
  items: ReadonlyArray<SegmentedNavItem>;
  active: unknown;
  /** The group's accessible name (`role="group"` + `aria-label`). */
  label: unknown;
  /**
   * `sliding` — the navigation bar with its animated thumb (`--segn`/`--segi`);
   * `plain` — an inline choice group inside a form, no thumb, no wrapper;
   * `leaf` — a sliding sub-bar, omitted entirely when there is nothing to choose.
   */
  variant?: "sliding" | "plain" | "leaf";
  /** Data attribute carrying each key, without `data-` (default `seg`). */
  attr?: string;
  /** Extra classes on the `.seg` group. */
  className?: string;
  /** Extra classes on the `.segwrap` wrapper (sliding / leaf). */
  wrapClass?: string;
  id?: string;
  /** Extra attributes on the group element. */
  attrs?: CairnUiAttrs;
  /** Emit `aria-pressed` on every button (default: on for sliding/leaf, off for plain). */
  pressed?: boolean;
};
type JobCaptionOptions = {
  text?: unknown;
  className?: string;
  tag?: "span" | "div";
  attrs?: CairnUiAttrs;
};
type SheetChipOptions = {
  label?: unknown;
  value?: unknown;
  className?: string;
  valueClassName?: string;
  labelClassName?: string;
  attrs?: CairnUiAttrs;
};
type EmptyStateOptions = {
  title: unknown;
  body?: unknown;
  artHtml?: string;
  action?: CairnUiAction | null;
  className?: string;
  style?: string;
  bodyClassName?: string;
};

function mergeAttrs(defaults: CairnUiAttrs, attrs: CairnUiAttrs | null | undefined): CairnUiAttrs {
  const row = attrs && typeof attrs === "object" ? attrs : {};
  return { ...defaults, ...row };
}

function uiAttrsHtml(attrs: CairnUiAttrs | null | undefined): string {
  const row = attrs && typeof attrs === "object" ? attrs : {};
  return Object.entries(row)
    .map(([key, value]) => {
      if (value == null) return "";
      const safeKey = /^[a-zA-Z][a-zA-Z0-9_:.:-]*$/.test(key) ? key : "";
      if (!safeKey) return "";
      const isAria = safeKey.toLowerCase().startsWith("aria-");
      if (value === false) return isAria ? ` ${safeKey}="false"` : "";
      if (value === true) return isAria ? ` ${safeKey}="true"` : ` ${safeKey}`;
      return ` ${safeKey}="${escAttr(value)}"`;
    })
    .join("");
}

function actionButtonHtml(action: CairnUiAction | null | undefined): string {
  if (!action || !String(action.label ?? "").trim()) return "";
  const id = action.id ? ` id="${escAttr(action.id)}"` : "";
  const cls = ` class="${escAttr(action.className || "logbtn")}"`;
  return `<button${id}${cls} type="button"${uiAttrsHtml(action.attrs)}>${escHtml(action.label)}</button>`;
}

function textChipHtml(options: TextChipOptions): string {
  if (!String(options.label ?? "").trim()) return "";
  const className = options.className || "chip";
  const title = options.title == null || !String(options.title).trim() ? "" : ` title="${escAttr(options.title)}"`;
  return `<span class="${escAttr(className)}"${title}${uiAttrsHtml(options.attrs)}>${escHtml(options.label)}</span>`;
}

function loadingStateHtml(options: LoadingStateOptions): string {
  const className = options.className || "loadstate";
  const live = options.live === false ? "" : ` aria-live="polite"`;
  return `<div class="${escAttr(className)}" role="status"${live}>
    <span class="aspin aspin-sm" aria-hidden="true"></span>
    <div class="loadstate-label">${escHtml(options.label)}</div>
  </div>`;
}

// The one segmented control. Every button is a real `<button type="button">`
// carrying its key in `data-<attr>`; `.active` marks the chosen one, and the
// sliding variants also set `aria-pressed`. Wiring stays with the caller
// (`wireSeg` for the section bars, delegation for form groups).
function segmentedHtml(options: SegmentedOptions): string {
  const items = Array.isArray(options.items) ? options.items : [];
  const variant = options.variant === "plain" || options.variant === "leaf" ? options.variant : "sliding";
  if (variant === "leaf" && items.length < 2) return "";
  const attr = /^[a-z][a-z0-9-]*$/.test(String(options.attr || "")) ? String(options.attr) : "seg";
  const pressed = options.pressed ?? variant !== "plain";
  const buttons = items
    .map(([key, label]) => {
      const on = key === options.active;
      const aria = pressed ? ` aria-pressed="${on ? "true" : "false"}"` : "";
      return `<button class="segbtn${on ? " active" : ""}" type="button" data-${attr}="${escAttr(key)}"${aria}>${escHtml(label)}</button>`;
    })
    .join("");
  const cls = options.className ? ` ${escAttr(options.className)}` : "";
  const id = options.id ? ` id="${escAttr(options.id)}"` : "";
  const group = `${id} role="group" aria-label="${escAttr(options.label)}"${uiAttrsHtml(options.attrs)}`;
  if (variant === "plain") return `<div class="seg${cls}"${group}>${buttons}</div>`;
  const idx = Math.max(
    0,
    items.findIndex(([key]) => key === options.active)
  );
  const wrap = options.wrapClass ? ` ${escAttr(options.wrapClass)}` : "";
  return `<div class="segwrap${wrap}" data-occludes="top"><div class="seg seg-sliding${cls}"${group} style="--segn:${items.length};--segi:${idx}"><span class="seg-thumb" aria-hidden="true"></span>${buttons}</div></div>`;
}

// The section navigation bar (Plan, Progress, Me): the sliding variant.
function segmentedNavHtml(options: SegmentedNavOptions): string {
  return segmentedHtml({ items: options.items, active: options.active, label: "Section navigation" });
}

function jobCaptionHtml(options: JobCaptionOptions = {}): string {
  const tag = options.tag === "div" ? "div" : "span";
  const className = options.className || "job-cap";
  const text = options.text == null ? "" : escHtml(options.text);
  const attrs = mergeAttrs({ role: "status", "aria-live": "polite", "aria-atomic": "true" }, options.attrs);
  return `<${tag} class="${escAttr(className)}"${uiAttrsHtml(attrs)}>${text}</${tag}>`;
}

function sheetChipHtml(options: SheetChipOptions): string {
  const label = options.label == null ? "" : String(options.label);
  const value = options.value == null ? "" : String(options.value);
  if (!label.trim() && !value.trim()) return "";
  const className = options.className || "sheet-chip";
  const valueHtml = value.trim()
    ? `<span class="${escAttr(options.valueClassName || "numeral")}">${escHtml(value)}</span>`
    : "";
  const labelHtml = label.trim()
    ? `<span class="${escAttr(options.labelClassName || "lbl")}">${escHtml(label)}</span>`
    : "";
  return `<span class="${escAttr(className)}"${uiAttrsHtml(options.attrs)}>${valueHtml}${labelHtml}</span>`;
}

function emptyStateHtml(options: EmptyStateOptions): string {
  const className = options.className || "empty-state reveal";
  const style = options.style ? ` style="${escAttr(options.style)}"` : "";
  const art = options.artHtml ? `<div class="artile artile-lg">${options.artHtml}</div>` : "";
  const bodyClass = options.bodyClassName || "hpic-hero-sub";
  const body = options.body ? `<div class="${escAttr(bodyClass)}">${escHtml(options.body)}</div>` : "";
  const action = actionButtonHtml(options.action);
  return `<div class="${escAttr(className)}" role="status" aria-live="polite"${style}>
    ${art}
    <div class="empty-state-line">${escHtml(options.title)}</div>
    ${body}
    ${action}
  </div>`;
}

const CAIRN_UI = {
  attrsHtml: uiAttrsHtml,
  actionButtonHtml,
  textChipHtml,
  loadingStateHtml,
  segmentedHtml,
  segmentedNavHtml,
  jobCaptionHtml,
  sheetChipHtml,
  emptyStateHtml,
};

Object.assign(globalThis, { CairnUi: CAIRN_UI });

if (typeof window !== "undefined") {
  window.CairnUi = CAIRN_UI;
}
