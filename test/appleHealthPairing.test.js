import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { shouldMarkAppleHealthUsed } from "../dist/routes/health-metrics.js";
import {
  bundledShortcutInstallPath,
  resolveShortcutInstallUrl,
  validatedAppleHealthShortcutUrl,
} from "../dist/routes/apple-health.js";

test("Apple Health pairing stores hashes, expires, and exchanges exactly once", () => {
  const now = Date.parse("2026-07-14T12:00:00.000Z");
  const pairing = repo.createAppleHealthPairing({ label: "Primary iPhone", now_ms: now, ttl_ms: 60_000 });
  const stored = db.prepare("SELECT * FROM apple_health_pairings WHERE id = ?").get(pairing.id);
  assert.notEqual(stored.code_hash, pairing.code);
  assert.equal(stored.code_hash, repo.hashAppleHealthSecret(pairing.code));
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(pairing.code));

  const result = repo.exchangeAppleHealthPairing(pairing.code, { now_ms: now + 1_000, shortcut_version: "1" });
  assert.ok(result);
  assert.match(result.ingest_token, /^cairn_ah_/);
  assert.equal(result.connection.label, "Primary iPhone");
  assert.equal(repo.exchangeAppleHealthPairing(pairing.code, { now_ms: now + 2_000 }), null);

  const connectionRow = db.prepare("SELECT * FROM apple_health_connections WHERE id = ?").get(result.connection.id);
  assert.equal(connectionRow.token_hash, repo.hashAppleHealthSecret(result.ingest_token));
  assert.doesNotMatch(JSON.stringify(connectionRow), new RegExp(result.ingest_token));
  assert.equal(repo.verifyAppleHealthIngestToken(result.ingest_token, now + 3_000)?.id, result.connection.id);

  const expired = repo.createAppleHealthPairing({ now_ms: now, ttl_ms: 60_000 });
  assert.equal(repo.exchangeAppleHealthPairing(expired.code, { now_ms: now + 60_001 }), null);

  const shortConnectionPairing = repo.createAppleHealthPairing({ now_ms: now + 60_001 });
  assert.equal(
    db.prepare("SELECT 1 FROM apple_health_pairings WHERE id = ?").get(expired.id),
    undefined,
    "a later mint prunes expired pairing rows"
  );
  const shortConnection = repo.exchangeAppleHealthPairing(shortConnectionPairing.code, {
    now_ms: now + 61_001,
    connection_ttl_ms: 24 * 60 * 60 * 1000,
  });
  assert.ok(shortConnection);
  assert.equal(
    repo.verifyAppleHealthIngestToken(shortConnection.ingest_token, now + 24 * 60 * 60 * 1000 + 61_002),
    null
  );
});

test("Apple Health scoped credentials revoke independently and last-used updates explicitly", () => {
  const now = Date.parse("2026-07-14T12:00:00.000Z");
  const pairing = repo.createAppleHealthPairing({ now_ms: now });
  const result = repo.exchangeAppleHealthPairing(pairing.code, { now_ms: now + 1_000 });
  assert.ok(result);
  assert.equal(result.connection.last_used_at, null);
  assert.equal(shouldMarkAppleHealthUsed({ ok: false, saved: 0 }), false);
  assert.equal(shouldMarkAppleHealthUsed({ ok: false, saved: 1 }), true);
  assert.equal(shouldMarkAppleHealthUsed({ ok: true, saved: 1 }), true);

  assert.equal(repo.markAppleHealthConnectionUsed(result.connection.id, now + 2_000), true);
  assert.equal(repo.listAppleHealthConnections(now + 3_000)[0].last_used_at, "2026-07-14T12:00:02.000Z");
  assert.equal(repo.revokeAppleHealthConnection(result.connection.id, now + 4_000), true);
  assert.equal(repo.verifyAppleHealthIngestToken(result.ingest_token, now + 5_000), null);
  assert.equal(repo.markAppleHealthConnectionUsed(result.connection.id, now + 6_000), false);
  assert.equal(repo.listAppleHealthConnections(now + 7_000)[0].status, "revoked");
});

