import { Router } from "express";
import { authEnabled } from "../auth.js";
import { getUpdateStatus, checkForUpdate } from "../updateCheck.js";
import { getVersion } from "../version.js";

export const systemRouter = Router();

systemRouter.get("/health", (_req, res) =>
  res.json({ ok: true, auth_required: authEnabled, version: getVersion() })
);

// The running version, and whether a newer Cairn release exists. The status is
// served from the app_state cache; the scheduler keeps it fresh, and POST forces
// an explicit operator-pulled check.
systemRouter.get("/version", (_req, res) => res.json({ version: getVersion() }));
systemRouter.get("/update-status", (_req, res) => res.json(getUpdateStatus()));
systemRouter.post("/update-check", async (_req, res) => {
  // checkForUpdate never throws; network failures fold into status.error.
  res.json(await checkForUpdate());
});
