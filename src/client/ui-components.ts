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
type EmptyStateOptions = {
  title: unknown;
  body?: unknown;
  artHtml?: string;
  action?: CairnUiAction | null;
  className?: string;
  style?: string;
  bodyClassName?: string;
};

function uiAttrsHtml(attrs: CairnUiAttrs | null | undefined): string {
  const row = attrs && typeof attrs === "object" ? attrs : {};
  return Object.entries(row)
    .filter(([, value]) => value !== false && value != null)
    .map(([key, value]) => {
      const safeKey = /^[a-zA-Z][a-zA-Z0-9_:.:-]*$/.test(key) ? key : "";
      if (!safeKey) return "";
      return value === true ? ` ${safeKey}` : ` ${safeKey}="${escAttr(value)}"`;
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

function emptyStateHtml(options: EmptyStateOptions): string {
  const className = options.className || "empty-state reveal";
  const style = options.style ? ` style="${escAttr(options.style)}"` : "";
  const art = options.artHtml
    ? `<div class="artile artile-lg" style="margin:0 auto 14px">${options.artHtml}</div>`
    : "";
  const bodyClass = options.bodyClassName || "hpic-hero-sub";
  const body = options.body ? `<div class="${escAttr(bodyClass)}">${escHtml(options.body)}</div>` : "";
  const action = actionButtonHtml(options.action);
  return `<div class="${escAttr(className)}"${style}>
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
  emptyStateHtml,
};

Object.assign(globalThis, { CairnUi: CAIRN_UI });

if (typeof window !== "undefined") {
  window.CairnUi = CAIRN_UI;
}
