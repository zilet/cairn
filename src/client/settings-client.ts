// @ts-check
// Pure Settings renderers for the vanilla PWA.

type SettingsDateFns = {
  relTime?: (value: string) => string;
  absDate?: (value: string) => string;
};

type SettingsDiagnosticsOptions = SettingsDateFns & {
  status?: "loading" | "ready" | "unavailable";
  readinessStatus?: "loading" | "ready" | "unavailable";
  readiness?: unknown;
  days?: 1 | 7 | 30;
  source?: string;
  severity?: string;
  issuePage?: number;
  recentPage?: number;
};

type SettingsUpdateOptions = { updateCheckEnabled: boolean };
type SettingsChipState = { cls: string; label: string };

const SETTINGS_AGENT_OP_LABELS: Record<string, string> = {
  day_read: "read your day",
  session_suggest: "drafted a session",
  session_verify: "checked the session",
  meal_plan: "drafted a meal plan",
  meal_plan_verify: "checked the meal plan",
  meal_swap: "swapped a meal",
  recipe: "wrote a recipe",
  nutrition_checkin: "ran a nutrition check-in",
  insight: "looked for a connection",
  weekly_read: "read the week",
  health_review: "reviewed your labs",
  chat: "answered in chat",
  coach: "drafted a coach proposal",
  compose_week: "composed your first week",
  enrich: "tidied a log",
  enrich_activity: "tidied an activity",
  enrich_food: "tidied a food note",
  enrich_health: "read a lab document",
  garmin_strength: "read a strength session",
  chat_distill: "saved chat to memory",
  research: "researched evidence",
};

function settingsClientRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function settingsAgentWord(value: number | null | undefined): string | null {
  return value == null ? null : value >= 0.9 ? "reliable" : value >= 0.6 ? "mostly clean" : "often retries";
}

function settingsLatency(value: unknown): string {
  const n = Number(value) || 0;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
}

function settingsCompactCount(value: unknown): string {
  const n = Number(value) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

function settingsFirstMetric(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) if (row[key] != null) return row[key];
  return null;
}

function settingsAttemptStatus(row: Record<string, unknown>): { label: string; cls: string; title: string } {
  if (row.ok) return { label: "clean", cls: "actlog-clean", title: "Completed cleanly" };
  const status = String(row.status || row.error_class || "");
  if (status === "auth_required")
    return { label: "connect", cls: "actlog-auth", title: String(row.error_message || "Agent is not connected") };
  if (status === "empty_reply")
    return { label: "empty", cls: "actlog-retry", title: String(row.error_message || "No assistant text returned") };
  if (status === "timeout")
    return { label: "timeout", cls: "actlog-retry", title: String(row.error_message || "The CLI timed out") };
  if (row.tried_json)
    return { label: "retried", cls: "actlog-retry", title: String(row.error_message || "Needed a retry") };
  return { label: "failed", cls: "actlog-retry", title: String(row.error_message || "The CLI failed") };
}

function garminStatusLine(settings: unknown, syncing: boolean, options: SettingsDateFns = {}): string {
  if (syncing) return `<span class="sync-dot pulse"></span><span class="sync-text">Syncing…</span>`;
  const settingsRow = settingsClientRecord(settings);
  const at = settingsRow.garmin_last_sync_at;
  const raw = String(settingsRow.garmin_last_sync_status || "");
  if (!at) return `<span class="sync-dot"></span><span class="sync-text">Never synced</span>`;
  const ok = raw.startsWith("ok");
  const text = raw.replace(/^(ok|failed):\s*/, "");
  const rel = options.relTime ? options.relTime(String(at)) : String(at);
  return `<span class="sync-dot ${ok ? "ok" : "err"}"></span>
    <span class="sync-text">${ok ? "Synced" : "Sync failed"} ${escHtml(rel)}${text ? ` · ${escHtml(text)}` : ""}</span>`;
}

