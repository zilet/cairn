import { Router } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  cancelTurn,
  completeInstantFoodCapture,
  enqueueChatTurn,
  getTurnPartialReply,
  isInstantFoodCaptureDecision,
  onTurnEvent,
} from "../chatTurns.js";
import { enqueueAgentJob } from "../agentJobs.js";
import {
  archiveChat,
  clearChat,
  createAgentJob,
  createChatRequest,
  getArchivedConversation,
  getChatMessage,
  getChatTurn,
  getSettings,
  listActiveChatTurns,
  listArchivedSessions,
  listChatMessages,
  replayChatRequest,
  searchChatMessages,
} from "../domain/person/index.js";
import { classifyChatRoute } from "../chatRouting.js";
import { hasRecentFoodNote } from "../domain/nutrition/index.js";
import { UPLOADS_DIR } from "../uploadPaths.js";
import { extForMime, isAcceptedMime } from "../uploadMime.js";

export const chatRouter = Router();

const CHAT_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const CHAT_REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export function normalizeChatRequestId(value: unknown): string | null {
  if (value == null || value === "") return null;
  const requestId = String(value).trim();
  if (!CHAT_REQUEST_ID_RE.test(requestId)) throw new Error("invalid request_id");
  return requestId;
}

// A committed request must always be driven toward a terminal state, including
// when the original HTTP response was lost after SQLite committed but before the
// instant receipt or in-process enqueue completed. Replays use only the durable
// row's message/routing (never the retry payload), so resuming is deterministic
// and cannot repeat a food-note side effect.
function resumePersistedChatTurn(turn: any) {
  if (!turn || turn.status !== "queued") return turn;
  if (isInstantFoodCaptureDecision(turn.routing, turn.message)) {
    const completed = completeInstantFoodCapture(Number(turn.id), String(turn.message ?? ""));
    if (completed?.turn) return completed.turn;
  }
  enqueueChatTurn(Number(turn.id));
  return getChatTurn(Number(turn.id));
}

chatRouter.get("/", (req, res) => res.json(listChatMessages(req.query.limit ? Number(req.query.limit) : 50)));

// Chat is now a DURABLE, non-blocking turn (see src/chatTurns.ts): we persist the
// user message + a chat_turn and hand it to the serial worker, returning at once.
// The PWA streams progress over GET /api/chat/turns/:id/stream and rebuilds the
// in-flight + queued thread from GET /api/chat/turns on (re)load — so a follow-up
// queued mid-think, or a turn interrupted by navigation/reload/restart, survives.
chatRouter.post("/", (req, res) => {
  const b = req.body ?? {};
  const rawMessage = (b.message ?? "").toString();
  const message = rawMessage.trim();
  let requestId: string | null;
  try {
    requestId = normalizeChatRequestId(b.request_id);
  } catch {
    return res.status(400).json({ error: "request_id must be 8-128 URL-safe characters" });
  }

  // Retry lookup precedes base64 decoding and file creation. A response lost
  // after commit therefore reuses the existing message/turn/note/upload exactly.
  if (requestId) {
    const replay = replayChatRequest(requestId) as any;
    if (replay?.turn) {
      const turn = resumePersistedChatTurn(replay.turn);
      return res.json({ ok: true, ...replay, turn, replayed: true });
    }
  }

  // Optional attached photo (plate shot etc.): saved like a health-doc upload,
  // then the agent gets the absolute path and looks at the file itself.
  let imagePath: string | null = null;
  let imageUrl: string | null = null;
  if (b.image_base64) {
    const mime = (b.image_mime ?? "").toString().toLowerCase();
    if (!mime.startsWith("image/") || !isAcceptedMime(mime)) {
      return res.status(400).json({ error: "image_mime must be an accepted raster image type" });
    }
    let buf: Buffer;
    try {
      buf = Buffer.from(String(b.image_base64), "base64");
    } catch {
      return res.status(400).json({ error: "invalid base64" });
    }
    if (!buf.length) return res.status(400).json({ error: "empty image" });
    if (buf.length > CHAT_IMAGE_MAX_BYTES) return res.status(413).json({ error: "image too large" });
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const name = `${crypto.randomUUID()}.${extForMime(mime)}`;
    imagePath = path.join(UPLOADS_DIR, name);
    fs.writeFileSync(imagePath, buf);
    imageUrl = `/api/chat-images/${name}`;
  }

  if (!message && !imagePath) return res.status(400).json({ error: "message or image required" });

  const settings = getSettings();
  const routing =
    settings.chat_routing_mode === "adaptive"
      ? classifyChatRoute({ message, has_image: !!imagePath, recent_food_capture: hasRecentFoodNote() })
      : null;
  let created: any;
  try {
    created = createChatRequest({
      message,
      image_path: imagePath,
      image_url: imageUrl,
      agent: b.agent ?? null,
      request_id: requestId,
      user_content: message || "(photo)",
      user_meta: imageUrl ? { image: imageUrl } : undefined,
      ...(routing ? { routing } : {}),
    });
  } catch (error) {
    // The unique index is the final race guard. If another request committed the
    // same key after our initial lookup, discard only this request's new upload
    // and return the durable winner.
    if (requestId) {
      const replay = replayChatRequest(requestId) as any;
      if (replay?.turn) {
        if (imagePath) {
          try {
            fs.unlinkSync(imagePath);
          } catch {
            /* no orphan cleanup needed */
          }
        }
        const replayedTurn = resumePersistedChatTurn(replay.turn);
        return res.json({ ok: true, ...replay, turn: replayedTurn, replayed: true });
      }
    }
    if (imagePath) {
      try {
        fs.unlinkSync(imagePath);
      } catch {
        /* preserve the original error */
      }
    }
    throw error;
  }
  const turn = created.turn;
  const userMsg = created.user_message;
  const progressedTurn = resumePersistedChatTurn(turn);
  res.json({ ok: true, turn: progressedTurn, user_message: userMsg });
});

