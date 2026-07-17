// Lightweight HTTP smoke test for Cairn's REST surface.
//
// Boots the BUILT server (dist/server.js) against throwaway temp DBs — the same
// DATA_DIR / DB_PATH isolation `test/run.mjs` uses, so it never touches the real
// data/cairn.db — waits for GET /api/health, then drives a few key flows end to
// end over HTTP with the built-in fetch (no browser, no extra dependency, no
// network beyond loopback). It exercises the API/PWA contract the offline unit
// tests don't: the deterministic day-read, plan CRUD, set logging, export, and
// CAIRN_AUTH_TOKEN runtime behavior.
//
// Deliberately kept OUT of `npm test` (which must stay deterministic/offline/fast
// and not spawn a server). Run it with `npm run smoke` — the `presmoke` script
// builds dist/ first, exactly like `pretest` does for the unit suite.
//
// Agent: the `stub` backend is configured but no flow here needs it — every
// asserted endpoint is deterministic and agent-independent (today-read falls back
// to its deterministic floor when no agent is reachable), so the smoke run stays
// offline. Exits non-zero on the first failed assertion or a boot timeout.
import { existsSync } from "node:fs";
import { BUNDLES } from "../scripts/build-client.mjs";
import { serverEntry, withServer } from "../scripts/smoke-server.mjs";

// The app shell boots via the LAST bundle (it carries the 10-boot shim). Derive
// it from the build manifest so a bundle rename/reshape can't silently break this.
const bootBundleUrl = BUNDLES[BUNDLES.length - 1].output.replace(/^public/, "");

const AUTH_TOKEN = "cairn-smoke-auth-token";

let passed = 0;