function agentHealthCard(stats: unknown): string {
  const statsRow = stats && typeof stats === "object" ? (stats as Record<string, unknown>) : null;
  if (!statsRow || !Number(statsRow.runs)) return "";
  const runs = Number(statsRow.runs);
  const runWord = `${runs} run${runs === 1 ? "" : "s"} tracked`;
  const rate = statsRow.ok_rate != null ? Number(statsRow.ok_rate) : null;
  const okLine =
    rate == null
      ? `In the last 7 days · ${runWord}`
      : rate >= 0.9
        ? `In the last 7 days, runs completed cleanly · ${runWord}`
        : rate >= 0.6
          ? `In the last 7 days, most runs completed — a few needed a retry · ${runWord}`
          : `In the last 7 days, several runs needed a retry · ${runWord}`;
  const byAgent = Array.isArray(statsRow.by_agent) ? statsRow.by_agent : [];
  const rows = byAgent
    .map(settingsClientRecord)
    .filter((row) => row.agent)
    .map((row) => {
      const total = (Number(row.ok) || 0) + (Number(row.fail) || 0);
      const word = total ? settingsAgentWord((Number(row.ok) || 0) / total) : null;
      const lat = row.p50_ms != null ? ` · ${settingsLatency(row.p50_ms)} typical` : "";
      const auth = Number(row.auth_required) ? ` · ${Number(row.auth_required)} connect` : "";
      const tokens =
        Number(row.input_tokens) || Number(row.output_tokens)
          ? ` · ${settingsCompactCount((Number(row.input_tokens) || 0) + (Number(row.output_tokens) || 0))} tok`
          : "";
      return `<div class="agenthealth-row">
        <span class="agenthealth-name">${escHtml(String(row.agent))}</span>
        <span class="agenthealth-stat">${word || "—"}${lat}${auth}${tokens}</span>
      </div>`;
    })
    .join("");
  const byOp = Array.isArray(statsRow.by_op) ? statsRow.by_op : [];
  const byLane = Array.isArray(statsRow.by_lane) ? statsRow.by_lane : [];
  const laneRows = byLane
    .map(settingsClientRecord)
    .filter((row) => row.lane)
    .map((row) => {
      const runs = Number(row.runs) || 0;
      const latencyP50 = settingsFirstMetric(row, "latency_p50_ms", "p50_ms", "p50_latency_ms");
      const latencyP95 = settingsFirstMetric(row, "latency_p95_ms", "p95_ms", "p95_latency_ms");
      const ttftP50 = settingsFirstMetric(row, "ttft_p50_ms", "p50_ttft_ms");
      const ttftP95 = settingsFirstMetric(row, "ttft_p95_ms", "p95_ttft_ms");
      const latency = latencyP50 != null ? ` · ${settingsLatency(latencyP50)} p50${latencyP95 != null ? ` / ${settingsLatency(latencyP95)} p95` : ""}` : "";
      const ttft = ttftP50 != null ? ` · TTFT ${settingsLatency(ttftP50)}${ttftP95 != null ? ` / ${settingsLatency(ttftP95)} p95` : ""}` : "";
      return `<div class="agenthealth-row"><span class="agenthealth-name">${escHtml(String(row.lane))}</span><span class="agenthealth-stat">${runs} run${runs === 1 ? "" : "s"}${latency}${ttft}</span></div>`;
    }).join("");
  const opRows = byOp
    .slice(0, 8)
    .map(settingsClientRecord)
    .filter((row) => row.op)
    .map((row) => {
      const runs = Number(row.runs) || 0;
      const fail = Number(row.fail) || 0;
      const suffix = fail ? ` · ${fail} fallback${fail === 1 ? "" : "s"}` : "";
      return `<span class="agentop-pill">${escHtml(agentOpLabel(row.op))} · ${runs}${escHtml(suffix)}</span>`;
    })
    .join("");
  return `
    <div class="sess agenthealth" style="margin-top:14px">
      <div class="lbl" style="margin-bottom:6px">Agent health · last 7 days</div>
      <div class="sess-line">${okLine}</div>
      ${rows ? `<div class="agenthealth-rows">${rows}</div>` : ""}
      ${laneRows ? `<div class="agenthealth-rows" style="margin-top:8px"><div class="sess-line" style="color:var(--muted)">Chat lanes</div>${laneRows}</div>` : ""}
      ${opRows ? `<div class="agentop-rows">${opRows}</div>` : ""}
      <div class="sess-line" style="color:var(--muted);margin-top:8px">A failed run just falls through to the next enabled agent — this is the quiet pulse, not a verdict.</div>
    </div>`;
}

function agentOpLabel(op: unknown): string {
  const key = String(op || "").trim();
  if (Object.hasOwn(SETTINGS_AGENT_OP_LABELS, key)) {
    return SETTINGS_AGENT_OP_LABELS[key] || key;
  }
  return key ? key.replace(/_/g, " ") : "agent run";
}

function agentActivityCard(stats: unknown, options: SettingsDateFns = {}): string {
  const statsRow = settingsClientRecord(stats);
  const recent = Array.isArray(statsRow.recent) ? statsRow.recent : [];
  if (!recent.length) return "";
  const rows = recent
    .slice(0, 12)
    .map((item) => {
      const row = settingsClientRecord(item);
      const created = String(row.created_at || "");
      const op = escHtml(agentOpLabel(row.op));
      const agent = row.agent ? `<span class="actlog-agent">${escHtml(String(row.agent))}</span>` : "";
      const when = created
        ? `<span class="actlog-when" title="${escAttr(options.absDate ? options.absDate(created.slice(0, 10)) : created.slice(0, 10))}">${escHtml(options.relTime ? options.relTime(`${created.replace(" ", "T")}Z`) : created)}</span>`
        : "";
      const status = settingsAttemptStatus(row);
      const model = row.model
        ? `<span class="actlog-dot">·</span><span class="actlog-model">${escHtml(String(row.model))}</span>`
        : "";
      const tokens =
        Number(row.input_tokens) || Number(row.output_tokens)
          ? `<span class="actlog-dot">·</span><span class="actlog-tokens">${escHtml(settingsCompactCount((Number(row.input_tokens) || 0) + (Number(row.output_tokens) || 0)))} tok</span>`
          : "";
      return `<div class="actlog-row">
        <span class="actlog-op">${op}</span>
        <span class="actlog-meta">${agent}${agent && when ? `<span class="actlog-dot">·</span>` : ""}${when}${model}${tokens}</span>
        <span class="actlog-flag ${escAttr(status.cls)}" title="${escAttr(status.title)}">${escHtml(status.label)}</span>
      </div>`;
    })
    .join("");
  return `
    <div class="sess agentactivity" style="margin-top:14px">
      <div class="lbl" style="margin-bottom:6px">What Cairn did</div>
      <div class="sess-line" style="color:var(--muted);margin-bottom:4px">A quiet log of the most recent agent work — so you can see what ran, and when.</div>
      <div class="actlog-rows">${rows}</div>
    </div>`;
}

