// The starter picture pack (src/artStarter.ts): pre-baked exercise figures for a
// keyless install, plus generic movement-pattern stand-ins.
//
// Pins the four promises that matter:
//   • matching is TIMID — expanded key, the resolved stored name, or an explicit
//     exercise_aliases link; never a similar movement, never a coin flip;
//   • a pack hit is installed as a real, versioned asset and NEVER queues a paid
//     generation, while "Redraw this figure" still goes bespoke;
//   • the generic stand-in lives at its own URL and is never served (so never
//     cached) as an exercise's real picture;
//   • the committed lists are well-formed.
//
// Offline — global fetch is stubbed. The fixture pack lives in this worker's temp
// DATA_DIR, set BEFORE dist/art.js loads (the pack dir resolves at module load).
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, repo } from "./_seed.js";
import { MUSCLE_GROUPS } from "../dist/repo/exercise-canon.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACK = path.join(process.env.DATA_DIR, "starter-fixture");
process.env.CAIRN_STARTER_ART_DIR = PACK;
process.env.GEMINI_API_KEY = "test-key-not-a-real-credential";

// JPEG magic + padding: what the builder's ffmpeg downscale writes.
const jpeg = (fill) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(96, fill)]);
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

function writePack() {
  fs.rmSync(PACK, { recursive: true, force: true });
  fs.mkdirSync(path.join(PACK, "exercises"), { recursive: true });
  fs.mkdirSync(path.join(PACK, "patterns"), { recursive: true });
  const entry = (name, pattern, extra = {}) => ({
    name,
    pattern,
    equipment: "a barbell",
    muscle_group: "quads",
    pose: "Standing tall with the implement in hand, then moving through the working position of the lift.",
    ...extra,
  });
  fs.writeFileSync(
    path.join(PACK, "exercises.json"),
    JSON.stringify({
      version: 1,
      exercises: [
        entry("Barbell Bench Press", "horizontal_push", { aliases: ["Bench Press"], muscle_group: "chest" }),
        entry("Romanian Deadlift", "hinge", { muscle_group: "hamstrings" }),
        entry("Goblet Squat", "squat", { equipment: "a kettlebell" }),
        entry("Face Pull", "shoulder_raise", { muscle_group: "rear delts" }), // listed, never built
      ],
    })
  );
  fs.writeFileSync(
    path.join(PACK, "patterns.json"),
    JSON.stringify({
      version: 1,
      patterns: [
        { id: "squat", subject: "a bodyweight squat", pose: "Squatting." },
        { id: "general", subject: "an athletic ready stance", pose: "Ready." },
      ],
    })
  );
  fs.writeFileSync(path.join(PACK, "exercises", "barbell-bench-press.jpg"), jpeg(1));
  fs.writeFileSync(path.join(PACK, "exercises", "romanian-deadlift.jpg"), jpeg(2));
  fs.writeFileSync(path.join(PACK, "exercises", "goblet-squat.jpg"), jpeg(3));
  fs.writeFileSync(path.join(PACK, "patterns", "squat.jpg"), jpeg(4));
  fs.writeFileSync(path.join(PACK, "patterns", "general.jpg"), jpeg(5));
}

let art;
let starter;
let circuit;
let calls = [];
const realFetch = globalThis.fetch;
let server = null;

function okImage() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [
        { content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG_BYTES.toString("base64") } }] } },
      ],
    }),
    text: async () => "",
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function settleUntil(done, tries = 400) {
  for (let i = 0; i < tries; i++) {
    if (done()) return true;
    await sleep(5);
  }
  return done();
}

async function base() {
  if (!server) {
    const express = (await import("express")).default;
    const { artRouter } = await import("../dist/routes/art.js");
    const app = express();
    app.use(express.json());
    app.use("/api", artRouter);
    server = await new Promise((resolve, reject) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
      s.on("error", reject);
    });
  }
  return `http://127.0.0.1:${server.address().port}/api`;
}

before(async () => {
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes("generativelanguage.googleapis.com")) return realFetch(url, init);
    calls.push(String(url));
    return okImage();
  };
  writePack();
  art = await import("../dist/art.js");
  starter = await import("../dist/artStarter.js");
  circuit = await import("../dist/artCircuit.js");
});

