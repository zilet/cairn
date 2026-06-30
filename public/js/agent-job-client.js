// @ts-check
// ==== agent-job-client.js ====
// Durable agent jobs: kind-agnostic non-blocking ops + live SSE progress.
// This owns the global runOp/registerJobReconnector compatibility surface used by
// Today, Capture, Progress, Meals, Health, Chat, and boot-time reconnectors.
(() => {
    const jobStreams = new Map();
    const jobDone = new Set();
    const jobHandlers = new Map();
    const jobReconnectors = new Map();
    function agentJobRecord(value) {
        return value && typeof value === "object" ? value : {};
    }
    function agentJobRows(value) {
        return Array.isArray(value) ? value.filter((row) => !!row && typeof row === "object") : [];
    }
    function jobKey(jobId) {
        return String(jobId ?? "");
    }
    function agentJob(value) {
        const row = agentJobRecord(value);
        return row.id != null ? row : null;
    }
    function eventData(event) {
        const data = event.data;
        if (typeof data !== "string" || !data)
            return null;
        try {
            const parsed = JSON.parse(data);
            return agentJobRecord(parsed);
        }
        catch {
            return null;
        }
    }
    function jobStatus(job) {
        return typeof job?.status === "string" ? job.status : "";
    }
    function isTerminal(job) {
        return ["done", "error", "canceled"].includes(jobStatus(job));
    }
    function jobError(row, job) {
        return row.message ?? job?.error ?? null;
    }
    function registerJobReconnector(kind, factory) {
        if (!kind || typeof factory !== "function")
            return;
        jobReconnectors.set(kind, factory);
    }
    async function enqueueJob(path, body) {
        return api(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body || {}),
        });
    }
    function openJobStream(jobId, handlers = {}) {
        const id = jobKey(jobId);
        if (!id || jobStreams.has(id))
            return;
        let es;
        try {
            es = new EventSource(withToken(`/api/agent-jobs/${encodeURIComponent(id)}/stream`));
        }
        catch {
            return;
        }
        jobStreams.set(id, es);
        jobHandlers.set(id, handlers);
        const close = () => {
            const cur = jobStreams.get(id);
            if (cur === es)
                jobStreams.delete(id);
            try {
                es.close();
            }
            catch { }
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
        const finish = (job, result) => {
            if (jobDone.has(id))
                return;
            jobDone.add(id);
            try {
                handlers.onDone?.(result, job);
            }
            catch { }
        };
        es.addEventListener("snapshot", (event) => {
            if (guard())
                return;
            const row = eventData(event);
            if (!row)
                return;
            const job = agentJob(row.job) || agentJob(row);
            if (isTerminal(job)) {
                if (jobStatus(job) === "done")
                    finish(job, row.result != null ? row.result : job?.result);
                else if (jobStatus(job) === "canceled") {
                    try {
                        handlers.onCanceled?.(job);
                    }
                    catch { }
                }
                else {
                    try {
                        handlers.onError?.(jobError(row, job), job);
                    }
                    catch { }
                }
                terminal();
                return;
            }
            try {
                handlers.onSnapshot?.(job);
                handlers.onPhase?.(job);
            }
            catch { }
        });
        es.addEventListener("phase", (event) => {
            if (guard())
                return;
            const row = eventData(event);
            if (!row)
                return;
            try {
                handlers.onPhase?.(agentJob(row.job) || agentJob(row));
            }
            catch { }
        });
        es.addEventListener("done", (event) => {
            if (guard())
                return;
            const row = eventData(event);
            if (!row)
                return;
            finish(agentJob(row.job), row.result);
            terminal();
        });
        es.addEventListener("canceled", (event) => {
            if (guard())
                return;
            const row = eventData(event);
            if (!row)
                return;
            try {
                handlers.onCanceled?.(agentJob(row.job));
            }
            catch { }
            terminal();
        });
        es.addEventListener("error", (event) => {
            const data = event.data;
            if (!data)
                return; // native connection blip; let EventSource reconnect.
            if (guard())
                return;
            const row = eventData(event);
            if (!row)
                return;
            const job = agentJob(row.job);
            try {
                handlers.onError?.(jobError(row, job), job);
            }
            catch { }
            terminal();
        });
    }
    async function jobReconnect() {
        let jobs = [];
        try {
            const res = await api("/agent-jobs");
            const row = agentJobRecord(res);
            jobs = agentJobRows(row.jobs).map(agentJob).filter((job) => !!job);
        }
        catch {
            jobs = [];
        }
        for (const job of jobs) {
            const id = jobKey(job.id);
            if (!id || jobStreams.has(id))
                continue;
            let handlers = jobHandlers.get(id);
            if (!handlers) {
                const factory = jobReconnectors.get(job.kind);
                if (!factory)
                    continue;
                try {
                    handlers = factory(job) || undefined;
                }
                catch {
                    handlers = undefined;
                }
            }
            if (handlers)
                openJobStream(id, handlers);
        }
    }
    function teardownJobs(pred) {
        const keep = typeof pred === "function" ? pred : null;
        for (const [id, es] of [...jobStreams.entries()]) {
            if (keep && !keep(id))
                continue;
            try {
                es.close();
            }
            catch { }
            jobStreams.delete(id);
            jobHandlers.delete(id);
        }
    }
    async function runOp(_kind, body, opts = {}) {
        const { path, anchor, render, onFail, caption, isFail, guard } = opts;
        if (!path)
            return undefined;
        const failCheck = isFail || ((result) => {
            const row = agentJobRecord(result);
            return !result || row.ok === false;
        });
        const anchorGone = () => (anchor ? !document.querySelector(anchor)?.isConnected : false);
        const guardFn = guard || anchorGone;
        const clearFilament = (host) => {
            if (!host)
                return;
            host.classList.remove("is-thinking", "is-thinking--determinate");
            host.style.removeProperty("--frac");
        };
        let stopCaption = () => { };
        const host = anchor ? document.querySelector(anchor) : null;
        const capEl = host ? host.querySelector(".job-cap, .typing-cap") : null;
        if (capEl && caption)
            stopCaption = thinkingCaption(capEl, caption);
        if (host && !reducedMotion())
            host.classList.add("is-thinking");
        const renderResult = (result, job) => {
            stopCaption();
            clearFilament(anchor ? document.querySelector(anchor) : null);
            if (failCheck(result)) {
                onFail?.(result);
                return;
            }
            try {
                render?.(result, job);
            }
            catch { }
        };
        const fail = (error) => {
            stopCaption();
            clearFilament(anchor ? document.querySelector(anchor) : null);
            onFail?.(error);
        };
        let response;
        try {
            response = await enqueueJob(path, body);
        }
        catch {
            fail(null);
            return undefined;
        }
        const job = agentJob(agentJobRecord(response).job);
        if (!job) {
            renderResult(response);
            return undefined;
        }
        openJobStream(job.id, {
            guard: guardFn,
            onPhase: (phaseJob) => {
                const h = anchor ? document.querySelector(anchor) : null;
                const frac = agentJobRecord(agentJobRecord(phaseJob).meta).frac;
                const fracRow = agentJobRecord(frac);
                const total = Number(fracRow.total);
                const done = Number(fracRow.done);
                if (h && Number.isFinite(done) && Number.isFinite(total) && total > 0 && !reducedMotion()) {
                    h.classList.add("is-thinking--determinate");
                    h.style.setProperty("--frac", String(Math.max(0, Math.min(1, done / total))));
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
