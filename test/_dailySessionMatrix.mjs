// The daily-session OWNERSHIP MATRIX — shared by the dailySessionMatrix*.test.js files.
//
// "As a user I am literally stuck": a tap to start or open today's session answered with
// a conflict and nowhere to go. The contract this matrix holds `POST
// /api/daily-session/prepare` to, for EVERY cell, is exactly one of:
//
//   - 200 `ok:true` with the session to open (new, superseding, or `reused:true`) — and
//     never a second session row on a date that already had one;
//   - 409 with a conflict code whose body carries a COMPLETE `owner` that itself
//     resolves: `expected_active_id = owner.daily_session_id` opens that same session, or,
//     for an owner logged outside any composition (`daily_session_id: null`), the plain
//     open prepare (no replace, no fingerprint) adopts that same session row.
//     `daily_session_missing` without an owner means the date is free, and the plain
//     open prepare then starts a new one;
//   - 409 `daily_session_preview_stale` carrying a fresh preview;
//   - 400 for a malformed request (a fingerprint on a non-adaptive source).
//
// And an OPEN request (no replace, no fingerprint, no expected_active_id) over a date
// that has a session never conflicts: it answers with that session.
//
// And in every cell (2026-11-12 review):
//   - the owner's logged sets and notes survive, and its skips too unless a replace
//     started an UNSTARTED day over;
//   - a replace over a started owner never comes back as a new (non-reused) session;
//   - the athlete's unstarted chosen card that holds work (manual_plan, agent_suggest,
//     itemful athlete_override — open-session.ts unstartedChosenCard) is never taken by
//     an adaptive replace nor by an EMPTY override replace (the outbox retry): both answer
//     `daily_session_active_changed` with it as the owner. An ITEMFUL override replace —
//     the athlete writing a new session, chat's today_session included — replaces it.
//
// Axes (generated, not hand-listed):
//   owner state  — none · a legacy session row (no composition) unstarted / started /
//                  finished · a composition per source (adaptive_plan, adaptive
//                  train-by-choice, manual_plan, agent_suggest with items, athlete_override
//                  empty, athlete_override with items) × unstarted / started / finished /
//                  finished-empty (every lift skipped, then finished — no logged work).
//                  "Started" carries a logged set, notes and a skip of another lift.
//   request      — source (adaptive_plan / manual_plan / agent_suggest / athlete_override /
//                  an EMPTY athlete_override) × replace × fingerprint (none / matching /
//                  stale) × train_anyway × expected_active_id (absent / matching / stale)
//
// Pruned, and why:
//   - expected_active_id "matching" on a state with no active composition (none and the
//     three legacy states): there is no composition id to match.
//   - "started" by notes / feedback / pain answers / a linked watch activity alone rather
//     than with a logged set: session-started.ts is one test, so a logged set stands for
//     all of them (the chat Undo and discard edges test them one by one).
//   - duplicate session rows on one date: a legacy anomaly with its own test
//     (adaptiveDailySession.test.js "duplicate same-date sessions …").
// Everything else is generated, including the cells whose outcome is fixed by an earlier
// axis (an expected_active_id short-circuits every other field; a fingerprint on a
// non-adaptive source is malformed) — they are cheap, and they pin that precedence.
//
// Each cell runs inside a SAVEPOINT rolled back afterwards (through db.exec, so the
// request memo sees it), so one owner state is set up once per test and every cell
// starts from it.
import assert from "node:assert/strict";
import { dayCoachRouter } from "../dist/routes/day-coach.js";
import { previewAdaptiveDailySessionUseCase } from "../dist/domain/training/adaptive-session-use-case.js";
import { db, repo } from "./_seed.js";

export const DATE = "2032-06-08";
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow }));
const PROVENANCE = { entry: "matrix" };
export const OPEN_SESSION = {
  name: "Open session",
  focus: "Choose as you go",
  why: "A blank session for whatever feels useful today.",
  est_minutes: null,
  items: [],
};
const CONFLICT_CODES = new Set([
  "daily_session_preview_stale",
  "daily_session_active_changed",
  "daily_session_missing",
  "daily_session_changed",
  "daily_session_locked",
]);
const OWNER_CODES = new Set(["daily_session_active_changed", "daily_session_changed", "daily_session_locked"]);
const OWNER_KEYS = ["daily_session_id", "session_id", "source", "title", "set_count", "started"];
const SOURCES = ["adaptive_plan", "manual_plan", "agent_suggest", "athlete_override"];
// The request axis adds the EMPTY override — the "Open session" door, and the client's
// outbox retry that forces replace:true on it — beside the four stored sources.
const REQUEST_SOURCES = [...SOURCES, "athlete_override_empty"];
// The athlete's chosen card that holds work (open-session.ts compositionIsItemfulChoice).
const CHOSEN_ITEMFUL = new Set(["manual_plan", "agent_suggest", "override_items"]);

