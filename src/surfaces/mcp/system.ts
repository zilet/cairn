import { checkForUpdate, getUpdateStatus } from "../../updateCheck.js";
import { asText, type McpToolRegistrar } from "./shared.js";

export function registerSystemTools(server: McpToolRegistrar) {
  server.tool("get_update_status",
    "Get the running Cairn version and whether a newer release is available (current, latest, update_available, html_url, notes, checked_at, enabled). Served from the cached daily check — no network on this call. Pull-never-push: nothing notifies; the result just waits in Settings → Data.",
    {},
    async () => asText(getUpdateStatus()));

  server.tool("check_for_update",
    "Force an immediate check against the GitHub Releases API for a newer Cairn version, then return the fresh status. Use when you want to refresh now rather than wait for the daily background check. Never throws — a network/rate-limit failure is reported in the status `error` field.",
    {},
    async () => asText(await checkForUpdate()));
}
