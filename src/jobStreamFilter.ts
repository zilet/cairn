import { CHAT_ACTION_SENTINEL, CHAT_REPLY_SENTINEL } from "./prompt.js";

// Marker-aware streaming gate for the prose-bearing JOB ops (health synthesis,
// session-suggest, nutrition check-in, weekly read) — the server-side sibling of
// chatStreamFilter.ts, deliberately SIMPLER.
//
// The reply contract (prompt.ts renderStreamingContract) asks the model to write
// ===CAIRN_REPLY=== on its own line before the athlete-facing prose, then
// ===CAIRN_ACTIONS=== before the structured JSON the op parses. Jobs need none of
// chat's machinery (no progress captions, no reconnect snapshot, no reset): they just
// paint the prose into a waiting card. So this filter BUFFERS everything until the
// reply marker is seen, emits the prose as `onDelta` chunks, and STOPS at the data
// marker — pre-marker tool narration never reaches the card, so there is nothing to
// retract and no `reset` event. Text only ever grows forward.
export function createJobStreamFilter(onDelta: (chunk: string) => void) {
  let acc = "";
  let replyAt = -1; // index in acc just past CHAT_REPLY_SENTINEL, once seen
  let emitted = 0; // how far into acc we've emitted the reply as deltas
  let emittedAny = false;
  // Always hold back a forming sentinel at the tail so a half-marker never streams
  // as prose (and a forming action marker isn't mistaken for finished reply text).
  const TAIL = Math.max(CHAT_ACTION_SENTINEL.length, CHAT_REPLY_SENTINEL.length) - 1;

  // Post-marker: stream the prose, stopping at the LAST action sentinel (so a reply
  // that merely MENTIONS the marker isn't truncated there — mirrors extractMarkedJson's
  // lastIndexOf). The leading whitespace after the reply marker line is swallowed so
  // the card never opens with a blank line.
  const stream = (final: boolean) => {
    const cut = acc.lastIndexOf(CHAT_ACTION_SENTINEL);
    let safeEnd: number;
    if (cut >= replyAt)
      safeEnd = cut; // the real actions block
    else if (final) safeEnd = acc.length;
    else safeEnd = Math.max(emitted, acc.length - TAIL); // hold back a forming marker
    if (safeEnd <= emitted) return;
    let chunk = acc.slice(emitted, safeEnd);
    emitted = safeEnd;
    if (!emittedAny) {
      chunk = chunk.replace(/^\s+/, "");
      if (!chunk) return; // still only whitespace after the marker — wait for real prose
      emittedAny = true;
    }
    onDelta(chunk);
  };

  const flush = (final: boolean) => {
    if (replyAt === -1) {
      const r = acc.indexOf(CHAT_REPLY_SENTINEL);
      if (r === -1) return; // pre-marker narration — emit nothing
      replyAt = r + CHAT_REPLY_SENTINEL.length;
      emitted = replyAt;
    }
    stream(final);
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
  };
}
