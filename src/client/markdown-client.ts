// @ts-check
// Tiny dependency-free markdown renderer for assistant chat bubbles.

function mdSafeUrl(url: unknown): string | null {
  const text = String(url ?? "").trim();
  return /^(https?:\/\/|mailto:|\/)/i.test(text) ? text.replace(/"/g, "&quot;") : null;
}

// ---- TeX math -> plain typeset text (no library; chat replies sometimes carry LaTeX) ----
// The source is already HTML-escaped, so every character copied through stays escaped;
// the only markup added here is our own <sub>, <sup> and <span>/<div class="md-math">.
const TEX_WORDS: Record<string, string> = {
  times: "×", cdot: "·", div: "÷", pm: "±", mp: "∓", approx: "≈", sim: "~", le: "≤", leq: "≤",
  ge: "≥", geq: "≥", ne: "≠", neq: "≠", rightarrow: "→", to: "→", leftarrow: "←", Rightarrow: "⇒",
  infty: "∞", circ: "°", degree: "°", ldots: "…", dots: "…", cdots: "…", quad: " ", qquad: " ",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η",
  theta: "θ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ",
  sigma: "σ", tau: "τ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ",
  Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
};
const TEX_TEXT = /^(text|mathrm|textbf|mathbf|textit|mathit|mathsf|operatorname|boldsymbol|mathbb|mathcal)$/;

function texEntityAt(s: string, i: number): string {
  return s.slice(i).match(/^&(#\d+|#x[0-9a-f]+|[a-z]+);/i)?.[0] ?? s[i];
}

function texGroupEnd(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

function texArg(s: string, from: number, depth: number): [string, number] {
  let i = from;
  while (s[i] === " ") i++;
  if (i >= s.length) return ["", i];
  if (s[i] === "{") {
    const end = texGroupEnd(s, i);
    return end < 0 ? [texRun(s.slice(i + 1), depth + 1), s.length] : [texRun(s.slice(i + 1, end), depth + 1), end + 1];
  }
  if (s[i] === "\\") return texCommand(s, i, depth);
  const ch = texEntityAt(s, i);
  return [ch, i + ch.length];
}

function texCommand(s: string, at: number, depth: number): [string, number] {
  const name = s.slice(at + 1).match(/^[A-Za-z]+/)?.[0];
  if (!name) {
    if (at + 1 >= s.length) return ["", at + 1];
    const ch = texEntityAt(s, at + 1);
    const next = at + 1 + ch.length;
    if (ch === "!") return ["", next];
    return [/^[,;: \\]$/.test(ch) ? " " : ch, next];
  }
  const i = at + 1 + name.length;
  if (name === "left" || name === "right") return ["", s[i] === "." ? i + 1 : i];
  if (TEX_TEXT.test(name)) return texArg(s, i, depth);
  if (name === "frac" || name === "dfrac" || name === "tfrac") {
    const [num, a] = texArg(s, i, depth);
    const [den, b] = texArg(s, a, depth);
    const wrap = (h: string): string => (/[\s+\-*/=×·÷±]|&lt;|&gt;/.test(h.replace(/<[^>]+>/g, "")) ? `(${h})` : h);
    return [`${wrap(num)}/${wrap(den)}`, b];
  }
  if (name === "sqrt") {
    const [inner, a] = texArg(s, i, depth);
    return [`√(${inner})`, a];
  }
  return [TEX_WORDS[name] ?? name, i];
}

function texRun(s: string, depth = 0): string {
  if (depth > 8) return s.replace(/[{}\\]/g, "");
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && s.startsWith("&amp;", i + 1)) {
      out += "&amp;";
      i += 6;
    } else if (c === "\\") {
      const [h, next] = texCommand(s, i, depth);
      out += h;
      i = next;
    } else if (c === "^" || c === "_") {
      const [h, next] = texArg(s, i + 1, depth);
      const tag = c === "^" ? "sup" : "sub";
      out += h ? `<${tag}>${h}</${tag}>` : "";
      i = next;
    } else if (c === "{") {
      const [h, next] = texArg(s, i, depth);
      out += h;
      i = next;
    } else if (c === "}") {
      i++;
    } else {
      const ch = texEntityAt(s, i);
      out += ch;
      i += ch.length;
    }
  }
  return out;
}

// Inline `$...$` is math only when it clearly is: no space just inside the delimiters AND a
// TeX signal in the body, so "$5 and $10" and "$1,546" stay money.
// A lone underscore inside a word ("$HOME_DIR/$USER") is not a subscript.
const TEX_SIGNAL = /\\[a-zA-Z]|\^|_\{|_[A-Za-z0-9](?![A-Za-z0-9])/;
const TEX_MAX = 500;
const mathSpan = (tex: string): string => `<span class="md-math">${texRun(tex.trim())}</span>`;
const mathBlock = (tex: string): string => `<div class="md-math md-math-block">${texRun(tex.trim())}</div>`;

function mdStashMath(text: string, stash: (html: string) => string): string {
  const explicit = (m: string, tex: string): string => (tex.trim() && tex.length <= TEX_MAX ? stash(mathSpan(tex)) : m);
  const dollar = (m: string, tex: string): string => (TEX_SIGNAL.test(tex) && tex.length <= TEX_MAX ? stash(mathSpan(tex)) : m);
  return text
    .replace(/(?<!\\)\$\$(?![\s$])((?:\\.|[^$\\])+?)(?<!\s)\$\$/g, dollar)
    .replace(/\\\(([^\n]{1,500}?)\\\)/g, explicit)
    .replace(/\\\[([^\n]{1,500}?)\\\]/g, explicit)
    .replace(/(?<![\\$])\$(?![\s$])((?:\\.|[^$\\])+?)(?<!\s)\$(?![\d$])/g, dollar);
}

const HELD = /\uE000/;

function mdInline(source: string): string {
  // source is already HTML-escaped before inline markdown is applied. Code spans and math are
  // stashed behind placeholders so no later rule (emphasis, links) can touch them.
  const held: string[] = [];
  const stash = (html: string): string => `\uE000${held.push(html) - 1}\uE001`;
  // A code span stashed inside a math span restores with it (one level deep is all there is).
  const restore = (_: string, n: string): string => held[Number(n)].replace(/\uE000(\d+)\uE001/g, (_m, k) => held[Number(k)]);
  const text = mdStashMath(
    source.replace(/[\uE000\uE001]/g, "").replace(/`([^`]+)`/g, (_, code) => stash(`<code>${code}</code>`)),
    stash,
  ).replace(/\\\$/g, "$");
  return text
    .replace(/!\[([^\]]*)\]\(([^()\s]+)\)/g, (match, alt, url) => {
      // A held span (code, math) is restored raw, so it may never land inside an attribute.
      const safeUrl = HELD.test(url) || HELD.test(alt) ? null : mdSafeUrl(url);
      if (!safeUrl && HELD.test(alt + url)) return match;
      return safeUrl ? `<img src="${safeUrl}" alt="${String(alt).replace(/"/g, "&quot;")}" loading="lazy">` : alt || match;
    })
    .replace(/\[([^\]]+)\]\(([^()\s]+)\)/g, (_match, text, url) => {
      if (HELD.test(url)) return _match;
      const safeUrl = mdSafeUrl(url);
      return safeUrl ? `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
    })
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*((?:[^*\n]|\*(?!\*))+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, "$1<em>$2</em>")
    .replace(/\uE000(\d+)\uE001/g, restore);
}

function mdToHtml(source: unknown): string {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  let html = "";
  let index = 0;
  let para: string[] = [];
  const flush = (): void => {
    if (!para.length) return;
    html += `<p>${para.map(mdInline).join("<br>")}</p>`;
    para = [];
  };
  const isTableRow = (line: string): boolean => /^\s*\|.*\|\s*$/.test(line);
  const isTableSep = (line: string): boolean => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-");
  const cells = (line: string): string[] =>
    line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((cell) => mdInline(escHtml(cell.trim())));
  const itemRe = /^([ \t]*)([-*•]|\d+[.)])\s+(.*)$/;
  const itemOf = (line: string): { ind: number; ordered: boolean; rest: string } | null => {
    const m = itemRe.exec(line);
    return m ? { ind: m[1].replace(/\t/g, "    ").length, ordered: /\d/.test(m[2]), rest: m[3] } : null;
  };
  // One list at the current line's indent; a deeper item nests inside the item above it, and an
  // indented non-item line continues that item.
  const list = (): string => {
    const first = itemOf(lines[index]);
    if (!first) return "";
    let items = "";
    while (index < lines.length) {
      const it = itemOf(lines[index]);
      if (!it || it.ind < first.ind || (it.ordered !== first.ordered && it.ind <= first.ind + 1)) break;
      const parts = [mdInline(escHtml(it.rest))];
      let nested = "";
      index++;
      while (index < lines.length && lines[index].trim() && !/^\s*```/.test(lines[index])) {
        const sub = itemOf(lines[index]);
        if (sub) {
          if (sub.ind < it.ind + 2) break;
          nested += list();
        } else if (lines[index].replace(/\t/g, "    ").search(/\S/) > it.ind) parts.push(mdInline(escHtml(lines[index++].trim())));
        else break;
      }
      items += `<li>${parts.join("<br>")}${nested}</li>`;
    }
    return first.ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
  };
  // Display math owns its own block: `$$ ... $$` or `\[ ... \]`, on one line or across several.
  // Unclosed (a streaming reply mid-formula) answers null and renders literally.
  const displayMath = (): string | null => {
    const m = /^\s*(\$\$|\\\[)(.*)$/.exec(lines[index]);
    if (!m) return null;
    const close = m[1] === "$$" ? "$$" : "\\]";
    const body: string[] = [];
    let rest = m[2];
    let at = index;
    for (;;) {
      const end = rest.indexOf(close);
      if (end >= 0) {
        body.push(rest.slice(0, end));
        const tex = body.join(" ");
        if (rest.slice(end + close.length).trim() || !tex.trim() || tex.length > TEX_MAX) return null;
        // A stray "$$" in prose must not pull the lines after it into a formula.
        if (close === "$$" && at > index && !TEX_SIGNAL.test(tex)) return null;
        index = at + 1;
        return mathBlock(escHtml(tex));
      }
      if (at > index && !rest.trim()) return null;
      body.push(rest);
      if (++at >= lines.length || at - index > 20) return null;
      rest = lines[at];
    }
  };
  while (index < lines.length) {
    const raw = lines[index];
    const block = displayMath();
    if (block !== null) {
      flush();
      html += block;
      continue;
    }
    const fence = raw.match(/^\s*```/);
    if (fence) {
      flush();
      index++;
      const code: string[] = [];
      while (index < lines.length && !/^\s*```/.test(lines[index])) code.push(lines[index++]);
      index++;
      html += `<pre><code>${escHtml(code.join("\n"))}</code></pre>`;
      continue;
    }
    if (isTableRow(raw) && index + 1 < lines.length && isTableSep(lines[index + 1])) {
      flush();
      const head = cells(raw);
      index += 2;
      let rows = "";
      while (index < lines.length && isTableRow(lines[index])) rows += `<tr>${cells(lines[index++]).map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
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
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) quote.push(mdInline(escHtml(lines[index++].replace(/^\s*>\s?/, ""))));
      html += `<blockquote>${quote.join("<br>")}</blockquote>`;
      continue;
    }
    if (itemOf(raw)) {
      flush();
      html += list();
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
