// ==== settings-routes.js ====
// Server-owned route-task metadata + compact rendering helpers for Settings.
// 10-boot owns the Settings shell; this file owns the route-list policy boundary so
// task labels do not drift from src/repo/settings.ts.

type SettingsRouteTask = [string, string];

const FALLBACK_ROUTE_TASK_KEYS: string[] = [
  "chat",
  "day_read",
  "session_suggest",
  "meal_plan",
  "meal_swap",
  "recipe",
  "nutrition_checkin",
  "insight",
  "weekly_read",
  "health_review",
  "health_synthesis",
];

function settingsEscHtml(value: unknown): string {
  const chars: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return String(value ?? "").replace(/[&<>"']/g, (char) => chars[char] || char);
}

function settingsEscAttr(value: unknown): string {
  return settingsEscHtml(value);
}

function settingsRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function settingsRouteLabel(key: unknown): string {
  return String(key || "")
    .split("_")
    .filter(Boolean)
    .map((part, index) => (index === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function settingsRouteTasks(data: unknown): SettingsRouteTask[] {
  const source = settingsRecord(data);
  const rows = Array.isArray(source.route_tasks) ? source.route_tasks : [];
  const normalized = rows
    .map((item): SettingsRouteTask | null => {
      const row = settingsRecord(item);
      const key = String(row.key ?? row.task ?? "").trim();
      const label = String(row.label ?? key.replace(/_/g, " ")).trim();
      return key && label ? [key, label] : null;
    })
    .filter((row): row is SettingsRouteTask => row !== null);
  return normalized.length
    ? normalized
    : FALLBACK_ROUTE_TASK_KEYS.map((key): SettingsRouteTask => [key, settingsRouteLabel(key)]);
}

function settingsPruneRoutes(
  routes: unknown,
  routeTasks: SettingsRouteTask[] | null | undefined,
  enabledAgents: unknown[] | null | undefined,
): Record<string, string> {
  const taskSet = new Set((routeTasks || []).map(([task]) => String(task)));
  const agentSet = new Set((enabledAgents || []).map((agent) => String(settingsRecord(agent).name || "")).filter(Boolean));
  const cleaned: Record<string, string> = {};
  for (const [task, agent] of Object.entries(settingsRecord(routes))) {
    const key = String(task);
    const value = String(agent || "");
    if (taskSet.has(key) && agentSet.has(value)) cleaned[key] = value;
  }
  return cleaned;
}

function settingsRouteRowsHtml(
  routeTasks: SettingsRouteTask[] | null | undefined,
  enabledAgents: Array<{ name?: unknown }> | null | undefined,
  routes: Record<string, unknown> | null | undefined,
): string {
  const activeRoutes = routes || {};
  return (routeTasks || [])
    .map(([task, label]) => {
      const current = activeRoutes[task] || "";
      const options =
        `<option value="">⟳ Auto</option>` +
        (enabledAgents || [])
          .map((agent) => {
            const name = String(agent?.name || "");
            return `<option value="${settingsEscAttr(name)}" ${current === name ? "selected" : ""}>${settingsEscHtml(name)}</option>`;
          })
          .join("");
      return `<div class="logrow route-row">
      <span class="route-task">${settingsEscHtml(label)}</span>
      <select class="route-sel selflex" data-route="${settingsEscAttr(task)}" aria-label="Agent for ${settingsEscAttr(label)}">${options}</select>
    </div>`;
    })
    .join("");
}

Object.assign(globalThis, {
  settingsRouteTasks,
  settingsPruneRoutes,
  settingsRouteRowsHtml,
});
