// ==== settings-routes.js ====
// Server-owned route-task metadata + compact rendering helpers for Settings.
// 10-boot owns the Settings shell; this file owns the route-list policy boundary so
// task labels do not drift from src/repo/settings.ts.
const FALLBACK_ROUTE_TASK_KEYS = [
  "chat", "day_read", "session_suggest", "meal_plan", "meal_swap", "recipe",
  "nutrition_checkin", "insight", "weekly_read", "health_review", "health_synthesis",
];

function settingsEscHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function settingsEscAttr(s) {
  return settingsEscHtml(s);
}

function settingsRouteLabel(key) {
  return String(key || "")
    .split("_")
    .filter(Boolean)
    .map((part, i) => i === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part)
    .join(" ");
}

function settingsRouteTasks(data) {
  const rows = Array.isArray(data?.route_tasks) ? data.route_tasks : [];
  const normalized = rows.map((r) => {
    const key = String(r?.key ?? r?.task ?? "").trim();
    const label = String(r?.label ?? key.replace(/_/g, " ")).trim();
    return key && label ? [key, label] : null;
  }).filter(Boolean);
  return normalized.length ? normalized : FALLBACK_ROUTE_TASK_KEYS.map((key) => [key, settingsRouteLabel(key)]);
}

function settingsPruneRoutes(routes, routeTasks, enabledAgents) {
  const taskSet = new Set((routeTasks || []).map(([task]) => String(task)));
  const agentSet = new Set((enabledAgents || []).map((a) => String(a?.name || "")).filter(Boolean));
  const cleaned = {};
  Object.entries(routes || {}).forEach(([task, agent]) => {
    const k = String(task);
    const v = String(agent || "");
    if (taskSet.has(k) && agentSet.has(v)) cleaned[k] = v;
  });
  return cleaned;
}

function settingsRouteRowsHtml(routeTasks, enabledAgents, routes) {
  return (routeTasks || []).map(([task, label]) => {
    const cur = routes?.[task] || "";
    const opts = `<option value="">⟳ Auto</option>` + (enabledAgents || []).map((a) =>
      `<option value="${settingsEscAttr(a.name)}" ${cur === a.name ? "selected" : ""}>${settingsEscHtml(a.name)}</option>`).join("");
    return `<div class="logrow route-row">
      <span class="route-task">${settingsEscHtml(label)}</span>
      <select class="route-sel selflex" data-route="${settingsEscAttr(task)}" aria-label="Agent for ${settingsEscAttr(label)}">${opts}</select>
    </div>`;
  }).join("");
}
