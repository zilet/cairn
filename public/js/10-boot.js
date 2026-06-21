// ==== 10-boot.js ====
// ---------- Settings (agent rotation + auto-coach) ----------
// Garmin sync status line: colored dot + relative time + the short result the
// server recorded ("ok: 12 activities · 14 daily" / "failed: …").
function garminStatusLine(s, syncing) {
  if (syncing) return `<span class="sync-dot pulse"></span><span class="sync-text">Syncing…</span>`;
  const at = s && s.garmin_last_sync_at;
  const raw = String((s && s.garmin_last_sync_status) || "");
  if (!at) return `<span class="sync-dot"></span><span class="sync-text">Never synced</span>`;
  const ok = raw.startsWith("ok");
  const text = raw.replace(/^(ok|failed):\s*/, "");
  return `<span class="sync-dot ${ok ? "ok" : "err"}"></span>
    <span class="sync-text">${ok ? "Synced" : "Sync failed"} ${escHtml(relTime(at))}${text ? ` · ${escHtml(text)}` : ""}</span>`;
}

// Agent-health card — a small, calm read on the coaching brain's reliability:
// overall ok-rate + per-agent latency, mirroring the art-spend card's ledger
// style. NO scores, just plain words. Returns "" when the endpoint is absent or
// empty (Stream 1's GET /api/agent-stats may 404 on an older backend → silent).
function agentHealthCard(st) {
  if (!st || !Number(st.runs)) return "";
  const runs = Number(st.runs);
  const runWord = `${runs} run${runs === 1 ? "" : "s"} tracked`;
  const ms = (v) => { const n = Number(v) || 0; return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`; };
  // Qualitative ONLY — the constitution bans numeric scores; this is a calm pulse,
  // not a grade. Thresholds map an internal ok-rate to plain words.
  const word = (p) => (p == null ? null : p >= 0.9 ? "reliable" : p >= 0.6 ? "mostly clean" : "often retries");
  const rate = st.ok_rate != null ? Number(st.ok_rate) : null;
  const okLine = rate == null ? runWord
    : rate >= 0.9 ? `Recent runs have been completing cleanly · ${runWord}`
    : rate >= 0.6 ? `Most recent runs completed — a few needed a retry · ${runWord}`
    : `Several recent runs needed a retry · ${runWord}`;
  const rows = (Array.isArray(st.by_agent) ? st.by_agent : []).filter((a) => a && a.agent).map((a) => {
    const tot = (Number(a.ok) || 0) + (Number(a.fail) || 0);
    const w = tot ? word((Number(a.ok) || 0) / tot) : null;
    const lat = a.p50_ms != null ? ` · ${ms(a.p50_ms)} typical` : "";
    return `<div class="agenthealth-row">
        <span class="agenthealth-name">${escHtml(String(a.agent))}</span>
        <span class="agenthealth-stat">${w || "—"}${lat}</span>
      </div>`;
  }).join("");
  return `
    <div class="sess agenthealth" style="margin-top:14px">
      <div class="lbl" style="margin-bottom:6px">Agent health</div>
      <div class="sess-line">${okLine}</div>
      ${rows ? `<div class="agenthealth-rows">${rows}</div>` : ""}
      <div class="sess-line" style="color:var(--muted);margin-top:8px">A failed run just falls through to the next enabled agent — this is the quiet pulse, not a verdict.</div>
    </div>`;
}

// Plain-language label for an agentic op key (from agent_runs.op) — the activity
// log reads in human words, never an internal token. Falls back to a tidied key.
const AGENT_OP_LABELS = {
  day_read: "read your day", session_suggest: "drafted a session", session_verify: "checked the session",
  meal_plan: "drafted a meal plan", meal_plan_verify: "checked the meal plan", meal_swap: "swapped a meal",
  recipe: "wrote a recipe", nutrition_checkin: "ran a nutrition check-in", insight: "looked for a connection",
  weekly_read: "read the week", health_review: "reviewed your labs", chat: "answered in chat",
  coach: "drafted a coach proposal", enrich: "tidied a log", enrich_activity: "tidied an activity",
  enrich_food: "tidied a food note", enrich_health: "read a lab document", garmin_strength: "read a strength session",
  chat_distill: "saved chat to memory", research: "researched evidence",
};
function agentOpLabel(op) {
  const key = String(op || "").trim();
  if (AGENT_OP_LABELS[key]) return AGENT_OP_LABELS[key];
  return key ? key.replace(/_/g, " ") : "agent run";
}

// "What Cairn did" — a calm activity log of recent agentic runs, built from
// GET /api/agent-stats recent[]. Transparency, NEVER a grade/score: each line is
// op · agent · relative time · "clean" or "needed a retry" (a fall-through to the
// next agent, or output that needed a repair). Renders nothing when empty/absent.
function agentActivityCard(st) {
  const recent = st && Array.isArray(st.recent) ? st.recent : [];
  if (!recent.length) return "";
  const rows = recent.slice(0, 12).map((r) => {
    const op = escHtml(agentOpLabel(r.op));
    const agent = r.agent ? `<span class="actlog-agent">${escHtml(String(r.agent))}</span>` : "";
    const when = r.created_at ? `<span class="actlog-when" title="${escAttr(absDate((r.created_at || "").slice(0, 10)))}">${escHtml(relTime((r.created_at || "").replace(" ", "T") + "Z"))}</span>` : "";
    // "clean" = succeeded first try with parseable output, no fall-through; otherwise
    // it needed a retry (a repair or a hand-off to the next enabled agent).
    const clean = r.ok && r.parsed && !r.tried_json;
    const flag = clean
      ? `<span class="actlog-flag actlog-clean">clean</span>`
      : `<span class="actlog-flag actlog-retry">needed a retry</span>`;
    return `<div class="actlog-row">
        <span class="actlog-op">${op}</span>
        <span class="actlog-meta">${agent}${agent && when ? `<span class="actlog-dot">·</span>` : ""}${when}</span>
        ${flag}
      </div>`;
  }).join("");
  return `
    <div class="sess agentactivity" style="margin-top:14px">
      <div class="lbl" style="margin-bottom:6px">What Cairn did</div>
      <div class="sess-line" style="color:var(--muted);margin-bottom:4px">A quiet log of the most recent agent work — so you can see what ran, and when.</div>
      <div class="actlog-rows">${rows}</div>
    </div>`;
}

// "What Cairn has noticed" (F2) — the durable learnings drawn from comparing what
// the Brief / a session suggestion / a nutrition check-in PROPOSED against what
// actually happened (e.g. "tolerates higher training frequency than the read
// assumed"). Gentle observations only — pull-never-push, no scores, never a gate;
// they just season the coach's defaults. Renders nothing when there's nothing yet.
function noticedCard(data) {
  const rows = data && Array.isArray(data.learnings) ? data.learnings : [];
  if (!rows.length) return "";
  const items = rows.slice(0, 8).map((l) => {
    const text = String(l.content || "").trim();
    if (!text) return "";
    // noticed_at is a SQLite "YYYY-MM-DD HH:MM:SS" UTC stamp → a relative time.
    const when = l.noticed_at
      ? `<span class="noticed-when" title="${escAttr(absDate(String(l.noticed_at).slice(0, 10)))}">${escHtml(relTime(String(l.noticed_at).replace(" ", "T") + "Z"))}</span>`
      : "";
    return `<div class="noticed-row">
        <span class="noticed-dot" aria-hidden="true">·</span>
        <div class="noticed-body"><span class="noticed-text">${escHtml(text)}</span>${when}</div>
      </div>`;
  }).filter(Boolean).join("");
  if (!items) return "";
  return `
    <div class="sess noticed" style="margin-top:14px">
      <div class="lbl" style="margin-bottom:6px">What Cairn has noticed</div>
      <div class="sess-line" style="color:var(--muted);margin-bottom:6px">Quiet patterns Cairn has picked up from how its suggestions played out. Gentle observations that shape the defaults — never a rule, never a score.</div>
      <div class="noticed-rows">${items}</div>
    </div>`;
}

// Settings sub-nav: the long single-scroll tab is split into four calm sections,
// using the SAME sliding-thumb segmented switcher the Me/Progress/Plan tabs use
// (segBar/fitSeg). The slices read from ONE in-memory working model (built once on
// entry) so switching sub-tabs never refetches /settings and never loses an unsaved
// edit; the floating save bar (mounted once on a stable sentinel) persists the whole
// model regardless of which slice is on screen.
const SET_SEG = [["agents", "Agents"], ["sources", "Sources"], ["automation", "Automation"], ["data", "Data"]];

// A state chip for an agent connect-card, derived from the declarative fields the
// settings endpoint now supplies (present/configured/can_login/…). Calm, never
// alarming: "Not installed" when the CLI binary is missing; otherwise the connection
// state — Connected / Connect → / Installed. Returns {cls, label}.
function agentChipState(a) {
  if (a.present === false) return { cls: "agent-chip-absent", label: "Not installed" };
  if (a.configured === true) return { cls: "agent-chip-ok", label: "✓ Connected" };
  if (a.configured === false) return { cls: "agent-chip-connect", label: "Connect →" };
  return { cls: "agent-chip-installed", label: "Installed" }; // configured === null/undefined
}

async function renderSettings() {
  headerTitle.textContent = "Settings";
  const [data, artStats, agentStats, learnings] = await Promise.all([
    api("/settings"),
    api("/art/stats").catch(() => null),
    api("/agent-stats").catch(() => null), // 404s on a backend without telemetry → degrade silently
    api("/learnings").catch(() => null),   // F2: outcome learnings → "What Cairn has noticed"; absent on an older backend
  ]);
  const s = data.settings;
  const agents = data.agents; // ordered: {name, description, env_ok, enabled, configured?, present?, version?, can_login?, models_list?, usable?}

  // ---- ONE in-memory working model, built once on entry. Every editable control
  // mirrors into this on change; persistSettings() serializes from HERE (never from
  // DOM elements, which may not be mounted in the active slice). Switching sub-tabs
  // re-renders a slice FROM the model — no refetch, no lost edits.
  const wm = {
    agent_strategy: s.agent_strategy,
    order: agents.map((a) => a.name),
    disabled: new Set(agents.filter((a) => !a.enabled).map((a) => a.name)),
    routes: { ...(s.agent_routes || {}) },
    enrich_enabled: !!s.enrich_enabled,
    art_enabled: !!(s.art_enabled ?? 1),
    research_enabled: !!s.research_enabled,
    gemini_api_key: "",       // blank = preserve existing; only a typed value is sent
    garmin_username: s.garmin_username || "",
    garmin_password: "",      // blank = preserve existing
    coach_enabled: !!s.coach_enabled,
    coach_day: s.coach_day,
    coach_hour: s.coach_hour,
  };
  const meta = Object.fromEntries(agents.map((a) => [a.name, a])); // name → declarative fields
  // lazily-fetched per-agent detail (version/model/update + models list), cached so a
  // re-render of the Agents slice doesn't re-hit the network for what we already have.
  const agentInfo = {};   // name → {version, model_current, update_available}
  const agentModels = {}; // name → [..]

  // Side cards (built once; folded into the Agents slice). All degrade to "" when the
  // backing endpoint is absent/empty.
  const agentHealthHtml = agentHealthCard(agentStats);
  const agentActivityHtml = agentActivityCard(agentStats);
  const noticedHtml = noticedCard(learnings);
  let artSpendHtml = "";
  if (artStats) {
    const money = (v) => { const n = Number(v) || 0; return "$" + (n && n < 0.005 ? n.toFixed(4) : n.toFixed(2)); };
    const t = artStats.since_enabled, a = artStats.all_time;
    const since = artStats.enabled_at ? `since ${escHtml(String(artStats.enabled_at).slice(0, 10))}` : "all-time";
    artSpendHtml = `
    <div class="sess" style="margin-top:10px">
      <div class="sess-line"><b>${money(t.est_cost_usd)}</b> est. spend ${since} · ${t.images_generated} image${t.images_generated === 1 ? "" : "s"} generated · ${t.reused} reused (~${money(t.est_saved_usd)} saved)</div>
      <div class="sess-line" style="color:var(--muted)">All-time: ${money(a.est_cost_usd)} spent · ${a.images_generated} images · ${artStats.cached_assets} cached, served from cache forever after.</div>
    </div>`;
  }

  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const routeTasks = typeof settingsRouteTasks === "function" ? settingsRouteTasks(data) : [];

  if (!state.setSeg || !SET_SEG.some(([k]) => k === state.setSeg)) state.setSeg = "agents";

  // ---- Stable shell. The sub-nav band + a #setSlice container persist across slice
  // swaps (only #setSlice's innerHTML changes), so the save-bar sentinel below — which
  // lives in the shell, NOT in a slice — stays connected and the bar survives a sub-tab
  // switch with edits pending. A full renderTab() re-render replaces the whole view,
  // disconnecting the sentinel, which correctly dismisses the bar.
  view.innerHTML = `
    <span id="setSaveSentinel" hidden></span>
    ${segBar(state.setSeg, SET_SEG)}
    <p class="set-lede">Everything here is optional — Cairn works out of the box. Connect an agent for coaching.</p>
    <div id="setSlice"></div>`;

  // ---- Persist EVERYTHING from the working model, regardless of the visible slice.
  const persistSettings = async () => {
    const body = {
      agent_strategy: wm.agent_strategy,
      agent_order: wm.order,
      disabled_agents: [...wm.disabled],
      enrich_enabled: wm.enrich_enabled,
      art_enabled: wm.art_enabled,
      research_enabled: wm.research_enabled,
      garmin_username: wm.garmin_username.trim(),
      coach_enabled: wm.coach_enabled,
      coach_day: +wm.coach_day,
      coach_hour: +wm.coach_hour,
      agent_routes: wm.routes,
    };
    // password / api-key fields: blank means "leave the configured value intact" — only
    // send a typed value (matches the old per-field placeholder behavior).
    if (wm.gemini_api_key.trim()) body.gemini_api_key = wm.gemini_api_key.trim();
    if (wm.garmin_password.trim()) body.garmin_password = wm.garmin_password.trim();
    await api("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    artEnabled = wm.art_enabled; // take effect on the next render, no reload
    return true;
  };
  // Floating save bar — mounted ONCE on the shell-level sentinel so it persists across
  // sub-tab switches (sentinel stays connected while only #setSlice swaps).
  const settingsBar = mountSaveBar({
    sentinel: $("#setSaveSentinel"),
    fields: view,
    onSave: persistSettings,
    onDiscard: () => renderSettings(),
  });

  // ---- Slice renderers. Each writes #setSlice and wires its own controls; all reads
  // come from `wm`, all writes go back into `wm` + settingsBar.markDirty().
  const slice = () => $("#setSlice");

  function renderAgentsSlice() {
    const stratOpt = (v, label) => `<option value="${v}" ${wm.agent_strategy === v ? "selected" : ""}>${label}</option>`;
    const enabledAgents = wm.order.map((n) => meta[n]).filter((a) => a && !wm.disabled.has(a.name));
    // Silently reconcile pins to agents/tasks that no longer exist so the selects
    // and pinned-count render clean. This runs on every full-slice render (mount,
    // sub-tab switch, discard) — NOT on a user edit — so it must NOT markDirty,
    // or opening Settings would spuriously show "Unsaved changes". A genuine route
    // edit dirties via the select's change handler below; the server also drops
    // stale pins on save, so a benign leftover never persists past the next save.
    if (typeof settingsPruneRoutes === "function") {
      wm.routes = settingsPruneRoutes(wm.routes, routeTasks, enabledAgents);
    }
    const pinnedRouteCount = Object.keys(wm.routes || {}).length;
    const routeSummary = `Route tasks to agents${pinnedRouteCount ? ` · ${pinnedRouteCount} pinned` : ""}`;
    const routeRowsHtml = typeof settingsRouteRowsHtml === "function"
      ? settingsRouteRowsHtml(routeTasks, enabledAgents, wm.routes)
      : "";

    slice().innerHTML = `
      <section class="set-group set-group--flush">
        <p class="set-group-sub">The agent brain. When you draft without naming an agent (the Coach <b>Auto</b> option and the weekly auto-coach), Cairn rotates across the agents you enable here.</p>

        <div class="field" style="margin-top:14px"><label>Selection strategy</label>
          <select id="strat">
            ${stratOpt("round_robin", "Round-robin · even rotation")}
            ${stratOpt("random", "Random · dice")}
            ${stratOpt("priority", "Priority · top first, fall back on failure")}
          </select></div>

        <h1 class="lbl" style="margin:18px 0 8px">Agents</h1>
        <div id="agentlist"></div>
        <div class="agent-update">
          <button id="updateAgentClis" class="ghostbtn" style="width:100%;text-align:center;padding:11px">Update CLI tools</button>
          <div id="agentCliUpdateStatus" class="sess-line agent-update-status"></div>
        </div>
        ${agentHealthHtml}
        ${agentActivityHtml}
        ${noticedHtml}

        <details class="route-card">
          <summary><h1 class="lbl" style="margin:22px 0 8px;display:inline">${escHtml(routeSummary)}</h1></summary>
          <p class="set-group-sub" style="margin-top:2px">Optional. Pin a specific agent to a task — say chat to one, meal drafts to another. Leave any task on <b>Auto</b> to use the rotation above. Only enabled agents appear.</p>
          <div id="routelist" class="route-list">${routeRowsHtml}</div>
        </details>

        <h1 class="lbl" style="margin:22px 0 8px">Weekly auto-coach</h1>
        <label class="toggle"><input type="checkbox" id="coachEnabled" ${wm.coach_enabled ? "checked" : ""}>
          <span>Draft a proposal automatically each week</span></label>
        <div class="logrow" style="margin-top:12px">
          <select id="coachDay" class="selflex">${dayNames.map((d, i) => `<option value="${i}" ${wm.coach_day === i ? "selected" : ""}>${d}</option>`).join("")}</select>
          <select id="coachHour" class="selflex">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${wm.coach_hour === h ? "selected" : ""}>${String(h).padStart(2, "0")}:00</option>`).join("")}</select>
        </div>
      </section>`;

    // strategy + coach fields → working model
    $("#strat").addEventListener("change", (e) => { wm.agent_strategy = e.target.value; });
    $("#coachEnabled").addEventListener("change", (e) => { wm.coach_enabled = e.target.checked; });
    $("#coachDay").addEventListener("change", (e) => { wm.coach_day = +e.target.value; });
    $("#coachHour").addEventListener("change", (e) => { wm.coach_hour = +e.target.value; });
    // per-task routing selects (mirror into the model; empty clears the pin → Auto)
    slice().querySelectorAll("[data-route]").forEach((sel) => sel.addEventListener("change", () => {
      const task = sel.dataset.route; const v = sel.value;
      if (v) wm.routes[task] = v; else delete wm.routes[task];
    }));

    renderAgentList();
    wireCliUpdate();
  }

  // Agent connect-cards: enable/disable + ordering (as before) PLUS a state chip, a
  // Connect button (when can_login), a lazily-fetched info line, and a "view models"
  // disclosure (when models_list). All visibility-only — no model picker; defaults rule.
  function renderAgentList() {
    const wrap = $("#agentlist");
    if (!wrap) return;
    wrap.innerHTML = wm.order.map((name, i) => {
      const a = meta[name] || {};
      const off = wm.disabled.has(name);
      const chip = agentChipState(a);
      const cached = agentInfo[name];
      const infoLine = cached
        ? `CLI ${cached.version ? `v${escHtml(String(cached.version))}` : "version —"} · model: ${escHtml(String(cached.model_current || "—"))}${cached.update_available ? ` · <span class="agent-upd">update available</span>` : ""}`
        : "";
      const models = agentModels[name];
      const modelsList = Array.isArray(models)
        ? (models.length ? models.map((m) => `<li>${escHtml(String(m))}</li>`).join("") : `<li class="agent-models-empty">No models reported.</li>`)
        : "";
      return `<div class="agent-card${off ? " off" : ""} reveal" style="${stagger(i)}">
        <div class="agent-card-top">
          <div class="agentmeta">
            <div class="agentname">${escHtml(name)}</div>
            <div class="agentdesc">${escHtml(a.description || "")}</div>
          </div>
          <span class="agent-chip ${chip.cls}">${chip.label}</span>
        </div>
        <div class="agent-card-ctl">
          <div class="agentctl">
            <button class="ordbtn" data-up="${escAttr(name)}" ${i === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
            <button class="ordbtn" data-down="${escAttr(name)}" ${i === wm.order.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
            <button class="togglebtn${off ? "" : " on"}" data-toggle="${escAttr(name)}">${off ? "OFF" : "ON"}</button>
          </div>
          <div class="agent-card-actions">
            ${a.can_login ? `<button class="ghostbtn agent-connect-btn" data-connect="${escAttr(name)}">Connect</button>` : ""}
            <button class="agent-detail-link" data-detail="${escAttr(name)}">${cached ? "details" : "check"}</button>
            ${a.models_list ? `<button class="agent-detail-link" data-models="${escAttr(name)}">${Array.isArray(models) ? "hide models" : "view models"}</button>` : ""}
          </div>
        </div>
        ${a.configured === false ? `<div class="agent-card-note">Not in rotation until connected${a.can_login ? " — tap Connect" : ""}.</div>` : ""}
        ${infoLine ? `<div class="agent-info-line">${infoLine}</div>` : ""}
        ${Array.isArray(models) ? `<ul class="agent-models">${modelsList}</ul>` : ""}
      </div>`;
    }).join("");

    wrap.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", () => {
      const n = b.dataset.toggle; wm.disabled.has(n) ? wm.disabled.delete(n) : wm.disabled.add(n);
      settingsBar.markDirty(); renderAgentList();
    }));
    wrap.querySelectorAll("[data-up]").forEach((b) => b.addEventListener("click", () => {
      const i = wm.order.indexOf(b.dataset.up);
      if (i > 0) { [wm.order[i - 1], wm.order[i]] = [wm.order[i], wm.order[i - 1]]; settingsBar.markDirty(); renderAgentList(); }
    }));
    wrap.querySelectorAll("[data-down]").forEach((b) => b.addEventListener("click", () => {
      const i = wm.order.indexOf(b.dataset.down);
      if (i < wm.order.length - 1) { [wm.order[i + 1], wm.order[i]] = [wm.order[i], wm.order[i + 1]]; settingsBar.markDirty(); renderAgentList(); }
    }));
    // Connect → hand off to the login modal provided by another module (guarded: it
    // exists after integration; until then the button is a calm no-op).
    wrap.querySelectorAll("[data-connect]").forEach((b) => b.addEventListener("click", () => {
      const n = b.dataset.connect;
      if (typeof openAgentLoginModal === "function") openAgentLoginModal(n);
      else toast("Agent connect is unavailable here");
    }));
    // Lazy detail (NOT fetched on paint — only on tap): version / current model /
    // update-available. Cached, so re-renders are free.
    wrap.querySelectorAll("[data-detail]").forEach((b) => b.addEventListener("click", async () => {
      const n = b.dataset.detail;
      if (agentInfo[n]) return; // already shown
      b.disabled = true; b.textContent = "checking…";
      try {
        const r = await api(`/agents/${encodeURIComponent(n)}/info`);
        if (r && r.ok) agentInfo[n] = { version: r.version, model_current: r.model_current, update_available: r.update_available };
        else agentInfo[n] = { version: null, model_current: null, update_available: false };
      } catch { agentInfo[n] = { version: null, model_current: null, update_available: false }; }
      renderAgentList();
    }));
    // "view models" disclosure (lazy, cached) — a plain list, no picker.
    wrap.querySelectorAll("[data-models]").forEach((b) => b.addEventListener("click", async () => {
      const n = b.dataset.models;
      if (Array.isArray(agentModels[n])) { delete agentModels[n]; renderAgentList(); return; } // toggle off
      b.disabled = true; b.textContent = "loading…";
      try {
        const r = await api(`/agents/${encodeURIComponent(n)}/models`);
        agentModels[n] = r && r.ok && Array.isArray(r.models) ? r.models : [];
      } catch { agentModels[n] = []; }
      renderAgentList();
    }));
  }

  // "Update CLI tools" — unchanged behavior, just wired from inside the Agents slice.
  function wireCliUpdate() {
    const renderCliStatus = (r) => {
      const el = $("#agentCliUpdateStatus");
      if (!el || !r) return;
      if (r.status === "running") el.textContent = `Updating since ${(r.started_at || "").replace("T", " ").slice(0, 16)}`;
      else if (r.status === "succeeded") el.textContent = `Updated ${(r.finished_at || "").replace("T", " ").slice(0, 16)}`;
      else if (r.status === "failed") el.textContent = `Update failed${r.error ? `: ${r.error}` : ""}`;
      else el.textContent = "";
    };
    const pollCliStatus = async () => {
      const btn = $("#updateAgentClis");
      if (!btn) return;
      let r = await api("/agent-clis/update");
      renderCliStatus(r);
      if (!btn.isConnected) return;
      btn.disabled = r.status === "running";
      while (r.status === "running") {
        await sleep(2000);
        r = await api("/agent-clis/update");
        if (!$("#agentCliUpdateStatus")) return; // slice swapped away
        renderCliStatus(r);
        const b2 = $("#updateAgentClis"); if (b2) b2.disabled = r.status === "running";
      }
    };
    $("#updateAgentClis").addEventListener("click", async () => {
      const btn = $("#updateAgentClis");
      btn.disabled = true;
      renderCliStatus({ status: "running", started_at: new Date().toISOString() });
      await api("/agent-clis/update", { method: "POST" });
      await pollCliStatus();
      toast("CLI update finished");
    });
    pollCliStatus().catch(() => {});
  }

  function renderSourcesSlice() {
    slice().innerHTML = `
      <section class="set-group set-group--flush">
        <p class="set-group-sub">Where your recovery and activity data come in. Both are optional and gracefully absent.</p>

        <h1 class="lbl" style="margin:14px 0 8px">Garmin Connect</h1>
        <div class="field"><label>Garmin email</label>
          <input id="garminUsername" type="email" autocomplete="username" value="${escAttr(wm.garmin_username)}" placeholder="you@example.com">
        </div>
        <div class="field"><label>Garmin password</label>
          <input id="garminPassword" type="password" autocomplete="current-password" placeholder="${s.garmin_password_configured ? `Configured via ${escAttr(s.garmin_credentials_source)}` : "Optional: GARMIN_PASSWORD"}">
        </div>
        <div class="sess-line" style="color:var(--muted);margin-top:6px">Settings credentials override GARMIN_USERNAME / GARMIN_PASSWORD. Garmin remains an input source for coaching context.</div>
        <div class="syncrow">
          <div class="syncstatus" id="garminStatus">${garminStatusLine(s, false)}</div>
          <button id="garminSyncBtn" class="ghostbtn syncbtn">Sync now</button>
        </div>
        <div class="sess-line" style="color:var(--muted);margin-top:6px">Once configured, Cairn syncs automatically every ~6 hours.</div>

        <h1 class="lbl" style="margin:22px 0 8px">Apple Health (steps, sleep, recovery)</h1>
        <div class="sess-line" style="color:var(--muted)">
          An iOS Shortcut can post daily metrics straight to Cairn. Missing fields are fine; Cairn
          keeps working without wearable data.
        </div>
        <div class="ah-fields">
          <span>date</span><span>steps</span><span>sleep_min</span><span>resting_hr</span><span>hrv_ms</span><span>active_calories</span>
        </div>
        <div class="field" style="margin-top:12px"><label>POST URL</label>
          <div class="ah-url"><code id="ahUrl"></code><button id="ahUrlCopy" class="ghostbtn ah-copy" type="button">Copy</button></div>
        </div>
        <div class="ah-example">
          <span class="ah-example-lbl">Shortcut body</span>
          <code>[{"date":"2026-06-13","steps":8421,"resting_hr":52}]</code>
        </div>
        <div class="sess-line" style="color:var(--muted);margin-top:8px">Full Shortcut recipe: <code>docs/APPLE_HEALTH.md</code></div>
      </section>`;

    $("#garminUsername").addEventListener("input", (e) => { wm.garmin_username = e.target.value; });
    $("#garminPassword").addEventListener("input", (e) => { wm.garmin_password = e.target.value; });

    // Manual Garmin sync: pulse while the connector runs, then re-pull /settings so the
    // status line shows exactly what the server recorded.
    $("#garminSyncBtn").addEventListener("click", async () => {
      const btn = $("#garminSyncBtn");
      const status = $("#garminStatus");
      btn.disabled = true; btn.textContent = "Syncing…";
      status.innerHTML = garminStatusLine(null, true);
      let r = null;
      try { r = await api("/garmin/sync", { method: "POST" }); } catch {}
      let fresh = s;
      try { fresh = (await api("/settings")).settings; } catch {}
      if (!btn.isConnected) return; // slice/tab swapped while we waited
      status.innerHTML = garminStatusLine(fresh, false);
      btn.disabled = false; btn.textContent = "Sync now";
      toast(r && r.ok ? `Garmin synced · ${r.activities} activit${r.activities === 1 ? "y" : "ies"}` : "Garmin sync failed");
    });

    // Apple Health: page-origin POST URL + one-tap copy.
    const ahUrl = $("#ahUrl");
    if (ahUrl) ahUrl.textContent = location.origin + "/api/health-metrics";
    const ahCopy = $("#ahUrlCopy");
    if (ahCopy) ahCopy.addEventListener("click", async () => {
      const url = location.origin + "/api/health-metrics";
      try { await navigator.clipboard.writeText(url); ahCopy.textContent = "Copied"; }
      catch { ahCopy.textContent = "Copy failed"; }
      setTimeout(() => { ahCopy.textContent = "Copy"; }, 1600);
    });
  }

  function renderAutomationSlice() {
    slice().innerHTML = `
      <section class="set-group set-group--flush">
        <p class="set-group-sub">Background touches that make logging effortless. Both fall back gracefully when off.</p>

        <h1 class="lbl" style="margin:14px 0 8px">Agentic enrichment</h1>
        <label class="toggle"><input type="checkbox" id="enrichEnabled" ${wm.enrich_enabled ? "checked" : ""}>
          <span>Refine free-text logs &amp; capture coaching notes via an agent</span></label>
        <div class="sess-line" style="color:var(--muted);margin-top:6px">Logs stay instant; an agent upgrades them in the background. Falls back to offline parsing when off.</div>

        <h1 class="lbl" style="margin:22px 0 8px">Artwork generation</h1>
        <label class="toggle"><input type="checkbox" id="artEnabled" ${wm.art_enabled ? "checked" : ""}>
          <span>Generate studio photos for foods, exercises &amp; activities</span></label>
        <div class="field" style="margin-top:10px"><label>Gemini API key</label>
          <input id="geminiApiKey" type="password" autocomplete="off" placeholder="${s.gemini_api_key_configured ? `Configured via ${escAttr(s.gemini_api_key_source)}` : "Optional: GOOGLE_AI_KEY / GEMINI_API_KEY"}">
        </div>
        <div class="sess-line" style="color:var(--muted);margin-top:6px">Settings key overrides GOOGLE_AI_KEY / GEMINI_API_KEY from the server environment. Blank preserves the current key.</div>
        ${artSpendHtml}

        <h1 class="lbl" style="margin:22px 0 8px">Research &amp; grounding</h1>
        <label class="toggle"><input type="checkbox" id="researchEnabled" ${wm.research_enabled ? "checked" : ""}>
          <span>Let Cairn research your findings and cite real sources</span></label>
        <div class="sess-line" style="color:var(--muted);margin-top:6px">When on, a web-capable agent grounds your lab findings against current clinical guidance and attaches the sources behind each directive — open them under “see the evidence” in <b>Me → Brain</b>. Off by default; everything stays deterministic and offline when off. Informational, never medical advice.</div>
      </section>`;

    $("#enrichEnabled").addEventListener("change", (e) => { wm.enrich_enabled = e.target.checked; });
    $("#artEnabled").addEventListener("change", (e) => { wm.art_enabled = e.target.checked; });
    $("#researchEnabled").addEventListener("change", (e) => { wm.research_enabled = e.target.checked; });
    $("#geminiApiKey").addEventListener("input", (e) => { wm.gemini_api_key = e.target.value; });
  }

  function renderDataSlice() {
    slice().innerHTML = `
      <section class="set-group set-group--flush">
        <p class="set-group-sub">Keep an offline copy of everything, or start the first-time setup over.</p>

        <h1 class="lbl" style="margin:14px 0 8px">Data &amp; backup</h1>
        <button id="dlJson" class="ghostbtn" style="width:100%;text-align:center;padding:11px">Download JSON backup</button>
        <button id="dlDb" class="ghostbtn" style="width:100%;text-align:center;padding:11px;margin-top:8px">Download SQLite snapshot</button>

        <h1 class="lbl" style="margin:22px 0 8px">Setup</h1>
        <button id="rerunSetup" class="ghostbtn" style="width:100%;text-align:center;padding:11px">Re-run first-time setup</button>
      </section>`;

    $("#dlJson").addEventListener("click", () => downloadFile(withToken("/api/export")));
    $("#dlDb").addEventListener("click", () => downloadFile(withToken("/api/export/db")));
    $("#rerunSetup").addEventListener("click", async () => {
      await api("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ onboarded: false }) });
      location.reload();
    });
  }

  const SLICES = { agents: renderAgentsSlice, sources: renderSourcesSlice, automation: renderAutomationSlice, data: renderDataSlice };
  const paintSlice = (key) => (SLICES[key] || renderAgentsSlice)();

  // Sub-tab switch: slide the thumb, swap ONLY #setSlice from the working model (no
  // refetch, edits preserved), keep the save bar mounted on the stable sentinel.
  view.querySelectorAll(".segbtn").forEach((b) => b.addEventListener("click", () => {
    const key = b.dataset.seg;
    if (!SLICES[key] || key === state.setSeg) return;
    state.setSeg = key;
    const seg = b.closest(".seg");
    if (seg) {
      // Slide the ink thumb AND move the .active state (paper text) with it — the
      // shell persists across slice swaps, so without this the active class stays
      // stuck on the first tab (cream-on-cream, invisible) while the thumb is
      // elsewhere. Mirrors setHealthSegActive.
      const btns = [...seg.querySelectorAll(".segbtn")];
      seg.style.setProperty("--segi", btns.indexOf(b));
      btns.forEach((x) => x.classList.toggle("active", x === b));
    }
    withViewTransition(() => { paintSlice(key); viewEnter(); });
  }));
  view.querySelectorAll(".seg").forEach(fitSeg);

  paintSlice(state.setSeg);
}

