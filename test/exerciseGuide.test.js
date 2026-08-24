import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { db } from "../dist/db.js";
import {
  attachGuide,
  buildGuideIndex,
  detachGuide,
  EXERCISE_GUIDE_DATASET_PATH,
  EXERCISE_GUIDE_IMAGES_DIR,
  EXERCISE_GUIDES_DIR,
  exerciseGuideStatus,
  getExerciseGuide,
  isValidGuideId,
  linkGuidesToExercises,
  listGuideSuggestions,
  localGuideImagePath,
  matchGuide,
  upsertGuideRecords,
  usableGuideRecords,
} from "../dist/repo/exercise-guide.js";
import { findOrCreateExercise, mergeExercises } from "../dist/repo/exercises.js";
import { getExerciseDetail } from "../dist/repo/profile.js";
import {
  autoImportExerciseGuidesIfEmpty,
  ensureGuideImage,
  importExerciseGuides,
} from "../dist/domain/training/exercise-guide-use-case.js";
import { queryTokenAllowedPath } from "../dist/auth.js";
import { streamGuideImage } from "../dist/routes/plan-exercises.js";

// A miniature stand-in for free-exercise-db, built to exercise every matching tier
// and, more importantly, the cases that must NOT match.
const DATASET = [
  guide("Barbell_Curl", "Barbell Curl", { primaryMuscles: ["biceps"], equipment: "barbell" }),
  guide("Leg_Extensions", "Leg Extensions", { primaryMuscles: ["quadriceps"], equipment: "machine" }),
  guide("Incline_Dumbbell_Press", "Incline Dumbbell Press", { primaryMuscles: ["chest"], equipment: "dumbbell" }),
  // A GRIP qualifier is safe to strip: same movement, described more precisely.
  guide("Barbell_Bench_Press_-_Medium_Grip", "Barbell Bench Press - Medium Grip", { equipment: "barbell" }),
  // An EQUIPMENT qualifier is not: this must never stand in for a plain lateral raise.
  guide("Lateral_Raise_-_With_Bands", "Lateral Raise - With Bands", { equipment: "bands" }),
  // Implement-only sibling of a name the athlete writes without the implement.
  guide("Barbell_Hip_Thrust", "Barbell Hip Thrust", { primaryMuscles: ["glutes"], equipment: "barbell" }),
  // Two rows that collapse onto the same implement-stripped key → ambiguous.
  guide("Dumbbell_Bench_Press", "Dumbbell Bench Press", { equipment: "dumbbell" }),
  guide("Machine_Bench_Press", "Machine Bench Press", { equipment: "machine" }),
  // The only "crossover" in the library: an exact match for one exercise name and an
  // implement-stripped candidate for another. See the tier-order test below.
  guide("Cable_Crossover", "Cable Crossover", { primaryMuscles: ["chest"], equipment: "cable" }),
];

function guide(id, name, extra = {}) {
  return {
    id,
    name,
    level: "intermediate",
    mechanic: "compound",
    force: "push",
    category: "strength",
    primaryMuscles: [],
    secondaryMuscles: ["forearms"],
    instructions: ["Set up.", "Do the thing.", "Return under control."],
    images: [`${id}/0.jpg`, `${id}/1.jpg`],
    ...extra,
  };
}

function seedExercises(names) {
  for (const name of names) findOrCreateExercise(name);
}

