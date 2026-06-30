(() => {
// @ts-check
// Pure Settings renderers for the vanilla PWA.
const SETTINGS_AGENT_OP_LABELS = {
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
function settingsClientRecord(value) {
    return value && typeof value === "object" ? value : {};
}
function settingsAgentWord(value) {
    return value == null ? null : value >= 0.9 ? "reliable" : value >= 0.6 ? "mostly clean" : "often retries";
}
function settingsLatency(value) {
    const n = Number(value) || 0;
    return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
}
function garminStatusLine(settings, syncing, options = {}) {
    if (syncing)
        return `<span class="sync-dot pulse"></span><span class="sync-text">Syncing…</span>`;
    const settingsRow = settingsClientRecord(settings);
    const at = settingsRow.garmin_last_sync_at;
    const raw = String(settingsRow.garmin_last_sync_status || "");
    if (!at)
        return `<span class="sync-dot"></span><span class="sync-text">Never synced</span>`;
    const ok = raw.startsWith("ok");
    const text = raw.replace(/^(ok|failed):\s*/, "");
    const rel = options.relTime ? options.relTime(String(at)) : String(at);
    return `<span class="sync-dot ${ok ? "ok" : "err"}"></span>
    <span class="sync-text">${ok ? "Synced" : "Sync failed"} ${escHtml(rel)}${text ? ` · ${escHtml(text)}` : ""}</span>`;
}
function agentHealthCard(stats) {
    const statsRow = stats && typeof stats === "object" ? stats : null;
    if (!statsRow || !Number(statsRow.runs))
        return "";
    const runs = Number(statsRow.runs);
    const runWord = `${runs} run${runs === 1 ? "" : "s"} tracked`;
    const rate = statsRow.ok_rate != null ? Number(statsRow.ok_rate) : null;
    const okLine = rate == null
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
        return `<div class="agenthealth-row">
        <span class="agenthealth-name">${escHtml(String(row.agent))}</span>
        <span class="agenthealth-stat">${word || "—"}${lat}</span>
      </div>`;
    })
        .join("");
    return `
    <div class="sess agenthealth" style="margin-top:14px">
      <div class="lbl" style="margin-bottom:6px">Agent health</div>
      <div class="sess-line">${okLine}</div>
      ${rows ? `<div class="agenthealth-rows">${rows}</div>` : ""}
      <div class="sess-line" style="color:var(--muted);margin-top:8px">A failed run just falls through to the next enabled agent — this is the quiet pulse, not a verdict.</div>
    </div>`;
}
function agentOpLabel(op) {
    const key = String(op || "").trim();
    if (Object.hasOwn(SETTINGS_AGENT_OP_LABELS, key)) {
        return SETTINGS_AGENT_OP_LABELS[key] || key;
    }
    return key ? key.replace(/_/g, " ") : "agent run";
}
function agentActivityCard(stats, options = {}) {
    const statsRow = settingsClientRecord(stats);
    const recent = Array.isArray(statsRow.recent) ? statsRow.recent : [];
    if (!recent.length)
        return "";
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
        const clean = row.ok && row.parsed && !row.tried_json;
        const flag = clean
            ? `<span class="actlog-flag actlog-clean">clean</span>`
            : `<span class="actlog-flag actlog-retry">needed a retry</span>`;
        return `<div class="actlog-row">
        <span class="actlog-op">${op}</span>
        <span class="actlog-meta">${agent}${agent && when ? `<span class="actlog-dot">·</span>` : ""}${when}</span>
        ${flag}
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
function noticedCard(data, options = {}) {
    const dataRow = settingsClientRecord(data);
    const learnings = Array.isArray(dataRow.learnings) ? dataRow.learnings : [];
    if (!learnings.length)
        return "";
    const items = learnings
        .slice(0, 8)
        .map((item) => {
        const row = settingsClientRecord(item);
        const text = String(row.content || "").trim();
        if (!text)
            return "";
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
    if (!items)
        return "";
    return `
    <div class="sess noticed" style="margin-top:14px">
      <div class="lbl" style="margin-bottom:6px">What Cairn has noticed</div>
      <div class="sess-line" style="color:var(--muted);margin-bottom:6px">Quiet patterns Cairn has picked up from how its suggestions played out. Gentle observations that shape the defaults — never a rule, never a score.</div>
      <div class="noticed-rows">${items}</div>
    </div>`;
}
function agentChipState(agent) {
    if (agent.present === false)
        return { cls: "agent-chip-absent", label: "Not installed" };
    if (agent.configured === true)
        return { cls: "agent-chip-ok", label: "✓ Connected" };
    if (agent.configured === false)
        return { cls: "agent-chip-connect", label: "Connect →" };
    return { cls: "agent-chip-installed", label: "Installed" };
}
function updateCardHtml(status, options) {
    const statusRow = status && typeof status === "object" ? status : null;
    const current = escHtml(String((statusRow && statusRow.current) || "—"));
    const head = `<div class="sess-line">Running <b>v${current}</b>.</div>`;
    if (!options.updateCheckEnabled) {
        return `${head}<div class="sess-line" style="color:var(--muted)">Automatic update checks are off. Turn them on to see when a newer Cairn is released.</div>`;
    }
    if (!statusRow)
        return `${head}<div class="sess-line" style="color:var(--muted)">Checking…</div>`;
    const checked = statusRow.checked_at ? ` · checked ${escHtml(String(statusRow.checked_at).replace("T", " ").slice(0, 16))}` : "";
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
        agentChipState,
        updateCardHtml,
    },
});
})();
