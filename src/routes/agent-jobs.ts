import { Router } from "express";
import * as repo from "../repo.js";
import { cancelAgentJob, onJobEvent } from "../agentJobs.js";

export const agentJobsRouter = Router();

// Durable agent jobs are the backgrounded heavy agentic ops. This mirrors the
// chat-turns surface: the PWA's kind-agnostic job runner can restore in-flight
// and queued work after reloads.

// Active (queued + running) jobs, oldest-first.
agentJobsRouter.get("/", (_req, res) => res.json({ ok: true, jobs: repo.listActiveAgentJobs() }));

// One job's current state (poll fallback when SSE is unavailable). A `done` job
// includes job.result = the ref-hydrated contract body.
agentJobsRouter.get("/:id", (req, res) => {
  const job = repo.getAgentJob(Number(req.params.id));
  if (!job) return res.status(404).json({ ok: false, error: "not found" });
  res.json({ ok: true, job });
});

// Stop a queued or running job (drops it / SIGKILLs the live subprocess).
agentJobsRouter.post("/:id/cancel", (req, res) => {
  const job = cancelAgentJob(Number(req.params.id));
  res.json({ ok: !!job, job: job ?? null });
});

// Live progress for one job (Server-Sent Events). An immediate `snapshot` (so a
// late subscriber / poll-fallback sees current state, with the result if already
// terminal), then every phase + the terminal event from the worker bus, then
// close. EventSource can't set headers, so the PWA reaches this with ?token=.
agentJobsRouter.get("/:id/stream", (req, res) => {
  const id = Number(req.params.id);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event: string, data: any) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
  };

  const job = repo.getAgentJob(id) as any;
  if (!job) { send("error", { error: "no such job" }); return res.end(); }

  // Initial snapshot, with the result if the job already finished.
  send("snapshot", { job, ...(job.result !== undefined ? { result: job.result } : {}) });
  if (["done", "error", "canceled"].includes(job.status)) return res.end();

  const keepalive = setInterval(() => { try { res.write(`: keepalive\n\n`); } catch { /* client gone */ } }, 15000);
  let unsubscribe = () => {};
  const cleanup = () => { clearInterval(keepalive); unsubscribe(); };
  unsubscribe = onJobEvent(id, (e) => {
    send(e.type, e);
    if (e.type === "done" || e.type === "error" || e.type === "canceled") { cleanup(); res.end(); }
  });
  req.on("close", cleanup);
});