function noticedCard(data: unknown, options: SettingsDateFns = {}): string {
  const dataRow = settingsClientRecord(data);
  const learnings = Array.isArray(dataRow.learnings) ? dataRow.learnings : [];
  if (!learnings.length) return "";
  const items = learnings
    .slice(0, 8)
    .map((item) => {
      const row = settingsClientRecord(item);
      const text = String(row.content || "").trim();
      if (!text) return "";
      const noticedAt = String(row.noticed_at || "");
      const when = noticedAt
        ? `<span class="noticed-when" title="${escAttr(options.absDate ? options.absDate(noticedAt.slice(0, 10)) : noticedAt.slice(0, 10))}">${escHtml(options.relTime ? options.relTime(`${noticedAt.replace(" ", "T")}Z`) : noticedAt)}</span>`
        : "";
      return `<div class="noticed-row">
        <span class="noticed-dot" aria-hidden="true">·</span>
        <div class="noticed-body"><span class="noticed-text">${escHtml(text)}</span>${when}</div>
      </div>`;
    })
    .filter(Boolean)
    .join("");
  if (!items) return "";
  return `
    <div class="sess noticed" style="margin-top:14px">
      <div class="lbl" style="margin-bottom:6px">What Cairn has noticed</div>
      <div class="sess-line" style="color:var(--muted);margin-bottom:6px">Quiet patterns Cairn has picked up from how its suggestions played out. Gentle observations that shape the defaults — never a rule, never a score.</div>
      <div class="noticed-rows">${items}</div>
    </div>`;
}

function brainDiagnosticsCard(data: unknown): string {
  const row = settingsClientRecord(data);
  const decisions = Array.isArray(row.decisions) ? row.decisions : [];
  const calls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
  const metrics = settingsClientRecord(row.metrics);
  if (!decisions.length && !calls.length && !Object.keys(metrics).length) return "";
  const decisionMetrics = settingsClientRecord(metrics.decisions);
  const expectationMetrics = settingsClientRecord(metrics.expectations);
  const autonomyMetrics = settingsClientRecord(metrics.autonomy);
  const toolMetrics = settingsClientRecord(metrics.tools);
  const conferenceMetrics = settingsClientRecord(metrics.conferences);
  const metricLines = [
    Number(decisionMetrics.material) > 0
      ? `${Number(decisionMetrics.with_expectations) || 0} of ${Number(decisionMetrics.material) || 0} material decisions carry a checkable expectation`
      : "",
    Number(expectationMetrics.matured) > 0
      ? `${Number(expectationMetrics.matured_evaluated) || 0} of ${Number(expectationMetrics.matured) || 0} mature expectations have been evaluated`
      : "",
    Number(autonomyMetrics.resolved) > 0
      ? `${Number(autonomyMetrics.reverted) || 0} of ${Number(autonomyMetrics.resolved) || 0} resolved autonomous changes were put back`
      : "",
    Number(toolMetrics.calls) > 0
      ? `${Number(toolMetrics.calls) || 0} bounded chart reads · ${Number(toolMetrics.failed) || 0} failed · ${Number(toolMetrics.budget_exhausted) || 0} exhausted a budget`
      : "",
    Number(conferenceMetrics.jobs) > 0
      ? `${Number(conferenceMetrics.complete_successful) || 0} of ${Number(conferenceMetrics.jobs) || 0} case conferences were complete`
      : "",
    Number(conferenceMetrics.useful_degraded_or_incomplete) > 0
      ? `${Number(conferenceMetrics.useful_degraded_or_incomplete) || 0} returned useful partial or degraded advice`
      : "",
  ].filter(Boolean);
  const demoted = Array.isArray(autonomyMetrics.demoted_domains) ? autonomyMetrics.demoted_domains : [];
  if (demoted.length) metricLines.push(`Review-first after repeated reversals: ${demoted.map(String).join(", ")}`);
  const metricsHtml = metricLines.length
    ? `<div class="agenthealth-rows">${metricLines.map((line) => `<div class="sess-line">${escHtml(line)}</div>`).join("")}</div>`
    : "";
  const decisionRows = decisions
    .slice(0, 8)
    .map((item) => {
      const d = settingsClientRecord(item);
      const status = String(d.status || "").replaceAll("_", " ");
      const verdict = d.latest_verdict ? ` · ${String(d.latest_verdict).replaceAll("_", " ")}` : "";
      return `<div class="actlog-row"><span class="actlog-op">${escHtml(String(d.summary || d.kind || "coaching decision"))}</span><span class="actlog-meta">${escHtml(String(d.domain || ""))}</span><span class="actlog-flag actlog-clean">${escHtml(status + verdict)}</span></div>`;
    })
    .join("");
  const callRows = calls
    .slice(0, 8)
    .map((item) => {
      const c = settingsClientRecord(item);
      const rows = c.rows_returned == null ? "" : ` · ${Number(c.rows_returned) || 0} rows`;
      return `<div class="actlog-row"><span class="actlog-op">${escHtml(String(c.tool || "bounded read"))}</span><span class="actlog-meta">${escHtml(String(c.op || "coach read"))}${escHtml(rows)}</span><span class="actlog-flag actlog-clean">${escHtml(String(c.status || "ok"))}</span></div>`;
    })
    .join("");
  return `<details class="sess agentactivity" style="margin-top:14px"><summary class="lbl">Brain diagnostics</summary>
    <div class="sess-line" style="color:var(--muted);margin:7px 0">Operator view of recent decisions and bounded chart reads. Raw prompts, private files, hidden reasoning, and internal scores are never shown.</div>
    ${metricsHtml}
    ${decisionRows ? `<div class="lbl" style="margin:8px 0 4px">Decisions</div><div class="actlog-rows">${decisionRows}</div>` : ""}
    ${callRows ? `<div class="lbl" style="margin:10px 0 4px">Chart reads</div><div class="actlog-rows">${callRows}</div>` : ""}
  </details>`;
}

