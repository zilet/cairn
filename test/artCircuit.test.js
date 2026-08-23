// The art circuit breaker (src/artCircuit.ts).
//
// The defect this guards is specifically a RESTART defect: the old per-process
// `failed` Set was wiped on boot, warmArt() fires 5s later, and the whole miss
// backlog went out again with no backoff — which is why the 500-650 fail/day
// bursts landed on deploy days. So the tests that matter most here are the ones
// that cross a simulated restart (forgetArtCircuitCache() drops the process
// cache and leaves the durable app_state row alone, exactly like a redeploy).
//
// The second class of defect is per-MODEL: the pipeline can send exercise art to
// GEMINI_EXERCISE_IMAGE_MODEL, and a single global counter both hid a model that
// failed every call (interleaved successes from the other model kept resetting
// it) and, when it finally opened, took the healthy model's backlog with it.
//
// Offline: app_state only, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  artCircuitOpen,
  artCircuitState,
  forgetArtCircuitCache,
  noteArtFailure,
  noteArtSuccess,
  onArtCircuitClose,
  resetArtCircuit,
  COOLDOWN_CEILING_MS,
  COOLDOWN_FLOOR_MS,
  OPEN_AFTER_CONSECUTIVE_FAILURES,
} from "../dist/artCircuit.js";

// Two distinct model ids, exactly the shape imageModelFor() produces.
const FLASH = "gemini-3.1-flash-image";
const PRO = "gemini-3-pro-image";

beforeEach(() => resetArtCircuit());

/** Drive one model to its open threshold at a fixed instant. */
function openAt(now, model = FLASH, code = "400:INVALID_ARGUMENT") {
  for (let i = 0; i < OPEN_AFTER_CONSECUTIVE_FAILURES; i++) noteArtFailure(model, code, now);
}

test("stays closed below the consecutive-failure threshold", () => {
  for (let i = 0; i < OPEN_AFTER_CONSECUTIVE_FAILURES - 1; i++) noteArtFailure(FLASH, "400:INVALID_ARGUMENT");
  assert.equal(artCircuitOpen(FLASH), false);
  assert.equal(artCircuitState(FLASH).consecutive_failures, OPEN_AFTER_CONSECUTIVE_FAILURES - 1);
});

test("opens exactly at the threshold and reports the last error code", () => {
  openAt(Date.now());
  const state = artCircuitState(FLASH);
  assert.equal(state.open, true);
  assert.equal(state.last_error_code, "400:INVALID_ARGUMENT");
  assert.ok(state.retry_at, "an open circuit names when it will retry");
  assert.ok(state.last_failure_at);
});

test("a success anywhere below the threshold resets the count", () => {
  noteArtFailure(FLASH, "400:X");
  noteArtFailure(FLASH, "400:X");
  noteArtSuccess(FLASH);
  for (let i = 0; i < OPEN_AFTER_CONSECUTIVE_FAILURES - 1; i++) noteArtFailure(FLASH, "400:X");
  assert.equal(artCircuitOpen(FLASH), false, "the counter restarted at the success");
});

test("the cooldown lapsing closes the circuit", () => {
  const t0 = 1_000_000;
  openAt(t0);
  assert.equal(artCircuitOpen(FLASH, t0 + COOLDOWN_FLOOR_MS - 1), true, "still open one ms early");
  assert.equal(artCircuitOpen(FLASH, t0 + COOLDOWN_FLOOR_MS), false, "closed once the cooldown lapsed");
});

// ---- the per-model cases: one bad model must not hide behind, or take down, a good one ----

