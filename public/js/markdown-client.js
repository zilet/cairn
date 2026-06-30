(() => {
// @ts-check
// Tiny dependency-free markdown renderer for assistant chat bubbles.
function mdSafeUrl(url) {
    const text = String(url ?? "").trim();
    return /^(https?:\/\/|mailto:|\/)/i.test(text) ? text.replace(/"/g, "&quot;") : null;
}
function mdInline(source) {
    // source is already HTML-escaped before inline markdown is applied.
    return source
        .replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`)
        .replace(/!\[([^\]]*)\]\(([^()\s]+)\)/g, (match, alt, url) => {
        const safeUrl = mdSafeUrl(url);
        return safeUrl ? `<img src="${safeUrl}" alt="${String(alt).replace(/"/g, "&quot;")}" loading="lazy">` : alt || match;
    })
        .replace(/\[([^\]]+)\]\(([^()\s]+)\)/g, (_match, text, url) => {
        const safeUrl = mdSafeUrl(url);
        return safeUrl ? `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
    })
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, "$1<em>$2</em>")
        .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, "$1<em>$2</em>");
}
function mdToHtml(source) {
    const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
    let html = "";
    let index = 0;
    let para = [];
    const flush = () => {
        if (!para.length)
            return;
        html += `<p>${para.map(mdInline).join("<br>")}</p>`;
        para = [];
    };
    const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
    const isTableSep = (line) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-");
    const cells = (line) => line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => mdInline(escHtml(cell.trim())));
    while (index < lines.length) {
        const raw = lines[index];
        const fence = raw.match(/^\s*```/);
        if (fence) {
            flush();
            index++;
            const code = [];
            while (index < lines.length && !/^\s*```/.test(lines[index]))
                code.push(lines[index++]);
            index++;
            html += `<pre><code>${escHtml(code.join("\n"))}</code></pre>`;
            continue;
        }
        if (isTableRow(raw) && index + 1 < lines.length && isTableSep(lines[index + 1])) {
            flush();
            const head = cells(raw);
            index += 2;
            let rows = "";
            while (index < lines.length && isTableRow(lines[index]))
                rows += `<tr>${cells(lines[index++]).map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
            html += `<div class="md-tablewrap"><table><thead><tr>${head.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
            continue;
        }
        const line = escHtml(raw);
        const heading = line.match(/^(#{1,6})\s+(.*)$/);
        if (heading) {
            flush();
            const level = Math.min(heading[1].length + 2, 6);
            html += `<h${level}>${mdInline(heading[2])}</h${level}>`;
            index++;
            continue;
        }
        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
            flush();
            html += "<hr>";
            index++;
            continue;
        }
        if (/^\s*&gt;\s?/.test(line)) {
            flush();
            const quote = [];
            while (index < lines.length && /^\s*>\s?/.test(lines[index]))
                quote.push(mdInline(escHtml(lines[index++].replace(/^\s*>\s?/, ""))));
            html += `<blockquote>${quote.join("<br>")}</blockquote>`;
            continue;
        }
        const ul = /^\s*[-*•]\s+/;
        const ol = /^\s*\d+[.)]\s+/;
        if (ul.test(raw) || ol.test(raw)) {
            flush();
            const ordered = ol.test(raw);
            const marker = ordered ? ol : ul;
            let items = "";
            while (index < lines.length && marker.test(lines[index]))
                items += `<li>${mdInline(escHtml(lines[index++].replace(marker, "")))}</li>`;
            html += ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
            continue;
        }
        if (!raw.trim()) {
            flush();
            index++;
            continue;
        }
        para.push(line);
        index++;
    }
    flush();
    return html || "";
}
const CAIRN_MARKDOWN = {
    mdSafeUrl,
    mdInline,
    mdToHtml,
};
Object.assign(globalThis, {
    CairnMarkdown: CAIRN_MARKDOWN,
    mdSafeUrl,
    mdInline,
    mdToHtml,
});
if (typeof window !== "undefined") {
    Object.assign(window, {
        CairnMarkdown: CAIRN_MARKDOWN,
        mdSafeUrl,
        mdInline,
        mdToHtml,
    });
}
})();