function downloadFile(href) {
  const a = document.createElement("a");
  a.href = href; a.download = "";
  document.body.appendChild(a); a.click(); a.remove();
}

// ---------- tabs ----------
// The Progress sub-view to land on. Endurance athletes default to the Endurance
// read; everyone else to History. Once the user picks any Progress seg this session
// we remember it (state.progressSeg) so the default never yanks them back.
function defaultProgressSeg() {
  if (state.progressSeg && PROGRESS_SEG.some(([k]) => k === state.progressSeg)) return state.progressSeg;
  return isEndurance() ? "endurance" : "sessions";
}

function renderTab(tab) {
  headerTitle.classList.remove("hdr-tappable"); // only Today re-arms the date control
  document.getElementById("hdrChatActions")?.remove(); // only Chat re-creates the header affordances
  document.body.classList.remove("chat-mode");
  // Leaving Chat: drop any lingering keyboard state so a non-installed Safari tab
  // bar isn't left un-lifted (--vvb:0). Removing a focused field doesn't reliably
  // fire blur, so don't rely on focusout alone here. Chat re-arms it via focusin.
  if (tab !== "chat") document.body.classList.remove("kb-open");
  document.body.dataset.tab = tab; // scopes the sticky/condensing header to Today
  updateHeaderCondense();
  if (tab === "today") return renderToday();
  if (tab === "plan") {
    const jump = state.planJump; state.planJump = null;
    return jump === "meals" ? renderMeals() : jump === "coach" ? renderCoach() : renderPlanEditor();
  }
  // Endurance athletes land on the Endurance read first (gentle emphasis, not a
  // different app — History/1RM/Volume are all still one tap away). A user who has
  // navigated to another Progress seg this session keeps it.
  if (tab === "progress") return defaultProgressSeg() === "endurance" ? renderEndurance() : renderHistory();
  if (tab === "chat") return renderChat();
  if (tab === "me") return renderMe();
  return renderSettings();
}
// Synchronous skeleton for a tab, so the view-transition crossfade lands on a
// shaped placeholder INSTANTLY — the old tab never sits frozen through the data/
// agent awaits. Each render function paints its own matching skeleton on entry
// (idempotent), then hydrates in place once data lands. Chat owns its own
// shell-first paint, so we don't pre-skeleton it.
function tabSkeleton(tab) {
  if (tab === "today") return todaySkeleton();
  if (tab === "progress") return defaultProgressSeg() === "endurance" ? segSkeleton("endurance", PROGRESS_SEG, 2) : segSkeleton("sessions", PROGRESS_SEG, 3);
  if (tab === "plan") return segSkeleton(state.planJump === "meals" ? "meals" : state.planJump === "coach" ? "coach" : "edit", planSeg(), 3);
  if (tab === "me") {
    const seg = state.meSeg || "profile";
    return ME_SEG.some(([k]) => k === seg) ? segSkeleton(seg, ME_SEG, 2) : segSkeleton("profile", ME_SEG, 2);
  }
  if (tab === "settings") return skelLines(2) + skelLines(3);
  return "";
}