test("a successful pairing reaps superseded never-used connections under the same label", () => {
  const now = Date.parse("2026-07-14T12:00:00.000Z");
  const pair = (label, atMs) =>
    repo.exchangeAppleHealthPairing(repo.createAppleHealthPairing({ label, now_ms: atMs }).code, {
      label,
      now_ms: atMs + 1_000,
    });

  const abandoned = pair("iPhone Shortcut", now);
  const alsoAbandoned = pair("iPhone Shortcut", now + 10_000);
  const other = pair("iPad Shortcut", now + 20_000);
  const current = pair("iPhone Shortcut", now + 30_000);
  assert.ok(abandoned && alsoAbandoned && other && current);

  const ids = repo.listAppleHealthConnections(now + 40_000).map((connection) => connection.id);
  assert.deepEqual(
    ids.slice().sort((a, b) => a - b),
    [other.connection.id, current.connection.id].sort((a, b) => a - b),
    "18 identical never-used rows collapse to the newest one, per label"
  );
  assert.equal(repo.verifyAppleHealthIngestToken(abandoned.ingest_token, now + 40_000), null);
  assert.equal(repo.verifyAppleHealthIngestToken(current.ingest_token, now + 40_000)?.id, current.connection.id);
  assert.equal(repo.verifyAppleHealthIngestToken(other.ingest_token, now + 40_000)?.id, other.connection.id);

  // A connection that ever ingested is history, not noise: re-pairing keeps it.
  assert.equal(repo.markAppleHealthConnectionUsed(current.connection.id, now + 41_000), true);
  const replacement = pair("iPhone Shortcut", now + 50_000);
  assert.ok(replacement);
  const after = repo.listAppleHealthConnections(now + 60_000).map((connection) => connection.id);
  assert.equal(after.includes(current.connection.id), true, "a used credential is never reaped");
  assert.equal(after.includes(replacement.connection.id), true);
  assert.equal(after.length, 3);

  // A revoked-but-used row also survives; the direct helper is a no-op without a keeper.
  assert.equal(repo.reapSupersededAppleHealthConnections("iPhone Shortcut", 0), 0);
  assert.equal(repo.reapSupersededAppleHealthConnections("", replacement.connection.id), 0);
});

test("Apple Health install URL accepts only official iCloud or same-origin shortcut assets", () => {
  const origin = "https://cairn.test";
  assert.match(validatedAppleHealthShortcutUrl("https://www.icloud.com/shortcuts/abc-123", origin), /icloud\.com/);
  assert.equal(
    validatedAppleHealthShortcutUrl("/assets/cairn-health.shortcut", origin),
    "/assets/cairn-health.shortcut"
  );
  assert.match(
    validatedAppleHealthShortcutUrl("https://cairn.test/assets/cairn-health.shortcut", origin),
    /cairn-health\.shortcut/
  );
  assert.equal(validatedAppleHealthShortcutUrl("http://www.icloud.com/shortcuts/abc", origin), null);
  assert.equal(validatedAppleHealthShortcutUrl("https://evil.test/cairn.shortcut", origin), null);
  assert.equal(validatedAppleHealthShortcutUrl("shortcuts://create-shortcut", origin), null);
});

test("Apple Health install URL defaults to the bundled signed template only when unconfigured", () => {
  const origin = "https://cairn.test";
  // No configured URL → the repo-shipped artifact under public/shortcuts/.
  assert.equal(resolveShortcutInstallUrl(undefined, origin), "/shortcuts/Cairn%20Apple%20Health%20Sync.shortcut");
  assert.equal(resolveShortcutInstallUrl("  ", origin), "/shortcuts/Cairn%20Apple%20Health%20Sync.shortcut");
  assert.equal(bundledShortcutInstallPath(), "/shortcuts/Cairn%20Apple%20Health%20Sync.shortcut");
  // A configured value always wins; a configured-but-invalid value surfaces as
  // unavailable instead of being silently masked by the bundled fallback.
  assert.match(
    resolveShortcutInstallUrl("https://www.icloud.com/shortcuts/abc-123", origin),
    /icloud\.com/
  );
  assert.equal(resolveShortcutInstallUrl("https://evil.test/cairn.shortcut", origin), null);
});

test("Apple Health install URL tolerates HTTPS termination without trusting forwarded headers", () => {
  assert.equal(
    validatedAppleHealthShortcutUrl(
      "https://cairn.example/assets/cairn-health.shortcut",
      "http://cairn.example"
    ),
    "https://cairn.example/assets/cairn-health.shortcut"
  );
  assert.equal(
    validatedAppleHealthShortcutUrl(
      "https://cairn.example:8443/assets/cairn-health.shortcut",
      "http://cairn.example"
    ),
    null,
    "a different externally configured port is not the same instance authority"
  );
  assert.equal(
    validatedAppleHealthShortcutUrl(
      "https://other.example/assets/cairn-health.shortcut",
      "http://cairn.example"
    ),
    null
  );
});
