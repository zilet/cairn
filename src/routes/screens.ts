import { Router } from "express";
import { trainHomeResponses, youHealthResponses } from "./screen-responses.js";

export const screensRouter = Router();

// Train in ONE request (routes/screen-responses.ts): `?view=overview|program|endurance`
// picks the screen (`goal` serves Horizon's goal line, `fuel` Today's Fuel with `?hour=`),
// `?date=` is the device's local day its dated reads are keyed by.
// `responses` is keyed by the path each individual route answers, with that route's
// exact body — every one of those routes still stands on its own. Not memoized: the
// reads are computed on every open, as the individual routes are.
screensRouter.get("/train-home", (req, res) => {
  // `view=goal` (Horizon's goal line) and `view=fuel` (Today's Fuel, `?hour=` the
  // device's local hour) ride the same fan-in (trainHomeResponses).
  res.json({ responses: trainHomeResponses(req.query.view, req.query.date, req.query.hour) });
});

// You -> Health in ONE request: the standing overview's reads plus the open leaf's own
// (`?leaf=health|records|markers|share`). Health data throughout, so no-store (api.ts).
screensRouter.get("/you-health", (req, res) => {
  res.json({ responses: youHealthResponses(req.query.leaf) });
});
