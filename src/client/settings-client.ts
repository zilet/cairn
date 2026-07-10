// @ts-check
// Pure Settings renderers for the vanilla PWA.

type SettingsDateFns = {
  relTime?: (value: string) => string;
  absDate?: (value: string) => string;
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
      ? runWord
      : rate >= 0.9
        ? `Recent runs have been completing cleanly · ${runWord}`
        : rate >= 0.6
          ? `Most recent runs completed — a few needed a retry · ${runWord}`
          : `Several recent runs needed a retry · ${runWord}`;
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
      <div class="lbl" style="margin-bottom:6px">Agent health</div>
      <div class="sess-line">${okLine}</div>
      ${rows ? `<div class="agenthealth-rows">${rows}</div>` : ""}
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
      ? `${Number(conferenceMetrics.successful) || 0} of ${Number(conferenceMetrics.jobs) || 0} case conferences completed`
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

function diagnosticsCard(data: unknown, options: SettingsDateFns = {}): string {
  const row = settingsClientRecord(data);
  const issues = Array.isArray(row.issues) ? row.issues.map(settingsClientRecord) : [];
  const slow = Array.isArray(row.slow) ? row.slow.map(settingsClientRecord) : [];
  const total = Math.max(0, Number(row.total) || 0);
  if (!total && !issues.length && !slow.length) return "";
  const days = Math.max(1, Number(row.window_days) || 7);
  const issueRows = issues
    .slice(0, 8)
    .map((issue) => {
      const source = String(issue.source || "system").replaceAll("_", " ");
      const kind = String(issue.kind || "issue").replaceAll("_", " ");
      const where = String(issue.route || issue.operation || "");
      const count = Math.max(1, Number(issue.count) || 1);
      const status = issue.status == null ? "" : ` · ${Number(issue.status)}`;
      const lastSeen = String(issue.last_seen || "");
      const when = lastSeen
        ? options.relTime
          ? options.relTime(lastSeen.includes("T") ? lastSeen : `${lastSeen.replace(" ", "T")}Z`)
          : lastSeen
        : "";
      const title = [String(issue.message || ""), issue.release ? `release ${String(issue.release)}` : ""]
        .filter(Boolean)
        .join(" · ");
      return `<div class="actlog-row">
      <span class="actlog-op" title="${escAttr(title)}">${escHtml(kind)}</span>
      <span class="actlog-meta">${escHtml(source)}${where ? ` · ${escHtml(where)}` : ""}${escHtml(status)}${when ? ` · ${escHtml(when)}` : ""}</span>
      <span class="actlog-flag ${String(issue.level) === "error" ? "actlog-retry" : "actlog-clean"}">${count}×</span>
    </div>`;
    })
    .join("");
  const slowLine = slow.length
    ? `<div class="sess-line" style="color:var(--muted);margin-top:8px">${slow.length} recent slow request${slow.length === 1 ? "" : "s"} captured with route and duration only.</div>`
    : "";
  return `<details class="sess agentactivity" style="margin-top:14px">
    <summary class="lbl">System diagnostics</summary>
    <div class="sess-line" style="color:var(--muted);margin:7px 0">${total} diagnostic event${total === 1 ? "" : "s"} in the last ${days} day${days === 1 ? "" : "s"}. Request bodies, health values, chat text, and credentials are never collected.</div>
    ${issueRows ? `<div class="actlog-rows">${issueRows}</div>` : ""}
    ${slowLine}
  </details>`;
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
          <div class="sess-line" style="color:var(--muted);margin-top:6px">Back up first (use <b>Download SQLite snapshot</b> below), then pull the new image and restart. Your data lives in Docker volumes — updating never touches it, and schema migrations run automatically on boot.</div>
          <div class="cmd-line">docker compose pull &amp;&amp; docker compose up -d</div>
          <div class="sess-line" style="color:var(--muted);margin-top:6px">Started with <span class="phone-cmd-inline">docker run</span>? Pull <span class="phone-cmd-inline">ghcr.io/zilet/cairn:latest</span> and recreate the container. Building from source? <span class="phone-cmd-inline">git pull &amp;&amp; docker compose up -d --build</span>.</div>
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
