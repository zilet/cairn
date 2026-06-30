// @ts-check
// Me Memory renderers: pure HTML for remembered facts and preferences.
(() => {
    const MEM_KINDS = ["note", "preference", "constraint", "goal", "fact"];
    function memoryKindOptionsHtml(selected = "") {
        const selectedKind = String(selected || "");
        return MEM_KINDS
            .map((kind) => `<option value="${escAttr(kind)}"${kind === selectedKind ? " selected" : ""}>${escHtml(kind)}</option>`)
            .join("");
    }
    function memoryRowHtml(row, index) {
        const reveal = typeof index === "number";
        const date = String(row.created_at || "").slice(0, 10);
        const source = row.source && row.source !== "user" ? ` · ${escHtml(row.source)}` : "";
        return `<div class="memrow${reveal ? " reveal" : ""}"${reveal ? ` style="${stagger(index)}"` : ""} data-mem="${escAttr(row.id)}">
      <div class="memrow-main">
        <div class="memrow-top"><span class="memtag">${escHtml(row.kind || "note")}</span><span class="memdate">${escHtml(date)}${source}</span></div>
        <div class="memcontent" data-memcontent>${escHtml(row.content || "")}</div>
      </div>
      <div class="memctl">
        <button class="iconbtn" data-memedit title="edit">✎</button>
        <button class="iconbtn memdel" data-memdel title="delete">×</button>
      </div>
    </div>`;
    }
    const CAIRN_MEMORY = {
        MEM_KINDS,
        memoryKindOptionsHtml,
        memoryRowHtml,
    };
    Object.assign(globalThis, { CairnMemory: CAIRN_MEMORY });
    if (typeof window !== "undefined") {
        window.CairnMemory = CAIRN_MEMORY;
    }
})();
