import { Router } from "express";
import * as repo from "../repo.js";

export const personRouter = Router();

// ---- profile & goal ----
personRouter.get("/profile", (_req, res) => res.json(repo.getProfile()));
personRouter.put("/profile", (req, res) => {
  const body = req.body ?? {};
  // A real goal change is a confirmation: restart the gentle goal-check clock so
  // it does not resurface immediately after the athlete just set it.
  if ("goal_mode" in body || "goal_weight_lb" in body || "goal_date" in body) {
    try {
      repo.confirmGoalCheckin();
    } catch {
      /* best-effort */
    }
  }
  res.json(repo.setProfile(body));
});
personRouter.get("/goal", (_req, res) => res.json(repo.computeGoalCheck()));

// ---- bodyweight log ----
personRouter.get("/bodyweight", (req, res) =>
  res.json(repo.listWeight(req.query.limit ? Number(req.query.limit) : 60))
);
personRouter.post("/bodyweight", (req, res) => {
  const b = req.body ?? {};
  if (b.weight_lb == null) return res.status(400).json({ error: "weight_lb required" });
  res.json(repo.logWeight(Number(b.weight_lb), b.date, b.note));
});

// ---- blood pressure log ----
// A BP reading is point-in-time, not a profile field: home cuffs, MyChart vitals
// and clinic readings all land as dated observations that also project into the
// marker history as Systolic BP / Diastolic BP / Pulse.
personRouter.get("/blood-pressure", (req, res) =>
  res.json(repo.listBloodPressureReadings(req.query.limit ? Number(req.query.limit) : 60))
);
personRouter.post("/blood-pressure", (req, res) => {
  const b = req.body ?? {};
  try {
    const row = repo.addBloodPressureReading({
      measured_at: b.measured_at ?? b.measuredAt ?? null,
      systolic: b.systolic,
      diastolic: b.diastolic,
      pulse: b.pulse == null || b.pulse === "" ? null : b.pulse,
      source: b.source ?? "manual",
      position: b.position ?? null,
      note: b.note ?? null,
    });
    try {
      repo.deriveDirectives();
    } catch {
      /* never fail the vital log */
    }
    res.json(row);
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "could not log blood pressure" });
  }
});
personRouter.delete("/blood-pressure/:id", (req, res) =>
  res.json(repo.deleteBloodPressureReading(Number(req.params.id)))
);

// ---- optional morning check-in (T5C: a day-read signal, offered never required) ----
// All fields optional; mood/energy/sleep_feel/soreness are clamped to 1-5 in the
// repo. GET /checkins?date= returns the latest for that date (or null);
// GET /checkins (no date) lists recent.
personRouter.post("/checkins", (req, res) => {
  const b = req.body ?? {};
  res.json(repo.addCheckin(b.date, {
    mood: b.mood,
    energy: b.energy,
    sleep_feel: b.sleep_feel,
    soreness: b.soreness,
    note: b.note,
  }));
});
personRouter.get("/checkins", (req, res) => {
  if (req.query.date) return res.json(repo.getCheckinByDate(String(req.query.date)));
  res.json(repo.listCheckins(req.query.limit ? Number(req.query.limit) : 14));
});
