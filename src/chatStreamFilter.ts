import { progressLabelFromText } from "./agents.js";
import { CHAT_ACTION_SENTINEL, CHAT_REPLY_SENTINEL } from "./prompt.js";

export type LiveReplyEvent =
  | { type: "progress"; text: string } // transient, sanitized thinking/tool status
  | { type: "delta"; text: string }    // a live chunk of the streaming reply prose
  | { type: "reset" };                 // streaming attempt fell back — clear the partial bubble

// Marker-aware streaming gate for the chat reply.
//
// The reply contract (prompt.ts) asks the model to write ===CAIRN_REPLY=== on its
// own line right before the athlete-facing reply, then ===CAIRN_ACTIONS=== before
// the internal JSON. Autonomous CLIs (and Claude Code between tool calls) narrate
// their working thoughts as plain text BEFORE that reply marker. The earlier design
// tried to classify those leading lines and stream the "non-narration" ones — but
// plain interim commentary ("Let me look at your recent training…") isn't tool
// narration, so it streamed into the bubble and then got WIPED when the real reply
// marker finally landed. That show-then-retract is the "thinking looks cut off" bug.
//
// This filter fixes it structurally: NOTHING before the reply marker is ever emitted
// as reply text — pre-marker output surfaces only as sanitized `progress` captions.
// Deltas begin only AFTER the marker, so there is never anything to retract. The
// accumulated reply prose is kept so a reconnecting client (iOS backgrounding kills
// the EventSource) can be handed the streamed-so-far text in the SSE snapshot.
export function createChatStreamFilter(emitLive: (e: LiveReplyEvent) => void) {
  let acc = "";
  let replyAt = -1;          // index in acc just past CHAT_REPLY_SENTINEL, once seen
  let emitted = 0;           // how far into acc we've emitted the reply as deltas
  let progressedTo = 0;      // how far into the PRE-marker text we've captioned
  let accumulatedReply = ""; // the reply prose streamed so far (for the SSE snapshot)
  // Always hold back a forming sentinel at the tail so a half-marker never streams
  // (and a forming reply marker isn't mistaken for a completed pre-marker line).
  const TAIL = Math.max(CHAT_ACTION_SENTINEL.length, CHAT_REPLY_SENTINEL.length) - 1;
  let lastProgress = "";
  let lastProgressAt = 0;

  const progress = (label: string | null | undefined) => {
    const text = String(label ?? "").trim();
    if (!text) return;
    const now = Date.now();
    if (text === lastProgress && now - lastProgressAt < 1800) return;
    lastProgress = text;
    lastProgressAt = now;
    emitLive({ type: "progress", text });
  };

  // Pre-marker text is never athlete-facing — surface it only as a sanitized,
  // category-level progress caption (progressLabelFromText never echoes raw text).
  const captionPreMarker = (final: boolean) => {
    // Only treat a line as "complete" up to the tail-safe boundary, so a forming
    // reply marker at the very end isn't consumed as a finished narration line.
    const lineLimit = final ? acc.length : Math.max(0, acc.length - TAIL);
    while (progressedTo < lineLimit) {
      const nl = acc.indexOf("\n", progressedTo);
      if (nl === -1 || nl >= lineLimit) break;
      const line = acc.slice(progressedTo, nl);
      if (line.trim()) progress(progressLabelFromText(line));
      progressedTo = nl + 1;
    }
    // Caption the current in-progress line from the full buffer (captions carry no
    // raw text, so there's no sentinel-leak risk in reading past the tail guard).
    const tail = acc.slice(progressedTo);
    if (tail.trim()) progress(progressLabelFromText(tail));
  };

  // Post-marker: stream the reply prose, stopping at the LAST action sentinel so a
  // reply that merely MENTIONS "===CAIRN_ACTIONS===" isn't truncated there. This
  // mirrors parseChatReply's lastIndexOf on `done`, so the live view and the final
  // render agree. Text only ever grows forward — no retraction, ever.
  const streamReply = (final: boolean) => {
    const cut = acc.lastIndexOf(CHAT_ACTION_SENTINEL);
    let safeEnd: number;
    if (cut >= replyAt) safeEnd = cut;               // the real actions block
    else if (final) safeEnd = acc.length;
    else safeEnd = Math.max(emitted, acc.length - TAIL);
    if (safeEnd > emitted) {
      const chunk = acc.slice(emitted, safeEnd);
      emitted = safeEnd;
      accumulatedReply += chunk;
      emitLive({ type: "delta", text: chunk });
    }
  };

  const flush = (final: boolean) => {
    if (replyAt === -1) {
      const r = acc.indexOf(CHAT_REPLY_SENTINEL);
      if (r === -1) { captionPreMarker(final); return; }
      replyAt = r + CHAT_REPLY_SENTINEL.length;
      emitted = replyAt;
      progress("Writing the reply…");
    }
    streamReply(final);
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
    // The reply prose streamed so far — handed to a reconnecting client so a turn
    // interrupted mid-stream (iOS backgrounding) doesn't come back a hollow bubble.
    reply: () => accumulatedReply,
    reset() {
      accumulatedReply = "";
      emitLive({ type: "reset" });
    },
  };
}
