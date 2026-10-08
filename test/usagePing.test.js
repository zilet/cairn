// The opt-in usage ping (src/usagePing.ts): OFF by default, inert without a feedback
// service, at most weekly, and exactly five fields. fetch is always injected — the
// suite never reaches the network (test/run.mjs also sets CAIRN_FEEDBACK_URL="").
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { maybeSendUsagePing, readUsagePingState, usagePingDue, usagePingPayload } from "../dist/usagePing.js";

const SERVICE = { CAIRN_FEEDBACK_URL: "https://feedback.example.org", CAIRN_PLATFORM: "railway" };
const DAY = 24 * 60 * 60 * 1000;

function recorder(response = { ok: true, status: 204 }) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  return { calls, fetch };
}

beforeEach(() => {
  db.prepare("DELETE FROM app_state WHERE key IN ('usage_ping', 'instance_id')").run();
});

test("usage_ping_enabled defaults OFF and round-trips", () => {
  assert.equal(repo.getSettings().usage_ping_enabled, false);
  repo.setSettings({ usage_ping_enabled: true });
  assert.equal(repo.getSettings().usage_ping_enabled, true);
  repo.setSettings({ lead_mode: "lead" }); // an unrelated save keeps it
  assert.equal(repo.getSettings().usage_ping_enabled, true);
  db.prepare("UPDATE settings SET usage_ping_enabled = NULL WHERE id = 1").run();
  assert.equal(repo.getSettings().usage_ping_enabled, false, "an old NULL row stays opted out");
});

test("usagePingDue: opted in, a service, a week since the last ping, a day since a failed try", () => {
  const now = new Date("2026-10-07T12:00:00Z");
  const never = { last_sent_at: null, last_attempt_at: null };
  const base = "https://feedback.example.org";
  assert.equal(usagePingDue({ enabled: false, baseUrl: base, state: never, now }), false);
  assert.equal(usagePingDue({ enabled: true, baseUrl: null, state: never, now }), false);
  assert.equal(usagePingDue({ enabled: true, baseUrl: base, state: never, now }), true);
  const sixDays = new Date(now.getTime() - 6 * DAY).toISOString();
  const eightDays = new Date(now.getTime() - 8 * DAY).toISOString();
  const anHourAgo = new Date(now.getTime() - 3600_000).toISOString();
  assert.equal(
    usagePingDue({ enabled: true, baseUrl: base, state: { last_sent_at: sixDays, last_attempt_at: sixDays }, now }),
    false
  );
  assert.equal(
    usagePingDue({ enabled: true, baseUrl: base, state: { last_sent_at: eightDays, last_attempt_at: eightDays }, now }),
    true
  );
  assert.equal(
    usagePingDue({ enabled: true, baseUrl: base, state: { last_sent_at: eightDays, last_attempt_at: anHourAgo }, now }),
    false,
    "a failed try waits a day"
  );
});

test("the ping is exactly five fields", () => {
  const payload = usagePingPayload("id-1", { CAIRN_PLATFORM: "railway" });
  assert.deepEqual(Object.keys(payload).sort(), ["arch", "instance_id", "node", "platform", "version"]);
  assert.equal(payload.platform, "railway");
  assert.equal(payload.arch, process.arch);
  assert.equal(payload.node, process.version);
});

test("nothing is sent when off, or with no service configured", async () => {
  const off = recorder();
  assert.equal(await maybeSendUsagePing({ env: SERVICE, fetch: off.fetch }), false, "settings default is off");
  assert.equal(off.calls.length, 0);
  const noService = recorder();
  assert.equal(
    await maybeSendUsagePing({
      env: { CAIRN_FEEDBACK_URL: "", CAIRN_PLATFORM: "docker" },
      enabled: true,
      fetch: noService.fetch,
    }),
    false
  );
  assert.equal(noService.calls.length, 0);
  assert.deepEqual(readUsagePingState(), { last_sent_at: null, last_attempt_at: null }, "no attempt recorded either");
});

test("opted in with a service: one POST to /v1/ping, then quiet for a week", async () => {
  repo.setSettings({ usage_ping_enabled: true });
  const net = recorder();
  const now = new Date("2026-10-07T12:00:00Z");
  assert.equal(await maybeSendUsagePing({ env: SERVICE, fetch: net.fetch, now }), true);
  assert.equal(net.calls.length, 1);
  assert.equal(net.calls[0].url, "https://feedback.example.org/v1/ping");
  assert.equal(net.calls[0].init.method, "POST");
  assert.equal(net.calls[0].init.headers["Content-Type"], "application/json");
  const body = JSON.parse(net.calls[0].init.body);
  assert.deepEqual(Object.keys(body).sort(), ["arch", "instance_id", "node", "platform", "version"]);
  assert.equal(body.platform, "railway");
  assert.match(body.instance_id, /^[0-9a-f-]{36}$/);

  assert.equal(
    await maybeSendUsagePing({ env: SERVICE, fetch: net.fetch, now: new Date(now.getTime() + 3 * DAY) }),
    false
  );
  assert.equal(net.calls.length, 1, "at most weekly");
  assert.equal(
    await maybeSendUsagePing({ env: SERVICE, fetch: net.fetch, now: new Date(now.getTime() + 7 * DAY) }),
    true
  );
  assert.equal(net.calls.length, 2);
  repo.setSettings({ usage_ping_enabled: false });
});

test("a failed ping is silent, never throws, and waits a day before trying again", async () => {
  const now = new Date("2026-10-07T12:00:00Z");
  const down = recorder({ ok: false, status: 503 });
  assert.equal(await maybeSendUsagePing({ env: SERVICE, enabled: true, fetch: down.fetch, now }), false);
  const state = readUsagePingState();
  assert.equal(state.last_sent_at, null);
  assert.equal(state.last_attempt_at, now.toISOString());
  assert.equal(
    await maybeSendUsagePing({
      env: SERVICE,
      enabled: true,
      fetch: down.fetch,
      now: new Date(now.getTime() + 3600_000),
    }),
    false
  );
  assert.equal(down.calls.length, 1, "no retry within the day");
  const thrower = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.doesNotReject(
    maybeSendUsagePing({ env: SERVICE, enabled: true, fetch: thrower, now: new Date(now.getTime() + 2 * DAY) })
  );
});
