// @ts-check
// ==== agent-job-client.js ====
// Durable agent jobs: kind-agnostic non-blocking ops + live SSE progress.
// This owns the global runOp/registerJobReconnector compatibility surface used by
// Today, Capture, Progress, Meals, Health, Chat, and boot-time reconnectors.

type AgentJob = import("../contracts/client-api.js").ClientAgentJob;
type AgentJobId = string | number;
type AgentJobHandlers = {
  guard?: () => boolean;
  onSnapshot?: (job: AgentJob | null) => unknown;
  onPhase?: (job: AgentJob | null) => unknown;
  onDelta?: (delta: string) => unknown;
  onDone?: (result: unknown, job: AgentJob | null) => unknown;
  onError?: (error?: unknown, job?: AgentJob | null) => unknown;
  onCanceled?: (job?: AgentJob | null) => unknown;
};
type AgentJobReconnector = (job?: AgentJob) => AgentJobHandlers | null | undefined;
type AgentRunOptions = Omit<AgentJobHandlers, "onDelta"> & {
  path?: string;
  anchor?: string;
  caption?: string | readonly string[];
  render?: (result: unknown, job?: AgentJob | null) => unknown;
  onFail?: (error?: unknown) => unknown;
  isFail?: (result: unknown) => boolean;
  // Prose-bearing ops stream their reading into the anchor card token by token. Set
  // `stream: true` for the built-in painter (accumulating escaped prose + a caret,
  // swapped for the final render on done), or pass a custom `onDelta` for full control.
  stream?: boolean;
  onDelta?: (delta: string, accumulated: string, host: Element | null) => unknown;
};

