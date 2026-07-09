import type { Request, Response } from "express";
import { onEnrichEvent, isEnrichTerminal, type EnrichResourceKind } from "../enrichBus.js";

// Shared Server-Sent-Events handler for the three polled enrichment resources
// (activities / food-notes / health-docs). It replaces the PWA's status polling:
// an immediate `snapshot` with the row's current PUBLIC shape, then an `update`
// per status transition off the enrich bus, then close on a terminal status.
// Modelled 1:1 on the agent-jobs stream (src/routes/agent-jobs.ts): snapshot then
// subscribe with NO await between them, so a transition can never slip through the
// gap (an emit only runs in a separate task). EventSource can't set headers, so the
// PWA reaches this with ?token= — the matching /stream paths are on the auth
// query-token allowlist (src/auth.ts).
//
// `getRow` MUST return the same public shape the sibling GET /:id route returns —
// for health docs that is getHealthDocument (never the raw file_path).
export function streamEnrichRow(kind: EnrichResourceKind, getRow: (id: number) => any) {
  return (req: Request, res: Response) => {
    const id = Number(req.params.id);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event: string, data: unknown) => {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        /* client gone */
      }
    };

    const row = getRow(id);
    if (!row) {
      send("error", { error: "not found" });
      return res.end();
    }

    // Initial snapshot. If the row is already terminal (done/failed/skipped/null),
    // there is nothing to wait for — end right after.
    send("snapshot", { row });
    if (isEnrichTerminal(row.enrichment_status)) return res.end();

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
    unsubscribe = onEnrichEvent(kind, id, (e) => {
      send("update", { row: e.row });
      if (isEnrichTerminal(e.status)) {
        cleanup();
        res.end();
      }
    });
    req.on("close", cleanup);
  };
}