// The cache key whose warm presence means a tab's render can paint REAL content
// from the peek immediately — so switchTab/activateTab skip the skeleton on a warm
// re-entry (the render then SWR-paints in place). Returns null for tabs that own
// their own paint (chat) or have no single primary surface (me/settings keep their
// skeleton). The plan tab lands on History/Training/Meals per state.planJump.
function primaryKeyFor(tab) {
  if (tab === "today") return "plan"; // Today's first input; warm => render paints from cache
  // The endurance default reads /stats live (no SWR peek) — keep its skeleton; the
  // History default warms off history:sessions exactly as before.
  if (tab === "progress") return defaultProgressSeg() === "endurance" ? null : "history:sessions";
  if (tab === "plan") return state.planJump === "coach" ? null : state.planJump === "meals" ? MEALS_KEY : "plan";
  return null;
}

// Switch tabs: crossfade the old tab → a synchronous skeleton (the view
// transition only waits for THIS, never the async render), then hydrate outside
// the transition. The frozen-tab problem is gone: paint is always instant.
function switchTab(tab) {
  if (state.tab === "chat" && tab !== "chat") chatTeardownMonitor(); // drop the chat stream when leaving
  teardownJobs(); // close agent-job streams from the leaving tab (jobs keep running server-side; reload reconnects)
  closeDetail(true); // overlays never outlive a tab switch
  closeMealSheet(true);
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === tab));
  state.tab = tab;
  // Warm re-entry (the tab's primary surface is cached) skips the skeleton — the
  // render paints REAL content from the peek (its own SWR), so there's no flash.
  // Cold keeps the skeleton-first crossfade.
  const warm = !!peekCached(primaryKeyFor(tab));
  const paintSkeleton = () => {
    const skel = warm ? "" : tabSkeleton(tab);
    if (skel) { view.innerHTML = skel; viewEnter(); }
  };
  // Wrap ONLY the synchronous skeleton paint in the transition; the (possibly
  // slow, agentic) render runs after, swapping skeleton→content with no wait.
  Promise.resolve(withViewTransition(paintSkeleton)).finally(() => {
    Promise.resolve(renderTab(tab)).catch(() => tabErrorState(tab));
  });
}
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => switchTab(t.dataset.tab))
);