function stubFetch(handlers) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const handler = handlers(url);
    if (!handler) return { ok: false, status: 404, headers: { get: () => null } };
    return handler;
  };
  impl.calls = calls;
  return impl;
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function jpegResponse(bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])) {
  return {
    ok: true,
    status: 200,
    headers: { get: (h) => (String(h).toLowerCase() === "content-type" ? "image/jpeg" : null) },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

// Enough of an express response to be piped into: a real Writable, plus the header
// and status surface streamGuideImage touches.
class FakeResponse extends Writable {
  constructor() {
    super();
    this.headers = new Map();
    this.statusCode = 200;
    this.headersSent = false;
    this.ended = false;
  }

  _write(_chunk, _encoding, done) {
    done();
  }

  setHeader(name, value) {
    this.headers.set(name, value);
  }

  removeHeader(name) {
    this.headers.delete(name);
  }

  getHeader(name) {
    return this.headers.get(name);
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  end(...args) {
    this.ended = true;
    return super.end(...args);
  }
}

function clearGuideFiles() {
  fs.rmSync(EXERCISE_GUIDES_DIR, { recursive: true, force: true });
}

// ---- matching ---------------------------------------------------------------

test("a confident name match links; an ambiguous one stays silent", () => {
  const index = buildGuideIndex(usableGuideRecords(DATASET));

  // Tier 1: the same name, spelled the same way.
  assert.equal(matchGuide(index, "Barbell Curl").confidence, "exact");
  assert.equal(matchGuide(index, "Barbell Curl").record.id, "Barbell_Curl");

  // Tier 2: the canon merge key — a plural and an abbreviation are the same movement.
  assert.equal(matchGuide(index, "Leg Extension").record.id, "Leg_Extensions");
  assert.equal(matchGuide(index, "Leg Extension").confidence, "key");
  assert.equal(matchGuide(index, "Incline DB Press").record.id, "Incline_Dumbbell_Press");
  assert.equal(matchGuide(index, "Incline DB Press").confidence, "key");

  // Tier 3: a trailing GRIP qualifier is the same lift described more precisely.
  assert.equal(matchGuide(index, "Barbell Bench Press").record.id, "Barbell_Bench_Press_-_Medium_Grip");
  assert.equal(matchGuide(index, "Barbell Bench Press").confidence, "qualified");

  // An EQUIPMENT qualifier is NOT strippable — a banded raise is not a plain one,
  // and its photos would show bands.
  assert.equal(matchGuide(index, "Lateral Raise"), null);

  // Two dataset rows share the implement-stripped key, so neither may claim it.
  assert.equal(matchGuide(index, "Bench Press"), null);
});

test("an implement-only match is a suggestion, never an auto-link", () => {
  const index = buildGuideIndex(usableGuideRecords(DATASET));
  const match = matchGuide(index, "Hip Thrust");
  assert.equal(match.record.id, "Barbell_Hip_Thrust");
  // Barbell vs bodyweight vs machine hip thrusts are different setups; this tier is
  // reported, not applied.
  assert.equal(match.confidence, "movement");
});

test("a learned alias can reach a guide the canonical name misses", () => {
  const index = buildGuideIndex(usableGuideRecords(DATASET));
  assert.equal(matchGuide(index, "Bicep Curl (BB)"), null);
  assert.equal(matchGuide(index, "Bicep Curl (BB)", ["Barbell Curl"]).record.id, "Barbell_Curl");
});

test("linking attaches confident matches and parks the rest", () => {
  seedExercises(["Barbell Curl", "Leg Extension", "Hip Thrust", "Lateral Raise", "Front Squat"]);
  upsertGuideRecords(usableGuideRecords(DATASET));
  const result = linkGuidesToExercises(usableGuideRecords(DATASET));

  assert.equal(result.linked, 2, "Barbell Curl + Leg Extension are the confident pair");
  assert.deepEqual(
    result.suggested.map((s) => s.exercise),
    ["Hip Thrust"]
  );
  assert.equal(result.suggested[0].confidence, "movement");
  // Never guessed at, so never shown.
  assert.ok(result.unmatched.includes("Lateral Raise"));
  assert.ok(result.unmatched.includes("Front Squat"));

  assert.equal(getExerciseGuide("Barbell Curl").guide_id, "Barbell_Curl");
  assert.equal(getExerciseGuide("Hip Thrust"), null, "a suggestion is not a guide");
  assert.equal(getExerciseGuide("Lateral Raise"), null);

  // The suggestion is retrievable for a human yes/no.
  const suggestions = listGuideSuggestions();
  assert.deepEqual(suggestions.map((s) => s.guide_id), ["Barbell_Hip_Thrust"]);
});

test("one dataset row can only stand for one movement", () => {
  // Both names resolve to Barbell_Curl; the guide is not shown twice.
  seedExercises(["Barbell Curl", "Barbell Curls"]);
  upsertGuideRecords(usableGuideRecords(DATASET));
  const result = linkGuidesToExercises(usableGuideRecords(DATASET));
  assert.equal(result.linked, 1);
  const rows = db.prepare(`SELECT COUNT(*) AS n FROM exercise_guides WHERE exercise_id IS NOT NULL`).get();
  assert.equal(rows.n, 1);
});

test("relinking is idempotent and drops links to exercises that are gone", () => {
  seedExercises(["Barbell Curl", "Leg Extension"]);
  upsertGuideRecords(usableGuideRecords(DATASET));
  const first = linkGuidesToExercises(usableGuideRecords(DATASET));
  const second = linkGuidesToExercises(usableGuideRecords(DATASET));
  assert.deepEqual({ ...second, suggested: [] }, { ...first, suggested: [] });

  db.prepare(`DELETE FROM exercises WHERE name = 'Leg Extension'`).run();
  const third = linkGuidesToExercises(usableGuideRecords(DATASET));
  assert.equal(third.linked, 1);
  assert.equal(getExerciseGuide("Leg Extension"), null);
});

test("a hand-confirmed guide replaces whatever the exercise had", () => {
  seedExercises(["Hip Thrust"]);
  upsertGuideRecords(usableGuideRecords(DATASET));
  linkGuidesToExercises(usableGuideRecords(DATASET));
  assert.equal(getExerciseGuide("Hip Thrust"), null);

  assert.deepEqual(attachGuide("Hip Thrust", "Barbell_Hip_Thrust"), { ok: true });
  assert.equal(getExerciseGuide("Hip Thrust").guide_id, "Barbell_Hip_Thrust");
  assert.equal(getExerciseGuide("Hip Thrust").match_confidence, "manual");

  // ok:false at the call level, never a throw — the designed failure signal.
  assert.equal(attachGuide("Nothing Here", "Barbell_Curl").ok, false);
  assert.equal(attachGuide("Hip Thrust", "No_Such_Guide").ok, false);
});

test("a re-import never revokes a hand-confirmed link", () => {
  seedExercises(["Hip Thrust", "Barbell Curl"]);
  upsertGuideRecords(usableGuideRecords(DATASET));
  linkGuidesToExercises(usableGuideRecords(DATASET));
  attachGuide("Hip Thrust", "Barbell_Hip_Thrust");

  // The athlete answered a question the matcher could not; relinking leaves it be
  // and still does its own work alongside.
  const result = linkGuidesToExercises(usableGuideRecords(DATASET));
  assert.equal(getExerciseGuide("Hip Thrust").guide_id, "Barbell_Hip_Thrust");
  assert.equal(getExerciseGuide("Hip Thrust").match_confidence, "manual");
  assert.equal(getExerciseGuide("Barbell Curl").guide_id, "Barbell_Curl");
  assert.equal(result.linked, 2, "the manual link counts toward what is linked");
  // Hip Thrust is answered, so it is no longer offered as a suggestion.
  assert.deepEqual(result.suggested, []);
  assert.deepEqual(listGuideSuggestions(), []);
});

test("an exact match outranks a suggestion, whatever the alphabet says", () => {
  // "Band Crossover" sorts first and reaches "Cable Crossover" on the weakest tier
  // (implements stripped). Resolving exercise-by-exercise would hand it the row, and
  // the exercise that matches that row BY NAME would be left with nothing.
  seedExercises(["Band Crossover", "Cable Crossover"]);
  upsertGuideRecords(usableGuideRecords(DATASET));
  const result = linkGuidesToExercises(usableGuideRecords(DATASET));

  assert.equal(getExerciseGuide("Cable Crossover").guide_id, "Cable_Crossover");
  assert.equal(getExerciseGuide("Cable Crossover").match_confidence, "exact");
  // And the loser gets no suggestion for a row that is already spoken for.
  assert.equal(getExerciseGuide("Band Crossover"), null);
  assert.deepEqual(result.suggested, []);
  assert.deepEqual(listGuideSuggestions(), []);
  assert.ok(result.unmatched.includes("Band Crossover"));
});

test("a manual link to a deleted exercise is stale, not sacred", () => {
  seedExercises(["Hip Thrust"]);
  upsertGuideRecords(usableGuideRecords(DATASET));
  linkGuidesToExercises(usableGuideRecords(DATASET));
  attachGuide("Hip Thrust", "Barbell_Hip_Thrust");

  db.prepare(`DELETE FROM exercises WHERE name = 'Hip Thrust'`).run();
  const result = linkGuidesToExercises(usableGuideRecords(DATASET));
  assert.equal(result.linked, 0);
  const row = db.prepare(`SELECT exercise_id, match_confidence FROM exercise_guides WHERE guide_id = 'Barbell_Hip_Thrust'`).get();
  assert.equal(row.exercise_id, null);
  assert.equal(row.match_confidence, null);
});

test("a refused guide stays refused across a re-import", () => {
  seedExercises(["Barbell Curl", "Leg Extension"]);
  upsertGuideRecords(usableGuideRecords(DATASET));
  linkGuidesToExercises(usableGuideRecords(DATASET));
  assert.equal(getExerciseGuide("Barbell Curl").guide_id, "Barbell_Curl");

  // "That is not the movement I do."
  assert.deepEqual(detachGuide("Barbell_Curl"), { ok: true });
  assert.equal(getExerciseGuide("Barbell Curl"), null);

  // The matcher would happily re-attach it; the remembered no is what stops it.
  const result = linkGuidesToExercises(usableGuideRecords(DATASET));
  assert.equal(getExerciseGuide("Barbell Curl"), null, "a re-import must not undo the refusal");
  assert.equal(result.linked, 1, "only Leg Extension is left linked");
  assert.ok(result.unmatched.includes("Barbell Curl"));
  // Nor is the refused row quietly re-offered as a suggestion.
  assert.deepEqual(listGuideSuggestions(), []);
});

test("a dismissed suggestion is not asked again, and an attach lifts the refusal", () => {
  seedExercises(["Hip Thrust"]);
  upsertGuideRecords(usableGuideRecords(DATASET));
  linkGuidesToExercises(usableGuideRecords(DATASET));
  assert.equal(listGuideSuggestions().length, 1);

  // Dismissing the ask is the same "no" as unlinking a guide.
  detachGuide("Barbell_Hip_Thrust");
  assert.deepEqual(listGuideSuggestions(), []);
  assert.deepEqual(linkGuidesToExercises(usableGuideRecords(DATASET)).suggested, []);
  assert.deepEqual(listGuideSuggestions(), [], "the question is answered, not re-asked");

  // Naming the guide by hand is the door back in.
  assert.deepEqual(attachGuide("Hip Thrust", "Barbell_Hip_Thrust"), { ok: true });
  assert.equal(getExerciseGuide("Hip Thrust").guide_id, "Barbell_Hip_Thrust");
  linkGuidesToExercises(usableGuideRecords(DATASET));
  assert.equal(getExerciseGuide("Hip Thrust").match_confidence, "manual", "and it survives the next import");
});

test("the detail sheet carries the one candidate waiting on this exercise", () => {
  seedExercises(["Hip Thrust", "Barbell Curl"]);
  upsertGuideRecords(usableGuideRecords(DATASET));
  linkGuidesToExercises(usableGuideRecords(DATASET));

  const asked = getExerciseDetail("Hip Thrust");
  assert.equal(asked.guide, null);
  assert.equal(asked.guide_suggestion.guide_id, "Barbell_Hip_Thrust");
  assert.equal(asked.guide_suggestion.guide_name, "Barbell Hip Thrust");
  assert.equal(asked.guide_suggestion.exercise, "Hip Thrust");

  // A linked guide leaves nothing to ask.
  const answered = getExerciseDetail("Barbell Curl");
  assert.equal(answered.guide.guide_id, "Barbell_Curl");
  assert.equal(answered.guide_suggestion, null);

  // And a dismissal clears the question from the sheet too.
  detachGuide("Barbell_Hip_Thrust");
  assert.equal(getExerciseDetail("Hip Thrust").guide_suggestion, null);
});

// ---- absence ----------------------------------------------------------------

test("absence is the ordinary state: lookups answer null, never throw", () => {
  seedExercises(["Barbell Curl"]);
  // Nothing imported at all.
  assert.equal(getExerciseGuide("Barbell Curl"), null);
  assert.equal(getExerciseGuide("Never Heard Of It"), null);
  assert.equal(getExerciseGuide(""), null);
  assert.equal(getExerciseGuide(null), null);

  const status = exerciseGuideStatus();
  assert.equal(status.imported, false);
  assert.equal(status.guides, 0);

  // And the exercise detail the PWA fetches simply carries guide: null.
  assert.equal(getExerciseDetail("Barbell Curl").guide, null);
});

test("the exercise detail carries the guide once one is linked", () => {
  seedExercises(["Barbell Curl"]);
  upsertGuideRecords(usableGuideRecords(DATASET));
  linkGuidesToExercises(usableGuideRecords(DATASET));
  const detail = getExerciseDetail("Barbell Curl");
  assert.equal(detail.guide.guide_id, "Barbell_Curl");
  assert.deepEqual(detail.guide.instructions, ["Set up.", "Do the thing.", "Return under control."]);
  assert.deepEqual(
    detail.guide.images.map((i) => i.url),
    ["/api/exercise-guides/image/Barbell_Curl/0", "/api/exercise-guides/image/Barbell_Curl/1"]
  );
});

// ---- import -----------------------------------------------------------------

test("import is idempotent and reuses the cached metadata on a second run", async () => {
  clearGuideFiles();
  seedExercises(["Barbell Curl", "Leg Extension"]);
  const fetchImpl = stubFetch((url) => (url.endsWith("exercises.json") ? jsonResponse(DATASET) : null));

  const first = await importExerciseGuides({ fetchImpl });
  assert.equal(first.ok, true);
  assert.equal(first.cached, false);
  assert.equal(first.records, DATASET.length);
  assert.equal(first.linked, 2);
  assert.equal(first.images_fetched, 0, "photos are lazy by default");
  assert.equal(fetchImpl.calls.length, 1);
  assert.ok(fs.existsSync(EXERCISE_GUIDE_DATASET_PATH));

  const second = await importExerciseGuides({ fetchImpl });
  assert.equal(second.ok, true);
  assert.equal(second.cached, true, "the second run reads the local copy");
  assert.equal(fetchImpl.calls.length, 1, "and makes no new request");
  assert.equal(second.linked, first.linked);
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM exercise_guides`).get().n,
    DATASET.length,
    "re-importing rewrites rows rather than duplicating them"
  );

  // refresh:true goes back to the network.
  const third = await importExerciseGuides({ fetchImpl, refresh: true });
  assert.equal(third.cached, false);
  assert.equal(fetchImpl.calls.length, 2);
  clearGuideFiles();
});

// ---- Round W2.2: the scheduler runs the import itself once, quietly, instead of
// waiting on the athlete's tap — but ONLY while the library is genuinely empty. ----
test("auto-import runs once when the library is empty, then leaves it alone", async () => {
  clearGuideFiles();
  seedExercises(["Barbell Curl", "Leg Extension"]);
  assert.equal(exerciseGuideStatus().imported, false, "starts empty");
  const fetchImpl = stubFetch((url) => (url.endsWith("exercises.json") ? jsonResponse(DATASET) : null));

  const first = await autoImportExerciseGuidesIfEmpty({ fetchImpl });
  assert.ok(first?.ok, "runs the import when empty");
  assert.equal(first.records, DATASET.length);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(exerciseGuideStatus().imported, true);

  // Once populated, a second boot pass is a quiet no-op — never re-fetches.
  const second = await autoImportExerciseGuidesIfEmpty({ fetchImpl });
  assert.equal(second, null, "a populated library is left alone");
  assert.equal(fetchImpl.calls.length, 1, "no second network call");
  clearGuideFiles();
});

test("auto-import never runs once the athlete has already imported (idempotent, not repeated on every boot)", async () => {
  clearGuideFiles();
  seedExercises(["Barbell Curl"]);
  const fetchImpl = stubFetch((url) => (url.endsWith("exercises.json") ? jsonResponse(DATASET) : null));
  await importExerciseGuides({ fetchImpl }); // the athlete's own manual import
  assert.equal(fetchImpl.calls.length, 1);

  const result = await autoImportExerciseGuidesIfEmpty({ fetchImpl });
  assert.equal(result, null);
  assert.equal(fetchImpl.calls.length, 1, "the boot pass never re-fetches a populated library");
  clearGuideFiles();
});

test("auto-import degrades to absence on a fetch failure, never throws, and stays retryable next boot", async () => {
  clearGuideFiles();
  seedExercises(["Barbell Curl"]);
  const offline = stubFetch(() => {
    throw new Error("getaddrinfo ENOTFOUND");
  });
  const result = await autoImportExerciseGuidesIfEmpty({ fetchImpl: offline });
  assert.equal(result.ok, false);
  assert.equal(exerciseGuideStatus().imported, false, "still empty — eligible for another boot attempt");
});

test("auto-import never disturbs a hand-confirmed link or refusal that already exists", async () => {
  clearGuideFiles();
  seedExercises(["Barbell Curl", "Leg Extension"]);
  const fetchImpl = stubFetch((url) => (url.endsWith("exercises.json") ? jsonResponse(DATASET) : null));
  await importExerciseGuides({ fetchImpl }); // seed the library so it's no longer empty
  assert.equal(getExerciseGuide("Leg Extension")?.guide_id, "Leg_Extensions", "linked by the import");
  detachGuide("Leg_Extensions"); // athlete explicitly refused this one

  // A later boot pass must be a no-op (library is non-empty) — the refusal survives.
  const result = await autoImportExerciseGuidesIfEmpty({ fetchImpl });
  assert.equal(result, null);
  assert.equal(getExerciseGuide("Leg Extension"), null, "the hand-refusal still holds");
  clearGuideFiles();
});

test("an import failure degrades to absence, never to an error", async () => {
  clearGuideFiles();
  seedExercises(["Barbell Curl"]);
  const offline = stubFetch(() => {
    throw new Error("getaddrinfo ENOTFOUND");
  });
  const result = await importExerciseGuides({ fetchImpl: offline });
  assert.equal(result.ok, false);
  assert.match(result.error, /ENOTFOUND/);
  assert.equal(exerciseGuideStatus().imported, false);
  assert.equal(getExerciseGuide("Barbell Curl"), null);

  const notFound = stubFetch(() => ({ ok: false, status: 503, headers: { get: () => null } }));
  const httpFail = await importExerciseGuides({ fetchImpl: notFound });
  assert.equal(httpFail.ok, false);
  assert.match(httpFail.error, /503/);
  clearGuideFiles();
});

test("rows the filter discards are counted, so upstream drift is visible", async () => {
  clearGuideFiles();
  seedExercises(["Barbell Curl"]);
  const drifted = [...DATASET, { id: "No_Steps", name: "No Steps", instructions: [] }, { name: "No Id" }];
  const fetchImpl = stubFetch((url) => (url.endsWith("exercises.json") ? jsonResponse(drifted) : null));
  const result = await importExerciseGuides({ fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.records, DATASET.length);
  assert.equal(result.dropped, 2, "the two unreadable rows are reported, not silently absorbed");
  clearGuideFiles();

  // The ordinary case says zero rather than nothing.
  const clean = stubFetch((url) => (url.endsWith("exercises.json") ? jsonResponse(DATASET) : null));
  assert.equal((await importExerciseGuides({ fetchImpl: clean })).dropped, 0);
  clearGuideFiles();
});

test("a malformed dataset is rejected rather than half-stored", () => {
  assert.deepEqual(usableGuideRecords(null), []);
  assert.deepEqual(usableGuideRecords("nope"), []);
  // No id, a traversal id, no steps — each row is dropped on its own.
  const kept = usableGuideRecords([
    { name: "No Id", instructions: ["a"] },
    { id: "../../etc/passwd", name: "Traversal", instructions: ["a"] },
    { id: "No_Steps", name: "No Steps", instructions: [] },
    { id: "Fine", name: "Fine", instructions: ["a"], images: ["Fine/0.jpg", "Elsewhere/0.jpg"] },
  ]);
  assert.deepEqual(kept.map((r) => r.id), ["Fine"]);
  // An image path outside the row's own folder is not addressable and is dropped.
  assert.deepEqual(kept[0].images, ["Fine/0.jpg"]);
});

// ---- images -----------------------------------------------------------------

test("a demonstration photo is fetched once, then served from disk", async () => {
  clearGuideFiles();
  seedExercises(["Barbell Curl"]);
  const fetchImpl = stubFetch((url) => (url.endsWith("exercises.json") ? jsonResponse(DATASET) : jpegResponse()));
  await importExerciseGuides({ fetchImpl });

  const file = await ensureGuideImage("Barbell_Curl", 0, { fetchImpl });
  assert.ok(file && fs.existsSync(file));
  const afterFirst = fetchImpl.calls.length;

  const again = await ensureGuideImage("Barbell_Curl", 0, { fetchImpl });
  assert.equal(again, file);
  assert.equal(fetchImpl.calls.length, afterFirst, "the cached photo costs no request");
  assert.equal(exerciseGuideStatus().images_cached, 1);
  clearGuideFiles();
});

test("a photo that is not a photo never reaches disk", async () => {
  clearGuideFiles();
  seedExercises(["Barbell Curl"]);
  const html = {
    ok: true,
    status: 200,
    headers: { get: () => "text/html" },
    async arrayBuffer() {
      return new TextEncoder().encode("<html>rate limited</html>").buffer;
    },
  };
  const fetchImpl = stubFetch((url) => (url.endsWith("exercises.json") ? jsonResponse(DATASET) : html));
  await importExerciseGuides({ fetchImpl });
  assert.equal(await ensureGuideImage("Barbell_Curl", 0, { fetchImpl }), null);
  assert.equal(exerciseGuideStatus().images_cached, 0);
  clearGuideFiles();
});

test("a photo that fails to open answers 204 with nothing cacheable attached", async () => {
  clearGuideFiles();
  // A directory where a JPEG should be: createReadStream fails on open, which is the
  // shape of every mid-flight read failure the route has to survive.
  const unreadable = path.join(EXERCISE_GUIDE_IMAGES_DIR, "Barbell_Curl", "0.jpg");
  fs.mkdirSync(unreadable, { recursive: true });

  const res = new FakeResponse();
  streamGuideImage(res, unreadable);
  // Wait for the response to actually end — a fixed sleep races the stream's
  // error event on a loaded runner.
  await new Promise((resolve) => res.on("finish", resolve));

  assert.equal(res.statusCode, 204);
  assert.equal(res.ended, true);
  // A year-long immutable cache on an empty body would hide the photo forever.
  assert.equal(res.getHeader("Cache-Control"), undefined);
  assert.equal(res.getHeader("Content-Type"), undefined);
  clearGuideFiles();
});

test("guide ids cannot escape the image cache directory", () => {
  for (const bad of ["../../etc/passwd", "a/b", "", "with space", "..", "a".repeat(200)]) {
    assert.equal(isValidGuideId(bad), false, `${bad} must be rejected`);
    assert.equal(localGuideImagePath(bad, 0), null);
  }
  assert.equal(isValidGuideId("Barbell_Bench_Press_-_Medium_Grip"), true);
  const good = localGuideImagePath("Barbell_Curl", 0);
  assert.ok(good.startsWith(path.resolve(EXERCISE_GUIDE_IMAGES_DIR)));
  // Out-of-range frame indexes are not addressable either.
  assert.equal(localGuideImagePath("Barbell_Curl", -1), null);
  assert.equal(localGuideImagePath("Barbell_Curl", 1.5), null);
  assert.equal(localGuideImagePath("Barbell_Curl", 99), null);
});

test("only the exact image path is query-token authed", () => {
  assert.equal(queryTokenAllowedPath("/api/exercise-guides/image/Barbell_Curl/0"), true);
  assert.equal(queryTokenAllowedPath("/api/exercise-guides/image/Barbell_Curl/0", "POST"), false);
  // Every other guide surface stays header-only.
  assert.equal(queryTokenAllowedPath("/api/exercise-guides/import"), false);
  assert.equal(queryTokenAllowedPath("/api/exercise-guides/status"), false);
  assert.equal(queryTokenAllowedPath("/api/exercise-guides/Barbell%20Curl"), false);
  assert.equal(queryTokenAllowedPath("/api/exercise-guides/image/Barbell_Curl/0/extra"), false);
  assert.equal(queryTokenAllowedPath("/api/exercise-guides/image/../../secret/0"), false);
});

// ---- merge ------------------------------------------------------------------

test("a merged-away exercise hands its guide to the survivor", () => {
  seedExercises(["Barbell Curl", "Bicep Curl"]);
  upsertGuideRecords(usableGuideRecords(DATASET));
  linkGuidesToExercises(usableGuideRecords(DATASET));
  assert.equal(getExerciseGuide("Barbell Curl").guide_id, "Barbell_Curl");

  const merged = mergeExercises("Barbell Curl", "Bicep Curl");
  assert.equal(merged.ok, true);
  // The survivor had no guide, so the matched one follows the history across.
  assert.equal(getExerciseGuide("Bicep Curl").guide_id, "Barbell_Curl");
  // And the vanished name reads as absent rather than crashing the lookup.
  assert.equal(getExerciseGuide("Barbell Curl"), null);
  assert.equal(getExerciseDetail("Barbell Curl").found, false);
  assert.equal(getExerciseDetail("Bicep Curl").guide.guide_id, "Barbell_Curl");
});

test("a merge never overwrites the survivor's own guide", () => {
  seedExercises(["Barbell Curl", "Leg Extension"]);
  upsertGuideRecords(usableGuideRecords(DATASET));
  linkGuidesToExercises(usableGuideRecords(DATASET));

  // Nonsense as a movement merge, but it is exactly the collision to defend:
  // both sides carry a guide.
  const merged = mergeExercises("Barbell Curl", "Leg Extension");
  assert.equal(merged.ok, true);
  assert.equal(getExerciseGuide("Leg Extension").guide_id, "Leg_Extensions", "survivor keeps its own");
  // The loser's guide is unlinked, not left pointing at a deleted row.
  const orphan = db.prepare(`SELECT exercise_id FROM exercise_guides WHERE guide_id = 'Barbell_Curl'`).get();
  assert.equal(orphan.exercise_id, null);
  assert.equal(exerciseGuideStatus().linked, 1);
});

test("deleting an exercise leaves the guide row intact and unlinked", () => {
  seedExercises(["Barbell Curl"]);
  upsertGuideRecords(usableGuideRecords(DATASET));
  linkGuidesToExercises(usableGuideRecords(DATASET));
  db.prepare(`DELETE FROM exercises WHERE name = 'Barbell Curl'`).run();
  // ON DELETE SET NULL: the imported text survives a deletion, ready to relink.
  const row = db.prepare(`SELECT exercise_id FROM exercise_guides WHERE guide_id = 'Barbell_Curl'`).get();
  assert.equal(row.exercise_id, null);
  assert.equal(getExerciseGuide("Barbell Curl"), null);
});
