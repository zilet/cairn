import { Router } from "express";
import type { Request, Response } from "express";
import { parseUiViewBatch, recordUiViewCounts, resolveUiViewDay } from "../repo/ui-views.js";

export const uiViewsRouter = Router();

// Aggregate screen opens for today. The body is `{views: [{view, n}]}` — at most
// 20 entries, each n an integer 1..50, plus an optional device `day`. Anything else, including an unknown view
// key, is a 400 and writes nothing. Success is empty: there is nothing to show.
export function uiViewsHandler(req: Request, res: Response): void {
  const entries = parseUiViewBatch(req.body);
  if (!entries) {
    res.status(400).json({ error: "invalid ui view batch" });
    return;
  }
  recordUiViewCounts(entries, resolveUiViewDay((req.body as { day?: unknown }).day));
  res.status(204).end();
}

uiViewsRouter.post("/ui-views", uiViewsHandler);