(() => {
const jobStreams = new Map<string, EventSource>();
const jobDone = new Set<string>();
const jobHandlers = new Map<string, AgentJobHandlers>();
const jobReconnectors = new Map<string, AgentJobReconnector>();
const agentJobRecords = (globalThis as unknown as { CairnAgentJobRecords: AgentJobRecordsApi }).CairnAgentJobRecords;

function registerJobReconnector(kind: string, factory: AgentJobReconnector): void {
  if (!kind || typeof factory !== "function") return;
  jobReconnectors.set(kind, factory);
}

async function enqueueJob(path: string, body?: unknown): Promise<unknown> {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
}

function openJobStream(jobId: AgentJobId, handlers: AgentJobHandlers = {}): void {
  const id = agentJobRecords.key(jobId);
  if (!id || jobStreams.has(id)) return;

  let es: EventSource;
  try {
    es = new EventSource(withToken(`/api/agent-jobs/${encodeURIComponent(id)}/stream`));
  } catch {
    return;
  }
  jobStreams.set(id, es);
  jobHandlers.set(id, handlers);

  const close = () => {
    const cur = jobStreams.get(id);
    if (cur === es) jobStreams.delete(id);
    try { es.close(); } catch {}
  };
  const guard = () => {
    if (typeof handlers.guard === "function" && handlers.guard()) {
      close();
      return true;
    }
    return false;
  };
  const terminal = () => {
    close();
    jobHandlers.delete(id);
  };
  const finish = (job: AgentJob | null, result: unknown) => {
    if (jobDone.has(id)) return;
    jobDone.add(id);
    try { handlers.onDone?.(result, job); } catch {}
  };

  es.addEventListener("snapshot", (event) => {
    if (guard()) return;
    const row = agentJobRecords.event(event);
    if (!row) return;
    const job = agentJobRecords.job(row.job) || agentJobRecords.job(row);
    if (agentJobRecords.isTerminal(job)) {
      if (agentJobRecords.status(job) === "done") finish(job, row.result != null ? row.result : job?.result);
      else if (agentJobRecords.status(job) === "canceled") { try { handlers.onCanceled?.(job); } catch {} }
      else { try { handlers.onError?.(agentJobRecords.error(row, job), job); } catch {} }
      terminal();
      return;
    }
    try {
      handlers.onSnapshot?.(job);
      handlers.onPhase?.(job);
    } catch {}
  });

  es.addEventListener("phase", (event) => {
    if (guard()) return;
    const row = agentJobRecords.event(event);
    if (!row) return;
    try { handlers.onPhase?.(agentJobRecords.job(row.job) || agentJobRecords.job(row)); } catch {}
  });

  // Live prose chunk (the four prose-bearing ops). Ephemeral — never persisted; a
  // reconnect mid-stream simply misses the earlier tokens and fills in on `done`.
  es.addEventListener("delta", (event) => {
    if (guard()) return;
    const row = agentJobRecords.event(event);
    const delta = row && typeof row.delta === "string" ? row.delta : "";
    if (delta) { try { handlers.onDelta?.(delta); } catch {} }
  });

  es.addEventListener("done", (event) => {
    if (guard()) return;
    const row = agentJobRecords.event(event);
    if (!row) return;
    finish(agentJobRecords.job(row.job), row.result);
    terminal();
  });

  es.addEventListener("canceled", (event) => {
    if (guard()) return;
    const row = agentJobRecords.event(event);
    if (!row) return;
    try { handlers.onCanceled?.(agentJobRecords.job(row.job)); } catch {}
    terminal();
  });

  es.addEventListener("error", (event) => {
    const data = (event as MessageEvent).data;
    if (!data) return; // native connection blip; let EventSource reconnect.
    if (guard()) return;
    const row = agentJobRecords.event(event);
    if (!row) return;
    const job = agentJobRecords.job(row.job);
    try { handlers.onError?.(agentJobRecords.error(row, job), job); } catch {}
    terminal();
  });
}

async function jobReconnect(): Promise<void> {
  let jobs: AgentJob[] = [];
  try {
    const res = await api("/agent-jobs");
    const row = agentJobRecords.record(res);
    jobs = agentJobRecords.rows(row.jobs).map(agentJobRecords.job).filter((job): job is AgentJob => !!job);
  } catch {
    jobs = [];
  }

  for (const job of jobs) {
    const id = agentJobRecords.key(job.id);
    if (!id || jobStreams.has(id)) continue;
    let handlers = jobHandlers.get(id);
    if (!handlers) {
      const factory = jobReconnectors.get(job.kind);
      if (!factory) continue;
      try { handlers = factory(job) || undefined; } catch { handlers = undefined; }
    }
    if (handlers) openJobStream(id, handlers);
  }
}

function teardownJobs(pred?: ((jobId: string) => boolean) | unknown): void {
  const keep = typeof pred === "function" ? pred as (jobId: string) => boolean : null;
  for (const [id, es] of [...jobStreams.entries()]) {
    if (keep && !keep(id)) continue;
    try { es.close(); } catch {}
    jobStreams.delete(id);
    jobHandlers.delete(id);
  }
}

// Built-in delta painter: accumulate the streamed prose into the anchor card as
// escaped text with a blinking caret (mirrors chat's .stream-text/.stream-caret). The
// done renderer swaps in the final structured card in place. Streamed chunks are
// UNTRUSTED text, so everything goes through escHtml.
function paintJobStream(host: Element | null, accumulated: string): void {
  if (!(host instanceof HTMLElement)) return;
  let box = host.querySelector(".job-stream");
  if (!box) {
    host.innerHTML = `<div class="job-stream"><div class="job-stream-text"></div></div>`;
    box = host.querySelector(".job-stream");
  }
  const body = box?.querySelector(".job-stream-text");
  if (body instanceof HTMLElement) {
    body.innerHTML = `${escHtml(accumulated)}<span class="stream-caret" aria-hidden="true"></span>`;
  }
}

async function runOp(_kind: string, body: Record<string, unknown>, opts: AgentRunOptions = {}): Promise<AgentJob | undefined> {
  const { path, anchor, render, onFail, caption, isFail, guard } = opts;
  if (!path) return undefined;

  const failCheck = isFail || ((result: unknown) => {
    const row = agentJobRecords.record(result);
    return !result || row.ok === false;
  });
  const anchorGone = () => (anchor ? !document.querySelector(anchor)?.isConnected : false);
  const guardFn = guard || anchorGone;
  const clearFilament = (host: Element | null) => {
    if (!host) return;
    host.classList.remove("is-thinking", "is-thinking--determinate");
    (host as HTMLElement).style.removeProperty("--frac");
  };

  let stopCaption = () => {};
  const host = anchor ? document.querySelector(anchor) : null;
  const capEl = host ? host.querySelector(".job-cap, .typing-cap") : null;
  if (capEl && caption) stopCaption = thinkingCaption(capEl, caption);
  if (host && !reducedMotion()) host.classList.add("is-thinking");

  const renderResult = (result: unknown, job?: AgentJob | null) => {
    stopCaption();
    clearFilament(anchor ? document.querySelector(anchor) : null);
    if (failCheck(result)) { onFail?.(result); return; }
    try { render?.(result, job); } catch {}
  };
  const fail = (error?: unknown) => {
    stopCaption();
    clearFilament(anchor ? document.querySelector(anchor) : null);
    onFail?.(error);
  };

  let response: unknown;
  try { response = await enqueueJob(path, body); }
  catch { fail(null); return undefined; }

  const job = agentJobRecords.job(agentJobRecords.record(response).job);
  if (!job) {
    renderResult(response);
    return undefined;
  }

  // Live prose streaming: on the first delta, retire the filament + caption and paint
  // the accumulating reading into the anchor (or hand it to a custom onDelta), then let
  // the done renderer swap in the final card. Absent when neither stream nor onDelta is set.
  let streamAcc = "";
  let streamStarted = false;
  const deltaHandler = (opts.stream || opts.onDelta)
    ? (delta: string) => {
        streamAcc += delta;
        const streamHost = anchor ? document.querySelector(anchor) : null;
        if (!streamStarted) {
          streamStarted = true;
          stopCaption();
          clearFilament(streamHost);
        }
        if (opts.onDelta) { try { opts.onDelta(delta, streamAcc, streamHost); } catch {} }
        else paintJobStream(streamHost, streamAcc);
      }
    : undefined;

  openJobStream(job.id, {
    guard: guardFn,
    onDelta: deltaHandler,
    onPhase: (phaseJob) => {
      const h = anchor ? document.querySelector(anchor) : null;
      const frac = agentJobRecords.record(agentJobRecords.record(phaseJob).meta).frac;
      const fracRow = agentJobRecords.record(frac);
      const total = Number(fracRow.total);
      const done = Number(fracRow.done);
      if (h && Number.isFinite(done) && Number.isFinite(total) && total > 0 && !reducedMotion()) {
        h.classList.add("is-thinking--determinate");
        (h as HTMLElement).style.setProperty("--frac", String(Math.max(0, Math.min(1, done / total))));
      }
    },
    onDone: (result, doneJob) => renderResult(result, doneJob),
    onError: (message) => fail(message || null),
    onCanceled: () => fail(null),
  });
  return job;
}

Object.assign(globalThis, {
  registerJobReconnector,
  enqueueJob,
  openJobStream,
  jobReconnect,
  teardownJobs,
  runOp,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    registerJobReconnector,
    enqueueJob,
    openJobStream,
    jobReconnect,
    teardownJobs,
    runOp,
  });
}
})();