export function chosenCard(name) {
  return {
    name,
    why: "The athlete wrote this one.",
    items: [{ exercise: "Chest-Supported Row", sets: 3, rep_low: 8, rep_high: 12 }],
  };
}

export function seedPlan() {
  repo.savePlanDay(1, "Push", "Shoulders, chest & triceps", [
    { exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8, target_weight: 135 },
  ]);
  repo.savePlanDay(2, "Pull", "Back, biceps & rear delts", [
    { exercise: "Barbell Row", sets: 3, rep_low: 6, rep_high: 8, target_weight: 115 },
  ]);
  repo.setProfile({ strength_schedule: { days: EVERY_DAY, source: "athlete", updated_at: DATE } });
}

export function suggestionJob(name) {
  const job = repo.createAgentJob({ kind: "session_suggest", input: { date: DATE } });
  return repo.finishAgentJob(job.id, {
    chosen_agent: "codex",
    result: {
      ok: true,
      agent: "codex",
      tried: [{ agent: "codex" }],
      session: {
        name,
        focus: "Upper",
        why: "Fits the ask.",
        est_minutes: 30,
        items: [{ exercise: "Barbell Row", sets: 3, rep_low: 6, rep_high: 8, target_weight: 115 }],
      },
    },
  });
}

export function routerRequest(method, url, body) {
  return new Promise((resolve, reject) => {
    const request = { method, url, originalUrl: url, body, query: {}, headers: {} };
    const response = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(value) {
        resolve({ status: this.statusCode, body: value });
        return this;
      },
    };
    dayCoachRouter.handle(request, response, (error) => reject(error ?? new Error(`unhandled ${method} ${url}`)));
  });
}

export const prepareRoute = (body) => routerRequest("POST", "/daily-session/prepare", body);

// ---- owner states -------------------------------------------------------------------

const COMPOSITION_SOURCES = {
  adaptive_plan: () => ({ source: "adaptive_plan", provenance: PROVENANCE }),
  adaptive_choice: () => ({ source: "adaptive_plan", train_anyway: true, provenance: PROVENANCE }),
  manual_plan: () => ({ source: "manual_plan", day_number: 1, provenance: PROVENANCE }),
  agent_suggest: (jobs) => ({ source: "agent_suggest", agent_job_id: jobs.owner.id }),
  override_empty: () => ({ source: "athlete_override", session: OPEN_SESSION, provenance: PROVENANCE }),
  override_items: () => ({ source: "athlete_override", session: chosenCard("Owner card"), provenance: PROVENANCE }),
};
const LIVES = ["unstarted", "started", "finished", "finished_empty"];

const logOne = () => repo.logSetByName({ date: DATE, exercise: "Barbell Row", weight: 115, reps: 8 });
// A started owner carries everything a lived-on session holds: a logged set, notes, and a
// skip of another lift. Every cell must leave all three exactly as they were.
const liveOn = () => {
  const id = Number(logOne().session_id);
  repo.updateSessionNotes(id, "Owner notes.");
  repo.skipExercise("Bench Press", DATE);
  return id;
};

export const OWNER_STATES = [
  { name: "none", composition: false, setup: () => null },
  {
    name: "legacy_unstarted",
    composition: false,
    setup: () => Number(db.prepare(`INSERT INTO sessions (date) VALUES (?)`).run(DATE).lastInsertRowid),
  },
  { name: "legacy_started", composition: false, setup: () => liveOn() },
  {
    name: "legacy_finished",
    composition: false,
    setup: () => {
      const id = liveOn();
      repo.finishSession(id);
      return id;
    },
  },
  ...Object.entries(COMPOSITION_SOURCES).flatMap(([source, request]) =>
    LIVES.map((life) => ({
      name: `${source}:${life}`,
      composition: true,
      source,
      life,
      setup: (jobs) => {
        const prepared = repo.prepareDailySession({ date: DATE, ...request(jobs) });
        const id = Number(prepared.session_id);
        if (life === "started" || life === "finished") liveOn();
        if (life === "finished_empty") repo.skipExercise("Barbell Row", DATE);
        if (life === "finished" || life === "finished_empty") repo.finishSession(id);
        return id;
      },
    }))
  ),
];

// ---- requests -------------------------------------------------------------------------