// ---------- first-run onboarding ----------
async function maybeOnboard() {
  let onboarded = true;
  try {
    const data = await api("/settings");
    onboarded = !!data?.settings?.onboarded;
    // settings is already in hand — cache the artwork-generation flag (default on)
    if (data?.settings && "art_enabled" in data.settings) artEnabled = !!data.settings.art_enabled;
  } catch { onboarded = true; } // never block the app on a settings failure
  if (!onboarded) openOnboarding();
}

// Frictionless first run: ONE optional free-text intro, or Skip. No form barrage —
// the server understands what they wrote (about_me, profile numbers, supplements,
// injuries) in one pass; everything else is learned as they go. "Get me started."
function openOnboarding() {
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="modal-card">
      <h2 class="modal-title">Welcome to Cairn</h2>
      <p class="ob-lead">A few basics, then you're in — I'll learn the rest as we go.</p>
      <div class="ob-grid">
        <div class="field"><label>Age</label>
          <input id="obAge" type="number" inputmode="numeric" min="13" max="100" placeholder="years"></div>
        <div class="field"><label>Days / week</label>
          <div class="seg" id="obDays">
            <button type="button" class="segbtn" data-dpw="3">3</button>
            <button type="button" class="segbtn active" data-dpw="4">4</button>
            <button type="button" class="segbtn" data-dpw="5">5</button>
            <button type="button" class="segbtn" data-dpw="6">6</button>
          </div></div>
      </div>
      <div class="field"><label>Your sport <span class="ob-opt">— optional</span></label>
        <div class="seg disc-seg" id="obDisc" role="group" aria-label="Primary discipline">
          <button type="button" class="segbtn active" data-disc="strength">Strength</button>
          <button type="button" class="segbtn" data-disc="endurance">Endurance</button>
          <button type="button" class="segbtn" data-disc="hybrid">Hybrid</button>
        </div></div>
      <div class="field"><label>Main goal</label>
        <select id="obGoal">
          <option value="">What matters most? (optional)</option>
          <option value="stay strong and age well">Stay strong &amp; age well</option>
          <option value="build muscle">Build muscle</option>
          <option value="lose fat and lean out">Lose fat / lean out</option>
          <option value="sport or event performance">Sport / performance</option>
          <option value="overall health and energy">Overall health &amp; energy</option>
        </select></div>
      <div class="field"><label>Anything else <span class="ob-opt">— optional</span></label>
        <textarea id="obIntro" class="ob-intro" rows="3"
          placeholder="injuries, how you eat, height &amp; weight, supplements you take… a sentence is plenty."></textarea></div>
      <button id="obStart" class="logbtn" style="width:100%;height:46px;margin-top:6px;letter-spacing:.05em">START</button>
      <button id="obSkip" class="ghostbtn" style="width:100%;text-align:center;padding:11px;margin-top:8px">Skip — just get me in</button>
      <div id="obStatus" style="margin-top:8px;color:var(--muted);font-size:.82rem"></div>
    </div>`;
  document.body.appendChild(m);

  let dpw = 4;
  m.querySelectorAll("#obDays [data-dpw]").forEach((b) =>
    b.addEventListener("click", () => {
      dpw = +b.dataset.dpw;
      m.querySelectorAll("#obDays .segbtn").forEach((x) => x.classList.toggle("active", x === b));
    })
  );
  // One-tap discipline so a runner self-identifies on day one. Default strength
  // (matching the server default); it's a calm preference, never a quiz step.
  let disc = "strength";
  m.querySelectorAll("#obDisc [data-disc]").forEach((b) =>
    b.addEventListener("click", () => {
      disc = b.dataset.disc;
      m.querySelectorAll("#obDisc .segbtn").forEach((x) => x.classList.toggle("active", x === b));
    })
  );
  const intro = m.querySelector("#obIntro");
  setTimeout(() => { try { m.querySelector("#obAge").focus(); } catch {} }, 60);

  async function persistOnboarded() {
    try { await api("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ onboarded: true }) }); } catch {}
  }
  function enterApp() {
    state.plan = []; state.day = null; state.dayPicked = false;
    // a fresh setup may have written profile / supplements / memory — clear the SWR
    // caches those surfaces read so nothing paints pre-onboarding data.
    ["plan", "profile", "stats", "progress:weight", "progress:energy", "supplements", "memory"].forEach(swrInvalidate);
    swrInvalidate("today:session:");
    m.remove();
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    const t = document.querySelector('.tab[data-tab="today"]'); if (t) t.classList.add("active");
    state.tab = "today";
    document.body.dataset.tab = "today";
    renderToday();
  }

  // Fold the quick taps + the optional note into ONE natural-language intro, then let
  // the agentic /api/onboard understand + apply it (age → profile, days/week → a soft
  // memory, goal → about-me/memory, note → injuries/diet/supplements/etc.). One robust
  // path that mirrors the free-text flow; nothing is lost without an agent (the endpoint
  // keeps a deterministic base that saves the text + extracts supplements).
  function composeIntro() {
    const parts = [];
    const age = +m.querySelector("#obAge").value || null;
    if (age) parts.push(`I'm ${age}.`);
    parts.push(`I train about ${dpw} days a week.`);
    if (disc === "endurance") parts.push("I'm primarily an endurance athlete.");
    else if (disc === "hybrid") parts.push("I train both strength and endurance (hybrid).");
    const goal = m.querySelector("#obGoal").value;
    if (goal) parts.push(`My main goal is to ${goal}.`);
    const note = (intro.value || "").trim();
    if (note) parts.push(note);
    return parts.join(" ").trim();
  }
  // The chosen discipline is a structured field, so persist it directly (the agent's
  // free-text pass can't be relied on to set it). Best-effort; never blocks setup.
  async function persistDiscipline() {
    if (disc === "strength") { setDiscipline("strength"); return; } // server default already
    try {
      await api("/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ primary_discipline: disc }) });
      setDiscipline(disc);
    } catch {}
  }

  m.querySelector("#obSkip").addEventListener("click", async () => { await persistDiscipline(); await persistOnboarded(); enterApp(); });

  m.querySelector("#obStart").addEventListener("click", async () => {
    const text = composeIntro();
    const status = m.querySelector("#obStatus");
    const btn = m.querySelector("#obStart");
    btn.disabled = true; btn.textContent = "GETTING TO KNOW YOU…";
    // Same elite loader the planning surfaces use — an oscillating filament + a calm
    // rotating caption so a 10–60s first-run agent pass reads as quiet motion, never a
    // frozen line. (Self-clears when enterApp() tears down the modal.)
    status.innerHTML = `<span class="job-cap"></span>`;
    const capEl = status.querySelector(".job-cap");
    if (capEl) thinkingCaption(capEl, "onboard");
    if (!reducedMotion()) status.classList.add("is-thinking");
    try {
      // /api/onboard understands + applies, then marks onboarded server-side.
      await api("/onboard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      await persistDiscipline(); // structured field — set it directly, after the agent pass
      toast("You're all set");
    } catch {
      // never trap them on setup — their basics are saved on the server regardless.
      await persistDiscipline();
      await persistOnboarded();
      toast("Saved — you can refine anytime in Me");
    }
    enterApp();
  });
}

// Activate a tab programmatically (used at startup + by manifest shortcuts via ?tab=).
// Skeleton-first, exactly like switchTab(): paint the synchronous skeleton now so the
// view never sits frozen on the previous tab while the (possibly agentic) render
// awaits its data — the content swaps in once it lands. This is what makes tapping
// Today feel instant instead of "stuck until the fetch returns".
function activateTab(name) {
  const valid = ["today", "plan", "progress", "chat", "me", "settings"];
  const tab = valid.includes(name) ? name : "today";
  if (state.tab === "chat" && tab !== "chat") chatTeardownMonitor(); // drop the chat stream when leaving
  teardownJobs(); // close agent-job streams from the leaving tab (jobs keep running server-side; reload reconnects)
  closeDetail(true);
  closeMealSheet(true);
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === tab));
  state.tab = tab;
  // Warm re-entry skips the skeleton (the render paints from cache) — same as
  // switchTab, so a programmatic/first activate is also flash-free when cached.
  const warm = !!peekCached(primaryKeyFor(tab));
  const paintSkeleton = () => {
    const skel = warm ? "" : tabSkeleton(tab);
    if (skel) { view.innerHTML = skel; viewEnter(); }
  };
  Promise.resolve(withViewTransition(paintSkeleton)).finally(() => {
    Promise.resolve(renderTab(tab)).catch(() => tabErrorState(tab));
  });
}