function ok(cond, label, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    throw new Error(`assertion failed: ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function getJson(base, p, init) {
  const res = await fetch(`${base}${p}`, init);
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

async function getText(base, p, init) {
  const res = await fetch(`${base}${p}`, init);
  return { status: res.status, headers: res.headers, text: await res.text() };
}

async function runOpenSmoke(ctx) {
  const base = ctx.base;
  // 1) Health — the readiness gate and a basic shape check.
  {
    const health = await fetch(`${base}/api/health`);
    const status = health.status;
    const body = await health.json();
    ok(status === 200, "GET /api/health → 200", `got ${status}`);
    ok(body && body.ok === true, "health body has ok:true", JSON.stringify(body));
    ok(body && "auth_required" in body, "health reports auth_required", JSON.stringify(body));
    ok(!!health.headers.get("x-request-id"), "health response carries a request id");
  }

  // 2) Readiness + diagnostic ingestion — prove the local operator spine over
  //    real HTTP, including the exact browser event namespace.
  {
    const ready = await getJson(base, "/api/ready");
    ok(ready.status === 200 && ready.body?.ok === true, "GET /api/ready proves SQLite readiness");
    ok(ready.body?.queues?.agent_jobs, "readiness reports compact durable queue counts");

    const ingested = await fetch(`${base}/api/telemetry/client`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [{
          kind: "api_failure",
          level: "warning",
          message: "http: Cairn request failed (409)",
          route: "/api/plan",
          method: "POST",
          status: 409,
          duration_ms: 12,
          request_id: "smoke-request",
          fingerprint: "smoke:client:plan:409",
        }],
      }),
    });
    ok(ingested.status === 204, "POST /api/telemetry/client accepts a browser batch", `got ${ingested.status}`);
    const diagnostics = await getJson(base, "/api/diagnostics?days=1&recent=10");
    ok(diagnostics.status === 200 && diagnostics.body?.total >= 1, "GET /api/diagnostics returns captured events");
    ok(
      diagnostics.body?.issues?.some((issue) =>
        issue.fingerprint === "client:api_failure:POST:/api/plan:409" &&
        issue.source === "client" && issue.kind === "api_failure" &&
        issue.route === "/api/plan" && issue.status === 409
      ),
      "diagnostics groups the ingested browser issue"
    );
  }

  // 3) The Brief — the deterministic day-read always returns a REAL read, even
  //    with no agent reachable (it falls back to the deterministic floor).
  {
    const { status, body } = await getJson(base, "/api/today-read");
    ok(status === 200, "GET /api/today-read → 200", `got ${status}`);
    ok(body && ["train", "easy", "rest", "done"].includes(body.kind), "day-read has a valid kind", JSON.stringify(body?.kind));
    ok(body && typeof body.headline === "string" && body.headline.length > 0, "day-read has a headline", JSON.stringify(body?.headline));
  }

  // 3) Plan — the server auto-seeds 5 default days; confirm they're listed.
  {
    const { status, body } = await getJson(base, "/api/plan");
    ok(status === 200, "GET /api/plan → 200", `got ${status}`);
    ok(Array.isArray(body) && body.length > 0, "plan lists seeded days", `len ${body?.length}`);
  }

  // 4) Settings metadata — the Settings route controls are server-owned metadata,
  //    not duplicated labels in the PWA.
  {
    const { status, body } = await getJson(base, "/api/settings");
    ok(status === 200, "GET /api/settings → 200", `got ${status}`);
    ok(body && body.settings && body.agents, "settings returns settings + agents", JSON.stringify(Object.keys(body || {})));
    const routeTasks = body?.route_tasks || [];
    ok(Array.isArray(routeTasks) && routeTasks.some((r) => r.key === "health_synthesis" && r.label), "settings returns route task metadata", JSON.stringify(routeTasks));
  }

  // 5) Static PWA split asset — route-list helper loads as a standalone cached file.
  {
    const res = await fetch(`${base}/js/settings-routes.js`);
    ok(res.status === 200, "GET /js/settings-routes.js → 200", `got ${res.status}`);
    const text = await res.text();
    ok(/settingsRouteTasks/.test(text) && /settingsRouteRowsHtml/.test(text), "settings route helper exposes expected functions");
  }

  // 6) PWA deep links — copied/bookmarked route-state URLs must return the app
  //    shell, not a 404 or JSON API body, so the client can hydrate the screen.
  for (const route of ["/app/today", "/app/me/health/read", "/app/chat?session=smoke-session", "/app/settings/data"]) {
    const { status, headers, text } = await getText(base, route);
    ok(status === 200, `GET ${route} → app shell 200`, `got ${status}`);
    ok((headers.get("content-type") || "").includes("text/html"), `GET ${route} returns HTML`);
    ok(text.includes(`<script src="${bootBundleUrl}" defer></script>`), `GET ${route} includes boot bundle`);
    ok(/<link rel="manifest" href="\/manifest\.json">/.test(text), `GET ${route} includes manifest`);
  }

  // 7) Create a plan day end-to-end (PUT /plan/:day), then read it back. Uses the
  //    top of the valid 1–14 range (plan quality rejects higher day numbers) so it
  //    still never clobbers a seeded day.
  const smokeDay = 14;
  {
    const put = await getJson(base, `/api/plan/${smokeDay}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Smoke Day",
        focus: "smoke",
        items: [{ exercise: "Smoke Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 135 }],
      }),
    });
    ok(put.status === 200, `PUT /api/plan/${smokeDay} → 200`, `got ${put.status}`);
    ok(put.body && put.body.day_number === smokeDay, "created day echoes day_number", JSON.stringify(put.body?.day_number));
    ok(Array.isArray(put.body?.items) && put.body.items.some((i) => i.exercise === "Smoke Squat"), "created day has the item", JSON.stringify(put.body?.items));

    const get = await getJson(base, `/api/plan/${smokeDay}`);
    ok(get.status === 200 && get.body?.name === "Smoke Day", `GET /api/plan/${smokeDay} reads it back`, JSON.stringify(get.body?.name));
  }

  // 8) Log a set, then read it back via the session-by-date lookup. Asserts the
  //    logged_set round-trips with the right exercise/weight/reps and est-1RM.
  const today = new Date().toISOString().slice(0, 10);
  {
    const post = await getJson(base, "/api/sets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ exercise: "Smoke Squat", weight: 135, reps: 5, date: today }),
    });
    ok(post.status === 200, "POST /api/sets → 200", `got ${post.status}`);
    ok(post.body && post.body.exercise === "Smoke Squat" && post.body.weight === 135 && post.body.reps === 5, "logged set echoes its fields", JSON.stringify(post.body));
    ok(post.body && typeof post.body.est_1rm === "number" && post.body.est_1rm > 135, "logged set computes est-1RM (Epley)", JSON.stringify(post.body?.est_1rm));

    const session = await getJson(base, `/api/sessions?date=${today}`);
    ok(session.status === 200 && session.body, "GET /api/sessions?date= returns a session", JSON.stringify(session.body?.id));
    const sets = session.body?.sets || [];
    ok(sets.some((s) => s.exercise === "Smoke Squat" && s.reps === 5), "the logged set is in today's session", JSON.stringify(sets));
  }

  // 9) Export — the JSON backup the whole DB serializes to.
  {
    const res = await fetch(`${base}/api/export`);
    ok(res.status === 200, "GET /api/export → 200", `got ${res.status}`);
    const data = await res.json();
    ok(data && typeof data === "object" && "exported_at" in data, "export has exported_at", JSON.stringify(Object.keys(data || {}).slice(0, 6)));
    ok(Array.isArray(data?.exercises) && data.exercises.length > 0, "export carries exercises", JSON.stringify(data?.exercises?.length));
    ok("plan" in data && "profile" in data && "settings" in data, "export carries the core tables", JSON.stringify(Object.keys(data || {}).slice(0, 12)));
  }
}