function requestPayload(source, jobs) {
  if (source === "manual_plan") return { source, day_number: 2, provenance: PROVENANCE };
  if (source === "agent_suggest") return { source, agent_job_id: jobs.request.id };
  if (source === "athlete_override") return { source, session: chosenCard("Request card"), provenance: PROVENANCE };
  if (source === "athlete_override_empty") {
    return { source: "athlete_override", session: OPEN_SESSION, provenance: PROVENANCE };
  }
  return { source, provenance: PROVENANCE };
}

export function* requestCells(state) {
  for (const source of REQUEST_SOURCES) {
    for (const replace of [false, true]) {
      for (const fingerprint of ["none", "matching", "stale"]) {
        for (const trainAnyway of [false, true]) {
          for (const expected of ["absent", "matching", "stale"]) {
            if (expected === "matching" && !state.composition) continue; // pruned: nothing to match
            yield { source, replace, fingerprint, trainAnyway, expected };
          }
        }
      }
    }
  }
}

export function cellCount(states = OWNER_STATES) {
  return states.reduce((sum, state) => sum + [...requestCells(state)].length, 0);
}

function activeRow() {
  return db
    .prepare(`SELECT id, session_id FROM daily_session_compositions WHERE date = ? AND status = 'active'`)
    .get(DATE);
}

const sessionCount = () => Number(db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE date = ?`).get(DATE).n);

let savepoint = 0;
async function inSavepoint(run) {
  const name = `matrix_cell_${++savepoint}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    return await run();
  } finally {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
  }
}

export function assertReadable(error, label) {
  assert.equal(typeof error, "string", label);
  assert.ok(error.length > 0, label);
  assert.match(error, /^[A-Z]/, `${label}: a sentence — ${error}`);
  assert.match(error, /[.!]$/, `${label}: a sentence — ${error}`);
  assert.doesNotMatch(error, /\b(?:session|composition) \d+\b|_|\bid\b/i, `${label}: no ids or codes — ${error}`);
}

export function assertOwnerShape(owner, label) {
  assert.ok(owner && typeof owner === "object", `${label}: owner`);
  assert.deepEqual(Object.keys(owner).sort(), [...OWNER_KEYS].sort(), `${label}: owner keys`);
  assert.ok(owner.daily_session_id === null || Number.isInteger(owner.daily_session_id), `${label}: daily_session_id`);
  assert.ok(Number.isInteger(owner.session_id) && owner.session_id > 0, `${label}: session_id`);
  assert.ok(
    owner.daily_session_id === null ? owner.source === null : SOURCES.includes(owner.source),
    `${label}: source ${owner.source}`
  );
  assert.ok(typeof owner.title === "string" && owner.title.trim(), `${label}: title`);
  assert.ok(Number.isInteger(owner.set_count) && owner.set_count >= 0, `${label}: set_count`);
  assert.equal(typeof owner.started, "boolean", `${label}: started`);
}

export function assertOpened(res, label) {
  assert.equal(res.status, 200, `${label}: ${JSON.stringify(res.body)}`);
  const { body } = res;
  assert.equal(body.ok, true, label);
  assert.ok(body.daily_session && body.session, `${label}: daily_session + session`);
  assert.equal(Number(body.session.id), Number(body.daily_session.session_id), `${label}: one bound session`);
  assert.equal(body.daily_session.date, DATE, label);
  assert.equal(body.daily_session.status, "active", label);
  assert.equal(typeof body.reused, "boolean", label);
}

// The owner's follow-up: the documented way to open it, which must land on that session.
async function assertOwnerResolves(owner, cell, jobs, label) {
  const follow =
    owner.daily_session_id != null
      ? await prepareRoute({ date: DATE, expected_active_id: owner.daily_session_id })
      : await prepareRoute({ date: DATE, ...requestPayload(cell.source, jobs) });
  assertOpened(follow, `${label} → follow-up`);
  assert.equal(Number(follow.body.session.id), owner.session_id, `${label} → follow-up opens the owner's session`);
  if (owner.daily_session_id != null) {
    assert.equal(follow.body.daily_session.id, owner.daily_session_id, `${label} → the owner's composition`);
    assert.equal(follow.body.reused, true, `${label} → follow-up reuses`);
  }
}

/**
 * Run every request cell against ONE owner state. Returns the tally of outcomes, keyed
 * `ok` / `ok_reused` / `409:<code>` / `400:<code>`. With `violations` (an array), a
 * failing cell is recorded there instead of thrown — a diagnostic mode for listing every
 * violating cell at once.
 */