// ---------- service-worker lifecycle: register + auto-update ----------
// Single-user self-hosted app: a deploy should always be live on the next open,
// never stranded behind a manual tap (a client once fell ~40 cache versions behind
// because the old build couldn't show the update prompt). sw.js skipWaiting()s on
// install, so the new worker activates as soon as it downloads; here we reload ONCE
// when it takes control. The first-ever install (no prior controller) must NOT
// reload — there's nothing to update and it would loop. Chat drafts + in-flight
// turns are persisted (localStorage + /chat/turns), and SWR repaints warm, so the
// reload is seamless and loses nothing.
if ("serviceWorker" in navigator) {
  const _hadController = !!navigator.serviceWorker.controller;
  let _swReloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!_hadController || _swReloading) return; // first install → nothing to reload
    _swReloading = true;
    location.reload();
  });
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
swrSweep(); // evict stale/over-cap SWR rows before the first paint reads the cache
// Register reconnectors so a job running across a reload re-attaches to its host
// (the registry const is defined in the job-runner section, so this runs at boot).
registerJobReconnector("session_suggest", reconnectSessionSuggest);
registerJobReconnector("meal_plan", reconnectMealPlan);
registerJobReconnector("meal_swap", reconnectMealSwap);
registerJobReconnector("recipe", reconnectRecipe);
registerJobReconnector("day_read_override", reconnectDayReadOverride);
registerJobReconnector("nutrition_checkin", reconnectNutritionCheckin);
registerJobReconnector("insight", reconnectInsight);
registerJobReconnector("proposal", reconnectProposal);
// Prime the discipline emphasis global BEFORE the first paint so a landing straight
// on Progress (?tab=progress / a PWA shortcut) honors an endurance athlete's default
// view. Warm cache → set it synchronously (no flash). Cold → fetch, and if the
// landing tab is Progress and the default seg flipped, re-render it once.
function primeDiscipline() {
  const warm = peekCached("profile");
  if (warm && warm.data) { setDiscipline(warm.data.primary_discipline); setEnduranceGoalSet(!!warm.data.endurance_goal_json); return; }
  api("/profile").then((p) => {
    if (!p) return;
    const before = defaultProgressSeg();
    const beforeEnd = showEnduranceTab();
    setDiscipline(p.primary_discipline);
    setEnduranceGoalSet(!!p.endurance_goal_json);
    // only re-render if we're still sitting on the Progress tab AND nothing was
    // navigated since boot AND the endurance default actually changed the seg.
    if (state.tab === "progress" && !state.progressSeg && defaultProgressSeg() !== before) renderTab("progress");
    // Likewise: a cold-boot landing straight on Plan painted the 3-tab sub-nav before
    // the profile resolved — repaint so the Endurance pill appears once we know.
    if (state.tab === "plan" && showEnduranceTab() !== beforeEnd) renderTab("plan");
  }).catch(() => {});
}
const _landingTab = new URLSearchParams(location.search).get("tab");
primeDiscipline();
activateTab(_landingTab);
maybeOnboard();
// Refresh art readiness from the server's on-disk manifest so a cold client (or a
// background-generated image) renders generated art instantly on the next render.
// The first paint already used the localStorage-hydrated set; this is the backstop.
primeArtManifest();
// Re-attach any agent job that was running when the app last closed. The first
// paint is async, so defer a tick; jobReconnect rebuilds each running job's host
// via its registered reconnector.
setTimeout(() => { jobReconnect(); }, 0);

