// @ts-check
// Pure durable agent-job record normalization and SSE event parsing.

type AgentJobRecordsClientJob = import("../contracts/client-api.js").ClientAgentJob;
type AgentJobRecordsRecord = Record<string, unknown>;
type AgentJobRecordsApi = {
  error(row: AgentJobRecordsRecord, job: AgentJobRecordsClientJob | null): unknown;
  event(event: Event): AgentJobRecordsRecord | null;
  isTerminal(job: AgentJobRecordsClientJob | null): boolean;
  job(value: unknown): AgentJobRecordsClientJob | null;
  key(jobId: unknown): string;
  record(value: unknown): AgentJobRecordsRecord;
  rows(value: unknown): AgentJobRecordsRecord[];
  status(job: AgentJobRecordsClientJob | null): string;
};

function agentJobRecordValue(value: unknown): AgentJobRecordsRecord {
  return value && typeof value === "object" ? (value as AgentJobRecordsRecord) : {};
}

function agentJobRecordRows(value: unknown): AgentJobRecordsRecord[] {
  return Array.isArray(value)
    ? (value.filter((row) => !!row && typeof row === "object") as AgentJobRecordsRecord[])
    : [];
}

function agentJobRecordKey(jobId: unknown): string {
  return String(jobId ?? "");
}

function agentJobRecordJob(value: unknown): AgentJobRecordsClientJob | null {
  const row = agentJobRecordValue(value);
  return row.id != null ? (row as AgentJobRecordsClientJob) : null;
}

function agentJobRecordEvent(event: Event): AgentJobRecordsRecord | null {
  const data = (event as MessageEvent).data;
  if (typeof data !== "string" || !data) return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return agentJobRecordValue(parsed);
  } catch {
    return null;
  }
}

function agentJobRecordStatus(job: AgentJobRecordsClientJob | null): string {
  return typeof job?.status === "string" ? job.status : "";
}

function agentJobRecordTerminal(job: AgentJobRecordsClientJob | null): boolean {
  return ["done", "error", "canceled"].includes(agentJobRecordStatus(job));
}

function agentJobRecordError(row: AgentJobRecordsRecord, job: AgentJobRecordsClientJob | null): unknown {
  return row.message ?? job?.error ?? null;
}

const CairnAgentJobRecords: AgentJobRecordsApi = {
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
