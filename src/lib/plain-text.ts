// Inline markdown, read as plain words.
//
// Agent-written text reaches the athlete through surfaces that print it verbatim and
// escape it (escHtml) — so a model's "**Monday: Push A.**" showed its asterisks on the
// day page's "the coach adapted this day" card (2026-10-20). Text a person reads off a
// server field goes through here first: emphasis, code ticks, links and line markers
// are dropped, the words kept. Never HTML: the client still escapes what it prints.
//
// Conservative on purpose: a training note is full of characters markdown also uses.
// "- 5 kg", "+ 2.5 kg" and "> 160 bpm" are signs, not list or quote markers; "5**2" is
// arithmetic; "__init__" and "snake__case__name" are identifiers; "[3x5](heavy)" is a
// set scheme with a note. Only what can only be markup is removed.

// A link target that is a URL (or a site path / anchor) — anything else in "(…)" is words.
const URL_TARGET = /^(?:[a-z][a-z0-9+.-]*:\/\/\S+|mailto:\S+|www\.\S+|\/\S*|#\S*)$/i;
// A word character on either side of a delimiter makes it part of the word, not markup.
const WORD = "\\p{L}\\p{N}_";

/** `text` with inline markdown removed (bold, italics, code, links, heading / list markers). */
export function plainInline(text: string): string {
  let out = String(text ?? "");
  // List and quote markers only before words in multi-line text — a single line's
  // "- 5 kg" or "> 160 bpm" is a sign — or, on any line, before more markup ("- **Monday:**"),
  // which no sign is.
  out = out.includes("\n")
    ? out.replace(/^[ \t]{0,3}(?:[-*+][ \t]+|>[ \t]?)(?=[\p{L}*_`[])/gmu, "")
    : out.replace(/^[ \t]{0,3}(?:[-*+][ \t]+|>[ \t]?)(?=\*\*|__|`)/u, "");
  out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
  // A link keeps its words; the target goes only when it is a URL.
  out = out.replace(/!?\[([^\]\n]*)\]\(([^)\s]*)(?:[ \t]+"[^"\n]*")?\)/g, (whole, label: string, target: string) =>
    URL_TARGET.test(target) ? label : whole
  );
  out = out.replace(/`([^`\n]*)`/g, "$1");
  // **bold**: the delimiters hug words (no space just inside), and neither touches a word
  // character outside — "5**2 + 3**2" is arithmetic, never one bold span.
  out = out.replace(new RegExp(`(^|[^${WORD}*])\\*\\*(?![\\s*])([^\\n]*?[^\\s*])\\*\\*(?![${WORD}*])`, "gu"), "$1$2");
  // __bold__: the same, and never a bare identifier ("__init__").
  out = out.replace(
    new RegExp(`(^|[^${WORD}])__(?![\\s_])([^\\n]*?[^\\s_])__(?![${WORD}])`, "gu"),
    (whole, lead: string, inner: string) => (new RegExp(`^[${WORD}]+$`, "u").test(inner) ? whole : `${lead}${inner}`)
  );
  // *italic* / _italic_: opened after a space or an opening mark, closed before one.
  out = out.replace(/(^|[\s(“"'])([*_])(?=[^\s*_])([^*_\n]*?[^\s*_])\2(?=[\s.,;:!?)”"']|$)/gmu, "$1$3");
  return out;
}
