import { test } from "node:test";
import assert from "node:assert/strict";
import { queryTokenAllowedPath } from "../dist/auth.js";

test("query-token auth is limited to browser-only GET surfaces", () => {
  assert.equal(queryTokenAllowedPath("/api/health-docs/12/file"), true);
  assert.equal(queryTokenAllowedPath("/api/chat/turns/12/stream"), true);
  assert.equal(queryTokenAllowedPath("/api/agent-jobs/12/stream"), true);
  assert.equal(queryTokenAllowedPath("/api/export"), true);
  assert.equal(queryTokenAllowedPath("/api/export/db"), true);
  assert.equal(queryTokenAllowedPath("/api/health-export"), true);
  assert.equal(queryTokenAllowedPath("/api/plan.ics"), true);
  // Generated artwork is loaded via <img> (can't set headers) → query token must pass.
  assert.equal(queryTokenAllowedPath("/api/art"), true);
});

test("query-token auth is rejected for normal API and MCP routes", () => {
  assert.equal(queryTokenAllowedPath("/api/settings"), false);
  assert.equal(queryTokenAllowedPath("/api/plan"), false);
  assert.equal(queryTokenAllowedPath("/mcp"), false);
  assert.equal(queryTokenAllowedPath("/api/export", "POST"), false);
});
