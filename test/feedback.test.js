// In-app feedback (src/feedback.ts): input validation, the bounded anonymous
// diagnostics snapshot, the GitHub new-issue fallback when no service is configured,
// and delivery to a configured service (mocked fetch — the suite never reaches out).
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import {
  FEEDBACK_DIAGNOSTICS_MAX_BYTES,
  boundDiagnostics,
  buildFeedbackPayload,
  feedbackBaseUrl,
  feedbackDiagnostics,
  getInstanceId,
  githubIssueUrl,
  parseFeedbackInput,
  sendFeedback,
} from "../dist/feedback.js";

const SERVICE = { CAIRN_FEEDBACK_URL: "https://feedback.example.org/" };
const fakeDiagnostics = () => ({
  version: "2.0.0",
  build_id: "b1",
  platform: "docker",
  update_method: "manual",
  arch: "arm64",
  node: "v26.0.0",
  uptime_hours: 1.5,
  window_days: 7,
  issues: [{ fingerprint: "api:http_error:GET:/api/today:500", source: "api", kind: "http_error", count: 2 }],
});

test("parseFeedbackInput requires words, bounds sizes, and keeps diagnostics opt-in", () => {
  assert.deepEqual(parseFeedbackInput({ kind: "idea", message: "  more runs  " }), {
    ok: true,
    value: { kind: "idea", message: "more runs", contact: null, include_diagnostics: false },
  });
  assert.equal(parseFeedbackInput({ kind: "bug", message: "   " }).ok, false);
  assert.equal(parseFeedbackInput({ kind: "rant", message: "x" }).ok, false);
  assert.equal(parseFeedbackInput({ kind: "bug", message: "x".repeat(4001) }).ok, false);
  assert.equal(parseFeedbackInput({ kind: "bug", message: "x".repeat(4000) }).ok, true);
  assert.equal(parseFeedbackInput({ kind: "bug", message: "x", contact: "c".repeat(201) }).ok, false);
  // Only a literal true opts in; a truthy string does not.
  assert.equal(parseFeedbackInput({ message: "x", include_diagnostics: "yes" }).value.include_diagnostics, false);
  assert.equal(parseFeedbackInput({ message: "x", include_diagnostics: true }).value.include_diagnostics, true);
});

test("feedbackBaseUrl: https (or local http) only, trailing slash trimmed; empty means no service", () => {
  assert.equal(feedbackBaseUrl({}), null);
  assert.equal(feedbackBaseUrl({ CAIRN_FEEDBACK_URL: "" }), null);
  assert.equal(feedbackBaseUrl(SERVICE), "https://feedback.example.org");
  assert.equal(feedbackBaseUrl({ CAIRN_FEEDBACK_URL: "http://feedback.example.org" }), null);
  assert.equal(feedbackBaseUrl({ CAIRN_FEEDBACK_URL: "http://localhost:8790" }), "http://localhost:8790");
});

test("the anonymous diagnostics snapshot carries taxonomy only and fits 32 KB", () => {
  db.prepare("DELETE FROM diagnostic_events").run();
  repo.recordDiagnosticEvent({
    source: "api",
    kind: "http_error",
    level: "error",
    operation: "GET",
    route: "/api/today",
    status: 500,
    fingerprint: "api:http_error:GET:/api/today:500",
    message: "HTTP 500",
    trusted_route_template: true,
  });
  const snap = feedbackDiagnostics({ CAIRN_PLATFORM: "docker" });
  assert.equal(snap.platform, "docker");
  assert.equal(snap.update_method, "manual");
  assert.ok(snap.issues.length >= 1);
  for (const issue of snap.issues) {
    assert.deepEqual(
      Object.keys(issue).sort(),
      ["count", "fingerprint", "kind", "last_seen", "level", "route", "source", "status"],
      "no stored message, no free text"
    );
  }
  assert.ok(Buffer.byteLength(JSON.stringify(snap)) <= FEEDBACK_DIAGNOSTICS_MAX_BYTES);

  // An oversize snapshot sheds issue rows (and says how many) until it fits.
  const big = {
    ...fakeDiagnostics(),
    issues: Array.from({ length: 400 }, (_, i) => ({ fingerprint: `fp-${i}-${"x".repeat(150)}` })),
  };
  const bounded = boundDiagnostics(big);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= FEEDBACK_DIAGNOSTICS_MAX_BYTES);
  assert.ok(bounded.issues.length < 400 && bounded.issues.length > 0);
  assert.equal(bounded.issues_omitted, 400 - bounded.issues.length);
});