// Keep the bottom-fixed UI (tab bar, rest timer, toast) clear of the mobile
// browser's bottom toolbar. iOS Safari anchors position:fixed;bottom:0 to the
// full layout viewport, so a visible address/tool bar overlaps the tab bar and
// clips its labels (env(safe-area-inset-bottom) is 0 in a normal tab, only the
// installed PWA gets it). visualViewport tells us how much layout viewport is
// hidden at the bottom; we lift everything by that much via the --vvb variable.
// Re-measure the chat column whenever the viewport shifts (zoom, keyboard,
// orientation, window resize). Cheap and idempotent — bails immediately when
// Chat isn't on screen.
const syncChatViewport = () => { if (state.tab === "chat") measureChatTop(); };
window.addEventListener("resize", syncChatViewport);
window.addEventListener("orientationchange", syncChatViewport);

(() => {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  // The keyboard is "open" whenever a text field is focused. This is the ONLY
  // signal that's reliable in both a Safari tab AND an installed PWA: in the
  // standalone PWA iOS shrinks the *layout* viewport together with the visual
  // viewport, so innerHeight - vv.height ≈ 0 and pure geometry never detects the
  // keyboard. Focus does. (Geometry is kept as a secondary OR for the rare
  // keyboard-without-focus case.)
  const TEXTY = /^(|text|search|email|url|tel|password|number)$/;
  const kbFocused = () => {
    const el = document.activeElement;
    if (!el || el === document.body) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT") return TEXTY.test((el.getAttribute("type") || "").toLowerCase());
    return el.isContentEditable === true;
  };
  // The tallest visual viewport seen this orientation ≈ the NO-keyboard height.
  // Used to tell "keyboard is actually on screen" (viewport shrunk) from "keyboard
  // is gone" (viewport back to full) — in BOTH a Safari tab and an installed PWA,
  // since vv.height itself shrinks/grows with the keyboard even when innerHeight
  // tracks it (so the layout-viewport `shrink` reads ~0 in a PWA). Reset on rotate.
  let vvMax = vv.height;
  let restoreTimer = 0;
  const applyVvb = (kbOpen) => {
    // Pin the fixed bottom bars to the VISUAL viewport's bottom edge:
    //  • settled PWA → 0
    //  • browser tab with a bottom toolbar → positive (lift the bar above it)
    //  • after the keyboard drops in a PWA, iOS can leave the LAYOUT viewport
    //    (innerHeight) SHORT of the restored visible area, so a plain bottom:0
    //    bar floats above the true screen bottom — this yields a NEGATIVE value
    //    that pushes the bar back down. The old Math.max(0,…) clamp swallowed
    //    exactly this correction, so the gap lingered until a re-render.
    // Keyboard open → 0 (the bar sits behind the keyboard; chat hides it anyway).
    const vvb = kbOpen ? 0 : window.innerHeight - (vv.offsetTop + vv.height);
    root.style.setProperty("--vvb", Math.round(vvb) + "px");
  };
  const sync = () => {
    if (vv.height > vvMax) vvMax = vv.height;
    const shrink = Math.max(0, window.innerHeight - vv.height);
    const kbOpen = kbFocused() || shrink > Math.max(140, window.innerHeight * 0.18);
    document.body.classList.toggle("kb-open", kbOpen);
    applyVvb(kbOpen);
    syncChatViewport();
    // iOS's on-screen "hide keyboard" button dismisses the keyboard WITHOUT blurring
    // the field, so kbFocused() stays true and kb-open stuck — the tab bar stayed
    // hidden with no keyboard on screen, leaving no way to navigate off Chat. When
    // the visual viewport sits back at its full (no-keyboard) height, the keyboard is
    // truly gone: clear kb-open even though focus is retained. The settle delay keeps
    // it distinct from the focus→keyboard-rising moment (also briefly full-height), so
    // instant-hide-on-focus is preserved.
    clearTimeout(restoreTimer);
    if (kbOpen && vv.height >= vvMax - 40) {
      restoreTimer = setTimeout(() => {
        if (vv.height >= vvMax - 40 && document.body.classList.contains("kb-open")) {
          document.body.classList.remove("kb-open");
          applyVvb(false);
          syncChatViewport();
        }
      }, 350);
    }
  };
  vv.addEventListener("resize", sync);
  vv.addEventListener("scroll", sync); // keyboard open/close shifts offsetTop
  window.addEventListener("orientationchange", () => { vvMax = vv.height; sync(); });
  // Focus/blur of a text field is the earliest, most reliable keyboard signal —
  // flip kb-open the instant focus moves, then re-settle after the keyboard
  // finishes animating (esp. on blur, when the bars slide back).
  document.addEventListener("focusin", sync, true);
  document.addEventListener("focusout", () => {
    sync();
    requestAnimationFrame(() => requestAnimationFrame(sync));
    setTimeout(sync, 300);
  }, true);
  // Returning to the app — tab switch back, app resume from background, or a bfcache
  // restore — can leave visualViewport metrics stale: --vvb keeps an old keyboard-inset
  // value, so the fixed tab bar sits off the bottom and swallows taps until a manual
  // scroll forces a reflow (the "looks stuck on resume" bug). Re-measure on every resume
  // path. iOS reports the final layout viewport a frame or two AFTER pageshow, so settle
  // with a double rAF in addition to the immediate read.
  const resync = () => { sync(); requestAnimationFrame(() => requestAnimationFrame(sync)); };
  window.addEventListener("pageshow", resync);
  window.addEventListener("focus", resync);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") resync(); });
  sync();
})();