function settingsDiagnosticLevel(value: unknown): string {
  const level = String(value || "info").toLowerCase();
  return level === "error" || level === "warning" || level === "warn" ? (level === "warn" ? "warning" : level) : "info";
}

function settingsDiagnosticTime(value: unknown, options: SettingsDateFns): string {
  const raw = String(value || "");
  if (!raw) return "—";
  const iso = raw.includes("T") ? raw : `${raw.replace(" ", "T")}Z`;
  const rel = options.relTime ? options.relTime(iso) : raw;
  let absolute = raw;
  try {
    absolute = new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
  } catch {
    absolute = options.absDate ? options.absDate(raw.slice(0, 10)) : raw;
  }
  return `<time datetime="${escAttr(iso)}" title="${escAttr(absolute)}"><span>${escHtml(rel)}</span><span class="sysdiag-absolute">${escHtml(absolute)}</span></time>`;
}

function settingsDiagnosticValue(label: string, value: unknown, cls = ""): string {
  if (value == null || String(value).trim() === "") return "";
  return `<div class="sysdiag-field${cls ? ` ${escAttr(cls)}` : ""}"><dt>${escHtml(label)}</dt><dd>${escHtml(String(value))}</dd></div>`;
}

function settingsDiagnosticPager(kind: "issues" | "recent", page: number, total: number, pageSize: number): string {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return "";
  const safePage = Math.min(Math.max(0, page), pages - 1);
  return `<nav class="sysdiag-pager" aria-label="${kind === "issues" ? "Grouped issues" : "Recent events"} pages">
    <button class="btn-sm" type="button" data-diag-page="${kind}" data-diag-delta="-1"${safePage === 0 ? " disabled" : ""}>Previous</button>
    <span>Page ${safePage + 1} of ${pages}</span>
    <button class="btn-sm" type="button" data-diag-page="${kind}" data-diag-delta="1"${safePage + 1 >= pages ? " disabled" : ""}>Next</button>
  </nav>`;
}

