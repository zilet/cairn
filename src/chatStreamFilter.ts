import { progressLabelFromText } from "./agents.js";
import { CHAT_ACTION_SENTINEL, CHAT_REPLY_SENTINEL } from "./prompt.js";

export type LiveReplyEvent =
  | { type: "progress"; text: string } // transient, sanitized thinking/tool status
  | { type: "delta"; text: string }    // a live chunk of the streaming reply prose
  | { type: "reset" };                 // streaming attempt fell back — clear the partial bubble

export function createChatStreamFilter(emitLive: (e: LiveReplyEvent) => void) {
  // Emit only the prose: hold back a possible partial sentinel mid-stream, and
  // stop the moment the ===CAIRN_ACTIONS=== block begins (that JSON is internal).
  let acc = "";
  let emitted = 0;
  // Reply-marker aware: leading tool-step narration is treated as transient
  // progress, not athlete-facing prose. If the reply marker arrives after any
  // fallback text already showed, reset once and continue from the clean reply.
  // Always hold back a forming sentinel at the tail so a half-marker never flashes.
  // The final reply is re-parsed (and narration-stripped) on `done` regardless.
  let replyAt = -1;
  const TAIL = Math.max(CHAT_ACTION_SENTINEL.length, CHAT_REPLY_SENTINEL.length) - 1;
  let displayStart = 0;
  let lastProgress = "";
  let lastProgressAt = 0;
  let emittedDelta = false;
  const progress = (label: string | null | undefined) => {
    const text = String(label ?? "").trim();
    if (!text) return;
    const now = Date.now();
    if (text === lastProgress && now - lastProgressAt < 1800) return;
    lastProgress = text;
    lastProgressAt = now;
    emitLive({ type: "progress", text });
  };
  const narrationProgress = (line: string): string | null => {
    const s = line.trim();
    if (!s || s.includes(CHAT_REPLY_SENTINEL) || s.includes(CHAT_ACTION_SENTINEL)) return null;
    const verb = /^\s*(I will|I'll|I am going to|I'm going to|Let me|First,?\s+I|Now,?\s+I|Next,?\s+I|Then,?\s+I|I need to|I should|I'll now|Reading|Fetching|Checking|Querying|Listing|Running|Inspecting|Examining|Looking at|Searching|Viewing)\b/i;
    const tech = /(\/\w|\.json\b|\.db\b|\.js\b|\.ts\b|\bsqlite|\bnode\b|\bnpm\b|\btable\b|\bdatabase\b|\bschema\b|\bdirectory\b|\bcommand\b|\bquery\b|\bfile\b|\bfiles\b|\brepo\b|\bworkspace\b|node_modules|package\.json|cairn\.db|chat_messages|chat_turns|\/app\b|\/home\b|\/data\b)/i;
    if (!(verb.test(s) && tech.test(s))) return null;
    return progressLabelFromText(s);
  };
  const skipNarration = (final: boolean): boolean => {
    if (replyAt !== -1) return true;
    const limit = final ? acc.length : Math.max(0, acc.length - TAIL);
    while (displayStart < limit) {
      const rest = acc.slice(displayStart, limit);
      const blank = rest.match(/^\s*\n/);
      if (blank) {
        displayStart += blank[0].length;
        emitted = Math.max(emitted, displayStart);
        continue;
      }
      const nl = rest.indexOf("\n");
      if (nl === -1 && !final) {
        // The first line is still undecided. It may become tool narration when
        // more tokens arrive, so do not stream any part of it yet.
        progress(narrationProgress(rest));
        return false;
      }
      const line = nl === -1 ? rest : rest.slice(0, nl);
      const label = narrationProgress(line);
      if (!label) return true;
      progress(label);
      displayStart += line.length + (nl === -1 ? 0 : 1);
      emitted = Math.max(emitted, displayStart);
    }
    return true;
  };
  const flush = (final: boolean) => {
    if (replyAt === -1) {
      const r = acc.indexOf(CHAT_REPLY_SENTINEL);
      if (r !== -1) {
        replyAt = r + CHAT_REPLY_SENTINEL.length;
        if (emittedDelta) emitLive({ type: "reset" }); // wipe any narration shown before the marker
        emitted = replyAt;
        progress("Writing the reply…");
      } else if (!skipNarration(final)) {
        return;
      }
    }
    const cut = acc.indexOf(CHAT_ACTION_SENTINEL, replyAt === -1 ? 0 : replyAt);
    let safeEnd: number;
    if (cut !== -1) safeEnd = cut;
    else if (final) safeEnd = acc.length;
    else safeEnd = Math.max(emitted, acc.length - TAIL);
    if (safeEnd > emitted) {
      emitLive({ type: "delta", text: acc.slice(emitted, safeEnd) });
      emitted = safeEnd;
      emittedDelta = true;
    }
  };
  return {
    push(piece: string) {
      if (!piece) return;
      acc += piece;
      flush(false);
    },
    finish() {
      flush(true);
    },
    progress,
    reset() {
      emitLive({ type: "reset" });
    },
  };
}
