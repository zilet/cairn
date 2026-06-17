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
  const pct = st.ok_rate != null ? Math.round(Number(st.ok_rate) * 100) : null;
  const ms = (v) => { const n = Number(v) || 0; return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`; };
  const okLine = pct != null
    ? `<b>${pct}%</b> of recent runs returned cleanly · ${Number(st.runs)} run${Number(st.runs) === 1 ? "" : "s"} tracked`
    : `${Number(st.runs)} run${Number(st.runs) === 1 ? "" : "s"} tracked`;
  const rows = (Array.isArray(st.by_agent) ? st.by_agent : []).filter((a) => a && a.agent).map((a) => {
    const tot = (Number(a.ok) || 0) + (Number(a.fail) || 0);
    const apct = tot ? Math.round((Number(a.ok) || 0) / tot * 100) : null;
    const lat = a.p50_ms != null ? ` · ${ms(a.p50_ms)} typical` : "";
    return `<div class="agenthealth-row">
        <span class="agenthealth-name">${escHtml(String(a.agent))}</span>
        <span class="agenthealth-stat">${apct != null ? `${apct}% clean` : "—"}${lat}</span>
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

async function renderSettings() {
  headerTitle.textContent = "Settings";
  const [data, artStats, agentStats, learnings] = await Promise.all([
    api("/settings"),
    api("/art/stats").catch(() => null),
    api("/agent-stats").catch(() => null), // 404s on a backend without telemetry → degrade silently
    api("/learnings").catch(() => null),   // F2: outcome learnings → "What Cairn has noticed"; absent on an older backend
  ]);
  const s = data.settings;
  const agents = data.agents; // ordered: {name, description, env_ok, enabled}

  const stratOpt = (v, label) => `<option value="${v}" ${s.agent_strategy === v ? "selected" : ""}>${label}</option>`;
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // Per-task agent routing (optional). Calm, advanced: each task can pin a specific
  // agent or stay on Auto (= the rotation above). Plain-language task labels; only
  // enabled agents are offered. "Auto" everywhere is today's behavior.
  const ROUTE_TASKS = [
    ["chat", "Chat"],
    ["day_read", "Daily brief"],
    ["session_suggest", "Build me a session"],
    ["meal_plan", "Meal plan"],
    ["meal_swap", "Meal swap"],
    ["recipe", "Recipe"],
    ["nutrition_checkin", "Nutrition check-in"],
    ["insight", "Quiet insight"],
    ["weekly_read", "Weekly read"],
    ["health_review", "Health review"],
  ];
  const routes = { ...(s.agent_routes || {}) }; // working copy, persisted on Save
  const enabledAgents = agents.filter((a) => a.enabled);
  const routeRowsHtml = ROUTE_TASKS.map(([task, label]) => {
    const cur = routes[task] || "";
    const opts = `<option value="">⟳ Auto</option>` + enabledAgents.map((a) =>
      `<option value="${escAttr(a.name)}" ${cur === a.name ? "selected" : ""}>${escHtml(a.name)}</option>`).join("");
    return `<div class="logrow route-row">
      <span class="route-task">${escHtml(label)}</span>
      <select class="route-sel selflex" data-route="${escAttr(task)}">${opts}</select>
    </div>`;
  }).join("");

  // Agent-health card (server telemetry; see GET /api/agent-stats — Stream 1).
  // Mirrors the art-spend card's calm ledger style. No scores, just ok-rate +
  // per-agent latency, plain words. Renders nothing if the endpoint is absent.
  const agentHealthHtml = agentHealthCard(agentStats);
  // "What Cairn did" — the quiet activity log of recent agent runs (transparency,
  // not a grade). Sits right under Agent health; renders nothing when empty.
  const agentActivityHtml = agentActivityCard(agentStats);
  // "What Cairn has noticed" (F2) — gentle outcome-learning observations. Sits with
  // the other quiet Coaching cards; renders nothing until reconciliation finds one.
  const noticedHtml = noticedCard(learnings);

  // Artwork spend telemetry card (server estimates; see GET /api/art/stats).
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

  view.innerHTML = `
    <p class="set-lede">Everything here is optional — Cairn works out of the box. Connect an agent below for coaching.</p>
    <section class="set-group">
      <h2 class="set-group-title">Coaching</h2>
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
        <summary><h1 class="lbl" style="margin:22px 0 8px;display:inline">Route tasks to agents</h1></summary>
        <p class="set-group-sub" style="margin-top:2px">Optional. Pin a specific agent to a task — say chat to one, meal drafts to another. Leave any task on <b>Auto</b> to use the rotation above. Only enabled agents appear.</p>
        <div id="routelist" class="route-list">${routeRowsHtml}</div>
      </details>

      <h1 class="lbl" style="margin:22px 0 8px">Weekly auto-coach</h1>
      <label class="toggle"><input type="checkbox" id="coachEnabled" ${s.coach_enabled ? "checked" : ""}>
        <span>Draft a proposal automatically each week</span></label>
      <div class="logrow" style="margin-top:12px">
        <select id="coachDay" class="selflex">${dayNames.map((d, i) => `<option value="${i}" ${s.coach_day === i ? "selected" : ""}>${d}</option>`).join("")}</select>
        <select id="coachHour" class="selflex">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${s.coach_hour === h ? "selected" : ""}>${String(h).padStart(2, "0")}:00</option>`).join("")}</select>
      </div>
    </section>

    <section class="set-group">
      <h2 class="set-group-title">Connected sources</h2>
      <p class="set-group-sub">Where your recovery and activity data come in. Both are optional and gracefully absent.</p>

      <h1 class="lbl" style="margin:14px 0 8px">Garmin Connect</h1>
      <div class="field"><label>Garmin email</label>
        <input id="garminUsername" type="email" autocomplete="username" value="${escAttr(s.garmin_username || "")}" placeholder="you@example.com">
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
        No App Store, no account — an iOS Shortcut posts your daily metrics straight to Cairn. Steps
        and sleep feed the day-read and the energy-balance estimate.
      </div>
      <div class="ah-steps">
        <div class="ah-step"><span class="ah-num">1</span><div>Open <b>Shortcuts</b> on your iPhone → <b>+</b> → add the <b>Get Health Sample</b> actions you want (Steps, Sleep, Resting Heart Rate, Heart Rate Variability, Active Energy).</div></div>
        <div class="ah-step"><span class="ah-num">2</span><div>Build one JSON row per day: <code>date</code> (YYYY-MM-DD) plus any of <code>steps</code>, <code>sleep_min</code>, <code>sleep_score</code>, <code>resting_hr</code>, <code>hrv_ms</code>, <code>active_calories</code>. Wrap the rows in an array — a backfill is one array with many rows.</div></div>
        <div class="ah-step"><span class="ah-num">3</span><div>Add a <b>Get Contents of URL</b> action: method <b>POST</b>, request body <b>JSON</b> (the array), to the URL below.</div></div>
        <div class="ah-step"><span class="ah-num">4</span><div>Set it to run on an <b>Automation</b> each morning. Posts are idempotent per source + date (source defaults to <code>apple</code>), so re-running never duplicates a day.</div></div>
      </div>
      <div class="field" style="margin-top:12px"><label>POST URL</label>
        <div class="ah-url"><code id="ahUrl"></code><button id="ahUrlCopy" class="ghostbtn ah-copy" type="button">Copy</button></div>
      </div>
      <div class="ah-example">
        <span class="ah-example-lbl">Example body</span>
        <code>[{"date":"2026-06-13","steps":8421,"sleep_min":437,"resting_hr":52}]</code>
      </div>
    </section>

    <section class="set-group">
      <h2 class="set-group-title">Automation &amp; artwork</h2>
      <p class="set-group-sub">Background touches that make logging effortless. Both fall back gracefully when off.</p>

      <h1 class="lbl" style="margin:14px 0 8px">Agentic enrichment</h1>
      <label class="toggle"><input type="checkbox" id="enrichEnabled" ${s.enrich_enabled ? "checked" : ""}>
        <span>Refine free-text logs &amp; capture coaching notes via an agent</span></label>
      <div class="sess-line" style="color:var(--muted);margin-top:6px">Logs stay instant; an agent upgrades them in the background. Falls back to offline parsing when off.</div>

      <h1 class="lbl" style="margin:22px 0 8px">Artwork generation</h1>
      <label class="toggle"><input type="checkbox" id="artEnabled" ${(s.art_enabled ?? 1) ? "checked" : ""}>
        <span>Generate studio photos for foods, exercises &amp; activities</span></label>
      <div class="field" style="margin-top:10px"><label>Gemini API key</label>
        <input id="geminiApiKey" type="password" autocomplete="off" placeholder="${s.gemini_api_key_configured ? `Configured via ${escAttr(s.gemini_api_key_source)}` : "Optional: GOOGLE_AI_KEY / GEMINI_API_KEY"}">
      </div>
      <div class="sess-line" style="color:var(--muted);margin-top:6px">Settings key overrides GOOGLE_AI_KEY / GEMINI_API_KEY from the server environment. Blank preserves the current key.</div>
      ${artSpendHtml}

      <h1 class="lbl" style="margin:22px 0 8px">Research &amp; grounding</h1>
      <label class="toggle"><input type="checkbox" id="researchEnabled" ${s.research_enabled ? "checked" : ""}>
        <span>Let Cairn research your findings and cite real sources</span></label>
      <div class="sess-line" style="color:var(--muted);margin-top:6px">When on, a web-capable agent grounds your lab findings against current clinical guidance and attaches the sources behind each directive — open them under “see the evidence” in <b>Me → Brain</b>. Off by default; everything stays deterministic and offline when off. Informational, never medical advice.</div>
    </section>

    <section class="set-group">
      <h2 class="set-group-title">Backup &amp; reset</h2>
      <p class="set-group-sub">Keep an offline copy of everything, or start the first-time setup over.</p>

      <h1 class="lbl" style="margin:14px 0 8px">Data &amp; backup</h1>
      <button id="dlJson" class="ghostbtn" style="width:100%;text-align:center;padding:11px">Download JSON backup</button>
      <button id="dlDb" class="ghostbtn" style="width:100%;text-align:center;padding:11px;margin-top:8px">Download SQLite snapshot</button>

      <h1 class="lbl" style="margin:22px 0 8px">Setup</h1>
      <button id="rerunSetup" class="ghostbtn" style="width:100%;text-align:center;padding:11px">Re-run first-time setup</button>
    </section>`;

  // working copy edited in place, persisted on Save
  const order = agents.map((a) => a.name);
  const disabled = new Set(agents.filter((a) => !a.enabled).map((a) => a.name));
  const meta = Object.fromEntries(agents.map((a) => [a.name, a]));

  const persistSettings = async () => {
    await api("/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_strategy: $("#strat").value,
        agent_order: order,
        disabled_agents: [...disabled],
        enrich_enabled: $("#enrichEnabled").checked,
        art_enabled: $("#artEnabled").checked,
        research_enabled: $("#researchEnabled").checked,
        gemini_api_key: $("#geminiApiKey").value.trim(),
        garmin_username: $("#garminUsername").value.trim(),
        garmin_password: $("#garminPassword").value.trim(),
        coach_enabled: $("#coachEnabled").checked,
        coach_day: +$("#coachDay").value,
        coach_hour: +$("#coachHour").value,
        agent_routes: routes,
      }),
    });
    artEnabled = $("#artEnabled").checked; // take effect on the next render, no reload
    return true;
  };
  // floating save bar: every field edit (inputs below + agent list buttons)
  // surfaces Save/Discard right above the tab bar, no scrolling to the button
  const settingsBar = mountSaveBar({
    sentinel: $("#agentlist"),
    fields: view,
    onSave: persistSettings,
    onDiscard: () => renderSettings(),
  });

  function renderAgentList() {
    const wrap = $("#agentlist");
    wrap.innerHTML = order.map((name, i) => {
      const a = meta[name];
      const off = disabled.has(name);
      // Calm presence indicator (no alarming red) so a user isn't left guessing why
      // coaching is silent. `present` = the CLI binary is installed; `env_ok` = any
      // required key is set; `usable` rolls those up (plus enabled). A dot + plain
      // word: ready / not installed / sign-in needed.
      let dotCls, statusLbl;
      if (a.present === false) { dotCls = "agentdot-absent"; statusLbl = "not installed"; }
      else if (a.env_ok === false) { dotCls = "agentdot-absent"; statusLbl = "sign-in needed"; }
      else { dotCls = "agentdot-ready"; statusLbl = "ready"; }
      return `<div class="agentrow${off ? " off" : ""} reveal" style="${stagger(i)}">
        <div class="agentmeta">
          <div class="agentname">${name}</div>
          <div class="agentstatus"><span class="agentdot ${dotCls}" aria-hidden="true"></span>${statusLbl}</div>
          <div class="agentdesc">${a.description || ""}</div>
        </div>
        <div class="agentctl">
          <button class="ordbtn" data-up="${name}" ${i === 0 ? "disabled" : ""}>↑</button>
          <button class="ordbtn" data-down="${name}" ${i === order.length - 1 ? "disabled" : ""}>↓</button>
          <button class="togglebtn${off ? "" : " on"}" data-toggle="${name}">${off ? "OFF" : "ON"}</button>
        </div>
      </div>`;
    }).join("");
    wrap.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", () => {
      const n = b.dataset.toggle; disabled.has(n) ? disabled.delete(n) : disabled.add(n); settingsBar.markDirty(); renderAgentList();
    }));
    wrap.querySelectorAll("[data-up]").forEach((b) => b.addEventListener("click", () => {
      const i = order.indexOf(b.dataset.up); if (i > 0) { [order[i - 1], order[i]] = [order[i], order[i - 1]]; settingsBar.markDirty(); renderAgentList(); }
    }));
    wrap.querySelectorAll("[data-down]").forEach((b) => b.addEventListener("click", () => {
      const i = order.indexOf(b.dataset.down); if (i < order.length - 1) { [order[i + 1], order[i]] = [order[i], order[i + 1]]; settingsBar.markDirty(); renderAgentList(); }
    }));
  }
  renderAgentList();

  // Per-task routing selects: keep the working copy in sync (the global save-bar
  // change listener marks dirty). An empty value clears the pin (back to Auto).
  view.querySelectorAll("[data-route]").forEach((sel) => sel.addEventListener("change", () => {
    const task = sel.dataset.route;
    const v = sel.value;
    if (v) routes[task] = v; else delete routes[task];
  }));

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
    let r = await api("/agent-clis/update");
    renderCliStatus(r);
    btn.disabled = r.status === "running";
    while (r.status === "running") {
      await sleep(2000);
      r = await api("/agent-clis/update");
      renderCliStatus(r);
      btn.disabled = r.status === "running";
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

  // Manual Garmin sync: pulse while the connector runs, then re-pull /settings
  // so the status line shows exactly what the server recorded.
  $("#garminSyncBtn").addEventListener("click", async () => {
    const btn = $("#garminSyncBtn");
    const status = $("#garminStatus");
    btn.disabled = true;
    btn.textContent = "Syncing…";
    status.innerHTML = garminStatusLine(null, true);
    let r = null;
    try { r = await api("/garmin/sync", { method: "POST" }); } catch {}
    let fresh = s;
    try { fresh = (await api("/settings")).settings; } catch {}
    // a tab switch may have replaced the view while we waited
    if (!btn.isConnected) return;
    status.innerHTML = garminStatusLine(fresh, false);
    btn.disabled = false;
    btn.textContent = "Sync now";
    toast(r && r.ok ? `Garmin synced · ${r.activities} activit${r.activities === 1 ? "y" : "ies"}` : "Garmin sync failed");
  });

  // Apple Health: show the page-origin POST URL + one-tap copy.
  const ahUrl = $("#ahUrl");
  if (ahUrl) ahUrl.textContent = location.origin + "/api/health-metrics";
  const ahCopy = $("#ahUrlCopy");
  if (ahCopy) ahCopy.addEventListener("click", async () => {
    const url = location.origin + "/api/health-metrics";
    try { await navigator.clipboard.writeText(url); ahCopy.textContent = "Copied"; }
    catch { ahCopy.textContent = "Copy failed"; }
    setTimeout(() => { ahCopy.textContent = "Copy"; }, 1600);
  });

  $("#dlJson").addEventListener("click", () => downloadFile(withToken("/api/export")));
  $("#dlDb").addEventListener("click", () => downloadFile(withToken("/api/export/db")));
  $("#rerunSetup").addEventListener("click", async () => {
    await api("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ onboarded: false }) });
    location.reload();
  });
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
    status.textContent = "One moment — folding this into your picture.";
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
    setDiscipline(p.primary_discipline);
    setEnduranceGoalSet(!!p.endurance_goal_json);
    // only re-render if we're still sitting on the Progress tab AND nothing was
    // navigated since boot AND the endurance default actually changed the seg.
    if (state.tab === "progress" && !state.progressSeg && defaultProgressSeg() !== before) renderTab("progress");
  }).catch(() => {});
}
const _landingTab = new URLSearchParams(location.search).get("tab");
primeDiscipline();
activateTab(_landingTab);
maybeOnboard();
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
  const sync = () => {
    const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    // A large inset is the on-screen keyboard, not browser chrome — leave the
    // bar at the bottom (hidden behind the keyboard) rather than flinging it up.
    root.style.setProperty("--vvb", (inset > 160 ? 0 : Math.round(inset)) + "px");
    syncChatViewport();
  };
  vv.addEventListener("resize", sync);
  vv.addEventListener("scroll", sync); // keyboard open/close shifts offsetTop
  window.addEventListener("orientationchange", sync);
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