function settingsDiagnosticAge(value: unknown): string {
  const seconds = Math.max(0, Number(value) || 0);
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(seconds < 7200 ? 1 : 0)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

function settingsReadinessView(options: SettingsDiagnosticsOptions): {
  tone: "healthy" | "warning" | "error";
  pending: boolean;
  html: string;
} {
  const status = options.readinessStatus || "unavailable";
  if (status === "loading") {
    return {
      tone: "healthy",
      pending: true,
      html: `<div class="sysdiag-readiness" aria-busy="true"><div class="sysdiag-section-title">Readiness</div><div class="sysdiag-state"><span class="sync-dot pulse" aria-hidden="true"></span><div><b>Checking runtime readiness…</b><p>Reading database, scheduler, and durable queue health.</p></div></div></div>`,
    };
  }
  if (status === "unavailable") {
    return {
      tone: "warning",
      pending: false,
      html: `<div class="sysdiag-readiness sysdiag-unavailable"><div class="sysdiag-section-title">Readiness</div><div class="sysdiag-state"><span class="sysdiag-state-icon" aria-hidden="true">!</span><div><b>Readiness unavailable</b><p>Cairn could not verify the database, scheduler, or durable queues.</p><button class="btn-sm" data-system-retry type="button">Try again</button></div></div></div>`,
    };
  }
  const readiness = settingsClientRecord(options.readiness);
  const scheduler = settingsClientRecord(readiness.scheduler);
  const queues = settingsClientRecord(readiness.queues);
  const warnings: string[] = [];
  let hasError = readiness.ok === false || readiness.database === "unavailable";
  if (readiness.database === "unavailable") warnings.push("Database is unavailable");
  const schedulerStatus = String(scheduler.status || "");
  if (schedulerStatus === "stale") {
    hasError = true;
    warnings.push("Scheduler heartbeat is stale");
  } else if (schedulerStatus === "starting") {
    warnings.push("Scheduler is still starting");
  } else if (!schedulerStatus) {
    warnings.push("Scheduler freshness is not reported by this version");
  }
  const queueRows = [
    ["Agent jobs", settingsClientRecord(queues.agent_jobs)],
    ["Chat turns", settingsClientRecord(queues.chat_turns)],
  ] as const;
  for (const [label, queue] of queueRows) {
    const failures = Math.max(0, Number(queue.failed_24h) || 0);
    const age = queue.oldest_age_sec == null ? null : Math.max(0, Number(queue.oldest_age_sec) || 0);
    if (failures) warnings.push(`${label}: ${failures} failed in the last 24 hours`);
    if (age != null && age >= 900) warnings.push(`${label}: oldest active item is ${settingsDiagnosticAge(age)} old`);
  }
  if (queueRows.some(([, queue]) => !Object.hasOwn(queue, "failed_24h") || !Object.hasOwn(queue, "oldest_age_sec"))) {
    warnings.push("Queue age and recent-failure detail are not reported by this version");
  }
  const tone = hasError ? "error" : warnings.length ? "warning" : "healthy";
  const databaseLabel =
    readiness.database === "ok" ? "Readable" : readiness.database === "unavailable" ? "Unavailable" : "Not reported";
  const schedulerLabel = schedulerStatus
    ? `${schedulerStatus}${scheduler.age_sec == null ? "" : ` · ${settingsDiagnosticAge(scheduler.age_sec)} ago`}`
    : "Not reported by this version";
  const queueHtml = queueRows
    .map(([label, queue]) => {
      const queued = Math.max(0, Number(queue.queued) || 0);
      const running = Math.max(0, Number(queue.running) || 0);
      const failed = Math.max(0, Number(queue.failed_24h) || 0);
      const age = queue.oldest_age_sec == null ? "" : ` · oldest ${settingsDiagnosticAge(queue.oldest_age_sec)}`;
      return `<div class="sysdiag-runtime-stat"><span>${escHtml(label)}</span><b>${queued} queued · ${running} running${escHtml(age)}</b>${failed ? `<em>${failed} failed / 24h</em>` : ""}</div>`;
    })
    .join("");
  return {
    tone,
    pending: false,
    html: `<div class="sysdiag-readiness sysdiag-readiness-${tone}">
      <div class="sysdiag-section-title">Readiness</div>
      <div class="sysdiag-runtime-grid">
        <div class="sysdiag-runtime-stat"><span>Database</span><b>${escHtml(databaseLabel)}</b></div>
        <div class="sysdiag-runtime-stat"><span>Scheduler</span><b>${escHtml(schedulerLabel)}</b>${scheduler.last_at ? `<small>${settingsDiagnosticTime(scheduler.last_at, options)}</small>` : ""}</div>
        ${queueHtml}
      </div>
      ${warnings.length ? `<ul class="sysdiag-warnings">${warnings.map((warning) => `<li>${escHtml(warning)}</li>`).join("")}</ul>` : `<div class="sysdiag-ready-line">Database, scheduler, and durable queues look ready.</div>`}
    </div>`,
  };
}

function settingsOperatorSummary(row: Record<string, unknown>, readiness: unknown): string {
  const ready = settingsClientRecord(readiness);
  const build = settingsClientRecord(row.build || ready.build);
  const performance = settingsClientRecord(row.performance);
  const storage = settingsClientRecord(row.storage);
  const diagnosticStorage = settingsClientRecord(storage.diagnostic_events);
  const metricStorage = settingsClientRecord(storage.request_metric_buckets);
  if (!Object.keys(build).length && !Object.keys(performance).length && !Object.keys(storage).length) return "";
  const buildLabel = build.version
    ? `${String(build.version)}${build.build_id ? ` @ ${String(build.build_id)}` : ""}`
    : build.build_id
      ? String(build.build_id)
      : "Not reported";
  const topRoutes = Array.isArray(performance.top_routes)
    ? performance.top_routes.map(settingsClientRecord).slice(0, 5)
    : [];
  const protocol = settingsClientRecord(performance.by_protocol);
  const perfHtml = Object.keys(performance).length
    ? `<div class="sysdiag-operator-group"><h4>Request performance · ${Math.max(1, Number(performance.window_days) || 7)}d</h4>
      <div class="sysdiag-metrics">
        <span><b>${Math.max(0, Number(performance.requests) || 0)}</b> requests</span>
        <span><b>${performance.avg_ms == null ? "—" : settingsLatency(performance.avg_ms)}</b> average</span>
        <span><b>${performance.p95_ms == null ? "—" : settingsLatency(performance.p95_ms)}</b> p95</span>
        <span><b>${performance.max_ms == null ? "—" : settingsLatency(performance.max_ms)}</b> max</span>
        <span><b>${performance.p50_ms == null ? "—" : settingsLatency(performance.p50_ms)}</b> p50</span>
        <span><b>${performance.throughput_per_hour == null ? "—" : Math.max(0, Number(performance.throughput_per_hour) || 0)}</b> requests/hour</span>
        <span><b>${Math.max(0, Number(protocol.api) || 0)}</b> API</span>
        <span><b>${Math.max(0, Number(protocol.mcp) || 0)}</b> MCP</span>
      </div>
      ${topRoutes.length ? `<div class="sysdiag-route-metrics">${topRoutes.map((route) => `<div><code>${escHtml(String(route.method || ""))} ${escHtml(String(route.route || "unknown"))}</code><span>${Math.max(0, Number(route.requests) || 0)} req · p95 ${route.p95_ms == null ? "—" : escHtml(settingsLatency(route.p95_ms))}${Number(route.errors) ? ` · ${Math.max(0, Number(route.errors) || 0)} errors` : ""}</span></div>`).join("")}</div>` : ""}
    </div>`
    : "";
  const storageParts = [
    Object.keys(diagnosticStorage).length
      ? `${Math.max(0, Number(diagnosticStorage.rows) || 0)} diagnostic rows · ${Math.max(0, Number(diagnosticStorage.retention_days) || 0)}d retention · cap ${settingsCompactCount(diagnosticStorage.row_cap)}`
      : "",
    Object.keys(metricStorage).length
      ? `${Math.max(0, Number(metricStorage.rows) || 0)} metric buckets · ${Math.max(0, Number(metricStorage.retention_days) || 0)}d retention · cap ${settingsCompactCount(metricStorage.row_cap)}`
      : "",
  ].filter(Boolean);
  return `<details class="sysdiag-operator"><summary>Runtime, performance &amp; storage</summary>
    <div class="sysdiag-operator-group"><h4>Build</h4><div class="sysdiag-build"><b>${escHtml(buildLabel)}</b>${build.build_source ? `<span>${escHtml(String(build.build_source))}</span>` : ""}</div></div>
    ${perfHtml}
    ${storageParts.length ? `<div class="sysdiag-operator-group"><h4>Local telemetry storage</h4>${storageParts.map((part) => `<p>${escHtml(part)}</p>`).join("")}</div>` : ""}
  </details>`;
}

function diagnosticsCard(data: unknown, options: SettingsDiagnosticsOptions = {}): string {
  const requestedDays = options.days || 7;
  const status = options.status || "ready";
  const privacy = "Request bodies, health values, chat text, and credentials are never collected.";
  const row = settingsClientRecord(data);
  const currentBuild = settingsClientRecord(row.current_build);
  const hasCurrentBuild = currentBuild.scope === "current_build";
  const pulse = hasCurrentBuild ? currentBuild : row;
  const issues = Array.isArray(pulse.issues) ? pulse.issues.map(settingsClientRecord) : [];
  const recent = Array.isArray(pulse.recent) ? pulse.recent.map(settingsClientRecord) : [];
  const slow = Array.isArray(pulse.slow) ? pulse.slow.map(settingsClientRecord) : [];
  const total = Math.max(0, Number(pulse.total) || 0);
  const priorBuildTotal = hasCurrentBuild ? Math.max(0, Number(currentBuild.prior_build_total) || 0) : 0;
  const currentRelease = hasCurrentBuild ? String(currentBuild.release || "").trim() : "";
  const currentBuildId = hasCurrentBuild ? String(currentBuild.build_id || "").trim() : "";
  const currentBuildLabel = currentRelease
    ? currentBuildId && !currentRelease.includes(currentBuildId)
      ? `${currentRelease}@${currentBuildId}`
      : currentRelease
    : currentBuildId;
  const days = Math.max(1, Number(row.window_days) || requestedDays);
  const sourceFilter = String(options.source || "all");
  const severityFilter = String(options.severity || "all");
  const matches = (item: Record<string, unknown>): boolean =>
    (sourceFilter === "all" || String(item.source || "system") === sourceFilter) &&
    (severityFilter === "all" || settingsDiagnosticLevel(item.level) === severityFilter);
  const filteredIssues = issues.filter(matches);
  const combinedRecent = [
    ...recent,
    ...slow
      .filter(
        (item) => item.id == null || !recent.some((entry) => entry.id != null && String(entry.id) === String(item.id))
      )
      .map(
        (item): Record<string, unknown> => ({
          ...item,
          level: settingsDiagnosticLevel(item.level) === "info" ? "warning" : item.level,
        })
      ),
  ].filter(matches);
  const sources = [...new Set([...issues, ...recent, ...slow].map((item) => String(item.source || "system")))].sort();
  const hasErrors = issues.some((item) => settingsDiagnosticLevel(item.level) === "error");
  const hasWarnings = issues.some((item) => settingsDiagnosticLevel(item.level) === "warning") || slow.length > 0;
  const readiness = settingsReadinessView(options);
  const diagnosticsTone = hasErrors ? "error" : hasWarnings || status === "unavailable" ? "warning" : "healthy";
  const tone =
    readiness.tone === "error" || diagnosticsTone === "error"
      ? "error"
      : readiness.tone === "warning" || diagnosticsTone === "warning"
        ? "warning"
        : "healthy";
  const pending = status === "loading" || readiness.pending;
  const headline = pending
    ? "Checking system health…"
    : tone === "error"
      ? "Runtime errors need a look"
      : tone === "warning"
        ? "Operational warnings captured"
        : "System is ready";
  const windowLabel = days === 1 ? "last 24 hours" : `last ${days} days`;
  const pageSize = 8;
  const issuePages = Math.max(1, Math.ceil(filteredIssues.length / pageSize));
  const recentPages = Math.max(1, Math.ceil(combinedRecent.length / pageSize));
  const issuePage = Math.min(Math.max(0, Number(options.issuePage) || 0), issuePages - 1);
  const recentPage = Math.min(Math.max(0, Number(options.recentPage) || 0), recentPages - 1);
  const issueRows = filteredIssues
    .slice(issuePage * pageSize, issuePage * pageSize + pageSize)
    .map((issue) => {
      const level = settingsDiagnosticLevel(issue.level);
      const source = String(issue.source || "system");
      const kind = String(issue.kind || "issue").replaceAll("_", " ");
      const where = String(issue.route || issue.operation || "unknown route");
      const count = Math.max(1, Number(issue.count) || 1);
      return `<details class="sysdiag-item sysdiag-${level}">
        <summary><span class="actlog-flag actlog-${level}">${escHtml(level)}</span><span class="sysdiag-summary-main"><b>${escHtml(kind)}</b><span>${escHtml(where)}</span></span><span class="sysdiag-count">${count}×</span></summary>
        <dl class="sysdiag-fields">
          ${settingsDiagnosticValue("Source", source)}${settingsDiagnosticValue("Kind", String(issue.kind || "issue"))}
          ${settingsDiagnosticValue("Route", issue.route, "sysdiag-break")}${settingsDiagnosticValue("Operation", issue.operation)}
          ${settingsDiagnosticValue("Status", issue.status)}${settingsDiagnosticValue("Release", issue.release)}
          ${settingsDiagnosticValue("Message", issue.message, "sysdiag-wide sysdiag-break")}
          <div class="sysdiag-field"><dt>First seen</dt><dd>${settingsDiagnosticTime(issue.first_seen, options)}</dd></div>
          <div class="sysdiag-field"><dt>Last seen</dt><dd>${settingsDiagnosticTime(issue.last_seen, options)}</dd></div>
        </dl>
      </details>`;
    })
    .join("");
  const recentRows = combinedRecent
    .slice(recentPage * pageSize, recentPage * pageSize + pageSize)
    .map((event) => {
      const level = settingsDiagnosticLevel(event.level);
      const kind = String(event.kind || "event").replaceAll("_", " ");
      const where = String(event.route || event.operation || "unknown route");
      const duration = event.duration_ms == null ? "" : settingsLatency(event.duration_ms);
      const requestId = String(event.request_id || "");
      return `<details class="sysdiag-item sysdiag-${level}">
        <summary><span class="actlog-flag actlog-${level}">${escHtml(level)}</span><span class="sysdiag-summary-main"><b>${escHtml(kind)}</b><span>${escHtml(where)}</span></span>${duration ? `<span class="sysdiag-duration">${escHtml(duration)}</span>` : ""}</summary>
        <dl class="sysdiag-fields">
          ${settingsDiagnosticValue("Source", event.source || "system")}${settingsDiagnosticValue("Kind", event.kind || "event")}
          ${settingsDiagnosticValue("Route", event.route, "sysdiag-break")}${settingsDiagnosticValue("Operation", event.operation)}
          ${settingsDiagnosticValue("Status", event.status)}${settingsDiagnosticValue("Duration", duration)}
          ${settingsDiagnosticValue("Release", event.release)}
          <div class="sysdiag-field"><dt>Captured</dt><dd>${settingsDiagnosticTime(event.created_at, options)}</dd></div>
          ${requestId ? `<div class="sysdiag-field sysdiag-wide sysdiag-break"><dt>Request ID</dt><dd><code>${escHtml(requestId)}</code><button class="btn-sm sysdiag-copy" type="button" data-copy-request="${escAttr(requestId)}" aria-label="Copy request ID">Copy</button></dd></div>` : ""}
          ${settingsDiagnosticValue("Message", event.message, "sysdiag-wide sysdiag-break")}
          ${settingsDiagnosticValue("Stack", event.stack, "sysdiag-wide sysdiag-break")}
        </dl>
      </details>`;
    })
    .join("");
  const noMatches =
    !filteredIssues.length && !combinedRecent.length && (sourceFilter !== "all" || severityFilter !== "all");
  const diagnosticBody =
    status === "loading"
      ? `<div class="sysdiag-state" aria-busy="true"><span class="sync-dot pulse" aria-hidden="true"></span><div><b>Loading diagnostics…</b><p>Reading the ${escHtml(windowLabel)} event window.</p></div></div>`
      : status === "unavailable"
        ? `<div class="sysdiag-state sysdiag-unavailable"><span class="sysdiag-state-icon" aria-hidden="true">!</span><div><b>Diagnostics unavailable</b><p>Cairn could not load the local diagnostics pulse. This is different from a valid zero-event response.</p><button class="btn-sm" data-system-retry type="button">Try again</button></div></div>`
        : `<p class="sess-line sysdiag-privacy">${total} diagnostic event${total === 1 ? "" : "s"} captured · ${privacy}</p>
        ${hasCurrentBuild ? `<div class="sysdiag-build-scope"><b>${currentBuildLabel ? `Current build ${escHtml(currentBuildLabel)}` : "Current build"}</b><span>${total} current-build event${total === 1 ? "" : "s"}.${priorBuildTotal ? ` ${priorBuildTotal} earlier-build event${priorBuildTotal === 1 ? " remains" : "s remain"} as history and do not affect current health.` : " No earlier-build events are in this window."}</span></div>` : ""}
        <div class="sysdiag-controls" aria-label="System health filters" data-save-ignore>
          <div class="sysdiag-window-buttons" role="group" aria-label="Diagnostics window">
            ${([1, 7, 30] as const).map((n) => `<button type="button" class="btn-sm${days === n ? " active" : ""}" data-diag-days="${n}" aria-pressed="${days === n}">${n === 1 ? "24h" : `${n}d`}</button>`).join("")}
          </div>
          <label>Source<select id="sysDiagSource"><option value="all">All sources</option>${sources.map((source) => `<option value="${escAttr(source)}"${source === sourceFilter ? " selected" : ""}>${escHtml(source.replaceAll("_", " "))}</option>`).join("")}</select></label>
          <label>Severity<select id="sysDiagSeverity"><option value="all">All severities</option>${["error", "warning", "info"].map((level) => `<option value="${level}"${level === severityFilter ? " selected" : ""}>${level[0].toUpperCase() + level.slice(1)}</option>`).join("")}</select></label>
        </div>
        ${noMatches ? `<div class="sysdiag-empty">No diagnostics match these filters.</div>` : ""}
        ${filteredIssues.length ? `<div class="sysdiag-section"><h3>Grouped issues <span>${filteredIssues.length}</span></h3><div class="sysdiag-list">${issueRows}</div>${settingsDiagnosticPager("issues", issuePage, filteredIssues.length, pageSize)}</div>` : ""}
        ${combinedRecent.length ? `<div class="sysdiag-section"><h3>Recent events <span>${combinedRecent.length}</span></h3><div class="sysdiag-list">${recentRows}</div>${settingsDiagnosticPager("recent", recentPage, combinedRecent.length, pageSize)}</div>` : ""}
        ${total === 0 && !combinedRecent.length ? `<div class="sysdiag-empty${tone === "healthy" ? " sysdiag-healthy-empty" : ""}"><b>${tone === "healthy" ? "Healthy zero-event response" : "No diagnostic events"}</b><span>No errors, warnings, or slow requests were captured${hasCurrentBuild ? " for the current build" : ""} in the ${escHtml(windowLabel)}.</span></div>` : ""}`;
  return `<section class="sess sysdiag-card sysdiag-tone-${tone}" aria-labelledby="sysdiag-title"${pending ? ` aria-busy="true"` : ""}>
    <div class="sysdiag-heading"><div><div class="lbl" id="sysdiag-title">System health</div><div class="sysdiag-headline"><span class="sysdiag-state-icon" aria-hidden="true">${tone === "healthy" ? "✓" : tone === "warning" ? "!" : "×"}</span><b>${headline}</b></div></div><span class="sysdiag-window">${escHtml(windowLabel)}</span></div>
    ${readiness.html}
    <div class="sysdiag-section-title sysdiag-diagnostics-title">Diagnostics</div>
    ${diagnosticBody}
    ${settingsOperatorSummary(row, options.readiness)}
  </section>`;
}

function agentChipState(agent: Record<string, unknown>): SettingsChipState {
  if (agent.present === false) return { cls: "agent-chip-absent", label: "Not installed" };
  if (agent.configured === true) return { cls: "agent-chip-ok", label: "✓ Connected" };
  if (agent.configured === false) return { cls: "agent-chip-connect", label: "Connect →" };
  return { cls: "agent-chip-installed", label: "Installed" };
}

function updateCardHtml(status: unknown, options: SettingsUpdateOptions): string {
  const statusRow = status && typeof status === "object" ? (status as Record<string, unknown>) : null;
  const current = escHtml(String((statusRow && statusRow.current) || "—"));
  const head = `<div class="sess-line">Running <b>v${current}</b>.</div>`;
  if (!options.updateCheckEnabled) {
    return `${head}<div class="sess-line" style="color:var(--muted)">Automatic update checks are off. Turn them on to see when a newer Cairn is released.</div>`;
  }
  if (!statusRow) return `${head}<div class="sess-line" style="color:var(--muted)">Checking…</div>`;
  const checked = statusRow.checked_at
    ? ` · checked ${escHtml(String(statusRow.checked_at).replace("T", " ").slice(0, 16))}`
    : "";
  if (statusRow.update_available && statusRow.latest) {
    const url = statusRow.html_url ? escAttr(String(statusRow.html_url)) : "";
    return `<div class="sess-line"><b>v${escHtml(String(statusRow.latest))} is available</b> — you're on v${current}.${checked}</div>
        ${url ? `<div class="sess-line"><a href="${url}" target="_blank" rel="noopener noreferrer">What's new ↗</a></div>` : ""}
        <details class="route-card" style="margin-top:8px">
          <summary><b>How to update</b></summary>
          <div class="sess-line" style="color:var(--muted);margin-top:6px">Back up first (use <b>Download SQLite snapshot</b> below). Release Compose files pin an exact image, so refresh the file before pulling and restarting:</div>
          <div class="cmd-line">curl -fsSLo docker-compose.yml.new https://github.com/zilet/cairn/releases/latest/download/docker-compose.yml &amp;&amp; mv docker-compose.yml.new docker-compose.yml &amp;&amp; docker compose pull &amp;&amp; docker compose up -d</div>
          <div class="sess-line" style="color:var(--muted);margin-top:6px">Started with <span class="phone-cmd-inline">docker run</span>? Pull <span class="phone-cmd-inline">ghcr.io/zilet/cairn:latest</span> and recreate the container. Building from source? Use <span class="phone-cmd-inline">git pull &amp;&amp; docker compose up -d --build</span> instead.</div>
        </details>`;
  }
  if (statusRow.error && !statusRow.latest) {
    return `${head}<div class="sess-line" style="color:var(--muted)">Couldn't reach GitHub to check (${escHtml(String(statusRow.error))}).${checked}</div>`;
  }
  return `<div class="sess-line">Running <b>v${current}</b> · up to date.${checked}</div>`;
}

Object.assign(globalThis, {
  CairnSettingsClient: {
    AGENT_OP_LABELS: SETTINGS_AGENT_OP_LABELS,
    garminStatusLine,
    agentHealthCard,
    agentOpLabel,
    agentActivityCard,
    noticedCard,
    brainDiagnosticsCard,
    diagnosticsCard,
    agentChipState,
    updateCardHtml,
  },
});