test("interleaved fail(A)/success(B) still opens A at the threshold", () => {
  // The masking bug: with one global counter, B's successes reset A's count on
  // every other call, so a model failing 100% of the time never opened at all.
  let now = 20_000_000;
  for (let i = 0; i < OPEN_AFTER_CONSECUTIVE_FAILURES; i++) {
    noteArtFailure(PRO, "400:INVALID_ARGUMENT", now++);
    noteArtSuccess(FLASH);
  }
  assert.equal(artCircuitOpen(PRO, now), true, "every pro call failed — its circuit must be open");
  assert.equal(artCircuitState(PRO, now).consecutive_failures, OPEN_AFTER_CONSECUTIVE_FAILURES);
  assert.equal(artCircuitOpen(FLASH, now), false, "the model that kept working is untouched");
  assert.equal(artCircuitState(FLASH, now).consecutive_failures, 0);
});

test("an open circuit on one model does not gate the other", () => {
  const t0 = 21_000_000;
  openAt(t0, PRO);
  assert.equal(artCircuitOpen(PRO, t0), true);
  assert.equal(artCircuitOpen(FLASH, t0), false, "food and activity art keeps running through a pro outage");

  // And the failing model's escalated backoff is its own, not everyone's.
  assert.equal(artCircuitState(PRO, t0).next_cooldown_ms, COOLDOWN_FLOOR_MS * 2);
  assert.equal(artCircuitState(FLASH, t0).next_cooldown_ms, COOLDOWN_FLOOR_MS);
});

test("a success on one model does not clear the other's failure count", () => {
  const now = 22_000_000;
  for (let i = 0; i < 3; i++) noteArtFailure(PRO, "400:X", now);
  noteArtSuccess(FLASH);
  assert.equal(artCircuitState(PRO, now).consecutive_failures, 3, "the pro count survived a flash success");
});

test("the aggregate read reports the pipeline as paused while any model is", () => {
  const t0 = 23_000_000;
  openAt(t0, PRO, "429:RESOURCE_EXHAUSTED");
  noteArtSuccess(FLASH);
  const all = artCircuitState(undefined, t0);
  assert.equal(all.open, true, "one paused model pauses the pipeline for the health line");
  assert.equal(all.last_error_code, "429:RESOURCE_EXHAUSTED");
  assert.ok(all.retry_at);

  // Once it recovers, the aggregate reads closed again.
  noteArtSuccess(PRO);
  assert.equal(artCircuitState(undefined, t0).open, false);
});

test("the per-model state survives a restart independently", () => {
  const t0 = 24_000_000;
  openAt(t0, PRO);
  noteArtFailure(FLASH, "500:X", t0);
  forgetArtCircuitCache();
  assert.equal(artCircuitOpen(PRO, t0 + 60_000), true);
  assert.equal(artCircuitOpen(FLASH, t0 + 60_000), false);
  assert.equal(artCircuitState(FLASH, t0 + 60_000).consecutive_failures, 1, "flash's own count came back too");
});

// ---- the restart cases: the actual regression ----

test("a RESTART mid-cooldown does not re-open the floodgates", () => {
  const t0 = 2_000_000;
  openAt(t0);

  forgetArtCircuitCache(); // the process died and came back
  assert.equal(
    artCircuitOpen(FLASH, t0 + 60_000),
    true,
    "the breaker rehydrated from app_state and still refuses — this is the bug that burned 600 calls a day"
  );
  const state = artCircuitState(FLASH, t0 + 60_000);
  assert.equal(state.consecutive_failures, OPEN_AFTER_CONSECUTIVE_FAILURES, "the failure count survived too");
  assert.equal(state.last_error_code, "400:INVALID_ARGUMENT");
});

test("a RESTART after the cooldown lapsed recovers with no operator action", () => {
  const t0 = 3_000_000;
  openAt(t0);
  forgetArtCircuitCache();
  assert.equal(artCircuitOpen(FLASH, t0 + COOLDOWN_FLOOR_MS), false, "the cooldown lapsed on its own across the restart");
  assert.equal(artCircuitState(FLASH, t0 + COOLDOWN_FLOOR_MS).consecutive_failures, 0, "and the count cleared");
});

