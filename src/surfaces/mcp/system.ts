import { applyUpdate } from "../../hosting.js";
import { checkForUpdate, getUpdateStatus } from "../../updateCheck.js";
import { asText, type McpToolRegistrar } from "./shared.js";

// Deliberately no feedback tool: sending feedback is a person's action in the app
// (Settings → Send feedback), never something an agent does on the owner's behalf.
export function registerSystemTools(server: McpToolRegistrar) {
  server.tool("get_update_status",
    "Get the running Cairn version and whether a newer release is available (current, latest, update_available, html_url, notes, checked_at, enabled), plus how releases reach this host: platform (railway|installer|docker|source), update_method (automatic|deploy_hook|trigger_file|manual), can_apply, update_how, and the host updater's last report for trigger_file. Served from the cached daily check — no network on this call. The result just waits in Settings → Data.",
    {},
    async () => asText(getUpdateStatus()));

  server.tool("check_for_update",
    "Force an immediate check against the GitHub Releases API for a newer Cairn version, then return the fresh status. Use when you want to refresh now rather than wait for the daily background check. Never throws — a network/rate-limit failure is reported in the status `error` field.",
    {},
    async () => asText(await checkForUpdate()));

  server.tool("apply_update",
    "Start updating this Cairn to the latest release with the host's own method: POST the platform deploy hook (deploy_hook) or ask the host updater through the data-folder trigger file (trigger_file). Returns {ok, method, message}. A host that updates itself (automatic) or only by hand (manual) returns ok:false with the explanation. Call only when the owner asked to update.",
    {},
    async () => asText(await applyUpdate()));
}