async function runAuthSmoke(ctx) {
  const base = ctx.base;
  const bearer = { authorization: `Bearer ${AUTH_TOKEN}` };
  const ownerJsonHeaders = { ...bearer, "content-type": "application/json" };
  const q = encodeURIComponent(AUTH_TOKEN);

  // 9) Health remains public, but reports that auth is enforced.
  {
    const { status, body } = await getJson(base, "/api/health");
    ok(status === 200, "auth: GET /api/health remains public", `got ${status}`);
    ok(body && body.auth_required === true, "auth: health reports auth_required:true", JSON.stringify(body));
  }

  // 10) Protected API rejects without a token.
  {
    const { status, body } = await getJson(base, "/api/plan");
    ok(status === 401, "auth: unauthenticated GET /api/plan → 401", `got ${status}`);
    ok(body && body.error === "unauthorized", "auth: unauthenticated body is unauthorized", JSON.stringify(body));
  }

  // 11) Authorization: Bearer succeeds on the same protected API.
  {
    const { status, body } = await getJson(base, "/api/plan", { headers: bearer });
    ok(status === 200, "auth: Bearer token GET /api/plan → 200", `got ${status}`);
    ok(Array.isArray(body) && body.length > 0, "auth: Bearer token can read seeded plan", `len ${body?.length}`);
  }

  // 12) Query-token auth is intentionally refused on normal JSON API routes.
  {
    const { status, body } = await getJson(base, `/api/plan?token=${q}`);
    ok(status === 401, "auth: query token rejected for normal API route", `got ${status}`);
    ok(body && body.error === "unauthorized", "auth: rejected query-token API body is unauthorized", JSON.stringify(body));
  }

  // 13) Query-token auth is allowed for browser-only download surfaces.
  {
    const res = await fetch(`${base}/api/export?token=${q}`);
    ok(res.status === 200, "auth: query token GET /api/export → 200", `got ${res.status}`);
    ok((res.headers.get("content-disposition") || "").includes("attachment"), "auth: export remains an attachment");
    const data = await res.json();
    ok(data && typeof data === "object" && "exported_at" in data, "auth: query-token export returns JSON backup", JSON.stringify(Object.keys(data || {}).slice(0, 6)));
  }

  // 14) Query-token auth is allowed for EventSource-style stream surfaces. Use a
  //     non-existent id so the route authenticates, emits one error event, and ends.
  {
    const res = await fetch(`${base}/api/chat/turns/0/stream?token=${q}`);
    const text = await res.text();
    ok(res.status === 200, "auth: query token GET /api/chat/turns/0/stream → 200", `got ${res.status}`);
    ok((res.headers.get("content-type") || "").includes("text/event-stream"), "auth: stream uses text/event-stream");
    ok(/event: error/.test(text) && /no such turn/.test(text), "auth: stream route emitted the expected terminal error event", JSON.stringify(text));
  }

  // 15) The background-enrichment status streams authenticate the same way (the
  //     PWA reaches them via EventSource + ?token=). A non-existent id snapshots an
  //     error event and closes. Covers all three polled resources.
  for (const path of ["/api/activities/0/stream", "/api/food-notes/0/stream", "/api/health-docs/0/stream"]) {
    const res = await fetch(`${base}${path}?token=${q}`);
    const text = await res.text();
    ok(res.status === 200, `auth: query token GET ${path} → 200`, `got ${res.status}`);
    ok((res.headers.get("content-type") || "").includes("text/event-stream"), `auth: ${path} uses text/event-stream`);
    ok(/event: error/.test(text) && /not found/.test(text), `auth: ${path} emitted the terminal not-found event`, JSON.stringify(text));
    // And the same path without a token is refused (query-token allowlist is GET-scoped).
    const denied = await fetch(`${base}${path}`);
    ok(denied.status === 401, `auth: unauthenticated ${path} → 401`, `got ${denied.status}`);
  }

  // 16) Apple Health pairing is an owner-controlled REST flow. The exchange is
  //     public so a new Shortcut can claim its one-time code, while the issued
  //     credential can only ingest Apple Health rows and can be revoked alone.
  {
    const deniedMint = await getJson(base, "/api/apple-health/pairings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Smoke iPhone" }),
    });
    ok(deniedMint.status === 401, "auth: unauthenticated Apple Health pairing mint is rejected");

    const deniedList = await getJson(base, "/api/apple-health/connections");
    ok(deniedList.status === 401, "auth: unauthenticated Apple Health connection list is rejected");

    const minted = await getJson(base, "/api/apple-health/pairings", {
      method: "POST",
      headers: ownerJsonHeaders,
      body: JSON.stringify({ label: "Smoke iPhone", shortcut_version: "smoke-1" }),
    });
    ok(minted.status === 201 && /^cairn_pair_/.test(minted.body?.code), "auth: owner can mint a one-time pairing code");

    const exchanged = await getJson(base, "/api/apple-health/pairing/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairing_code: minted.body.code, label: "Smoke iPhone", shortcut_version: "smoke-1" }),
    });
    ok(
      exchanged.status === 200 && /^cairn_ah_/.test(exchanged.body?.ingest_token),
      "auth: public pairing exchange returns a scoped ingest credential"
    );
    const connectionId = exchanged.body?.connection?.id;

    const replay = await getJson(base, "/api/apple-health/pairing/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairing_code: minted.body.code }),
    });
    ok(replay.status === 400, "auth: Apple Health pairing code cannot be exchanged twice");

    const scopedHeaders = {
      authorization: `Bearer ${exchanged.body.ingest_token}`,
      "content-type": "application/json",
    };
    const date = new Date().toISOString().slice(0, 10);
    const ingested = await getJson(base, "/api/health-metrics", {
      method: "POST",
      headers: scopedHeaders,
      body: JSON.stringify({ source: "garmin", date, steps: 4321 }),
    });
    ok(ingested.status === 200 && ingested.body?.saved === 1, "auth: scoped credential can ingest one metrics row");
    ok(ingested.body?.rows?.[0]?.source === "apple_health", "auth: scoped ingest cannot spoof another source");

    const scopedRead = await getJson(base, "/api/health-metrics", {
      headers: { authorization: `Bearer ${exchanged.body.ingest_token}` },
    });
    ok(scopedRead.status === 401, "auth: scoped credential cannot read health metrics");

    const listed = await getJson(base, "/api/apple-health/connections", { headers: bearer });
    const connection = listed.body?.connections?.find((item) => item.id === connectionId);
    ok(listed.status === 200 && connection?.status === "connected", "auth: owner can list the active connection");
    ok(!!connection?.last_used_at, "auth: successful scoped ingest updates connection last-used time");

    const deniedRevoke = await getJson(base, `/api/apple-health/connections/${connectionId}`, { method: "DELETE" });
    ok(deniedRevoke.status === 401, "auth: unauthenticated Apple Health revocation is rejected");

    const revoked = await getJson(base, `/api/apple-health/connections/${connectionId}`, {
      method: "DELETE",
      headers: bearer,
    });
    ok(revoked.status === 200 && revoked.body?.ok === true, "auth: owner can revoke one Apple Health connection");

    const deniedAfterRevoke = await getJson(base, "/api/health-metrics", {
      method: "POST",
      headers: scopedHeaders,
      body: JSON.stringify({ date, steps: 5000 }),
    });
    ok(deniedAfterRevoke.status === 401, "auth: revoked scoped credential cannot ingest");
  }
}

if (!existsSync(serverEntry)) {
  console.error(`✗ ${serverEntry} is missing — run \`npm run build\` first (presmoke does this).`);
  process.exit(1);
}

let exitCode = 1;
try {
  await withServer({ label: "open", authToken: "", portOffset: 0 }, runOpenSmoke);
  await withServer({ label: "auth", authToken: AUTH_TOKEN, portOffset: 1 }, runAuthSmoke);
  console.log(`\nSmoke OK — ${passed} assertions passed.`);
  exitCode = 0;
} catch (e) {
  console.error(`\n✗ Smoke FAILED: ${e.message}`);
  const serverLog = e.serverLog || "";
  if (serverLog.trim()) {
    console.error("--- server output (tail) ---");
    console.error(serverLog.split("\n").slice(-20).join("\n"));
  }
  exitCode = 1;
}

process.exit(exitCode);
