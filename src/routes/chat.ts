import { Router } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { enqueueChatTurn, cancelTurn, onTurnEvent, getTurnPartialReply } from "../chatTurns.js";
import { enqueueAgentJob } from "../agentJobs.js";
import {
  addChatMessage,
  archiveChat,
  clearChat,
  createAgentJob,
  createChatTurn,
  getArchivedConversation,
  getChatMessage,
  getChatTurn,
  listActiveChatTurns,
  listArchivedSessions,
  listChatMessages,
  searchChatMessages,
} from "../domain/person/index.js";
import { UPLOADS_DIR } from "../uploadPaths.js";
import { extForMime, isAcceptedMime } from "../uploadMime.js";

export const chatRouter = Router();

const CHAT_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

chatRouter.get("/", (req, res) => res.json(listChatMessages(req.query.limit ? Number(req.query.limit) : 50)));

// Chat is now a DURABLE, non-blocking turn (see src/chatTurns.ts): we persist the
// user message + a chat_turn and hand it to the serial worker, returning at once.
// The PWA streams progress over GET /api/chat/turns/:id/stream and rebuilds the
// in-flight + queued thread from GET /api/chat/turns on (re)load — so a follow-up
// queued mid-think, or a turn interrupted by navigation/reload/restart, survives.
chatRouter.post("/", (req, res) => {
  const b = req.body ?? {};
  const message = (b.message ?? "").toString().trim();

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

  const userMsg = addChatMessage("user", message || "(photo)", null, imageUrl ? { image: imageUrl } : undefined);
  const turn = createChatTurn({
    message,
    image_path: imagePath,
    image_url: imageUrl,
    agent: b.agent ?? null,
    user_message_id: (userMsg as any).id,
  });
  enqueueChatTurn((turn as any).id);
  res.json({ ok: true, turn, user_message: userMsg });
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
