import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_FORWARD_CAP,
  LIMITS,
  bearerToken,
  dayBucket,
  exceeds,
  hourBucket,
  isJsonContentType,
  issueBody,
  issueTitle,
  parseCap,
  rateChecks,
  validateFeedback,
  validatePing,
  webhookPayload,
  withinForwardCap,
} from "../src/lib.ts";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const base = { kind: "bug", message: "it broke", version: "2.0.0", platform: "linux", instance_id: ID };

test("validateFeedback accepts a minimal body and normalizes", () => {
  const r = validateFeedback({ ...base, instance_id: ID.toUpperCase(), contact: "  " });
  assert.ok(r.ok);
  assert.equal(r.value.instance_id, ID);
  assert.equal(r.value.contact, null);
  assert.equal(r.value.diagnostics, null);
});

test("validateFeedback rejects bad input", () => {
  const bads: unknown[] = [
    null,
    [],
    { ...base, kind: "rant" },
    { ...base, message: "" },
    { ...base, message: "   " },
    { ...base, message: "x".repeat(4001) },
    { ...base, contact: "c".repeat(201) },
    { ...base, version: "v".repeat(41) },
    { ...base, platform: "p".repeat(21) },
    { ...base, instance_id: "nope" },
    { ...base, diagnostics: "str" },
    { ...base, diagnostics: { big: "x".repeat(33 * 1024) } },
  ];
  for (const b of bads) assert.equal(validateFeedback(b).ok, false, JSON.stringify(b)?.slice(0, 60));
  assert.ok(validateFeedback({ ...base, message: "x".repeat(4000), diagnostics: { a: 1 } }).ok);
});

test("validatePing", () => {
  const p = { instance_id: ID, version: "2.0.0", platform: "darwin", arch: "arm64", node: "26.0.0" };
  assert.ok(validatePing(p).ok);
  assert.equal(validatePing({ ...p, arch: undefined }).ok, false);
  assert.equal(validatePing({ ...p, instance_id: "x" }).ok, false);
  assert.equal(validatePing({ ...p, node: "n".repeat(21) }).ok, false);
});

test("content type", () => {
  assert.ok(isJsonContentType("application/json"));
  assert.ok(isJsonContentType("application/json; charset=utf-8"));
  assert.equal(isJsonContentType("text/plain"), false);
  assert.equal(isJsonContentType(null), false);
});

test("rate checks and windows", () => {
  const t = Date.parse("2026-10-07T13:45:00Z");
  assert.equal(hourBucket(t), "2026-10-07T13");
  assert.equal(dayBucket(t), "2026-10-07");
  const fb = rateChecks("feedback", ID, "abc", t);
  assert.deepEqual(
    fb.map((c) => c.limit),
    [LIMITS.feedbackPerInstanceHour, LIMITS.feedbackPerIpHour],
  );
  assert.equal(rateChecks("feedback", ID, null, t).length, 1);
  assert.equal(rateChecks("ping", ID, "abc", t)[0].limit, 2);
  assert.equal(exceeds(5, 5), false);
  assert.equal(exceeds(6, 5), true);
});

test("daily forward cap decision", () => {
  assert.equal(DEFAULT_FORWARD_CAP, 50);
  assert.equal(parseCap(undefined), 50);
  assert.equal(parseCap("abc"), 50);
  assert.equal(parseCap("-3"), 50);
  assert.equal(parseCap("10"), 10);
  assert.equal(parseCap("0"), 0);
  assert.ok(withinForwardCap(50, 50));
  assert.ok(!withinForwardCap(51, 50));
  assert.ok(!withinForwardCap(1, 0), "cap 0 disables forwarding");
});

test("issue title and body", () => {
  const long = "a".repeat(80);
  assert.equal(issueTitle("idea", long), `[idea] ${"a".repeat(60)}...`);
  assert.equal(issueTitle("bug", "short\n text"), "[bug] short text");

  const noContact = issueBody({ kind: "bug", message: "hi @octocat", contact: null, version: "1", platform: "linux", diagnostics: null });
  assert.ok(!noContact.includes("Contact"));
  assert.ok(!noContact.includes("<details>"));
  assert.ok(!noContact.includes("@octocat"));

  const input = {
    kind: "bug" as const,
    message: "m",
    contact: "me@example.com",
    version: "1",
    platform: "linux",
    instance_id: ID,
    diagnostics: JSON.stringify({ log: "has ``` fence" }),
  };
  const full = issueBody(input);
  assert.ok(!full.includes("Contact"));
  assert.ok(!full.includes("example.com"), "contact never reaches a GitHub issue");
  assert.ok(!JSON.stringify(webhookPayload(1, input)).includes("example.com"), "nor the webhook");
  assert.ok(full.includes("<details><summary>Diagnostics</summary>"));
  assert.ok(full.includes("````json"), "fence longer than any backtick run inside");
});

test("bearerToken", () => {
  assert.equal(bearerToken("Bearer abc"), "abc");
  assert.equal(bearerToken("Basic abc"), null);
  assert.equal(bearerToken(null), null);
});