// Read-only history: browse past conversations (archived by "fresh start") and
// search across everything. These never mutate — nothing is hard-deleted.
chatRouter.get("/search", (req, res) =>
  res.json(searchChatMessages(String(req.query.q ?? ""), req.query.limit ? Number(req.query.limit) : 40))
);
chatRouter.get("/sessions", (req, res) =>
  res.json(listArchivedSessions(req.query.limit ? Number(req.query.limit) : 50))
);
chatRouter.get("/sessions/:sessionId", (req, res) => res.json(getArchivedConversation(req.params.sessionId)));

// "Clear" archives rather than deletes (repo.clearChat -> archiveChat): chat is
// part of the user's history/export, so nothing is hard-deleted anymore.
chatRouter.delete("/", (_req, res) => res.json(clearChat()));

// "Fresh start": ARCHIVE the live conversation immediately (so the composer is
// usable at once — no blocking on the agent), then distill durable facts from the
// pre-archive history into memory in the BACKGROUND as a chat_distill job. The
// PWA settles a "remembered" pill when the job lands; a message typed during
// the distill just queues as a normal chat turn (archive-before-enqueue keeps the
// ordering). This always queues: resetting chat never waits on a coaching CLI.
chatRouter.post("/reset", async (req, res) => {
  const history = listChatMessages(200);
  if (!history.length) return res.json({ ok: true, distilled: 0, archived: 0 });
  const agent = req.body?.agent ?? null;
  const snapshot = history.map((m: any) => ({ role: m.role, content: m.content }));
  const { archived, session_id } = archiveChat();
  const job = createAgentJob({ kind: "chat_distill", input: { agent, history: snapshot }, agent });
  enqueueAgentJob((job as any).id);
  return res.json({ ok: true, archived, session_id, distilling: (job as any).id });
});

// Active (queued + running) turns, oldest-first — the PWA reconstructs the live
// in-flight + queued thread from this on every (re)load (durable across restarts).
chatRouter.get("/turns", (_req, res) => res.json(listActiveChatTurns()));

// One turn's current state (poll fallback when SSE is unavailable). Carries the
// reply prose streamed so far so a poll-driven client fills the bubble live too.
chatRouter.get("/turns/:id", (req, res) => {
  const id = Number(req.params.id);
  const turn = getChatTurn(id) as any;
  if (!turn) return res.json(null);
  const partial = getTurnPartialReply(id);
  res.json(partial ? { ...turn, partial_reply: partial } : turn);
});

// Stop a queued or running turn (drops it / SIGKILLs the live subprocess).
chatRouter.post("/turns/:id/cancel", (req, res) => {
  const turn = cancelTurn(Number(req.params.id));
  res.json({ ok: !!turn, turn: turn ?? null });
});

// Live progress for one turn (Server-Sent Events). Sends an immediate snapshot
// (so a late subscriber / poll-fallback sees current state), then forwards every
// phase + the terminal event from the worker bus, then closes. A keepalive comment
// holds the connection through proxies. EventSource can't set headers, so the PWA
// reaches this with ?token= (withToken) when auth is on.
chatRouter.get("/turns/:id/stream", (req, res) => {
  const id = Number(req.params.id);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event: string, data: any) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* client gone */
    }
  };

  const turn = getChatTurn(id) as any;
  if (!turn) {
    send("error", { error: "no such turn" });
    return res.end();
  }

  // Initial snapshot, with the assistant message if the turn already finished, or
  // the reply prose streamed so far if it's still running (a reconnecting client —
  // iOS kills the EventSource on backgrounding — REPLACES its bubble with this so
  // an interrupted stream comes back filled, not hollow).
  const assistantMsg = turn.assistant_message_id ? getChatMessage(turn.assistant_message_id) : null;
  const partialReply = getTurnPartialReply(id);
  send("snapshot", { turn, message: assistantMsg, partial_reply: partialReply || undefined });
  if (["done", "error", "canceled"].includes(turn.status)) return res.end();

  const keepalive = setInterval(() => {
    try {
      res.write(`: keepalive\n\n`);
    } catch {
      /* client gone */
    }
  }, 15000);
  let unsubscribe = () => {};
  const cleanup = () => {
    clearInterval(keepalive);
    unsubscribe();
  };
  unsubscribe = onTurnEvent(id, (e) => {
    send(e.type, e);
    if (e.type === "done" || e.type === "error" || e.type === "canceled") {
      cleanup();
      res.end();
    }
  });
  req.on("close", cleanup);
});