after(async () => {
  globalThis.fetch = realFetch;
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(PACK, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
  writePack();
  starter.resetStarterPackCache();
  circuit.resetArtCircuit();
  art.resetArtRegenGate();
  fs.rmSync(path.join(process.env.DATA_DIR, "art"), { recursive: true, force: true });
});

const usageRows = () =>
  db
    .prepare("SELECT action FROM art_usage")
    .all()
    .map((r) => r.action);

test("the fixture pack is the one this process reads", () => {
  assert.equal(starter.STARTER_ART_DIR, PACK);
});

test("pack matching is timid: expanded key, a curated alias or an exercise_aliases link — never a similar movement", () => {
  const hit = (q) => starter.starterFigureFor(q)?.entry.name ?? null;
  assert.equal(hit("Barbell Bench Press"), "Barbell Bench Press");
  assert.equal(hit("BB Bench Press"), "Barbell Bench Press", "Cairn's abbreviation expands");
  assert.equal(hit("romanian deadlifts"), "Romanian Deadlift", "plural folds, as the canon key does");
  assert.equal(hit("Bench Press"), "Barbell Bench Press", "a curated alias");
  assert.equal(hit("Romanian Deadlift"), "Romanian Deadlift");
  assert.equal(hit("RDL"), "Romanian Deadlift");

  // Similar is not the same: a different implement, angle or stance never matches.
  assert.equal(hit("DB Bench Press"), null);
  assert.equal(hit("Incline Bench Press"), null);
  assert.equal(hit("Bench"), null);
  assert.equal(hit("Single-Leg RDL"), null);
  assert.equal(hit("Dumbbell Romanian Deadlift"), null);
  assert.equal(hit("Kettlebell Goblet Squat"), null);

  // Listed but never built → no figure (the generic layer answers instead).
  assert.equal(hit("Face Pull"), null);

  // An explicit alias row links a spelling the key cannot.
  repo.setExerciseAlias("flat bench", "Barbell Bench Press");
  assert.equal(hit("flat bench"), "Barbell Bench Press");
  // …in either direction: the stored canonical's own name reaches the pack via its alias.
  repo.setExerciseAlias("RDL hinge", "Hinge Day Main Lift");
  repo.setExerciseAlias("Romanian Deadlift", "Hinge Day Main Lift");
  assert.equal(hit("Hinge Day Main Lift"), "Romanian Deadlift");

  // A name whose evidence points at TWO entries is ambiguous and answers nothing.
  repo.setExerciseAlias("Goblet Squat", "Romanian Deadlift");
  assert.equal(hit("Goblet Squat"), null);
});

test("a pack hit installs a real, versioned figure and never queues a paid generation", async () => {
  assert.equal(art.cachedArtPath("exercise", "BB Bench Press"), null);
  assert.equal(art.requestArt("exercise", "BB Bench Press"), false, "nothing queued");
  const file = art.cachedArtPath("exercise", "BB Bench Press");
  assert.ok(file && file.startsWith(path.join(process.env.DATA_DIR, "art")), "installed into data/art");
  assert.equal(fs.readFileSync(file).subarray(0, 2).toString("hex"), "ffd8");
  assert.equal(art.artVersion("exercise", "BB Bench Press"), 1, "on the ordinary versioned URL");
  assert.equal(art.currentArtIndex("exercise", "BB Bench Press").asset_key, art.assetKeyFromPath(file));

  // The producer path (enrich jobs, the queue drain) lands the pack too.
  assert.equal(await art.warmExerciseArt("Romanian Deadlift"), false);
  assert.ok(art.cachedArtPath("exercise", "Romanian Deadlift"));

  // Two names for one entry share one asset.
  art.requestArt("exercise", "Bench Press");
  assert.equal(art.cachedArtPath("exercise", "Bench Press"), file);

  await sleep(20);
  assert.equal(calls.length, 0, "no Gemini call for a pack figure");
  assert.deepEqual(usageRows(), [], "a file copy is not spend, and not a 'reuse' either");
});

test("GET /api/art serves a pack figure on a miss, without a key and without queueing", async () => {
  const saved = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "";
  try {
    const res = await realFetch(`${await base()}/art?kind=exercise&q=${encodeURIComponent("Goblet Squat")}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/jpeg");
    assert.match(res.headers.get("cache-control") || "", /immutable/);
    assert.ok(art.cachedArtPath("exercise", "Goblet Squat"));
  } finally {
    process.env.GEMINI_API_KEY = saved;
  }
  await sleep(20);
  assert.equal(calls.length, 0);
});

test("Redraw still goes bespoke past a pack figure, under a new version", async () => {
  art.requestArt("exercise", "Romanian Deadlift");
  const packFile = art.cachedArtPath("exercise", "Romanian Deadlift");
  assert.equal(art.artVersion("exercise", "Romanian Deadlift"), 1);
  const out = await art.regenerateArt("exercise", "Romanian Deadlift");
  assert.equal(out.ok, true);
  assert.equal(out.regenerated, true);
  assert.equal(out.version, 2);
  assert.equal(calls.length, 1, "the redraw is the one paid call");
  const now = art.cachedArtPath("exercise", "Romanian Deadlift");
  assert.notEqual(now, packFile);
  assert.equal(fs.readFileSync(now).subarray(0, 4).toString("hex"), "89504e47", "the bespoke PNG");
});

test("the generic stand-in has its own URL and is never served as an exercise's picture", async () => {
  const api = await base();
  const q = "Zercher Squat"; // not in the fixture pack → squat pattern

  // While nothing is drawn, the stand-in comes from its own URL…
  const generic = await realFetch(`${api}/art/generic?q=${encodeURIComponent(q)}`);
  assert.equal(generic.status, 200);
  assert.equal(generic.headers.get("x-cairn-art-generic"), "squat");
  assert.equal(generic.headers.get("content-type"), "image/jpeg");
  assert.doesNotMatch(generic.headers.get("cache-control") || "", /immutable|public/);
  assert.equal(Buffer.from(await generic.arrayBuffer()).at(-1), 4, "the squat figure");

  // …and the real-picture URL answers 204 (and queues the bespoke generation as before).
  const real = await realFetch(`${api}/art?kind=exercise&q=${encodeURIComponent(q)}`);
  assert.equal(real.status, 204, "a stand-in is never the /api/art answer");

  // The queued generation lands; the real URL now serves the real figure and the
  // stand-in steps aside.
  assert.ok(await settleUntil(() => !!art.cachedArtPath("exercise", q)), "the bespoke figure was generated");
  const after = await realFetch(`${api}/art?kind=exercise&q=${encodeURIComponent(q)}`);
  assert.equal(after.status, 200);
  assert.equal(
    Buffer.from(await after.arrayBuffer())
      .subarray(0, 4)
      .toString("hex"),
    "89504e47"
  );
  const gone = await realFetch(`${api}/art/generic?q=${encodeURIComponent(q)}`);
  assert.equal(gone.status, 204);
  assert.equal(gone.headers.get("cache-control"), "no-store");
});

test("the generic route steps aside for a pack figure and degrades to a no-store 204 when unbuilt", async () => {
  const api = await base();
  const packHit = await realFetch(`${api}/art/generic?q=${encodeURIComponent("Goblet Squat")}`);
  assert.equal(packHit.status, 204, "the pack holds the real figure");

  // An unbuilt pattern falls back to the general figure…
  const pulldown = await realFetch(`${api}/art/generic?q=${encodeURIComponent("Lat Pulldown")}`);
  assert.equal(pulldown.status, 200);
  assert.equal(pulldown.headers.get("x-cairn-art-generic"), "general");

  // …and with no generic figures at all, nothing is served.
  fs.rmSync(path.join(PACK, "patterns"), { recursive: true, force: true });
  starter.resetStarterPackCache();
  const none = await realFetch(`${api}/art/generic?q=${encodeURIComponent("Lat Pulldown")}`);
  assert.equal(none.status, 204);
  assert.equal(none.headers.get("cache-control"), "no-store");
});

test("an empty pack changes nothing: no hit, no generic, today's queue behavior", async () => {
  fs.rmSync(PACK, { recursive: true, force: true });
  starter.resetStarterPackCache();
  assert.equal(starter.starterFigureFor("Barbell Bench Press"), null);
  assert.equal(starter.genericFigureFor("Back Squat"), null);
  assert.equal(art.requestArt("exercise", "Barbell Bench Press"), true, "queued for generation as before");
  assert.ok(await settleUntil(() => calls.length === 1));
});

test("the service worker's cache-first art layer never matches the generic URL", async () => {
  const { artCacheIdentity } = await import("../dist/artCachePolicy.js");
  assert.equal(artCacheIdentity("/api/art/generic?q=Back%20Squat"), null);
  assert.ok(artCacheIdentity("/api/art?kind=exercise&q=Back%20Squat&v=1"));
  const sw = fs.readFileSync(path.join(ROOT, "public", "sw.js"), "utf8");
  assert.match(sw, /url\.pathname === "\/api\/art"\)/, "the SW routes /api/art by exact path");
  assert.match(sw, /parsed\.pathname !== "\/api\/art"\) return null/);
  const { queryTokenAllowedPath } = await import("../dist/auth.js");
  assert.equal(queryTokenAllowedPath("/api/art/generic"), true, "an <img> can authenticate it");
  assert.equal(queryTokenAllowedPath("/api/art/generic", "POST"), false);
});

test("movement patterns classify from the row, the family classifier, then the group floor", () => {
  const p = (name, row) => starter.movementPatternFor(name, row);
  assert.equal(p("Back Squat"), "squat");
  assert.equal(p("Romanian Deadlift"), "hinge");
  assert.equal(p("Hip Thrust"), "hinge");
  assert.equal(p("Bulgarian Split Squat"), "lunge");
  assert.equal(p("Incline DB Press"), "horizontal_push");
  assert.equal(p("Arnold Press"), "vertical_push");
  assert.equal(p("Seated Cable Row"), "horizontal_pull");
  assert.equal(p("Lat Pulldown"), "vertical_pull");
  assert.equal(p("Hammer Curl"), "arms");
  assert.equal(p("Triceps Rope Pushdown"), "arms");
  assert.equal(p("Cable Lateral Raise"), "shoulder_raise");
  assert.equal(p("Face Pull"), "shoulder_raise");
  assert.equal(p("Seated Calf Raise"), "calf");
  assert.equal(p("Pallof Press"), "core");
  assert.equal(p("Farmer's Walk"), "carry");
  assert.equal(p("Cat-Cow"), "mobility");
  assert.equal(p("Treadmill Run"), "run");
  assert.equal(p("Assault Bike"), "ride");
  assert.equal(p("Sled Push"), "general");
  assert.equal(p("Zzz Unknown Thing"), "general");
  // A stored group decides when the name alone can't.
  assert.equal(p("Coach's Special", { muscle_group: "back" }), "horizontal_pull");
  assert.equal(p("Coach's Special", { muscle_group: "mobility" }), "mobility");
});

test("the committed starter lists are well-formed and unambiguous", () => {
  const dir = path.join(ROOT, "seed-art", "starter");
  const pack = starter.readStarterPack(dir);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "exercises.json"), "utf8")).exercises;
  assert.equal(pack.exercises.length, raw.length, "every entry parses (valid pattern, a name)");
  assert.ok(pack.exercises.length >= 190, `about two hundred exercises (${pack.exercises.length})`);
  for (const entry of pack.exercises) {
    assert.ok(entry.pose.length >= 40 && entry.pose.length <= 360, `${entry.name}: pose within the 360-char cap`);
    assert.ok(MUSCLE_GROUPS.includes(entry.muscle_group), `${entry.name}: ${entry.muscle_group} is a canonical group`);
  }
  const ambiguous = [...pack.byKey].filter(([, index]) => index < 0).map(([key]) => key);
  assert.deepEqual(ambiguous, [], "no key is claimed by two entries");
  const slugs = pack.exercises.map((e) => starter.starterSlug(e.name));
  assert.equal(new Set(slugs).size, slugs.length, "every figure has its own file");
  assert.deepEqual(
    pack.patterns.map((p) => p.id).sort(),
    [...starter.STARTER_PATTERNS].sort(),
    "one generic figure per pattern"
  );
  for (const p of pack.patterns) assert.ok(p.subject && p.pose.length <= 360, p.id);
  // The prompt the builder sends is the runtime's own exercise prompt.
  const first = pack.exercises[0];
  const prompt = art.stylePrompt("exercise", first.name, first);
  assert.ok(prompt.startsWith("The pose:"), "the pose leads, as at runtime");
  assert.match(prompt, /clay figurine/);
});