export async function runOwnerState(state, { onCell, violations } = {}) {
  const jobs = { owner: suggestionJob("Owner suggestion"), request: suggestionJob("Request suggestion") };
  state.setup(jobs);
  const before = activeRow() ?? null;
  const ownerSessionId =
    before != null
      ? Number(before.session_id)
      : Number(db.prepare(`SELECT MIN(id) AS id FROM sessions WHERE date = ?`).get(DATE).id) || null;
  const ownerSession = ownerSessionId
    ? db
        .prepare(
          `SELECT s.*, (SELECT COUNT(*) FROM logged_sets l WHERE l.session_id = s.id) AS set_count
             FROM sessions s WHERE s.id = ?`
        )
        .get(ownerSessionId)
    : null;
  const ownerStarted = Number(ownerSession?.set_count ?? 0) > 0;
  const ownerFinished = ownerSession?.finished_at != null;
  const countBefore = sessionCount();
  // The owner's own record — logged sets, notes, skips — as it stood before every cell.
  const ownerRecord = () =>
    ownerSessionId == null
      ? null
      : {
          sets: db
            .prepare(`SELECT id, exercise_id, weight, reps FROM logged_sets WHERE session_id = ? ORDER BY id`)
            .all(ownerSessionId)
            .map((row) => ({ ...row })),
          notes: db.prepare(`SELECT notes FROM sessions WHERE id = ?`).get(ownerSessionId)?.notes ?? null,
          skips: db
            .prepare(`SELECT exercise FROM session_skips WHERE session_id = ? ORDER BY exercise`)
            .all(ownerSessionId)
            .map((row) => row.exercise),
        };
  const recordBefore = ownerRecord();
  // The athlete's own chosen card holding work, nobody has lived on it (item 7 of the
  // 2026-11-12 review): a replace that authors nothing of theirs never takes it.
  const chosenUnstarted =
    state.composition &&
    CHOSEN_ITEMFUL.has(state.source) &&
    (state.life === "unstarted" || state.life === "finished_empty");
  const previews = new Map();
  const previewFor = (trainAnyway) => {
    if (!previews.has(trainAnyway)) {
      previews.set(trainAnyway, previewAdaptiveDailySessionUseCase({ date: DATE, train_anyway: trainAnyway }));
    }
    return previews.get(trainAnyway);
  };
  const tally = {};
  for (const cell of requestCells(state)) {
    const label = `${state.name} × ${JSON.stringify(cell)}`;
    const run = violations
      ? async (fn) => {
          try {
            await inSavepoint(fn);
          } catch (error) {
            violations.push({ state: state.name, cell, message: String(error?.message ?? error).split("\n")[0] });
          }
        }
      : inSavepoint;
    await run(async () => {
      const body = { date: DATE, ...requestPayload(cell.source, jobs) };
      if (cell.replace) body.replace = true;
      if (cell.trainAnyway) body.train_anyway = true;
      if (cell.fingerprint === "matching")
        body.expected_input_fingerprint = previewFor(cell.trainAnyway).input_fingerprint;
      if (cell.fingerprint === "stale") body.expected_input_fingerprint = "0".repeat(64);
      if (cell.expected === "matching") body.expected_active_id = Number(before.id);
      if (cell.expected === "stale") body.expected_active_id = before ? Number(before.id) + 1000 : 987654;
      const openIntent = cell.expected === "absent" && !cell.replace && cell.fingerprint === "none";
      const malformed = cell.expected === "absent" && cell.fingerprint !== "none" && cell.source !== "adaptive_plan";

      const res = await prepareRoute(body);
      const key =
        res.status === 200 ? (res.body.reused ? "ok_reused" : "ok") : `${res.status}:${res.body?.code ?? "?"}`;
      tally[key] = (tally[key] ?? 0) + 1;
      onCell?.(state, cell, res);

      // The owner's record survives every cell: its logged sets and notes always, its skips
      // unless a replace started an UNSTARTED day over (that clears a walked-away card's
      // bookkeeping by design — adaptive-session.ts).
      if (recordBefore) {
        const after = ownerRecord();
        assert.deepEqual(after.sets, recordBefore.sets, `${label}: the owner's logged sets survive`);
        assert.equal(after.notes, recordBefore.notes, `${label}: the owner's notes survive`);
        const startedOver = res.status === 200 && res.body.reused === false && !ownerStarted;
        if (!startedOver) assert.deepEqual(after.skips, recordBefore.skips, `${label}: the owner's skips survive`);
      }
      // A replace over a started owner never comes back as a NEW session.
      if (cell.replace && ownerStarted && res.status === 200) {
        assert.equal(res.body.reused, true, `${label}: a replace over logged work never writes a new card`);
        assert.equal(res.body.daily_session.id, before ? Number(before.id) : res.body.daily_session.id, label);
      }
      // One predicate for the athlete's unstarted chosen card: an adaptive replace and an
      // EMPTY override replace answer with it as the owner; an itemful override replaces it.
      if (chosenUnstarted && cell.replace && cell.expected === "absent" && !malformed && cell.fingerprint !== "stale") {
        if (cell.source === "adaptive_plan" || cell.source === "athlete_override_empty") {
          assert.equal(
            res.status,
            409,
            `${label}: never silently replaces the chosen card — ${JSON.stringify(res.body)}`
          );
          assert.equal(res.body.code, "daily_session_active_changed", label);
          assert.equal(res.body.owner?.daily_session_id, Number(before.id), label);
        } else if (cell.source === "athlete_override") {
          assert.equal(res.status, 200, `${label}: the athlete's new session replaces — ${JSON.stringify(res.body)}`);
          assert.equal(res.body.reused, false, label);
        }
      }

      if (res.status === 200) {
        assert.ok(!malformed, `${label}: a malformed request must not prepare`);
        assertOpened(res, label);
        if (ownerSessionId != null) {
          assert.equal(Number(res.body.session.id), ownerSessionId, `${label}: the date's own session row`);
          assert.equal(sessionCount(), countBefore, `${label}: never a second session for the date`);
        } else {
          assert.equal(sessionCount(), 1, `${label}: one session`);
        }
        if (cell.expected === "matching") {
          assert.equal(res.body.reused, true, label);
          assert.equal(res.body.daily_session.id, Number(before.id), label);
        }
        if (openIntent && before) {
          // An open request hands the owner back. The one documented exception: the same
          // adaptive request over a plain adaptive composition nobody has lived on (and
          // that is not finished) re-takes it from today's picture — a superseding
          // version bound to the same session row.
          const refreshable =
            state.source === "adaptive_plan" &&
            cell.source === "adaptive_plan" &&
            !cell.trainAnyway &&
            !ownerStarted &&
            !ownerFinished;
          if (!refreshable) {
            assert.equal(res.body.reused, true, `${label}: open reuses the owner`);
            assert.equal(res.body.daily_session.id, Number(before.id), `${label}: open returns the owner`);
          }
        }
        return;
      }

      if (res.status === 409) {
        assert.ok(!openIntent || ownerSessionId == null, `${label}: an open request never conflicts`);
        assert.ok(!malformed, `${label}: malformed is a 400`);
        assert.ok(CONFLICT_CODES.has(res.body.code), `${label}: conflict code ${res.body.code}`);
        assert.equal(res.body.ok, false, label);
        assertReadable(res.body.error, label);
        if (res.body.code === "daily_session_preview_stale") {
          assert.equal(cell.fingerprint, "stale", `${label}: only a stale token is stale`);
          assert.match(String(res.body.preview?.input_fingerprint), /^[a-f0-9]{64}$/, `${label}: a fresh preview`);
          assert.equal(res.body.preview.date, DATE, label);
          assert.equal(sessionCount(), countBefore, `${label}: a stale token writes nothing`);
          return;
        }
        if (res.body.code === "daily_session_missing") {
          assert.equal(before, null, `${label}: missing only when no composition holds the date`);
          if (ownerSessionId == null) {
            assert.equal(res.body.owner, undefined, `${label}: a free date carries no owner`);
            const fresh = await prepareRoute({ date: DATE, ...requestPayload(cell.source, jobs) });
            assertOpened(fresh, `${label} → the free date opens fresh`);
            return;
          }
        } else {
          assert.ok(OWNER_CODES.has(res.body.code), `${label}: ${res.body.code}`);
        }
        assertOwnerShape(res.body.owner, label);
        assert.equal(res.body.owner.session_id, ownerSessionId, `${label}: the owner is the date's session`);
        if (before) assert.equal(res.body.owner.daily_session_id, Number(before.id), `${label}: the owner composition`);
        await assertOwnerResolves(res.body.owner, cell, jobs, label);
        return;
      }

      assert.equal(res.status, 400, `${label}: unexpected status ${res.status} ${JSON.stringify(res.body)}`);
      assert.ok(
        malformed,
        `${label}: a well-formed request must not be refused as malformed — ${JSON.stringify(res.body)}`
      );
      assert.equal(res.body.ok, false, label);
      assert.equal(typeof res.body.code, "string", label);
      assert.ok(!CONFLICT_CODES.has(res.body.code), label);
      assert.equal(typeof res.body.error, "string", label);
    });
  }
  return tally;
}