test("the escalated cooldown survives a restart, so a redeploy loop cannot reset the backoff", () => {
  let now = 4_000_000;
  openAt(now);
  const escalated = artCircuitState(FLASH, now).next_cooldown_ms;
  assert.equal(escalated, COOLDOWN_FLOOR_MS * 2);

  forgetArtCircuitCache();
  assert.equal(
    artCircuitState(FLASH, now).next_cooldown_ms,
    escalated,
    "restarting must not hand the caller a fresh 15-minute floor"
  );

  // Ride out this cooldown, fail again: the NEXT wait is longer still.
  now += COOLDOWN_FLOOR_MS;
  artCircuitOpen(FLASH, now);
  openAt(now);
  assert.equal(artCircuitState(FLASH, now).next_cooldown_ms, COOLDOWN_FLOOR_MS * 4);
});

test("a corrupt or missing durable row reads as closed rather than wedging the pipeline", async () => {
  const { setAppState } = await import("../dist/repo/app-state.js");
  const { ART_CIRCUIT_KEY } = await import("../dist/artCircuit.js");
  setAppState(ART_CIRCUIT_KEY, "{not json");
  forgetArtCircuitCache();
  assert.equal(artCircuitOpen(FLASH), false);
  assert.equal(artCircuitState(FLASH).consecutive_failures, 0);
});

test("a row written by an older single-circuit build reads as closed, not as wedged", async () => {
  const { setAppState } = await import("../dist/repo/app-state.js");
  const { ART_CIRCUIT_KEY } = await import("../dist/artCircuit.js");
  // The pre-per-model shape: a flat circuit with no `models` map, mid-cooldown.
  setAppState(
    ART_CIRCUIT_KEY,
    JSON.stringify({ consecutive_failures: 9, open_until_ms: Date.now() + 3_600_000, cooldown_ms: COOLDOWN_FLOOR_MS })
  );
  forgetArtCircuitCache();
  assert.equal(artCircuitOpen(FLASH), false, "an unreadable shape fails OPEN — art is optional, never wedged");
  assert.equal(artCircuitState(undefined).open, false);
});

// ---- recovery wiring ----

test("closing lets previously-failed items retry once — no restart needed, and names the model", () => {
  const closed = [];
  const off = onArtCircuitClose((model) => closed.push(model));
  try {
    const t0 = 5_000_000;
    openAt(t0, PRO);
    assert.equal(closed.length, 0, "opening is not a close");
    artCircuitOpen(PRO, t0 + COOLDOWN_FLOOR_MS);
    assert.deepEqual(closed, [PRO], "the cooldown lapsing fires the close listener exactly once, for that model");
    artCircuitOpen(PRO, t0 + COOLDOWN_FLOOR_MS + 1);
    assert.equal(closed.length, 1, "an already-closed circuit does not re-fire");
  } finally {
    off();
  }
});

test("a success while open closes it immediately and fires the listener", () => {
  const closed = [];
  const off = onArtCircuitClose((model) => closed.push(model));
  try {
    openAt(Date.now(), PRO);
    noteArtSuccess(PRO);
    assert.equal(artCircuitOpen(PRO), false);
    assert.deepEqual(closed, [PRO]);
  } finally {
    off();
  }
});

test("the cooldown doubles per re-open and is capped, and a success resets it", () => {
  let now = 10_000_000;
  const openOnce = () => {
    openAt(now);
    const cooldown = artCircuitState(FLASH, now).next_cooldown_ms; // already advanced for the NEXT open
    now += cooldown; // outlive this cooldown so the next failures can re-open
    artCircuitOpen(FLASH, now);
    return cooldown;
  };
  assert.equal(openOnce(), COOLDOWN_FLOOR_MS * 2, "the second open would wait twice as long");
  assert.equal(openOnce(), COOLDOWN_FLOOR_MS * 4);
  for (let i = 0; i < 20; i++) openOnce();
  assert.equal(artCircuitState(FLASH, now).next_cooldown_ms, COOLDOWN_CEILING_MS, "escalation is capped");
  noteArtSuccess(FLASH);
  assert.equal(artCircuitState(FLASH, now).next_cooldown_ms, COOLDOWN_FLOOR_MS, "recovery returns to the floor");
});
