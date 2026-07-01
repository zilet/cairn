(() => {
// @ts-check
// Pure durable agent-job record normalization and SSE event parsing.
function agentJobRecordValue(value) {
    return value && typeof value === "object" ? value : {};
}
function agentJobRecordRows(value) {
    return Array.isArray(value)
        ? value.filter((row) => !!row && typeof row === "object")
        : [];
}
function agentJobRecordKey(jobId) {
    return String(jobId ?? "");
}
function agentJobRecordJob(value) {
    const row = agentJobRecordValue(value);
    return row.id != null ? row : null;
}
function agentJobRecordEvent(event) {
    const data = event.data;
    if (typeof data !== "string" || !data)
        return null;
    try {
        const parsed = JSON.parse(data);
        return agentJobRecordValue(parsed);
    }
    catch {
        return null;
    }
}
function agentJobRecordStatus(job) {
    return typeof job?.status === "string" ? job.status : "";
}
function agentJobRecordTerminal(job) {
    return ["done", "error", "canceled"].includes(agentJobRecordStatus(job));
}
function agentJobRecordError(row, job) {
    return row.message ?? job?.error ?? null;
}
const CairnAgentJobRecords = {
    error: agentJobRecordError,
    event: agentJobRecordEvent,
    isTerminal: agentJobRecordTerminal,
    job: agentJobRecordJob,
    key: agentJobRecordKey,
    record: agentJobRecordValue,
    rows: agentJobRecordRows,
    status: agentJobRecordStatus,
};
Object.assign(globalThis, { CairnAgentJobRecords });
if (typeof window !== "undefined") {
    Object.assign(window, { CairnAgentJobRecords });
}
})();