test("buildFeedbackPayload attaches diagnostics only when the person ticked the box", () => {
  const ctx = { version: "2.0.0", platform: "railway", instance_id: "id-1", diagnostics: fakeDiagnostics() };
  const without = buildFeedbackPayload({ kind: "bug", message: "m", contact: null, include_diagnostics: false }, ctx);
  assert.deepEqual(without, { kind: "bug", message: "m", version: "2.0.0", platform: "railway", instance_id: "id-1" });
  const withDiag = buildFeedbackPayload(
    { kind: "bug", message: "m", contact: "me@x.org", include_diagnostics: true },
    ctx
  );
  assert.equal(withDiag.contact, "me@x.org");
  assert.equal(withDiag.diagnostics.platform, "docker");
});

test("githubIssueUrl prefills a capped issue and keeps the contact out of a public page", () => {
  const url = githubIssueUrl({
    kind: "bug",
    message: "The Brief froze\nafter a sync & reload",
    version: "2.0.0",
    platform: "railway",
    diagnostics: fakeDiagnostics(),
  });
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, "https://github.com/zilet/cairn/issues/new");
  assert.equal(parsed.searchParams.get("title"), "Bug: The Brief froze");
  const body = parsed.searchParams.get("body");
  assert.match(body, /^The Brief froze\nafter a sync & reload/);
  assert.match(body, /Anonymous diagnostics/);
  assert.match(body, /Cairn 2\.0\.0 · railway/);

  const long = githubIssueUrl({
    kind: "idea",
    message: "y".repeat(4000),
    version: "2.0.0",
    platform: "docker",
    diagnostics: {
      ...fakeDiagnostics(),
      issues: Array.from({ length: 60 }, (_, i) => ({ fingerprint: `fp-${i}-${"z".repeat(120)}` })),
    },
  });
  const longBody = new URL(long).searchParams.get("body");
  assert.ok(longBody.length <= 6000, `body capped (${longBody.length})`);
  assert.ok(longBody.startsWith("y".repeat(4000)), "the person's words survive whole");
  assert.doesNotMatch(longBody, /fp-59/, "diagnostics give way first");
});

test("sendFeedback without a service returns the GitHub URL and sends nothing", async () => {
  let fetched = false;
  const result = await sendFeedback(
    { kind: "praise", message: "Calm and useful", contact: "me@example.org", include_diagnostics: false },
    {
      env: {},
      fetch: async () => {
        fetched = true;
        return { ok: true };
      },
      instanceId: () => "id-1",
    }
  );
  assert.equal(fetched, false);
  assert.equal(result.ok, true);
  assert.equal(result.method, "github");
  assert.match(result.url, /^https:\/\/github\.com\/zilet\/cairn\/issues\/new\?/);
  assert.doesNotMatch(decodeURIComponent(result.url), /me@example\.org/);
});

test("sendFeedback posts the contract body to {base}/v1/feedback", async () => {
  const calls = [];
  const result = await sendFeedback(
    { kind: "bug", message: "Sync stalls", contact: "@me", include_diagnostics: true },
    {
      env: { ...SERVICE, CAIRN_PLATFORM: "railway" },
      fetch: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 200, json: async () => ({ ok: true, id: "fb_42" }) };
      },
      instanceId: () => "11111111-2222-3333-4444-555555555555",
      diagnostics: fakeDiagnostics,
    }
  );
  assert.deepEqual(result, { ok: true, method: "service", id: "fb_42", message: "Thanks — your feedback was sent." });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://feedback.example.org/v1/feedback");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(body).sort(), [
    "contact",
    "diagnostics",
    "instance_id",
    "kind",
    "message",
    "platform",
    "version",
  ]);
  assert.equal(body.platform, "railway");
  assert.equal(body.instance_id, "11111111-2222-3333-4444-555555555555");
});

test("a failing service hands back the GitHub fallback instead of losing the message", async () => {
  const result = await sendFeedback(
    { kind: "idea", message: "Dark plates", contact: null, include_diagnostics: false },
    { env: SERVICE, fetch: async () => ({ ok: false, status: 503 }), instanceId: () => "id-1" }
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /HTTP 503/);
  assert.match(result.url, /github\.com\/zilet\/cairn\/issues\/new/);
});

test("the install id is created once and then stable", () => {
  db.prepare("DELETE FROM app_state WHERE key = 'instance_id'").run();
  const first = getInstanceId();
  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.equal(getInstanceId(), first);
});
