import { Router } from "express";
import { onboardFromText } from "../coachOps.js";
import {
  addContextEvent,
  addFamily,
  addSupplement,
  CONTEXT_TAG_VOCAB,
  deleteContextEvent,
  deleteFamily,
  deleteSupplement,
  getInjuryImpacts,
  listContextEvents,
  listContextTags,
  listFamily,
  listSupplements,
  resolveContextEvent,
  toggleContextTag,
  understandSupplements,
  updateContextEvent,
  updateFamily,
  updateSupplement,
} from "../domain/person/index.js";

export const personContextRouter = Router();

// ---- context events (life timeline: trips / injuries / life events) ----
personContextRouter.get("/context-events", (req, res) =>
  res.json(listContextEvents({ activeOnly: req.query.active === "1" || req.query.active === "true" }))
);

personContextRouter.post("/context-events", (req, res) => {
  const b = req.body ?? {};
  if (!b.kind) return res.status(400).json({ error: "kind required" });
  res.json(addContextEvent({
    kind: b.kind,
    title: b.title,
    detail: b.detail,
    start_date: b.start_date,
    end_date: b.end_date,
    meta: b.meta,
    archived: b.archived,
  }));
});

personContextRouter.put("/context-events/:id", (req, res) => {
  const b = req.body ?? {};
  const updated = updateContextEvent(Number(req.params.id), {
    kind: b.kind,
    title: b.title,
    detail: b.detail,
    start_date: b.start_date,
    end_date: b.end_date,
    meta: b.meta,
    archived: b.archived,
  });
  if (!updated) return res.status(404).json({ error: "not found" });
  res.json(updated);
});

// Close a context event as healed/over (one-tap resolve) without hard-deleting it —
// it stays on the timeline and in exports but stops gating the day-read/conductor.
personContextRouter.post("/context-events/:id/resolve", (req, res) => {
  const resolved = resolveContextEvent(Number(req.params.id), (req.body ?? {}).date);
  if (!resolved) return res.status(404).json({ error: "not found" });
  res.json(resolved);
});

personContextRouter.delete("/context-events/:id", (req, res) =>
  res.json(deleteContextEvent(Number(req.params.id)))
);

// Structured injury timeline: for each active injury, the planned exercises it
// touches + calm swap suggestions. Deterministic read: suggestion, never a gate.
personContextRouter.get("/injury-impacts", (_req, res) => res.json(getInjuryImpacts()));

// ---- context tags: cheap one-tap life context, a controlled vocabulary reusing context_events kind='tag' ----
// The vocabulary itself (travel/drinks/rough sleep/work crunch/feeling off).
personContextRouter.get("/context-tags/vocab", (_req, res) => res.json(CONTEXT_TAG_VOCAB));

personContextRouter.get("/context-tags", (req, res) => {
  const date = typeof req.query.date === "string" ? req.query.date : undefined;
  res.json(listContextTags(date));
});

// Tap = tag today, tap again = untag (archives the row). Body: { key, date? }.
personContextRouter.post("/context-tags/toggle", (req, res) => {
  const b = req.body ?? {};
  const key = String(b.key ?? "");
  if (!CONTEXT_TAG_VOCAB.some((t) => t.key === key)) return res.status(400).json({ error: "unknown tag" });
  const date = typeof b.date === "string" ? b.date : undefined;
  try {
    res.json(toggleContextTag(key, date));
  } catch (e) {
    res.status(400).json({ error: String((e as Error)?.message || e) });
  }
});

// ---- family roster (Me -> Family; recurring commitments live as family_event context_events) ----
personContextRouter.get("/family", (_req, res) => res.json(listFamily()));

personContextRouter.post("/family", (req, res) => {
  const b = req.body ?? {};
  res.json(addFamily({
    name: b.name,
    color: b.color,
    relationship: b.relationship,
    birthdate: b.birthdate,
    notes: b.notes,
    allergies: b.allergies,
    dietary_restrictions: b.dietary_restrictions,
  }));
});

personContextRouter.put("/family/:id", (req, res) => {
  const b = req.body ?? {};
  const updated = updateFamily(Number(req.params.id), {
    name: b.name,
    color: b.color,
    relationship: b.relationship,
    birthdate: b.birthdate,
    notes: b.notes,
    allergies: b.allergies,
    dietary_restrictions: b.dietary_restrictions,
  });
  if (!updated) return res.status(404).json({ error: "not found" });
  res.json(updated);
});

personContextRouter.delete("/family/:id", (req, res) => res.json(deleteFamily(Number(req.params.id))));

// ---- supplements (UNDERSTANDING, not a daily log) ----
// Me -> Health "What you're taking". ?all=1 includes stopped ones (active=0).
personContextRouter.get("/supplements", (req, res) =>
  res.json(listSupplements({ activeOnly: req.query.all !== "1" }))
);

// The headline: free text -> understood + approximated + stored. Returns the items.
personContextRouter.post("/supplements/understand", (req, res) => {
  const text = (req.body?.text ?? "").toString();
  if (!text.trim()) return res.status(400).json({ error: "text required" });
  res.json({ ok: true, supplements: understandSupplements(text) });
});

// Add one already-structured supplement (dedup by canonical name).
personContextRouter.post("/supplements", (req, res) => {
  const b = req.body ?? {};
  if (b.text && !b.name) return res.json({ ok: true, supplements: understandSupplements(String(b.text)) });
  if (!b.name) return res.status(400).json({ error: "name or text required" });
  res.json(addSupplement(b));
});

personContextRouter.put("/supplements/:id", (req, res) => {
  const updated = updateSupplement(Number(req.params.id), req.body ?? {});
  if (!updated) return res.status(404).json({ error: "not found" });
  res.json(updated);
});

personContextRouter.delete("/supplements/:id", (req, res) =>
  res.json(deleteSupplement(Number(req.params.id)))
);

// ---- frictionless onboarding ----
// One free-text intro -> understood + applied, then onboarded. Never bug-to-death:
// an empty text just marks onboarded. Always returns ok:true; degrades to the
// deterministic base (about_me + KB supplements) when no agent is reachable.
personContextRouter.post("/onboard", async (req, res) => {
  const text = (req.body?.text ?? "").toString();
  res.json(await onboardFromText(req.body?.agent, text));
});
